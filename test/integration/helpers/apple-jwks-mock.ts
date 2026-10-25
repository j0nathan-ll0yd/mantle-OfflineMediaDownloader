/**
 * Apple JWKS Mock Helper
 *
 * Mocks Apple's public key endpoint for testing Better Auth signInSocial.
 * An msw server intercepts requests to https://appleid.apple.com/auth/keys
 * and serves the public half of a test RSA key pair for JWT verification.
 * Tokens are signed RS256 with node:crypto.
 *
 * This allows integration tests to use real Better Auth code while only
 * mocking the external network call to Apple's JWKS endpoint.
 */

import {createSign, generateKeyPairSync, type KeyObject} from 'node:crypto'
import {http, HttpResponse} from 'msw'
import {type SetupServer, setupServer} from 'msw/node'

const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_JWKS_PATH = '/auth/keys'
const TEST_KEY_ID = 'omd-test-apple-key'
const RSA_MODULUS_BITS = 2048

/** A started JWKS mock: the msw server and the private key that signs test tokens */
interface AppleJWKSMock {
  server: SetupServer
  privateKey: KeyObject
}

// Singleton mock instance
let jwksMock: AppleJWKSMock | null = null

/**
 * Start the Apple JWKS mock server.
 * Must be called before any Better Auth operations in tests.
 *
 * @example
 * ```typescript
 * beforeAll(() => {
 *   startAppleJWKSMock()
 * })
 * ```
 */
export function startAppleJWKSMock(): void {
  if (jwksMock) {
    return
  }

  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: RSA_MODULUS_BITS})
  const jwks = {keys: [{...publicKey.export({format: 'jwk'}), alg: 'RS256', kid: TEST_KEY_ID, use: 'sig'}]}
  const server = setupServer(http.get(new URL(APPLE_JWKS_PATH, APPLE_ISSUER).href, () => HttpResponse.json(jwks)))
  server.listen({onUnhandledRequest: 'bypass'})

  jwksMock = {server, privateKey}
}

/**
 * Stop the Apple JWKS mock server.
 * Call in afterAll() to clean up.
 *
 * @example
 * ```typescript
 * afterAll(() => {
 *   stopAppleJWKSMock()
 * })
 * ```
 */
export function stopAppleJWKSMock(): void {
  jwksMock?.server.close()
  jwksMock = null
}

/**
 * Apple ID token claims structure.
 * These are the standard claims Apple includes in ID tokens.
 */
export interface AppleIdTokenClaims {
  /** User ID (Apple's unique identifier for this user) */
  sub: string
  /** User's email address */
  email: string
  /** Whether email is verified (defaults to true) */
  email_verified?: boolean | 'true' | 'false'
  /** Audience - typically the bundle ID or client ID */
  aud?: string
  /** Time at which user authenticated */
  auth_time?: number
  /** Whether nonce is supported */
  nonce_supported?: boolean
}

/**
 * Generate a mock Apple ID token for testing.
 *
 * Creates a properly-signed JWT that will validate against the mock JWKS.
 * The token includes Apple-specific claims required by Better Auth.
 *
 * @param claims - Custom claims to include in the token
 * @returns Signed JWT token string
 * @throws Error if mock is not started
 *
 * @example
 * ```typescript
 * const idToken = generateAppleIdToken({
 *   sub: 'apple-user-123',
 *   email: 'test@example.com',
 * })
 *
 * // Use in test request
 * const result = await loginHandler({body: JSON.stringify({idToken})}, context)
 * ```
 */
export function generateAppleIdToken(claims: AppleIdTokenClaims): string {
  if (!jwksMock) {
    throw new Error('Apple JWKS mock not started. Call startAppleJWKSMock() first.')
  }

  // Generate token with Apple-specific claims
  // Better Auth expects these claims for Apple Sign In verification
  return signRs256(jwksMock.privateKey, {
    iss: APPLE_ISSUER,
    sub: claims.sub,
    aud: claims.aud || 'com.example.app', // Default to test bundle ID
    email: claims.email,
    email_verified: claims.email_verified ?? true,
    auth_time: claims.auth_time ?? Math.floor(Date.now() / 1000),
    nonce_supported: claims.nonce_supported ?? true,
    // Standard JWT claims
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour expiry
  })
}

/** Encode a value as an unpadded base64url JSON segment */
function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Sign a compact RS256 JWS whose header names the mock JWKS key */
function signRs256(privateKey: KeyObject, payload: object): string {
  const signingInput = `${base64UrlJson({alg: 'RS256', typ: 'JWT', kid: TEST_KEY_ID})}.${base64UrlJson(payload)}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}
