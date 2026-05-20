/**
 * ApiGatewayAuthorizer Dedicated Integration Tests
 *
 * Tests the API Gateway custom authorizer against real services:
 * - PostgreSQL: Session validation
 *
 * Workflow:
 * 1. Extract token from Authorization header
 * 2. Validate session in PostgreSQL via Better Auth
 * 3. Return IAM policy (Allow/Deny)
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'
process.env.MULTI_AUTHENTICATION_PATH_PARTS = 'auth/login,auth/register,webhooks/feedly'

import {afterAll, afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import type {Context} from 'aws-lambda'
import {createObservabilityMock} from '@mantleframework/testing/lambda-mocks'

// Test helpers
import {closeTestDb, createAllTables, getTestDbAsync, insertSession, insertUser, truncateAllTables} from '../helpers/postgres-helpers'
import {createMockContext} from '../helpers/lambda-context'
import {createMockAPIGatewayRequestAuthorizerEvent} from '../helpers/test-data'

// Mock API Gateway SDK functions - must use vi.hoisted for ESM
// Note: API Gateway rate limiting (getApiKeys, getUsagePlans, getUsage) must remain mocked
// because LocalStack API Gateway emulation has limitations for these features
const {getApiKeysMock, getUsagePlansMock, getUsageMock} = vi.hoisted(() => ({getApiKeysMock: vi.fn(), getUsagePlansMock: vi.fn(), getUsageMock: vi.fn()}))

vi.mock('@mantleframework/aws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantleframework/aws')>()
  return {...actual, getApiKeys: getApiKeysMock, getUsagePlans: getUsagePlansMock, getUsage: getUsageMock}
})

vi.mock('@mantleframework/observability', () => createObservabilityMock())

const {handler} = await import('#lambdas/standalone/ApiGatewayAuthorizer/index')

// Helper to set up standard API Gateway mocks
function setupApiGatewayMocks() {
  getApiKeysMock.mockResolvedValue({items: [{id: 'api-key-id-1', value: 'test-api-key', enabled: true}]})
  getUsagePlansMock.mockResolvedValue({items: [{id: 'usage-plan-id-1', name: 'Test Plan'}]})
  getUsageMock.mockResolvedValue({items: {'api-key-id-1': [[100, 50]]}})
}

describe('ApiGatewayAuthorizer Dedicated Integration Tests', () => {
  let mockContext: Context

  beforeAll(async () => {
    await getTestDbAsync()
    await createAllTables()
    mockContext = createMockContext()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await truncateAllTables()
  })

  afterAll(async () => {
    await truncateAllTables()
    await closeTestDb()
  })

  test('should allow access for valid session', async () => {
    setupApiGatewayMocks()
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const token = crypto.randomUUID()

    // Create real user and session in PostgreSQL
    await insertUser({userId, email: 'authorized@example.com', firstName: 'Authorized'})
    await insertSession({id: sessionId, userId, token, expiresAt: new Date(Date.now() + 3600000)})

    // Real session validation against PostgreSQL
    const result = await handler(createMockAPIGatewayRequestAuthorizerEvent({token}), mockContext)

    expect(result.principalId).toBe(userId)
    expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
  })

  test('should reject expired session with Unauthorized', async () => {
    // Expired tokens are invalid tokens — even on multi-auth paths, the
    // authorizer rejects them rather than silently falling back to anonymous.
    // This avoids masking client-side stale-token bugs.
    setupApiGatewayMocks()
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const token = crypto.randomUUID()

    // Create user with expired session in PostgreSQL
    await insertUser({userId, email: 'expired@example.com', firstName: 'Expired'})
    await insertSession({id: sessionId, userId, token, expiresAt: new Date(Date.now() - 3600000)}) // Expired 1 hour ago

    const event = createMockAPIGatewayRequestAuthorizerEvent({token, path: '/auth/login'})

    await expect(handler(event, mockContext)).rejects.toThrow('Unauthorized')
  })

  test('should return anonymous principal for missing Authorization header on multi-auth path', async () => {
    setupApiGatewayMocks()

    // Use a multi-auth path that doesn't require Authorization header
    const event = createMockAPIGatewayRequestAuthorizerEvent({path: '/auth/login'})
    delete event.headers?.Authorization

    const result = await handler(event, mockContext)

    expect(result.principalId).toBe('anonymous')
    expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
  })

  test('should throw Unauthorized for malformed token on protected path', async () => {
    setupApiGatewayMocks()
    const event = createMockAPIGatewayRequestAuthorizerEvent({token: 'invalid-token', path: '/resource'})
    event.headers = {...event.headers, Authorization: 'invalid-token'}

    await expect(handler(event, mockContext)).rejects.toThrow('Unauthorized')
  })

  test('should throw Unauthorized when session validation fails on protected path', async () => {
    setupApiGatewayMocks()
    // Use a token that doesn't exist in the database
    const token = crypto.randomUUID()

    const event = createMockAPIGatewayRequestAuthorizerEvent({token, path: '/resource'})

    // Real session validation will fail because token doesn't exist
    await expect(handler(event, mockContext)).rejects.toThrow('Unauthorized')
  })

  test('should allow access with valid session and include principalId', async () => {
    setupApiGatewayMocks()
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const token = crypto.randomUUID()

    // Create real user and session in PostgreSQL
    await insertUser({userId, email: 'principal@example.com', firstName: 'Principal'})
    await insertSession({id: sessionId, userId, token, expiresAt: new Date(Date.now() + 3600000)})

    // Real session validation against PostgreSQL
    const result = await handler(createMockAPIGatewayRequestAuthorizerEvent({token}), mockContext)

    expect(result.principalId).toBe(userId)
    expect(result.policyDocument.Statement[0]!.Effect).toBe('Allow')
  })
})
