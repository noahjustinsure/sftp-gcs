import { ConnectionOptions, UserData } from '@/types'
import { inspect } from 'util'
import { createLogger } from './utils/Logger'
import { createServer } from './server'
import { config } from 'dotenv'
import { loadConfigData } from './utils/helpers'

config()

const run = async () => {
	const { allowedKeys, userData } = await loadConfigData(process.env.USER_FILE, process.env.PUB_KEY_FILE)

	const options: ConnectionOptions = {
		defaultBucket: process.env.DEFAULT_BUCKET || 'default',
		isNoneAllowed: false,
		allowedKeys,
		allowedUsers: new Map<string, UserData>(userData),
		port: parseInt(process.env.PORT) || 22,
		ipPattern: process.env.IP_PATTERN || '0.0.0.0',
		serviceAccountKeyFile: process.env.KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
	}

	if (options.serviceAccountKeyFile) {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = options.serviceAccountKeyFile
	}

	const logger = createLogger()
	createServer(options)
		.listen(options.port, options.ipPattern, function () {
			logger.info('****************************************')
			logger.info('*** Google Cloud Storage SFTP Server ***')
			logger.info('****************************************')
			logger.info('Listening on port ' + this.address().port)
			logger.info(`Users: ${options.allowedUsers.size}`)
			logger.info(`Public keys: ${options.allowedKeys.length}`)
			logger.info(
				`Service account key file: ${
					options.serviceAccountKeyFile === '' ? 'Not set' : options.serviceAccountKeyFile
				}`
			)
		})
		.on('error', (err) => {
			// Capture any networking exception.  A common error is that we are asking the sftp-gcs server
			// to listen on a port that is already in use.  Check for that error and call it out specifically.
			logger.info(`Error with networking ${inspect(err)}`)
			if ((err as any).code === 'EACCES') {
				logger.info(`It is likely that an application is already listening on port ${(err as any).port}.`)
			}
		})
}

run()
