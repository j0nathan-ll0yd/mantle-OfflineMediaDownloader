/**
 * Unit tests for ApiGatewayAuthorizer Lambda (custom authorizer)
 *
 * Tests API key validation, session token extraction, and policy generation.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/aws', () => ({getApiKeys: vi.fn(), getUsage: vi.fn(), getUsagePlans: vi.fn()}))

vi.mock('@mantleframework/core',
  () => ({
    defineAuthorizerHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    defineLambda: vi.fn(),
    UserStatus: {Authenticated: 'Authenticated', Anonymous: 'Anonymous'}
  }))

vi.mock('@mantleframework/env', () => ({
  getOptionalEnv: vi.fn((key: string, defaultVal: string) => {
    const envs: Record<string, string> = {RESERVED_CLIENT_IP: '104.1.88.244', NODE_ENV: 'staging'}
    return envs[key] ?? defaultVal
  }),
  getRequiredEnv: vi.fn((key: string) => {
    const envs: Record<string, string> = {MULTI_AUTHENTICATION_PATH_PARTS: 'device/register,device/event,files'}
    return envs[key] ?? 'mock-value'
  })
}))

vi.mock('@mantleframework/errors', () => {
  class UnexpectedError extends Error {
    statusCode = 500
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {UnexpectedError}
})

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => ({}))
  }))

vi.mock('#domain/auth/sessionService', () => ({validateSessionToken: vi.fn()}))

vi.mock('#errors/custom-errors', () => ({providerFailureErrorMessage: 'AWS request failed'}))

const {handler, generateAllow} = (await import('#lambdas/standalone/ApiGatewayAuthorizer/index.js')) as any
import {getApiKeys, getUsage, getUsagePlans} from '@mantleframework/aws'
import {validateSessionToken} from '#domain/auth/sessionService'
import {getOptionalEnv} from '@mantleframework/env'
import {metrics} from '@mantleframework/observability'

describe('ApiGatewayAuthorizer Lambda', () => {
  const methodArn = 'arn:aws:execute-api:us-west-2:123456789012:api-id/stage/GET/resource'
  const validApiKey = 'valid-api-key-12345'

  const makeEvent = (overrides: Record<string, unknown> = {}) => ({
    event: {path: '/files', requestContext: {identity: {sourceIp: '192.168.1.1'}}, ...overrides},
    headers: {} as Record<string, string | undefined>,
    queryStringParameters: {ApiKey: validApiKey} as Record<string, string>,
    methodArn
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getApiKeys).mockResolvedValue({items: [{id: 'key-1', value: validApiKey, enabled: true}], $metadata: {}})
    vi.mocked(getUsagePlans).mockResolvedValue({items: [{id: 'plan-1'}], $metadata: {}})
    vi.mocked(getUsage).mockResolvedValue({items: {'key-1': [[100, 50]]}, $metadata: {}})
  })

  describe('generateAllow', () => {
    it('should generate Allow policy with principalId', () => {
      const result = generateAllow('user-1', methodArn)

      expect(result.principalId).toBe('user-1')
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow')
      expect(result.policyDocument.Statement[0].Resource).toBe(methodArn)
      expect(result.policyDocument.Version).toBe('2012-10-17')
    })

    it('should include usageIdentifierKey when provided', () => {
      const result = generateAllow('user-1', methodArn, 'api-key-123')

      expect(result.usageIdentifierKey).toBe('api-key-123')
    })

    it('should include auth context when provided', () => {
      const result = generateAllow('user-1', methodArn, undefined, {userStatus: 'Authenticated'})

      expect(result.context).toEqual({userStatus: 'Authenticated'})
    })

    it('should default context to empty object', () => {
      const result = generateAllow('user-1', methodArn)

      expect(result.context).toEqual({})
    })
  })

  describe('API key validation', () => {
    it('should throw Unauthorized when no API key in query params', async () => {
      const event = makeEvent()
      event.queryStringParameters = {}

      await expect(handler(event)).rejects.toThrow('Unauthorized')
      expect(metrics.addMetric).toHaveBeenCalledWith('AuthorizationDenied', 'Count', 1)
    })

    it('should throw Unauthorized when query params are null', async () => {
      const event = makeEvent()
      event.queryStringParameters = null as never

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should throw Unauthorized when API key does not match', async () => {
      vi.mocked(getApiKeys).mockResolvedValue({items: [{id: 'key-1', value: 'different-key', enabled: true}], $metadata: {}})

      await expect(handler(makeEvent())).rejects.toThrow('Unauthorized')
    })

    it('should throw Unauthorized when API key is disabled', async () => {
      vi.mocked(getApiKeys).mockResolvedValue({items: [{id: 'key-1', value: validApiKey, enabled: false}], $metadata: {}})

      await expect(handler(makeEvent())).rejects.toThrow('Unauthorized')
    })

    it('should throw UnexpectedError when getApiKeys returns no items', async () => {
      vi.mocked(getApiKeys).mockResolvedValue({items: undefined, $metadata: {}})

      await expect(handler(makeEvent())).rejects.toThrow('AWS request failed')
    })

    it('should throw UnexpectedError when getApiKeys returns null', async () => {
      vi.mocked(getApiKeys).mockResolvedValue(null as never)

      await expect(handler(makeEvent())).rejects.toThrow('AWS request failed')
    })
  })

  describe('session token validation', () => {
    it('should return Allow with authenticated user when valid session token', async () => {
      const event = makeEvent()
      event.headers = {Authorization: 'Bearer valid-session-token'}
      vi.mocked(validateSessionToken).mockResolvedValue({userId: 'user-1', sessionId: 'sess-1', expiresAt: Date.now() + 86400000})

      const result = await handler(event)

      expect(result.principalId).toBe('user-1')
      expect(result.context).toEqual({userStatus: 'Authenticated'})
    })

    it('should throw Unauthorized for invalid Bearer token on non-multi-auth path', async () => {
      const event = makeEvent({path: '/protected-resource'})
      event.headers = {Authorization: 'Bearer invalid-token'}
      vi.mocked(validateSessionToken).mockRejectedValue(new Error('Invalid session'))

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should reject malformed Authorization header (no Bearer prefix)', async () => {
      const event = makeEvent({path: '/protected-resource'})
      event.headers = {Authorization: 'Basic abc123'}

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should throw Unauthorized when Authorization header missing on protected path', async () => {
      const event = makeEvent({path: '/protected-resource'})

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should allow anonymous access on multi-auth path without Authorization header', async () => {
      const event = makeEvent({path: '/files'})

      const result = await handler(event)

      expect(result.principalId).toBe('anonymous')
    })

    it('should allow anonymous access on device/register multi-auth path', async () => {
      const event = makeEvent({path: '/device/register'})

      const result = await handler(event)

      expect(result.principalId).toBe('anonymous')
    })

    it('should allow invalid token on multi-auth path (anonymous fallback)', async () => {
      const event = makeEvent({path: '/files'})
      event.headers = {Authorization: 'Bearer invalid-token'}
      vi.mocked(validateSessionToken).mockRejectedValue(new Error('Invalid session'))

      const result = await handler(event)

      expect(result.principalId).toBe('anonymous')
    })
  })

  describe('remote test request bypass', () => {
    it('should bypass auth for remote test requests in non-production', async () => {
      const event = makeEvent()
      event.event.requestContext = {identity: {sourceIp: '104.1.88.244'}}
      event.headers = {'User-Agent': 'localhost@lifegames'}

      const result = await handler(event)

      expect(result.principalId).toBe('123e4567-e89b-12d3-a456-426614174000')
      expect(metrics.addMetric).toHaveBeenCalledWith('AuthorizationSuccess', 'Count', 1)
    })

    it('should not bypass auth in production', async () => {
      vi.mocked(getOptionalEnv).mockImplementation((key: string, defaultVal: string) => {
        if (key === 'NODE_ENV') {
          return 'production'
        }
        if (key === 'RESERVED_CLIENT_IP') {
          return '104.1.88.244'
        }
        return defaultVal
      })
      const event = makeEvent({path: '/protected-resource'})
      event.event.requestContext = {identity: {sourceIp: '104.1.88.244'}}
      event.headers = {'User-Agent': 'localhost@lifegames'}

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should not bypass when IP does not match', async () => {
      const event = makeEvent({path: '/protected-resource'})
      event.event.requestContext = {identity: {sourceIp: '10.0.0.1'}}
      event.headers = {'User-Agent': 'localhost@lifegames'}

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })

    it('should not bypass when User-Agent does not match', async () => {
      const event = makeEvent({path: '/protected-resource'})
      event.event.requestContext = {identity: {sourceIp: '104.1.88.244'}}
      event.headers = {'User-Agent': 'Mozilla/5.0'}

      await expect(handler(event)).rejects.toThrow('Unauthorized')
    })
  })

  describe('usage data', () => {
    it('should fetch usage plans and usage data for valid API key', async () => {
      const event = makeEvent({path: '/files'})

      await handler(event)

      expect(getUsagePlans).toHaveBeenCalledWith({keyId: 'key-1'})
      expect(getUsage).toHaveBeenCalled()
    })

    it('should throw UnexpectedError when getUsagePlans returns no items', async () => {
      vi.mocked(getUsagePlans).mockResolvedValue({items: undefined, $metadata: {}})
      const event = makeEvent({path: '/files'})

      await expect(handler(event)).rejects.toThrow('AWS request failed')
    })

    it('should throw UnexpectedError when getUsage returns no items', async () => {
      vi.mocked(getUsage).mockResolvedValue({items: undefined, $metadata: {}})
      const event = makeEvent({path: '/files'})

      await expect(handler(event)).rejects.toThrow('AWS request failed')
    })
  })

  describe('metrics', () => {
    it('should track AuthorizationAttempt metric', async () => {
      const event = makeEvent({path: '/files'})

      await handler(event)

      expect(metrics.addMetric).toHaveBeenCalledWith('AuthorizationAttempt', 'Count', 1)
    })

    it('should track AuthorizationSuccess for authenticated user', async () => {
      const event = makeEvent()
      event.headers = {Authorization: 'Bearer valid-token'}
      vi.mocked(validateSessionToken).mockResolvedValue({userId: 'user-1', sessionId: 'sess-1', expiresAt: Date.now() + 86400000})

      await handler(event)

      expect(metrics.addMetric).toHaveBeenCalledWith('AuthorizationSuccess', 'Count', 1)
    })
  })
})
