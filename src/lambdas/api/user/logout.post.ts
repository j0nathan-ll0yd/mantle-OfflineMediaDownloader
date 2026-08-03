/**
 * LogoutUser Lambda
 *
 * Invalidates the user's current session by expiring it (setting expiresAt to now).
 * Uses BetterAuth to validate the session, then expires it while preserving the row
 * for the scheduled cleanup Lambda.
 *
 * Trigger: API Gateway POST /user/logout
 * Input: Authorization Bearer header
 * Output: 204 No Content on success
 */
import {expireSession, extractBearerToken} from '@j0nathan-ll0yd/auth'
import {buildValidatedResponse, defineLambda} from '@j0nathan-ll0yd/core'
import {UnauthorizedError} from '@j0nathan-ll0yd/errors'
import {logDebug, logInfo} from '@j0nathan-ll0yd/observability'
import {defineApiHandler} from '@j0nathan-ll0yd/validation'
import {getDrizzleClient} from '#db/client'
import {getAuthInstance} from '#domain/auth/authInstance'

defineLambda({secrets: {AUTH_SECRET: 'platform.key'}})

const api = defineApiHandler({auth: 'authorizer', operationName: 'LogoutUser'})
export const handler = api(async ({event, context, userId}) => {
  const token = extractBearerToken(event.headers?.['authorization'])
  if (!token) {
    throw new UnauthorizedError('Missing Authorization header')
  }

  // Expire the session via BetterAuth (validates then sets expiresAt = now, preserving row)
  logDebug('LogoutUser: expiring session via BetterAuth')
  const auth = await getAuthInstance()
  const db = await getDrizzleClient()
  await expireSession(auth, token, db)

  logInfo('LogoutUser: session expired successfully', {userId})

  return buildValidatedResponse(context, 204)
})
