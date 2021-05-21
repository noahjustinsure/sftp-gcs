import { SFTPSession } from 'sftp/SFTPSession'
import { SFTP_STATUS_CODE } from 'ssh2'
import { Attributes, InputAttributes } from 'ssh2-streams'
import { inspect } from 'util'
import { MODE_DIR, MODE_FILE } from './constants'

export class StatOperations {
	constructor(private session: SFTPSession) {}

	private async commonStat(reqId: number, path: string): Promise<boolean | void> {
		const attrs = await this.getStatData(path)

		if (attrs === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.sftpStream.attrs(reqId, attrs as Attributes)
	}

	/**
	 * Get the stat data of a file or directory.
	 * @param path
	 * @returns An object describing the attributes of the thing at the path or null if no such object
	 * can be found.
	 */
	private async getStatData(path: string): Promise<Partial<Attributes>> {
		if (path === '/') {
			// The root is a directory ... simple base/special case.
			return { mode: MODE_DIR }
		}

		path = this.session.normalizePath(path)

		try {
			// We test to see if we have a file of the exact name.  If yes, then use it's attributes.
			let [exists] = await this.session.bucket.file(path).exists()
			if (exists) {
				const [metadata] = await this.session.bucket.file(path).getMetadata()

				return {
					mode: MODE_FILE,
					size: Number(metadata.size),
				}
			}

			// We don't have an exact name match now we look to see if we have a file with this as a prefix.
			const [fileList] = await this.session.bucket.getFiles({
				delimiter: '/',
				directory: path,
				autoPaginate: false,
			})

			if (fileList.length == 0) {
				this.session.logger.debug(`Could not find ${path}`)
				return null
			}

			this.session.logger.debug(`"${path}" is a directory!`)
			return { mode: MODE_DIR }
		} catch (err) {
			this.session.logger.debug(`STAT Error: ${err}`)
			return null
		}
	}

	public async fStat(reqId: number, handleBuffer: Buffer): Promise<void | boolean> {
		// FSTAT(< integer >reqID, < Buffer >handle)
		const fileRecord = this.session.getFileRecord(handleBuffer)
		if (fileRecord === null) {
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.session.logger.debug(`FSTAT<${reqId}>: handle: ${fileRecord.handle} => path: "${fileRecord.path}"`)

		if (!fileRecord.path) {
			this.session.logger.error('Internal error: FSTAT - no path in fileRecord!')
			return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.FAILURE)
		}

		this.commonStat(reqId, fileRecord.path)
	}

	public async lStat(reqId: number, path: string): Promise<void> {
		// LSTAT(< integer >reqID, < string >path)
		// use attrs() to send attributes of the requested file back to the client.
		this.session.logger.debug(`LSTAT<${reqId}>: path: "${path}"`)
		this.commonStat(reqId, path)
	}

	public async stat(reqId: number, path: string): Promise<void> {
		// STAT(< integer >reqID, < string >path)
		this.session.logger.debug(`STAT<${reqId}>: path: "${path}"`)
		this.commonStat(reqId, path)
	}

	public setStat(reqId: number, path: string, attrs: InputAttributes): boolean {
		// SETSTAT < integer >reqID, < string >path, < ATTRS >attrs)
		this.session.logger.debug(`SETSTAT<${reqId}>: path: "${path}", attrs: ${inspect(attrs)}`)
		// Although we don't actually set any attributes, we say that we did.  WinSCP seems to complain
		// if we say we didn't.
		return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OK)
	}

	public setFstat(reqId: number, _handleBuffer: Buffer, _attrs: InputAttributes): boolean {
		// FSETSTAT(< integer >reqID, < Buffer >handle, < ATTRS >attrs)
		this.session.logger.debug(`FSETSTAT<${reqId}>`)
		return this.session.sftpStream.status(reqId, SFTP_STATUS_CODE.OP_UNSUPPORTED)
	}
}
