/**
 * ApiGatewayAuthorizer Lambda
 *
 * Custom authorizer for API Gateway using Better Auth sessions.
 * Validates session tokens and generates IAM policies.
 *
 * Trigger: API Gateway (custom authorizer, REQUEST type)
 */
import {defineAuthorizerHandler, defineLambda, UserStatus} from '@j0nathan-ll0yd/core'
import {addAnnotation, addMetadata, endSpan, logError, logInfo, metrics, MetricUnit, startSpan} from '@j0nathan-ll0yd/observability'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {validateSessionToken} from '#domain/auth/sessionService'
import {fetchApiKeys, fetchUsageData, fetchUsagePlans} from './helpers.js'
import {denyAuthorization, generateAllow, isRemoteTestRequest} from './helpers.js'

defineLambda({
  secrets: {AUTH_SECRET: 'platform.key'},
  staticEnvVars: {MULTI_AUTHENTICATION_PATH_PARTS: 'device/register,device/event,files', RESERVED_CLIENT_IP: '104.1.88.244'}
})

/**
 * Extract userId from an Authorization header containing a Bearer session token.
 * Returns undefined if the token is invalid or missing.
 */
async function getUserIdFromAuthenticationHeader(authorizationHeader: string): Promise<string | undefined> {
  const bearerRegex = /^Bearer [A-Za-z\d-_=.]+$/
  if (!authorizationHeader.match(bearerRegex)) {
    return
  }

  const keypair = authorizationHeader.split(' ')
  const token = keypair[1] ?? ''
  try {
    const payload = await validateSessionToken(token)
    return payload.userId
  } catch (err) {
    logError('invalid session token <=', {error: err instanceof Error ? err.message : String(err)})
    return
  }
}

const authorizer = defineAuthorizerHandler({operationName: 'ApiGatewayAuthorizer', type: 'request'})

export const handler = authorizer(async ({event, headers, queryStringParameters, methodArn}) => {
  metrics.addMetric('AuthorizationAttempt', MetricUnit.Count, 1)
  const span = startSpan('authorize-request')
  addAnnotation(span, 'path', event.path)

  if (!queryStringParameters || !('ApiKey' in queryStringParameters)) {
    denyAuthorization(span, 'No API key found')
  }

  const apiKeyValue = queryStringParameters.ApiKey
  const apiKeys = await fetchApiKeys()
  const matchedApiKey = apiKeys.filter((item) => item.value === apiKeyValue)
  if (matchedApiKey.length === 0) {
    denyAuthorization(span, 'API key is invalid')
  }

  const apiKey = matchedApiKey[0]!
  if (apiKey.enabled === false) {
    denyAuthorization(span, 'API key is disabled')
  }

  const sourceIp = event.requestContext.identity.sourceIp
  if (isRemoteTestRequest(headers as Record<string, string | undefined>, sourceIp)) {
    const fakeUserId = '123e4567-e89b-12d3-a456-426614174000'
    metrics.addMetric('AuthorizationSuccess', MetricUnit.Count, 1)
    addAnnotation(span, 'principalId', fakeUserId)
    addMetadata(span, 'testRequest', true)
    endSpan(span)
    return generateAllow(fakeUserId, methodArn, apiKeyValue, {userStatus: UserStatus.Authenticated})
  }

  const apiKeyId = apiKey.id as string
  const usagePlans = await fetchUsagePlans(apiKeyId)
  const usagePlanId = usagePlans[0]!.id as string
  const usageData = await fetchUsageData(apiKeyId, usagePlanId)
  logInfo('usageData =>', {usageData: JSON.stringify(usageData)})

  let principalId = 'anonymous'
  let userStatus: UserStatus = UserStatus.Anonymous
  const pathPart = event.path.slice(1)
  const multiAuthPaths = getRequiredEnv('MULTI_AUTHENTICATION_PATH_PARTS').split(',')

  // Framework normalizes headers to lowercase per HTTP/2 spec (C90).
  const authorizationHeader = headers?.authorization

  if (authorizationHeader !== undefined) {
    const maybeUserId = await getUserIdFromAuthenticationHeader(authorizationHeader)
    if (maybeUserId) {
      principalId = maybeUserId
      userStatus = UserStatus.Authenticated
    } else {
      // User sent an auth header but the session is invalid — deny auth regardless of path.
      // Multi-authentication paths allow no auth header, not an invalid one.
      denyAuthorization(span, 'session_invalid')
    }
  } else if (!multiAuthPaths.includes(pathPart)) {
    denyAuthorization(span, 'auth_header_missing')
  }

  metrics.addMetric('AuthorizationSuccess', MetricUnit.Count, 1)
  addAnnotation(span, 'principalId', principalId)
  addMetadata(span, 'success', true)
  endSpan(span)
  return generateAllow(principalId, methodArn, apiKeyValue, {userStatus})
})

export { generateAllow } from './helpers.js'
