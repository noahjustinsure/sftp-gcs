import { normalize } from 'path'
import { SFTP_STATUS_CODE } from 'ssh2'
import { FileEntry, InputAttributes } from 'ssh2-streams'
import { inspect } from 'util'
import { fileLongEntry } from 'utils/helpers'
import { SFTPSession } from '../SFTPSession'
import { MODE_DIR, MODE_FILE } from './constants'

export class DirectoryOperations {
	constructor(private session: SFTPSession) {}

	/**
	 * READDIR will be called multiple times following an OPENDIR until t
	 * he READDIR indicated that we have reached EOF.
	 * The READDIR will return an array of directory objects where each object
	 * contains:
	 * ```ts
	 * {
	 *   filename: string
	 *   longname: string
	 *    attrs: unknown? // TODO: Check
	 * }
	 * ```
	 * @param reqId Request id
	 * @param handleBuffer
	 * @returns
	 */
	public async read(reqId: number, handleBuffer: Buffer): Promise<FileEntry[] | boolean> {
		const fileRecord = this.session.getFileRecord(handleBuffer)
		if (fileRecord === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.logger.debug(`READDIR<${reqId}>: handle: ${fileRecord.handle}, path: "${fileRecord.path}"`)

		// When READDIR is called, it is expected to return some (maybe all) of the files in the directory.
		// It has two return values ... either one or more directory entries or an end of file marker indicating
		// that all the directory entries have been sent.  In our GCP mapping, on the first call, we return
		// all the directory entries and on the second call we return an EOF marker.  This satisfies the contract.
		// After the first call, we set a flag that indicates that the read of the directory is complete and that
		// subsequent calls should return EOF.
		if (fileRecord.readComplete) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.EOF)
		}

		fileRecord.readComplete = true
		try {
			// * The responses from a GCS file list are two parts.
			// * One part is files in the current "directory" while the other part is the list of directories.
			// * This is of course fake as GCS has no concept of directories.
			const [fileList] = await this.session.bucket.getFiles({
				autoPaginate: false,
				delimiter: '/',
				directory: fileRecord.path,
				includeTrailingDelimiter: true,
			})

			const results: FileEntry[] = []

			// Find the largest file size ...  We then determine how many characters this is and then
			// this becomes the padding for the long entry listing.
			let largest = Math.max(...fileList.map((f) => f.metadata.size as number))

			const padding = String(largest).length
			const dirPath = fileRecord.path + '/'

			for (const file of fileList) {
				let isDirectory = false
				let name = file.name

				// Remove prefix
				if (name.startsWith(dirPath)) {
					name = name.substring(dirPath.length)
				}

				// Remove trailing /
				if (name.endsWith('/')) {
					name = name.substr(0, name.length - 1)
					isDirectory = true
				}

				if (name === '') {
					return
				}

				// mode  - integer - Mode/permissions for the resource.
				// uid   - integer - User ID of the resource.
				// gid   - integer - Group ID of the resource.
				// size  - integer - Resource size in bytes.
				// atime - integer - UNIX timestamp of the access time of the resource.
				// mtime - integer - UNIX timestamp of the modified time of the resource.
				const newNameRecord: FileEntry = {
					filename: name,
					longname: fileLongEntry(
						name,
						isDirectory,
						file.metadata.size,
						padding,
						new Date(file.metadata.timeCreated).toISOString()
					),
					attrs: {
						mode: isDirectory ? MODE_DIR : MODE_FILE,
						size: Number(file.metadata.size),
						atime: 0,
						mtime: new Date(file.metadata.updated).getTime() / 1000,
					} as any,
				}
				results.push(newNameRecord)
			}

			fileRecord.readComplete = true // Flag that a subseqent call should return EOF.
			return this.session.sftpStream.name(reqId, results)
		} catch (err) {
			this.session.logger.debug(`Err: ${inspect(err)}`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	/**
	 * Handle the SFTP OPENDIR request.
	 * @param reqId is the request identifier that is returned in a matching response.
	 * @param path is the directory that we are going to list
	 */
	public async open(reqId: number, path: string) {
		this.session.logger.debug(`OPENDIR<${reqId}> path: "${path}"`)
		path = this.session.normalizePath(path)
		// Check that we have a directory to list.
		if (path !== '') {
			// Return an error
			// We have handled the simplest case, now we need to see if a directory exists with this name. Imagine we have been
			// asked to open "/dir".  This will have been normalized to "dir".  From a GCS perspective, we now want to determine if there are any files
			// that begin with the prefix "dir/".  If yes, then the directory exists.
			try {
				const [fileList] = await this.session.bucket.getFiles({
					directory: path,
					delimiter: '/',
					autoPaginate: false,
				})
				if (fileList.length == 0) {
					this.session.logger.debug(`we found no files/directories with directory: "${path}"`)
					return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE)
				}
			} catch (ex) {
				this.session.logger.debug(`Exception: ${inspect(ex)}`)
				return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
			}
		}

		const handle = this.session.handleCount
		this.session.handleCount += 1

		const fileRecord = {
			handle: handle,
			path: path,
			readComplete: false, // Have we completed our reading of data.
		}

		this.session.openFiles.set(handle, fileRecord)
		const handleBuffer = Buffer.alloc(4)
		handleBuffer.writeUInt32BE(handle, 0)
		this.session.sftpStream.handle(reqId, handleBuffer)
	}

	public async make(reqId: number, path: string, attrs: InputAttributes): Promise<void | boolean> {
		this.session.logger.debug(`MKDIR<${reqId}>: path: "${path}", attrs: ${inspect(attrs)}`)
		try {
			path = this.session.normalizePath(path)
			const dirName = path + '/'
			const [exists] = await this.session.bucket.file(dirName).exists()

			if (exists) {
				this.session.logger.debug(`something called ${dirName} already exists`)
				return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
			}
			// Create a stream and then immediately end writing to it. This creates a zero length file.
			const stream = this.session.bucket.file(dirName).createWriteStream()

			stream.end(() => {
				this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
			})
		} catch (ex) {
			this.session.logger.debug(`Exception: ${inspect(ex)}`)
			this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	public async remove(reqId: number, rawPath: string) {
		// RMDIR(< integer >reqID, < string >path)
		//
		// We need to check that the path exists and that it is a directory.
		// Imagine a request to delete a directory called "mydir".  We have a number of
		// known possibilities:
		//
		// 1. There is a gcs object called mydir.  This should not be deleted.  Return an error.
		// 2. There is a gcs object called mydir/.  This is indeed the directory and should be deleted BUT only ... if there are no objects that contain
		//    the mydir/ as a prefix.  If there are, then the directory can not be considered to be empty.
		// 3. There is no gcs object called mydir/ but there are objects that are prefixed mydir/.  We should not delete and return an error.  This would be an indication
		//    That there is logically a directory called mydir but that it is not empty.
		// 4. Otherwise we fail the directory deletion request.
		//

		this.session.logger.debug(`RMDIR<${reqId}>: path: "${rawPath}"`)

		let path = this.session.normalizePath(rawPath)

		// If the path does NOT end in with a '/', then add one
		if (!path.endsWith('/')) {
			path = path + '/'
		}

		try {
			// Let us see if we have files that end in path:
			const [fileList] = await this.session.bucket.getFiles({
				autoPaginate: false,
				delimiter: '/',
				prefix: path,
				maxResults: 2,
			})

			if (fileList.length === 0) {
				this.session.logger.debug(`No such file/directory: "${path}"`)
				return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE)
			} else if (fileList.length > 1) {
				this.session.logger.debug(`Directory not empty: "${path}"`)
				return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
			}

			await this.session.bucket.file(path).delete()
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
		} catch (ex) {
			this.session.logger.debug(`Exception: ${inspect(ex)}`)
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}
	}

	/**
	 * Called when the client wants to know the full path.
	 * @param reqId Request id
	 * @param rawPath Path to resolve
	 */
	public realPath(reqId: number, rawPath: string): void {
		this.session.logger.debug(`REALPATH<${reqId}>: path: "${rawPath}"`)

		let path = normalize(rawPath)

		if (['..', '.'].includes(path)) {
			path = '/'
		}

		this.session.logger.debug(`Returning "${path}"`)
		this.session.sftpStream.name(reqId, [{ filename: path } as any])
	}
}
