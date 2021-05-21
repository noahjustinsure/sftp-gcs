import { AuthContext, PasswordAuthContext, PublicKeyAuthContext, utils } from 'ssh2'
import fs from 'fs'
import { createLogger } from '../utils/Logger'
import { Logger } from 'winston'
import { ConnectionClient } from './ConnectionClient'
import { inspect } from 'util'
import { ParsedKey } from 'ssh2-streams'
import { timingSafeEqual } from 'crypto'
import { ConnectionOptions, UserData } from '@/types'

export class Authenticator {
	#allowedUsers: Map<string, UserData>
	#allowedKeys: { key: ParsedKey; bucketName: string }[]
	#logger: Logger

	bucketName: string

	constructor(private connection: ConnectionClient, options: ConnectionOptions) {
		this.#logger = createLogger()
		this.#allowedUsers = options.allowedUsers
		this.#allowedKeys = options.allowedKeys

		for (const { path, bucketName } of JSON.parse(process.env.PUBLIC_KEYS || '[]')) {
			const key = utils.parseKey(fs.readFileSync(path))

			if (key instanceof Error) throw key

			this.#allowedKeys.push({ key: Array.isArray(key) ? key[0] : key, bucketName })
		}
	}

	/**
	 * ctx.username - The identity of the user asking to be authenticated,
	 * ctx.method - How is the request being asked to authenticate?
	 * password - ctx.password contains the password.
	 * publickey - ctx.key, ctx.signature, ctx.blob
	 *  We must either call ctx.reject() or ctx.accept()
	 * @param ctx Auth context
	 */
	public handleAuthentication(ctx: AuthContext): void {
		this.#logger.debug(`authentication: method=${ctx.method}`)

		switch (ctx.method) {
			case 'none':
				return this.handleNoneAuthentication(ctx)

			case 'password':
				return this.handlePasswordAuthentication(ctx)

			case 'publickey':
				return this.handlePublicKeyAuthentication(ctx)
			default:
				return ctx.reject()
		}

		ctx.reject() // We should never reach here!!
	}

	/**
	 * Handles the logic when not priovided with any authentication method
	 * @param ctx The authentication context
	 */
	private handleNoneAuthentication(ctx: AuthContext): void {
		// * Deny if explicitly forbidden
		if (!this.connection.options.isNoneAllowed) return ctx.reject(['password', 'publickey'], true)
		else if (this.#allowedUsers.size > 0) {
			this.#logger.debug(`We have at least a user to match`)
			return ctx.reject(['password', 'publickey'], true)
		} else if (this.#allowedKeys.length > 0) {
			this.#logger.debug(`We want a public key exchange`)
			// The following code lifted as a solution to this issue:
			// https://github.com/mscdex/ssh2/issues/235 for SSH2.
			return ctx.reject(['password', 'publickey'], true)
		}

		this.bucketName = this.connection.options.defaultBucket

		return ctx.accept() // No userid and no password and no public key, come on in!
	}

	/**
	 * Handles the username/password logic for authentication
	 * @param ctx The authentication context
	 * @returns void
	 */
	private handlePasswordAuthentication(ctx: PasswordAuthContext): void {
		const password = ctx.password || ''

		if (!ctx.username || !password) return ctx.reject(['publickey'], true)

		const registeredUser = this.#allowedUsers.get(ctx.username)

		if (registeredUser && registeredUser.password === password) {
			this.bucketName = registeredUser.bucketName
			return ctx.accept()
		}

		ctx.reject()
	}

	/**
	 * Handles the logic for authentication with public key file
	 * @param ctx Authentication context
	 * @returns void
	 */
	private handlePublicKeyAuthentication(ctx: PublicKeyAuthContext): void {
		this.#logger.debug(`key: ${inspect(ctx.key)}, signature: ${inspect(ctx.signature)}`)

		if (this.#allowedKeys.length < 1 || !ctx.key) {
			this.#logger.debug(`No PubKey or no key provided in request`)
			return ctx.reject(['password'], true)
		}

		const matchingKey = this.#allowedKeys.find(({ key }) => {
			const publicKey = key.getPublicSSH()

			return (
				ctx.key.algo === key.type &&
				ctx.key.data.length === publicKey.length &&
				timingSafeEqual(ctx.key.data, publicKey as any) && // TODO: Check why publickey is string?
				ctx.signature &&
				key.verify(ctx.blob, ctx.signature) === true
			)
		})

		if (matchingKey) {
			this.bucketName = matchingKey.bucketName
			return ctx.accept()
		}

		return ctx.reject()
	}
}
