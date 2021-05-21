import { Connection } from 'ssh2'
import { createLogger } from 'utils/Logger'
import { Logger } from 'winston'
import { Authenticator } from './Authenticator'
import { inspect } from 'util'
import { SFTPSession } from '../sftp/SFTPSession'
import { ConnectionOptions } from '@/types'

export class ConnectionClient {
	#connection: Connection
	#logger: Logger
	authenticator: Authenticator

	constructor(connection: Connection, public options: ConnectionOptions) {
		this.#connection = connection
		this.#logger = createLogger()
		this.authenticator = new Authenticator(this, options)

		this.registerListeners(this.#connection)
	}

	registerListeners(client: Connection): void {
		client.on('authentication', (ctx) => this.authenticator.handleAuthentication(ctx))
		client.on('ready', () => this.registerAuthenticatedListeners(client))
		client.on('end', () => this.#logger.debug('Client disconnected'))
		client.on('error', (err) => this.#logger.debug(`ERROR(client.on): ${inspect(err)}`))
	}

	registerAuthenticatedListeners(client: Connection): void {
		this.#logger.debug('Client authenticated!')

		client.on('session', (accept, _reject) => {
			const session = accept()

			session.on('sftp', (sftpAccept, _sftpReject) => {
				new SFTPSession(this, sftpAccept())
			})
		})
	}
}
