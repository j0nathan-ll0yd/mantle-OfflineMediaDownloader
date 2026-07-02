// covers: custom-authorizer#invalid-session-denies-not-anonymous
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as AuthorizerMod from '#lambdas/standalone/ApiGatewayAuthorizer/index.js'

vi.mock('@mantleframework/core',
  () => ({
    defineAuthorizerHandler: vi.fn(() => (fn: (...args: unknown[]) => unknown) => fn),
    defineLambda: vi.fn(),
    UserStatus: {Anonymous: 'Anonymous', Authenticated: 'Authenticated'}
  }))

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    MetricUnit: {Count: 'Count'},
    metrics: {addMetric: vi.fn()},
    startSpan: vi.fn().mockReturnValue({})
  }))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn().mockReturnValue('device/register,device/event,files')}))

vi.mock('#domain/auth/sessionService', () => ({validateSessionToken: vi.fn()}))

vi.mock('../../../src/lambdas/standalone/ApiGatewayAuthorizer/helpers.js', () => ({
  denyAuthorization: vi.fn().mockImplementation(() => {
    throw new Error('Unauthorized')
  }),
  fetchApiKeys: vi.fn(),
  fetchUsageData: vi.fn(),
  fetchUsagePlans: vi.fn(),
  generateAllow: vi.fn().mockReturnValue({
    context: {userStatus: 'Authenticated'},
    policyDocument: {Statement: [], Version: '2012-10-17'},
    principalId: 'user-test'
  }),
  isRemoteTestRequest: vi.fn().mockReturnValue(false)
}))

const {handler} = (await import('#lambdas/standalone/ApiGatewayAuthorizer/index.js')) as unknown as MockedModule<typeof AuthorizerMod>

import {
  denyAuthorization,
  fetchApiKeys,
  fetchUsageData,
  fetchUsagePlans,
  generateAllow
} from '../../../src/lambdas/standalone/ApiGatewayAuthorizer/helpers.js'
import {validateSessionToken} from '#domain/auth/sessionService'

const VALID_API_KEY = {enabled: true, id: 'key-id-1', name: 'Test Key', value: 'test-api-key-value'}
const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api-id/stage/GET/protected'

function makeAuthorizerArgs(overrides: Record<string, unknown> = {}) {
  return {
    event: {path: '/protected', requestContext: {identity: {sourceIp: '192.168.1.1'}}},
    headers: {authorization: 'Bearer valid-token-abc123'},
    methodArn: METHOD_ARN,
    queryStringParameters: {ApiKey: VALID_API_KEY.value},
    ...overrides
  }
}

describe('ApiGatewayAuthorizer — invalid session handling', () => {
  beforeEach(() => {
    vi.mocked(fetchApiKeys).mockResolvedValue([VALID_API_KEY])
    vi.mocked(fetchUsagePlans).mockResolvedValue([{id: 'plan-id-1', name: 'Default'}])
    vi.mocked(fetchUsageData).mockResolvedValue([[100, 200]])
  })

  it('denies authorization when a Bearer token is invalid, refusing to fall back to anonymous access', async () => {
    vi.mocked(validateSessionToken).mockRejectedValue(new Error('token expired'))

    await expect(handler(makeAuthorizerArgs())).rejects.toThrow('Unauthorized')
    expect(denyAuthorization).toHaveBeenCalledWith(expect.anything(), 'session_invalid')
    expect(generateAllow).not.toHaveBeenCalled()
  })
})
