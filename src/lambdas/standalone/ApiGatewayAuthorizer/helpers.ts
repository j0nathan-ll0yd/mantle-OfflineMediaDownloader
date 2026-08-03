/**
 * API Gateway Authorizer Helpers (Tier 2)
 *
 * Combined helper functions for the API Gateway custom authorizer Lambda.
 * Handles authorization denial, policy generation, remote test detection,
 * and API key/usage plan lookups.
 *
 * @see ADR-0012 for the three-tier handler decomposition policy
 */
import type {APIGatewayAuthorizerResult} from 'aws-lambda'
import {getApiKeys, getUsage, getUsagePlans} from '@j0nathan-ll0yd/aws'
import {getOptionalEnv} from '@j0nathan-ll0yd/env'
import {UnexpectedError} from '@j0nathan-ll0yd/errors'
import {addMetadata, endSpan, logDebug, logInfo, metrics, MetricUnit} from '@j0nathan-ll0yd/observability'
import type {startSpan} from '@j0nathan-ll0yd/observability'
import {providerFailureErrorMessage} from '#errors/custom-errors'

// --- Authorizer Service ---

/** Deny authorization with metrics and tracing, then throw */
export function denyAuthorization(span: ReturnType<typeof startSpan>, reason: string): never {
  logInfo(reason)
  metrics.addMetric('AuthorizationDenied', MetricUnit.Count, 1)
  addMetadata(span, 'reason', reason)
  endSpan(span)
  throw new Error('Unauthorized')
}

/** Generates an Allow policy for API Gateway authorization. */
export function generateAllow(
  principalId: string,
  resource: string,
  usageIdentifierKey?: string,
  authContext: Record<string, string> = {}
): APIGatewayAuthorizerResult {
  return {
    context: authContext,
    policyDocument: {Statement: [{Action: 'execute-api:Invoke', Effect: 'Allow', Resource: resource}], Version: '2012-10-17'},
    principalId,
    usageIdentifierKey
  }
}

/** Checks if the request is from a reserved IP for remote testing. SECURITY: Disabled in production. */
export function isRemoteTestRequest(headers: Record<string, string | undefined>, sourceIp: string): boolean {
  if (getOptionalEnv('NODE_ENV', '') === 'production') {
    return false
  }
  const reservedIp = getOptionalEnv('RESERVED_CLIENT_IP', '')
  if (!reservedIp) {
    return false
  }
  const userAgent = headers['user-agent']
  logDebug('isRemoteTestRequest <=', {reservedIp, userAgent, clientIp: sourceIp})
  return sourceIp === reservedIp && userAgent === 'localhost@lifegames'
}

// --- Key Service ---

type GetApiKeysResult = Awaited<ReturnType<typeof getApiKeys>>
type GetUsagePlansResult = Awaited<ReturnType<typeof getUsagePlans>>

/** Individual API key record from API Gateway */
export type ApiKey = NonNullable<GetApiKeysResult['items']>[number]

/** Usage plan record from API Gateway */
export type UsagePlan = NonNullable<GetUsagePlansResult['items']>[number]

/**
 * Returns an array of ApiKeys for API Gateway.
 *
 * @returns Array of API keys with their values
 */
export async function fetchApiKeys(): Promise<ApiKey[]> {
  const params = {includeValues: true}
  logDebug('fetchApiKeys <=', params)
  const response = await getApiKeys(params)
  logDebug('fetchApiKeys =>', {itemCount: response?.items?.length ?? 0})
  if (!response || !response.items) {
    throw new UnexpectedError(providerFailureErrorMessage)
  }
  return response.items
}

/**
 * Returns an array of UsagePlans for a given APIKey.
 *
 * @param keyId - The API key ID to fetch usage plans for
 * @returns Array of usage plans associated with the API key
 */
export async function fetchUsagePlans(keyId: string): Promise<UsagePlan[]> {
  const params = {keyId}
  logDebug('fetchUsagePlans <=', params)
  const response = await getUsagePlans(params)
  logDebug('fetchUsagePlans =>', {itemCount: response?.items?.length ?? 0})
  if (!response || !response.items) {
    throw new UnexpectedError(providerFailureErrorMessage)
  }
  return response.items
}

/**
 * Returns usage data by day for a given APIKey and UsagePlan.
 *
 * @param keyId - The API key ID
 * @param usagePlanId - The usage plan ID
 * @returns Usage data for the current day
 */
export async function fetchUsageData(keyId: string, usagePlanId: string) {
  const usageDate = new Date().toISOString().split('T')[0] ?? new Date().toISOString()
  logDebug('getUsage <=', {usagePlanId, keyId, usageDate})
  const response = await getUsage(usagePlanId, keyId, usageDate, usageDate)
  logDebug('getUsage =>', {hasItems: !!response?.items})
  if (!response || !response.items) {
    throw new UnexpectedError(providerFailureErrorMessage)
  }
  return response.items[keyId]
}
