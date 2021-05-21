import winston, { format, Logger } from 'winston'
import { LoggingWinston } from '@google-cloud/logging-winston'

export const createLogger = (debug = process.env.DEBUG_LEVEL || 'info'): Logger =>
	winston.createLogger({
		level: debug,

		transports: [
			new winston.transports.Console(),
			new LoggingWinston({
				logName: 'sftp-gcs',
				keyFile: process.env.KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS,
			}),
		],

		format: format.combine(
			format.label({ label: 'sftp-gcs', message: true }),
			format.timestamp(),
			format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
		),
	})
