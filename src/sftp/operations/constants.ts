import { constants } from 'fs'

export const MODE_FILE = constants.S_IFREG | constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO
export const MODE_DIR = constants.S_IFDIR | constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO
