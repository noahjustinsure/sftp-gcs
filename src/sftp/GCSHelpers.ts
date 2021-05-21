import { FileRecord, ReadMapProps } from '@/types'
import { Readable } from 'stream'

export const createGetGCSData = (
	readMap: Map<number, ReadMapProps>,
	fileRecord: FileRecord
): ((offset: number, requestedLength: number) => Promise<Map<number, ReadMapProps>>) => {
	return function (offset: number, requestedLength: number) {
		return new Promise((resolve, reject) => {
			readMap.set(offset, {
				offset,
				requestedLength,
				resolve,
				reject,
			})

			fileRecord.processQueue()
		})
	}
}

export const getProcessQueue = (
	gcsEnd: boolean,
	readMap: Map<number, ReadMapProps>,
	fileRecord: FileRecord,
	activeRead: ReadMapProps | null,
	gcsStream: Readable,
	gcsOffset: number
): (() => void) => {
	return function () {
		// If we have been asked to process the waiting for data queue and we have reached the EOF of the GCS stream
		// then the requests will never be fulfilled.  Resolve each of them with null indicating that we have no data.
		if (gcsEnd) {
			readMap.forEach((entry) => {
				readMap.delete(entry.offset)
				entry.resolve(null)
			})
			return
		}

		if (fileRecord.gcsError) {
			readMap.forEach((entry) => {
				readMap.delete(entry.offset)
				entry.reject(null)
			})
			return
		}

		while (true) {
			if (activeRead) {
				const data = gcsStream.read(activeRead.requestedLength)
				if (data === null) {
					return
				}
				activeRead.resolve(data)
				readMap.delete(activeRead.offset)
				activeRead = null
				gcsOffset += data.length
			}
			if (!readMap.has(gcsOffset)) {
				return
			}
			activeRead = readMap.get(gcsOffset)
		}
	}
}
