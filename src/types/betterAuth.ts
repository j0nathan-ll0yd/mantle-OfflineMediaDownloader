/**
 * Better Auth type utilities
 *
 * These types are extracted from Better Auth's API for use in tests and type-safe code.
 */

import type {BetterAuthInstance} from '@j0nathan-ll0yd/auth'

/**
 * Parameters for Better Auth's signInSocial API method.
 * Extracted from the actual Better Auth instance to ensure type safety.
 */
export type SignInSocialParams = Parameters<BetterAuthInstance['api']['signInSocial']>[0]

/**
 * Base user shape returned by Better Auth.
 * Matches the `User` base type from `better-auth`.
 */
export interface BetterAuthUser {
  id: string
  email: string
  emailVerified: boolean
  name: string
  image?: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

/**
 * Base session shape returned by Better Auth.
 * Matches the `Session` base type from `better-auth`.
 */
export interface BetterAuthSession {
  id: string
  token: string
  userId: string
  expiresAt: Date | string
  createdAt: Date | string
  updatedAt: Date | string
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Token-bearing result from Better Auth's signInSocial API method (ID token / non-redirect flow).
 * The other branch of the union is `{ redirect: true; url: string }` for OAuth redirect flows,
 * which is not used in the Lambda ID-token flow.
 */
export interface SignInSocialTokenResult {
  redirect: boolean
  token: string
  url: undefined
  user: BetterAuthUser
}

/**
 * Redirect result from Better Auth's signInSocial API method.
 * Returned when an OAuth redirect flow is triggered instead of returning a token directly.
 */
export interface SignInSocialRedirectResult {
  redirect: boolean
  url: string
}

/**
 * Union of both possible signInSocial return shapes.
 */
export type SignInSocialResult = SignInSocialTokenResult | SignInSocialRedirectResult

/**
 * Result from Better Auth's getSession API method.
 * Returns null when no valid session is found.
 */
export interface GetSessionResult {
  session: BetterAuthSession
  user: BetterAuthUser
}
