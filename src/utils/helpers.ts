export function fileLongEntry(name: string, isDirectory: boolean, size: number, padding: number, created: unknown) {
	if (isDirectory) {
		size = 0
	}
	return `${isDirectory ? 'd' : '-'}rw-rw-rw- 1 none none ${String(size).padStart(padding)} ${created} ${name}`
} // fileLongEntry
