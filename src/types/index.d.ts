import { File } from '@google-cloud/storage'
import { ParsedKey } from 'ssh2-streams'
import { Writable } from 'stream'

export type AllowedKey = {
	key: ParsedKey
	bucketName: string
}

export type ReadMapProps = {
	offset: number
	requestedLength: number
	resolve: (value: Map<number, ReadMapProps> | PromiseLike<Map<number, ReadMapProps>>) => void
	reject: (x: any) => void
}

export interface FileRecord {
	handle: number
	path: string
	writeStream?: Writable
	gcsFile?: File
	gcsError?: boolean
	currentReqid?: number
	readComplete?: boolean
	getGCSData?: (offset: number, requestedLength: number) => Promise<Map<number, ReadMapProps>>
	processQueue?: () => void
}

export interface ConnectionOptions {
	isNoneAllowed: boolean
	defaultBucket: string
	allowedUsers: Map<string, UserData>
	allowedKeys: AllowedKey[]
	port: number
	ipPattern: string
	serviceAccountKeyFile: string
}

export interface UserData {
	password: string
	bucketName: string
}
