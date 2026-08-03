/**
 * Shared BetterAuth instance factory for Lambda handlers.
 *
 * Provides a cached auth instance with the media downloader's schema and config.
 * Use this for session validation, expiry, and refresh — NOT for the API Gateway
 * authorizer, which uses direct DB queries by design for minimal cold-start latency.
 */
import {getAuth} from '@j0nathan-ll0yd/auth'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {getDrizzleClient} from '#db/client'
import {accounts, sessions, users, verification} from '#db/schema'

/**
 * Return the cached BetterAuth instance, initializing on first call.
 *
 * Social providers are not configured here — they are only needed for login/register
 * which configure them inline. This helper is for session operations (validate, expire, refresh).
 */
export async function getAuthInstance() {
  return getAuth(getDrizzleClient, {
    secret: getRequiredEnv('AUTH_SECRET'),
    baseURL: getRequiredEnv('AUTH_BASE_URL'),
    schema: {user: users, session: sessions, account: accounts, verification}
  })
}
