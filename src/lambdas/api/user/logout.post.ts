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
import {expireSession, extractBearerToken} from '@mantleframework/auth'
import {buildValidatedResponse, defineLambda} from '@mantleframework/core'
import {UnauthorizedError} from '@mantleframework/errors'
import {logDebug, logInfo} from '@mantleframework/observability'
import {defineApiHandler} from '@mantleframework/validation'
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
