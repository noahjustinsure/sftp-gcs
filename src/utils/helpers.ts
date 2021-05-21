import { AllowedKey, UserData } from '@/types'
import { utils } from 'ssh2-streams'
import fs from 'fs'

export function fileLongEntry(name: string, isDirectory: boolean, size: number, padding: number, created: unknown) {
	if (isDirectory) {
		size = 0
	}
	return `${isDirectory ? 'd' : '-'}rw-rw-rw- 1 none none ${String(size).padStart(padding)} ${created} ${name}`
} // fileLongEntry

export async function loadConfigData(
	userDataPath: string,
	keyDataPath: string
): Promise<{ allowedKeys: AllowedKey[]; userData: [string, UserData][] }> {
	// ! You should REALLY think of how you store these files,
	// ! because if this leaks you're screwed
	const userData = userDataPath ? JSON.parse((await fs.promises.readFile(userDataPath)).toString()) : []

	const keys: { keyPath: string; bucketName: string }[] = keyDataPath
		? JSON.parse((await fs.promises.readFile(keyDataPath)).toString())
		: []

	const allowedKeys: AllowedKey[] = []

	for (const { keyPath, bucketName } of keys) {
		const key = utils.parseKey(fs.readFileSync(keyPath))

		if (key instanceof Error) throw key

		allowedKeys.push({ key: Array.isArray(key) ? key[0] : key, bucketName })
	}

	return { userData, allowedKeys }
}
