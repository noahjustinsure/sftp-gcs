import { FileRecord, ReadMapProps } from '@/types'
import { SFTP_STATUS_CODE } from 'ssh2'
import { SFTPStream } from 'ssh2-streams'
import { inspect } from 'util'
import { createGetGCSData, getProcessQueue } from '../GCSHelpers'
import { SFTPSession } from '../SFTPSession'

export class FileOperations {
	constructor(private session: SFTPSession) {}

	/**
	 * Called when the client sends a block of data to be written to the file on the SFTP server.
	 *
	 * @param reqId Request id
	 * @param handleBuffer
	 * @param offset
	 * @param data The data to write?
	 * @returns void
	 */
	public write(reqId: number, handleBuffer: Buffer, offset: number, data: Buffer): void | boolean {
		const fileRecord = this.session.getFileRecord(handleBuffer)
		if (fileRecord === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.logger.debug(
			`WRITE<${reqId}>: handle: ${fileRecord.handle}, offset ${offset}: data.length=${data.length}`
		)

		if (fileRecord.gcsError === true) {
			this.session.logger.debug(`Returning failure in WRITE because of flagged gcsError`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		fileRecord.writeStream.write(data, () => {
			this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
		})
	}

	/**
	 * Handle a SFTP protocol read request.
	 * We are asked to get data starting at a given
	 * offset for a maximum requested length.
	 * The outcome will either be data or a status of EOF.
	 *
	 * @param reqId Request id
	 * @param handleBuffer
	 * @param offset
	 * @param requestedLength
	 * @returns void or boolean
	 */
	public async read(
		reqId: number,
		handleBuffer: Buffer,
		offset: number,
		requestedLength: number
	): Promise<void | boolean> {
		// READ(< integer >reqID, < Buffer >handle, < integer >offset, < integer >length)

		const fileRecord = this.session.getFileRecord(handleBuffer)
		if (fileRecord === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.logger.debug(
			`READ<${reqId}>: handle: ${fileRecord.handle}, offset: ${offset}, max length: ${requestedLength}`
		)

		// * Request GCS data starting at a given offset for a requested length.  This is a promise that will
		// * be eventually fulfilled.  The data returned is either a Buffer or null.  If null, that is the
		// * indication that we have reached the end of file.
		fileRecord.currentReqid = reqId

		try {
			// TODO: Check why type is off here?
			const data: any = await fileRecord.getGCSData(offset, requestedLength)

			return data === null
				? this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.EOF)
				: this.session.sftpStream.data(reqId, data) // Return the requested data.
		} catch (err) {
			this.session.logger.debug(`Exception: ${inspect(err)}`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	/**
	 * Handle OPEN
	 *
	 * "flags" is a bitfield containing any of the flags defined in SFTPStream.OPEN_MODE. These modes are:
	 *
	 * - READ
	 * - WRITE
	 * - APPEND
	 * - CREATE
	 * - TRUNC
	 * - EXCL
	 *
	 * @param reqId Request ID
	 * @param rawFilename The filename
	 * @param flags
	 * @returns void
	 */
	public async open(reqId: number, rawFilename: string, flags: number): Promise<void | boolean> {
		this.session.logger.debug(`OPEN<${reqId}>: filename: "${rawFilename}", flags: ${SFTPStream.flagsToString(flags)}`)

		const filename = this.session.normalizePath(rawFilename)

		const handle = this.session.handleCount
		this.session.handleCount += 1

		let fileRecord: FileRecord = { handle, path: filename }

		if (flags & SFTPStream.OPEN_MODE.WRITE) {
			fileRecord = this.openFileWrite(fileRecord)
		} else if (flags & SFTPStream.OPEN_MODE.READ) {
			fileRecord = this.openFileRead(fileRecord)
		} else {
			this.session.logger.debug(`Open mode not supported`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.openFiles.set(handle, fileRecord) // We are indeed going to process opening a file ... so record the fileRecord.

		// Return the file handle in BigEndian format as unsigned 32bit.
		const handleBuffer = Buffer.alloc(4)
		handleBuffer.writeUInt32BE(handle, 0)
		this.session.sftpStream.handle(reqId, handleBuffer)
	}

	/**
	 * Handling reads for SFTP mapped to GCS is an interesting story.  SFTP assumes block oriented access to the files that it thinks it is
	 * reading.  SFTP clients send individual requests to read chunks of storage  For example, an SFTP client may send a request such as:
	 *
	 * READ: reqId: 12, offset: 2048, maxLength: 512
	 *
	 * This would be interpreted as read and return up to 512 bytes starting at offset 2048 into the file.  With GCS access, we retrieve our data
	 * as a stream of data starting from the beginning.  We have no way to ask GCS to obtain an arbitrary block.  We might think we can simply map the
	 * SFTP requests to serial consumption of the stream data but there are dangers in that story.  First of all, SFTP doesn't require that block
	 * read requests arrive one at a time or in order.  For example, the following two request messages may very well arrive:
	 *
	 * READ: reqId: x, offset: 2048, maxLength: 512
	 * READ: reqId: y, offset: 0, maxLength: 1024
	 *
	 * We may easily get a request for a block that comes later in the stream.  We can assume that we will eventually get requests for all blocks but
	 * must not assume that they come in order.  We can't simply process a read request with the next chunk of data read from the GCS object.  We
	 * should also note that we may get multiple READ requests before any previous ones have been satisfied.  Our SFTP server much honor the contract
	 * and not make assumptions on the order of the client send requests.
	 *
	 * Our algorithm is to receive READ requests and place them in a Map() keyed by the offset start of the data.  From the GCS stream, we know what the
	 * offset of the incoming data is.  To be specific, when we start a new GCS stream, it is at offset 0.  As we consume data of length "n" from the
	 * stream, the next offset moves forward by "n".  This then gives us the notion of matching up READ requests for data at a given starting offset
	 * and data arriving from the GCS stream.  Whenever a new READ request arrives, we add it to the map and then "process the map".  We perform
	 * the following:
	 *
	 * From the GCS stream we have a current "offset".  Do we have a READ request which starts at that offset?  If yes, we can return data.
	 * If no, we can not return data and must await some expected future READ request which does start at that offset.  When ever a new READ
	 * request arrives, we again perform this processing.  One further twist is that we don't want to return only the available data but instead
	 * we want to maximize the data returned in a READ request.  Let us look at an example.  Imagine we have a READ request that asks for data
	 * at offset 0 and a maximum length of 32768.  Now consider that from the GCS stream, we may have received 4096 bytes starting at offset 0.
	 * We could immediately satisfy the READ and return 4096 bytes.  This would be legal as per the SFTP spec but it would not be optimal.  Instead
	 * we want to wait until we have 32768 bytes (or more) to return in the READ request.  Adding this twist to our story means that we aren't
	 * just looking for some data, we are looking for as much data as possible.
	 */
	public openFileRead(fileRecord: FileRecord): FileRecord {
		this.session.logger.debug(`Opening file for READ`)

		fileRecord.gcsError = false
		let gcsEnd = false
		let gcsOffset = 0
		let activeRead = null as ReadMapProps | null
		const readMap = new Map()

		fileRecord.getGCSData = createGetGCSData(readMap, fileRecord)

		const gcsStream = this.session.bucket.file(fileRecord.path).createReadStream()

		gcsStream.on('error', (err) => {
			this.session.logger.debug(`GCS readStream: Error: ${err}`)
			fileRecord.gcsError = true
		})

		gcsStream.on('end', () => {
			this.session.logger.debug(`End of GCS stream`)
			gcsEnd = true
		})

		gcsStream.on('readable', () => {
			fileRecord.processQueue()
		})

		fileRecord.processQueue = getProcessQueue(gcsEnd, readMap, fileRecord, activeRead, gcsStream, gcsOffset)

		return fileRecord
	}

	public openFileWrite(fileRecord: FileRecord): FileRecord {
		this.session.logger.debug('Opening file for WRITE')

		// We now need to open the GCS file for writing.  It will be written in subsequent WRITE requests.
		fileRecord.gcsFile = this.session.bucket.file(fileRecord.path)
		fileRecord.gcsError = false
		fileRecord.writeStream = fileRecord.gcsFile.createWriteStream()
		fileRecord.writeStream.on('error', (err) => {
			this.session.logger.debug(`Detected an error with writeStream to the GCS file: ${err}`)
			fileRecord.gcsError = true
		})

		return fileRecord
	}

	public async rename(reqId: number, rawOldPath: string, rawNewPath: string): Promise<boolean> {
		// RENAME(< integer >reqID, < string >oldPath, < string >newPath)
		this.session.logger.debug(`RENAME<${reqId}>: oldPath: ${rawOldPath}, newPath: ${rawNewPath}`)

		const oldPath = this.session.normalizePath(rawOldPath)
		const newPath = this.session.normalizePath(rawNewPath)

		try {
			// Map the request to a GCS command to rename a GCS object.
			await this.session.bucket.file(oldPath).rename(newPath)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
		} catch (exc) {
			this.session.logger.debug(`Exception: ${inspect(exc)}`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	public async remove(reqId: number, rawPath: string): Promise<void | boolean> {
		// REMOVE(< integer >reqID, < string >path)
		this.session.logger.debug(`REMOVE<${reqId}>: path: "${rawPath}"`)

		const path = this.session.normalizePath(rawPath)

		if (path.endsWith('/')) {
			// Sneaky user trying to remove a directory as though it were a file!
			this.session.logger.debug(`Can't remove a file ending with "/"`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		try {
			// Map the request to a GCS command to delete/remove a GCS object.
			await this.session.bucket.file(path).delete()
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
		} catch (exc) {
			this.session.logger.debug(`Failed to delete file "${path}"`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	/**
	 * Called when the client closes the file.
	 * For example at the end of a write.
	 * The points where we know a close will be called include
	 * following an OPEN and an OPENDIR.
	 *
	 * @param reqId Request ID
	 * @param handleBuffer
	 */
	public close(reqId: number, handleBuffer: Buffer): void | boolean {
		const fileRecord = this.session.getFileRecord(handleBuffer)

		if (fileRecord === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.logger.debug(`CLOSE<${reqId}>: handle: ${fileRecord.handle}`)

		// Close the GCS file stream by calling end().  We save the SFTP request id in the fileRecord.  Notice
		// that we don't flag the status of this stream request.  Instead, we assume that the call to end will result
		// in a call to close() which will close the stream and THAT will send back the stream response.
		this.session.openFiles.delete(fileRecord.handle)

		if (fileRecord.writeStream) {
			this.session.logger.debug(`Closing GCS write stream`)

			if (fileRecord.gcsError) {
				this.session.logger.debug(`Returning error because of previous GCS Error with write stream`)
				return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
			}

			fileRecord.writeStream.end(() => {
				this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
			})
			return
		}

		return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
	}
}
