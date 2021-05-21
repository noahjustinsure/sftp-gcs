import { ConnectionClient } from '../ssh/ConnectionClient'
import { InputAttributes, SFTPStream } from 'ssh2-streams'
import { createLogger } from '../utils/Logger'
import { Logger } from 'winston'
import { normalize } from 'path'
import { Storage, Bucket } from '@google-cloud/storage'
import { FileRecord } from '@/types'
import { DirectoryOperations, FileOperations, StatOperations } from './operations'

export class SFTPSession {
	logger: Logger
	bucket: Bucket
	handleCount: number = 0
	openFiles: Map<number, FileRecord> = new Map()

	private dirOps: DirectoryOperations
	private fileOps: FileOperations
	private statOps: StatOperations

	constructor(private client: ConnectionClient, public sftpStream: SFTPStream) {
		this.logger = createLogger()
		this.bucket = new Storage().bucket(this.client.authenticator.bucketName)

		// Instantiate operators:
		this.dirOps = new DirectoryOperations(this)
		this.fileOps = new FileOperations(this)
		this.statOps = new StatOperations(this)

		this.registerListeners(sftpStream)
	}

	private registerListeners(sftpStream: SFTPStream) {
		this.logger.debug('Client SFTP session initiated')

		//#region File events

		sftpStream.on('OPEN', (reqId: number, rawFilename: string, flags: number, _attrs: InputAttributes) =>
			this.fileOps.open(reqId, rawFilename, flags)
		)

		sftpStream.on('WRITE', (reqId: number, handleBuffer: Buffer, offset: number, data: Buffer) =>
			this.fileOps.write(reqId, handleBuffer, offset, data)
		)

		sftpStream.on('READ', (reqId: number, handleBuffer: Buffer, offset: number, requestedLength: number) =>
			this.fileOps.read(reqId, handleBuffer, offset, requestedLength)
		)

		sftpStream.on('RENAME', (reqId: number, oldPath: string, newPath: string) =>
			this.fileOps.rename(reqId, oldPath, newPath)
		)

		sftpStream.on('REMOVE', (reqId: number, path: string) => this.fileOps.remove(reqId, path))

		sftpStream.on('CLOSE', (reqId, handleBuffer) => this.fileOps.close(reqId, handleBuffer))

		//#endregion

		//#region Directory events

		sftpStream.on('MKDIR', (reqId: number, path: string, attrs: InputAttributes) =>
			this.dirOps.make(reqId, path, attrs)
		)

		sftpStream.on('OPENDIR', (reqId: number, path: string) => this.dirOps.open(reqId, path))

		sftpStream.on('READDIR', (reqId: number, handleBuffer: Buffer) => this.dirOps.read(reqId, handleBuffer))

		sftpStream.on('RMDIR', (reqId: number, path: string) => this.dirOps.remove(reqId, path))

		sftpStream.on('REALPATH', (reqId: number, path: string) => this.dirOps.realPath(reqId, path))

		//#endregion

		//#region Stat events

		sftpStream.on('LSTAT', (reqId: number, path: string) => this.statOps.lStat(reqId, path))

		sftpStream.on('STAT', (reqId: number, path: string) => this.statOps.stat(reqId, path))

		sftpStream.on('FSTAT', (reqId: number, handleBuffer: Buffer) => this.statOps.fStat(reqId, handleBuffer))

		sftpStream.on('SETSTAT', (reqId: number, path: string, attrs: InputAttributes) =>
			this.statOps.setStat(reqId, path, attrs)
		)

		sftpStream.on('FSETSTAT', (reqId: number, handleBuffer: Buffer, attrs: InputAttributes) =>
			this.statOps.setFstat(reqId, handleBuffer, attrs)
		)

		//#endregion
	}

	/**
	 * We are passed paths that represent the SFTP client's vision of a path that is distinct from that of
	 * GCS.  We have to perform processing on the path to bring it to a canonical format.  This includes
	 * handling of prefix for the root of a file system ('xxx' vs '/xxx') and handling of relative
	 * directories such as '.' and '..'
	 * @param path The path to be processed.
	 */
	public normalizePath(path: string): string {
		const start = path
		// If path starts with '/', remove '/'
		if (path.startsWith('/')) {
			path = path.substring(1)
		}
		if (path.endsWith('.')) {
			path = path.substring(0, path.length - 1)
		}
		path = normalize(path)
		if (path === '.') {
			path = ''
		}
		if (path === '..') {
			path = ''
		}
		this.logger.debug(`Converted "${start}" to "${path}"`)
		return path
	}

	/**
	 * Get the file record (the open file) from the set of open files based
	 * on the value contained in the handle buffer.
	 *
	 * @param handleBuffer TODO: What is dis?
	 * @returns a fileRecord object or null if no corresponding file record object can be found.
	 */
	public getFileRecord(handleBuffer: Buffer): FileRecord | null {
		// Validate that the handle buffer is the right size for a 32bit BE integer.
		if (handleBuffer.length !== 4) {
			this.logger.debug('ERROR: Buffer wrong size for 32bit BE integer')
			return null
		}

		const handle = handleBuffer.readUInt32BE(0) // Get the handle of the file from the SFTP client.

		if (!this.openFiles.has(handle)) {
			this.logger.debug(`Unable to find file with handle ${handle}`)
			return null
		}

		return this.openFiles.get(handle)
	}
}
