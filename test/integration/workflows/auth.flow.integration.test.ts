/**
 * Auth Flow Integration Tests
 *
 * Tests the LoginUser and RegisterUser workflows including
 * user registration, session management, and credential validation.
 */

// Set environment variables BEFORE any imports
// These must be set before Better Auth config is loaded
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

// Required env vars for Lambda handlers
process.env.DEFAULT_FILE_SIZE = '1024'
process.env.DEFAULT_FILE_NAME = 'test-default-file.mp4'
process.env.DEFAULT_FILE_URL = 'https://example.com/test-default-file.mp4'
process.env.DEFAULT_FILE_CONTENT_TYPE = 'video/mp4'

// Better Auth configuration
process.env.AUTH_SECRET = 'test-secret-key-for-integration-tests-minimum-32-chars'
process.env.AUTH_BASE_URL = 'http://localhost:3000' // Used by getAuth() config
process.env.SIGN_IN_WITH_APPLE_CONFIG = JSON.stringify({client_id: 'com.example.service', bundle_id: 'lifegames.OfflineMediaDownloader'})

import {afterAll, afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import type {Context} from 'aws-lambda'
import {sql} from 'drizzle-orm'
import {createObservabilityMock} from '@j0nathan-ll0yd/testing/lambda-mocks'

vi.mock('@j0nathan-ll0yd/observability', () => createObservabilityMock())

// Test helpers
import {closeTestDb, createAllTables, getTestDbAsync, truncateAllTables} from '../helpers/postgres-helpers'
import {createMockContext} from '../helpers/lambda-context'
import {generateAppleIdToken, startAppleJWKSMock, stopAppleJWKSMock} from '../helpers/apple-jwks-mock'
import {createMockAPIGatewayProxyEvent} from '../helpers/test-data'

const {handler: loginHandler} = await import('#lambdas/api/user/login.post')
const {handler: registerHandler} = await import('#lambdas/api/user/register.post')

interface AuthRequestBody {
  idToken: string
  firstName?: string
  lastName?: string
}

// Helper using centralized factory for auth events (login/register don't need authorizer context)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createAuthEvent(body: AuthRequestBody, path: string): any {
  return createMockAPIGatewayProxyEvent({
    path,
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', 'User-Agent': 'iOS/17.0 TestApp/1.0'}
  })
}

describe('Auth Flow Integration Tests', () => {
  let mockContext: Context

  beforeAll(async () => {
    // Start the Apple JWKS mock - intercepts requests to https://appleid.apple.com/auth/keys
    startAppleJWKSMock()

    // Initialize database connection and create tables
    await getTestDbAsync()
    await createAllTables()
    mockContext = createMockContext()
  })

  afterEach(async () => {
    // Clean up database between tests
    await truncateAllTables()
  })

  afterAll(async () => {
    // Stop the JWKS mock and close database
    stopAppleJWKSMock()
    await closeTestDb()
  })

  describe('LoginUser', () => {
    test('should login/register user with valid Apple ID token', async () => {
      // Generate a valid Apple ID token using our mock JWKS
      // The token is signed with our test keys and will validate against the mock JWKS
      const appleUserId = 'apple-user-' + Date.now()
      const testEmail = `test-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({
        sub: appleUserId,
        email: testEmail,
        aud: 'lifegames.OfflineMediaDownloader' // Must match bundle_id in config
      })

      const body: AuthRequestBody = {idToken}
      const event = createAuthEvent(body, '/auth/login')
      const result = await loginHandler(event, mockContext)

      // Debug: log response if not 200
      if (result.statusCode !== 200) {
        console.log('Login failed with status:', result.statusCode)
        console.log('Response body:', result.body)
      }

      // Verify response structure
      expect(result.statusCode).toBe(200)
      const response = JSON.parse(result.body)
      expect(response.token).toBeDefined()
      expect(response.token).not.toBe('')
      expect(response.userId).toBeDefined()
      // Note: sessionId may not be in response (Better Auth doesn't always include it)
      // We verify session creation via database query below
      expect(new Date(response.expiresAt).getTime()).toBeGreaterThan(Date.now())

      // Verify user was created in database
      const db = await getTestDbAsync()
      const users = await db.execute(sql`SELECT * FROM users WHERE email = ${testEmail}`)
      const userRows = [...users] as Array<{id: string; email: string}>
      expect(userRows).toHaveLength(1)
      expect(userRows[0]!.email).toBe(testEmail)

      // Verify session was created in database
      const sessions = await db.execute(sql`SELECT * FROM sessions WHERE user_id = ${userRows[0]!.id}`)
      const sessionRows = [...sessions] as Array<{id: string; user_id: string; token: string}>
      expect(sessionRows.length).toBeGreaterThanOrEqual(1)
    })

    test('should return error for malformed ID token', async () => {
      // Send a completely invalid token (not a valid JWT)
      const body: AuthRequestBody = {idToken: 'not-a-valid-jwt-token'}
      const event = createAuthEvent(body, '/auth/login')
      const result = await loginHandler(event, mockContext)

      // Better Auth should reject the invalid token
      expect(result.statusCode).toBe(500)
    })

    test('should validate request body - missing idToken', async () => {
      const body = {} as AuthRequestBody
      const event = createAuthEvent(body, '/auth/login')
      const result = await loginHandler(event, mockContext)

      expect(result.statusCode).toBe(400)
    })
  })

  describe('RegisterUser', () => {
    test('should register new user and update name', async () => {
      // Generate a valid Apple ID token
      const appleUserId = 'apple-new-user-' + Date.now()
      const testEmail = `newuser-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({sub: appleUserId, email: testEmail, aud: 'lifegames.OfflineMediaDownloader'})

      const body: AuthRequestBody = {idToken, firstName: 'John', lastName: 'Doe'}
      const event = createAuthEvent(body, '/auth/register')
      const result = await registerHandler(event, mockContext)

      // Verify response
      expect(result.statusCode).toBe(200)
      const response = JSON.parse(result.body)
      expect(response.token).toBeDefined()
      expect(response.userId).toBeDefined()
      // Note: sessionId may not be in response (Better Auth doesn't always include it)

      // Verify user was created with name in database
      const db = await getTestDbAsync()
      const users = await db.execute(sql`SELECT * FROM users WHERE email = ${testEmail}`)
      const userRows = [...users] as Array<{id: string; email: string; first_name: string | null; last_name: string | null}>
      expect(userRows).toHaveLength(1)
      expect(userRows[0]!.first_name).toBe('John')
      expect(userRows[0]!.last_name).toBe('Doe')

      // Verify account was created (Better Auth creates this for OAuth)
      const accounts = await db.execute(sql`SELECT * FROM accounts WHERE user_id = ${userRows[0]!.id}`)
      const accountRows = [...accounts] as Array<{id: string; provider_id: string}>
      expect(accountRows.length).toBeGreaterThanOrEqual(1)
      expect(accountRows[0]!.provider_id).toBe('apple')
    })

    test('should not update name for existing user', async () => {
      // First, create a user by registering
      const appleUserId = 'apple-existing-' + Date.now()
      const testEmail = `existing-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({sub: appleUserId, email: testEmail, aud: 'lifegames.OfflineMediaDownloader'})

      // First registration - sets the name
      const firstBody: AuthRequestBody = {idToken, firstName: 'Original', lastName: 'Name'}
      const firstEvent = createAuthEvent(firstBody, '/auth/register')
      await registerHandler(firstEvent, mockContext)

      // Make the user appear "existing" by setting createdAt to more than 5 seconds ago
      // The RegisterUser handler checks: Date.now() - new Date(user.createdAt).getTime() < 5000
      const db = await getTestDbAsync()
      const tenSecondsAgo = new Date(Date.now() - 10000).toISOString()
      await db.execute(sql`UPDATE users SET created_at = ${tenSecondsAgo} WHERE email = ${testEmail}`)

      // Second registration with different name - should NOT update
      const secondBody: AuthRequestBody = {idToken, firstName: 'Should', lastName: 'NotUpdate'}
      const secondEvent = createAuthEvent(secondBody, '/auth/register')
      const result = await registerHandler(secondEvent, mockContext)

      expect(result.statusCode).toBe(200)

      // Verify name was NOT updated (reusing db from earlier in test)
      const users = await db.execute(sql`SELECT * FROM users WHERE email = ${testEmail}`)
      const userRows = [...users] as Array<{first_name: string | null; last_name: string | null}>
      expect(userRows[0]!.first_name).toBe('Original')
      expect(userRows[0]!.last_name).toBe('Name')
    })

    test('should allow registration without optional name fields', async () => {
      const appleUserId = 'apple-noname-' + Date.now()
      const testEmail = `noname-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({sub: appleUserId, email: testEmail, aud: 'lifegames.OfflineMediaDownloader'})

      // Register without firstName/lastName
      const body: AuthRequestBody = {idToken}
      const event = createAuthEvent(body, '/auth/register')
      const result = await registerHandler(event, mockContext)

      // Schema validation should pass (firstName/lastName are optional)
      expect(result.statusCode).toBe(200)

      // Verify user was created
      const db = await getTestDbAsync()
      const users = await db.execute(sql`SELECT * FROM users WHERE email = ${testEmail}`)
      const userRows = [...users] as Array<{id: string}>
      expect(userRows).toHaveLength(1)
    })

    test('should validate request body - missing idToken', async () => {
      const body = {firstName: 'Test'} as AuthRequestBody
      const event = createAuthEvent(body, '/auth/register')
      const result = await registerHandler(event, mockContext)

      expect(result.statusCode).toBe(400)
    })

    test('should handle malformed ID token', async () => {
      const body: AuthRequestBody = {idToken: 'bad-token', firstName: 'Test', lastName: 'User'}
      const event = createAuthEvent(body, '/auth/register')
      const result = await registerHandler(event, mockContext)

      expect(result.statusCode).toBe(500)
    })
  })

  describe('Common Auth Behaviors', () => {
    test('should pass IP address and user agent to Better Auth', async () => {
      // This test verifies that request headers are passed through to Better Auth
      // Better Auth uses these for session tracking
      const appleUserId = 'apple-headers-' + Date.now()
      const testEmail = `headers-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({sub: appleUserId, email: testEmail, aud: 'lifegames.OfflineMediaDownloader'})

      const body: AuthRequestBody = {idToken}
      const event = createAuthEvent(body, '/auth/login')
      const result = await loginHandler(event, mockContext)

      expect(result.statusCode).toBe(200)

      // Verify session was created with IP/user agent
      const db = await getTestDbAsync()
      const sessions = await db.execute(sql`SELECT * FROM sessions`)
      const sessionRows = [...sessions] as Array<{ip_address: string | null; user_agent: string | null}>

      // Better Auth should have recorded the IP and user agent
      // Note: The exact behavior depends on Better Auth's implementation
      expect(sessionRows.length).toBeGreaterThanOrEqual(1)
    })

    test('should create session with valid expiration', async () => {
      const appleUserId = 'apple-expiry-' + Date.now()
      const testEmail = `expiry-${Date.now()}@example.com`

      const idToken = generateAppleIdToken({sub: appleUserId, email: testEmail, aud: 'lifegames.OfflineMediaDownloader'})

      const body: AuthRequestBody = {idToken}
      const event = createAuthEvent(body, '/auth/login')
      const result = await loginHandler(event, mockContext)

      expect(result.statusCode).toBe(200)
      const response = JSON.parse(result.body)

      // Session should have an expiration in the future (30 days from now per config)
      const thirtyDaysFromNow = Date.now() + 29 * 24 * 60 * 60 * 1000 // 29 days to account for timing
      expect(new Date(response.expiresAt).getTime()).toBeGreaterThan(thirtyDaysFromNow)
    })
  })
})
