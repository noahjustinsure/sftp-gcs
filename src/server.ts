import ssh2 from 'ssh2'
import fs from 'fs'
import { createLogger } from './utils/Logger'
import { ConnectionClient } from './ssh/ConnectionClient'
import { ConnectionOptions } from '@/types'

/**
 * We need a host key to be used to identify our server.  We will look for such a key in a few places.
 *
 * Our algorithm will be:
 *
 * ---
 * if (/etc/ssh/ssh_host_rsa_key exists) {
 *   if (we can read the file) {
 *     Return the content as a host key
 *   }
 *   Warn that we found the file but could not read it.
 * }
 * Warn that we are going to use a default host key
 * return the common host key.
 * ---
 */
function getHostKey() {
	const logger = createLogger()

	if (fs.existsSync('/etc/ssh/ssh_host_rsa_key')) {
		try {
			return fs.readFileSync('/etc/ssh/ssh_host_rsa_key')
		} catch (err) {
			logger.warn(`Unable to read /etc/ssh/ssh_host_rsa_key even though it exists.`)
		}
	}
	logger.warn(`Unable to find/access a system host key, using the application default host key.`)
	return fs.readFileSync('keys/default_host.key')
}

export const createServer = (options: ConnectionOptions): ssh2.Server => {
	return new ssh2.Server(
		{
			hostKeys: [getHostKey()],
			greeting: 'SFTP-GCS demon',
			banner: 'SFTP-GCS demon',
		},
		(connection) => new ConnectionClient(connection, options)
	)
}
