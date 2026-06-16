/**
 * ApiGatewayAuthorizer Workflow Integration Tests
 *
 * Tests the session token validation and IAM policy generation.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'
process.env.MULTI_AUTHENTICATION_PATH_PARTS = 'files'

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'
import type {APIGatewayRequestAuthorizerEvent} from 'aws-lambda'
import {createMockContext} from '../../helpers/lambda-fixtures'
import {createObservabilityMock} from '@mantleframework/testing/lambda-mocks'

// Test helpers
import {closeTestDb, createAllTables, getTestDbAsync, insertSession, insertUser, truncateAllTables} from '../helpers/postgres-helpers'
import {createMockAPIGatewayRequestAuthorizerEvent} from '../helpers/test-data'

// Mock API Gateway vendor calls - must use vi.hoisted for ESM
// Note: API Gateway rate limiting must remain mocked due to LocalStack limitations
const {mockGetApiKeys, mockGetUsagePlans, mockGetUsage} = vi.hoisted(() => ({mockGetApiKeys: vi.fn(), mockGetUsagePlans: vi.fn(), mockGetUsage: vi.fn()}))

vi.mock('@mantleframework/aws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantleframework/aws')>()
  return {...actual, getApiKeys: mockGetApiKeys, getUsagePlans: mockGetUsagePlans, getUsage: mockGetUsage}
})

vi.mock('@mantleframework/observability', () => createObservabilityMock())

const {handler} = await import('#lambdas/standalone/ApiGatewayAuthorizer/index')

const TEST_API_KEY = 'test-api-key-12345'
const TEST_API_KEY_ID = 'test-key-id'
const TEST_USAGE_PLAN_ID = 'test-usage-plan'

// Helper to create authorizer event using factory - delegates to centralized factory
function createAuthorizerEvent(options: {path?: string; resource?: string; headers?: Record<string, string>} = {}): APIGatewayRequestAuthorizerEvent {
  // Extract token from Authorization header if present
  const authHeader = options.headers?.Authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined

  const baseEvent = createMockAPIGatewayRequestAuthorizerEvent({token, path: options.path ?? '/resource', apiKey: TEST_API_KEY})

  // Merge headers - the factory adds Authorization header if token is provided
  // For cases where we want custom headers (e.g., no auth, or Basic auth), override
  if (options.headers) {
    baseEvent.headers = {...baseEvent.headers, ...options.headers}
  }

  return baseEvent
}

const context = createMockContext({functionName: 'ApiGatewayAuthorizer'})

function setupApiGatewayMocks() {
  mockGetApiKeys.mockResolvedValue({items: [{id: TEST_API_KEY_ID, value: TEST_API_KEY, enabled: true}]})
  mockGetUsagePlans.mockResolvedValue({items: [{id: TEST_USAGE_PLAN_ID}]})
  mockGetUsage.mockResolvedValue({items: {[TEST_API_KEY_ID]: [[0, 100]]}})
}

describe('ApiGatewayAuthorizer Workflow Integration Tests', () => {
  beforeAll(async () => {
    await getTestDbAsync()
    await createAllTables()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    setupApiGatewayMocks()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await truncateAllTables()
  })

  afterAll(async () => {
    await closeTestDb()
  })

  describe('Session token validation', () => {
    test('should Allow when session token is valid and not expired', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const sessionToken = crypto.randomUUID()
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

      await insertUser({userId, email: 'valid@example.com', firstName: 'Valid'})
      await insertSession({id: sessionId, userId, token: sessionToken, expiresAt: oneHourFromNow})

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${sessionToken}`, 'User-Agent': 'iOS/17.0'}})
      const result = await handler(event, context)

      expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
      expect(result.principalId).toBe(userId)
      expect(result.usageIdentifierKey).toBe(TEST_API_KEY)
    })

    test('should throw Unauthorized when session token does not exist in database', async () => {
      const nonexistentToken = crypto.randomUUID()

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${nonexistentToken}`, 'User-Agent': 'iOS/17.0'}})
      await expect(handler(event, context)).rejects.toThrow('Unauthorized')
    })

    test('should throw Unauthorized when session token is expired', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const expiredToken = crypto.randomUUID()
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

      await insertUser({userId, email: 'expired@example.com', firstName: 'Expired'})
      await insertSession({id: sessionId, userId, token: expiredToken, expiresAt: oneHourAgo})

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${expiredToken}`, 'User-Agent': 'iOS/17.0'}})
      await expect(handler(event, context)).rejects.toThrow('Unauthorized')
    })

    test('should validate specific session token', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const sessionToken = crypto.randomUUID()
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

      await insertUser({userId, email: 'specific@example.com', firstName: 'Specific'})
      await insertSession({id: sessionId, userId, token: sessionToken, expiresAt: oneHourFromNow})

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${sessionToken}`, 'User-Agent': 'iOS/17.0'}})
      const result = await handler(event, context)

      expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
      expect(result.principalId).toBe(userId)
    })
  })

  describe('Multi-authentication paths', () => {
    test('should Allow multi-auth path without Authorization header', async () => {
      const event = createAuthorizerEvent({
        path: '/files',
        resource: '/files',
        headers: {'User-Agent': 'iOS/17.0'} // No Authorization header
      })

      const result = await handler(event, context)

      expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
      expect(result.principalId).toBe('anonymous')
    })

    test('should reject multi-auth path with invalid token (401 Unauthorized)', async () => {
      // Multi-auth paths accept missing tokens (anonymous) but explicitly REJECT
      // invalid ones. Silently falling back to anonymous on a bad token would
      // mask client-side stale-token bugs by returning default content.
      const invalidToken = crypto.randomUUID()

      const event = createAuthorizerEvent({path: '/files', resource: '/files', headers: {Authorization: `Bearer ${invalidToken}`, 'User-Agent': 'iOS/17.0'}})

      await expect(handler(event, context)).rejects.toThrow('Unauthorized')
    })

    test('should throw Unauthorized on non-multi-auth path without Authorization header', async () => {
      const event = createAuthorizerEvent({
        path: '/protected',
        resource: '/protected',
        headers: {'User-Agent': 'iOS/17.0'} // No Authorization header
      })

      await expect(handler(event, context)).rejects.toThrow('Unauthorized')
    })
  })

  describe('Token format validation', () => {
    test('should throw Unauthorized for malformed Authorization header (not Bearer format)', async () => {
      const event = createAuthorizerEvent({headers: {Authorization: 'Basic invalid-format', 'User-Agent': 'iOS/17.0'}})

      await expect(handler(event, context)).rejects.toThrow('Unauthorized')
    })

    test('should handle valid session with complex token format', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      // Use a JWT-like token (contains dots and hyphens)
      const sessionToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

      await insertUser({userId, email: 'jwt@example.com', firstName: 'JWT'})
      await insertSession({id: sessionId, userId, token: sessionToken, expiresAt: oneHourFromNow})

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${sessionToken}`, 'User-Agent': 'iOS/17.0'}})
      const result = await handler(event, context)

      expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
      expect(result.principalId).toBe(userId)
    })
  })

  describe('Multiple sessions per user', () => {
    test('should validate specific token when user has multiple sessions', async () => {
      const userId = crypto.randomUUID()
      const sessionId1 = crypto.randomUUID()
      const sessionId2 = crypto.randomUUID()
      const token1 = crypto.randomUUID()
      const token2 = crypto.randomUUID()
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

      await insertUser({userId, email: 'multi@example.com', firstName: 'Multi'})
      await insertSession({id: sessionId1, userId, token: token1, expiresAt: oneHourFromNow})
      await insertSession({id: sessionId2, userId, token: token2, expiresAt: oneHourFromNow})

      const event = createAuthorizerEvent({headers: {Authorization: `Bearer ${token2}`, 'User-Agent': 'iOS/17.0'}})
      const result = await handler(event, context)

      expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
      expect(result.principalId).toBe(userId)
    })
  })
})
