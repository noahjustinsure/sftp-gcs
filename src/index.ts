import { AllowedKey, ConnectionOptions, UserData } from '@/types'
import { inspect } from 'util'
import { createLogger } from 'utils/Logger'
import { createServer } from './server'
import { config } from 'dotenv'
import fs from 'fs'
import { utils } from 'ssh2'

config()

const run = async () => {
	// ! You should REALLY think of how you store these files,
	// ! because if this leaks you're screwed
	const userData = process.env.USER_FILE
		? JSON.parse((await fs.promises.readFile(process.env.USER_FILE)).toString())
		: []

	const keys: { keyPath: string; bucketName: string }[] = process.env.PUB_KEY_FILE
		? JSON.parse((await fs.promises.readFile(process.env.PUB_KEY_FILE)).toString())
		: []

	const allowedKeys: AllowedKey[] = []

	for (const { keyPath, bucketName } of keys) {
		const key = utils.parseKey(fs.readFileSync(keyPath))

		if (key instanceof Error) throw key

		allowedKeys.push({ key: Array.isArray(key) ? key[0] : key, bucketName })
	}

	console.log(allowedKeys)

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
