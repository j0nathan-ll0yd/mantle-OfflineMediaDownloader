/**
 * Better Auth Helper Functions
 *
 * Utility functions for working with Better Auth sessions and tokens in Lambda functions.
 * These helpers bridge Better Auth's framework with our serverless architecture.
 */

import {getSessionByToken, updateSession} from '#entities/queries'
import {logDebug, logError} from '@j0nathan-ll0yd/observability'
import {UnauthorizedError} from '@j0nathan-ll0yd/errors'
import type {SessionPayload} from '#types/util'

// NOTE: This module is intentionally kept for the API Gateway authorizer, which uses
// direct DB queries by design for minimal cold-start latency. Other handlers (logout,
// refresh) use @j0nathan-ll0yd/auth helpers instead. See the BetterAuth review plan.

/**
 * Validates a session token and returns the session payload.
 *
 * @param token - The session token from Authorization header (without "Bearer " prefix)
 * @returns Session payload with userId and sessionId
 * @throws UnauthorizedError if token is invalid or expired
 */
export async function validateSessionToken(token: string): Promise<SessionPayload> {
  logDebug('validateSessionToken: validating token', {tokenLength: token.length, tokenPrefix: token.slice(0, 8)})

  // Use index for O(1) lookup
  const session = await getSessionByToken(token)

  if (!session) {
    logError('validateSessionToken: session not found', {tokenPrefix: token.slice(0, 8), tokenLength: token.length})
    throw new UnauthorizedError('Invalid session token')
  }

  // Compare Date objects - expiresAt is now a TIMESTAMP WITH TIME ZONE
  if (session.expiresAt < new Date()) {
    logError('validateSessionToken: session expired', {expiresAt: session.expiresAt.toISOString(), now: new Date().toISOString()})
    throw new UnauthorizedError('Session expired')
  }

  await updateSession(session.id, {updatedAt: new Date()})

  logDebug('validateSessionToken: session valid', {userId: session.userId, sessionId: session.id})

  return {userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt.getTime()}
}
