/**
 * RefreshToken Workflow Integration Tests
 *
 * Tests the session refresh workflow including token validation,
 * session extension, and error handling.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import type {Context} from 'aws-lambda'
import {createObservabilityMock} from '@j0nathan-ll0yd/testing/lambda-mocks'

vi.mock('@j0nathan-ll0yd/observability', () => createObservabilityMock())

// Test helpers
import {closeTestDb, createAllTables, getSessionById, getTestDbAsync, insertSession, insertUser, truncateAllTables} from '../helpers/postgres-helpers'
import {createMockContext} from '../helpers/lambda-context'
import {createMockAPIGatewayProxyEvent} from '../helpers/test-data'

const {handler} = await import('#lambdas/api/user/refresh.post')

describe('RefreshToken Workflow Integration Tests', () => {
  let mockContext: Context

  beforeAll(async () => {
    await getTestDbAsync()
    await createAllTables()
    mockContext = createMockContext()
  }, 120_000)

  afterEach(async () => {
    await truncateAllTables()
  })

  afterAll(async () => {
    await closeTestDb()
  })

  test('should successfully refresh a valid session', async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const originalExpiry = new Date(Date.now() + 60000) // Expires in 1 minute

    await insertUser({userId, email: 'refresh@example.com', firstName: 'Refresh'})
    await insertSession({id: sessionId, userId, token, expiresAt: originalExpiry})

    const result = await handler(createMockAPIGatewayProxyEvent({path: '/auth/refresh', httpMethod: 'POST', headers: {authorization: `Bearer ${token}`}}),
      mockContext)

    expect(result.statusCode).toBe(200)
    const response = JSON.parse(result.body)
    expect(response.token).toBe(token)
    expect(response.sessionId).toBe(sessionId)
    expect(response.userId).toBe(userId)

    // Verify expiration was extended (should be ~30 days from now)
    const thirtyDaysFromNow = Date.now() + 29 * 24 * 60 * 60 * 1000 // 29 days minimum
    expect(new Date(response.expiresAt).getTime()).toBeGreaterThan(thirtyDaysFromNow)

    // Verify database was updated
    const updatedSession = await getSessionById(sessionId)
    expect(updatedSession).not.toBeNull()
    expect(updatedSession!.expiresAt.getTime()).toBeGreaterThan(thirtyDaysFromNow)
  })

  test('should return 401 when Authorization header is missing', async () => {
    const result = await handler(createMockAPIGatewayProxyEvent({path: '/auth/refresh', httpMethod: 'POST'}), mockContext)

    expect(result.statusCode).toBe(401)
    const response = JSON.parse(result.body)
    expect(response.error).toBeDefined()
  })

  test('should return 401 for invalid token format', async () => {
    const result = await handler(
      createMockAPIGatewayProxyEvent({path: '/auth/refresh', httpMethod: 'POST', headers: {authorization: 'invalid-token-format'}}),
      mockContext
    )

    expect(result.statusCode).toBe(401)
  })

  test('should return 401 when session is expired', async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const expiredTime = new Date(Date.now() - 60000) // Expired 1 minute ago

    await insertUser({userId, email: 'expired@example.com'})
    await insertSession({id: sessionId, userId, token, expiresAt: expiredTime})

    const result = await handler(createMockAPIGatewayProxyEvent({path: '/auth/refresh', httpMethod: 'POST', headers: {authorization: `Bearer ${token}`}}),
      mockContext)

    expect(result.statusCode).toBe(401)
  })

  test('should return 401 when session does not exist', async () => {
    const nonExistentToken = crypto.randomUUID()

    const result = await handler(
      createMockAPIGatewayProxyEvent({path: '/auth/refresh', httpMethod: 'POST', headers: {authorization: `Bearer ${nonExistentToken}`}}),
      mockContext
    )

    expect(result.statusCode).toBe(401)
  })
})
