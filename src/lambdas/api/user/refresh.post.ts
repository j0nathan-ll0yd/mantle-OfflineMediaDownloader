/**
 * RefreshToken Lambda
 *
 * Refreshes a user session by validating it through BetterAuth.
 * BetterAuth's getSession() automatically extends the session when the
 * updateAge threshold has elapsed, so no manual expiry extension is needed.
 *
 * Trigger: API Gateway POST /user/refresh
 * Input: Authorization Bearer header
 * Output: APIGatewayProxyResult with refreshed session info
 */
import {extractBearerToken, validateSession} from '@mantleframework/auth'
import {buildValidatedResponse, defineLambda} from '@mantleframework/core'
import {UnauthorizedError} from '@mantleframework/errors'
import {logDebug, logInfo} from '@mantleframework/observability'
import {defineApiHandler} from '@mantleframework/validation'
import {getAuthInstance} from '#domain/auth/authInstance'
import {userLoginResponseSchema} from '#types/api-schema'

defineLambda({secrets: {AUTH_SECRET: 'platform.key'}})

const api = defineApiHandler({auth: 'authorizer', operationName: 'RefreshToken'})
export const handler = api(async ({event, context}) => {
  const token = extractBearerToken(event.headers?.['authorization'])
  if (!token) {
    throw new UnauthorizedError('Missing Authorization header')
  }

  // Validate and refresh via BetterAuth — getSession() auto-extends when updateAge elapsed
  logDebug('RefreshToken: validating session via BetterAuth')
  const auth = await getAuthInstance()
  const sessionResult = await validateSession(auth, token)

  const responseData = {
    token, // Same token, BetterAuth extended the expiry internally
    expiresAt: sessionResult.session.expiresAt.toISOString(),
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id
  }

  logInfo('RefreshToken: session refreshed successfully', {sessionId: sessionResult.session.id})

  return buildValidatedResponse(context, 200, responseData, userLoginResponseSchema)
})
