/**
 * Better Auth Entities Integration Tests
 *
 * Tests the Better Auth entity operations with PostgreSQL:
 * 1. Users table CRUD operations
 * 2. Sessions table with user associations
 * 3. Accounts table for OAuth providers
 * 4. Devices and UserDevices associations
 *
 * These tests verify database operations using the postgres-helpers
 * against a real PostgreSQL instance (docker/docker-compose.test.yml).
 */

// Set environment variables before imports
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest'
import {
  closeTestDb,
  createAllTables,
  ensureSearchPath,
  getDevice,
  getTestDb,
  getTestDbAsync,
  getUser,
  insertDevice,
  insertUser,
  linkUserDevice,
  truncateAllTables
} from '../helpers/postgres-helpers'
import {accounts, devices, sessions, userDevices, users} from '#db/schema'
import {eq} from 'drizzle-orm'

describe('Better Auth Entities Integration Tests', () => {
  beforeAll(async () => {
    // Initialize database connection and create tables
    await getTestDbAsync()
    await createAllTables()
  })

  afterEach(async () => {
    // Clean up data between tests
    await truncateAllTables()
  })

  afterAll(async () => {
    // Close database connection
    await closeTestDb()
  })

  describe('Users Entity Operations', () => {
    test('should create and retrieve a user', async () => {
      const userId = crypto.randomUUID()

      await insertUser({userId, email: 'auth-test@example.com', firstName: 'Auth', lastName: 'Test', emailVerified: true})

      const user = await getUser(userId)

      expect(user).not.toBeNull()
      expect(user?.email).toBe('auth-test@example.com')
      expect(user?.firstName).toBe('Auth')
      expect(user?.lastName).toBe('Test')
      expect(user?.emailVerified).toBe(true)
    })

    test('should update user fields', async () => {
      const userId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'update@example.com', firstName: 'Before'})

      // Update user
      await db.update(users).set({firstName: 'After', lastName: 'Update'}).where(eq(users.id, userId))

      const user = await getUser(userId)

      expect(user?.firstName).toBe('After')
      expect(user?.lastName).toBe('Update')
    })

    test('should delete user', async () => {
      const userId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'delete@example.com', firstName: 'Delete'})

      // Delete user
      await db.delete(users).where(eq(users.id, userId))

      const user = await getUser(userId)

      expect(user).toBeNull()
    })

    test('should query user by email', async () => {
      const userId = crypto.randomUUID()
      const email = 'query-by-email@example.com'
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email, firstName: 'Query'})

      // Query by email
      const results = await db.select().from(users).where(eq(users.email, email))

      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe(userId)
    })
  })

  describe('Devices Entity Operations', () => {
    test('should create and retrieve a device', async () => {
      const deviceId = 'device-auth-test'

      await insertDevice({
        deviceId,
        name: 'Test iPhone',
        token: 'apns-token-123',
        systemName: 'iOS',
        systemVersion: '17.0',
        endpointArn: 'arn:aws:sns:us-west-2:123456789012:endpoint/APNS/App/device-auth-test'
      })

      const device = await getDevice(deviceId)

      expect(device).not.toBeNull()
      expect(device?.name).toBe('Test iPhone')
      expect(device?.systemName).toBe('iOS')
    })

    test('should update device token', async () => {
      const deviceId = 'device-update-token'
      const db = getTestDb()
      await ensureSearchPath()

      await insertDevice({deviceId, name: 'Update Device', token: 'old-token'})

      // Update token
      await db.update(devices).set({token: 'new-token'}).where(eq(devices.deviceId, deviceId))

      const device = await getDevice(deviceId)

      expect(device?.token).toBe('new-token')
    })
  })

  describe('UserDevices Association', () => {
    test('should link user to device', async () => {
      const userId = crypto.randomUUID()
      const deviceId = 'device-link-test'
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'device-owner@example.com', firstName: 'Owner'})
      await insertDevice({deviceId})

      await linkUserDevice(userId, deviceId)

      const associations = await db.select().from(userDevices).where(eq(userDevices.userId, userId))

      expect(associations).toHaveLength(1)
      expect(associations[0]!.deviceId).toBe(deviceId)
    })

    test('should support multiple devices per user', async () => {
      const userId = crypto.randomUUID()
      const deviceIds = ['device-1', 'device-2', 'device-3']
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'multi-device@example.com', firstName: 'Multi'})

      for (const deviceId of deviceIds) {
        await insertDevice({deviceId})
        await linkUserDevice(userId, deviceId)
      }

      const associations = await db.select().from(userDevices).where(eq(userDevices.userId, userId))

      expect(associations).toHaveLength(3)
    })
  })

  describe('Sessions Entity Operations', () => {
    test('should create and retrieve a session', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'session-test@example.com', firstName: 'Session'})

      // Create session
      const expiresAt = new Date(Date.now() + 86400 * 1000) // 24 hours from now
      await db.insert(sessions).values({
        id: sessionId,
        userId,
        token: 'session-token-123',
        expiresAt,
        ipAddress: '192.168.1.1',
        userAgent: 'iOS/17.0 TestApp/1.0'
      })

      const results = await db.select().from(sessions).where(eq(sessions.userId, userId))

      expect(results).toHaveLength(1)
      expect(results[0]!.token).toBe('session-token-123')
      expect(results[0]!.ipAddress).toBe('192.168.1.1')
    })

    test('should query sessions by token', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const token = 'unique-session-token'
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'token-query@example.com', firstName: 'Token'})

      const expiresAt = new Date(Date.now() + 86400 * 1000)
      await db.insert(sessions).values({id: sessionId, userId, token, expiresAt})

      const results = await db.select().from(sessions).where(eq(sessions.token, token))

      expect(results).toHaveLength(1)
      expect(results[0]!.userId).toBe(userId)
    })

    test('should delete expired sessions', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'expired@example.com', firstName: 'Expired'})

      const expired = new Date(Date.now() - 3600 * 1000) // 1 hour ago

      // Create expired session
      await db.insert(sessions).values({id: sessionId, userId, token: 'expired-token', expiresAt: expired})

      // Delete expired sessions (simulating cleanup Lambda)
      await db.delete(sessions).where(eq(sessions.id, sessionId))

      const results = await db.select().from(sessions).where(eq(sessions.userId, userId))

      expect(results).toHaveLength(0)
    })
  })

  describe('Accounts Entity Operations', () => {
    test('should create OAuth account for user', async () => {
      const userId = crypto.randomUUID()
      const accountId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'oauth@example.com', firstName: 'OAuth'})

      const expiresAt = new Date(Date.now() + 3600 * 1000)
      await db.insert(accounts).values({
        id: accountId,
        userId,
        providerId: 'apple',
        accountId: 'apple-user-123',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: expiresAt
      })

      const results = await db.select().from(accounts).where(eq(accounts.userId, userId))

      expect(results).toHaveLength(1)
      expect(results[0]!.providerId).toBe('apple')
      expect(results[0]!.accountId).toBe('apple-user-123')
    })

    test('should query account by provider', async () => {
      const userId = crypto.randomUUID()
      const accountId = crypto.randomUUID()
      const db = getTestDb()
      await ensureSearchPath()

      await insertUser({userId, email: 'provider@example.com', firstName: 'Provider'})

      await db.insert(accounts).values({id: accountId, userId, providerId: 'apple', accountId: 'unique-apple-id'})

      const results = await db.select().from(accounts).where(eq(accounts.accountId, 'unique-apple-id'))

      expect(results).toHaveLength(1)
      expect(results[0]!.userId).toBe(userId)
    })
  })

  describe('Cascade Delete Behavior', () => {
    test('should clean up user associations when deleting user', async () => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const deviceId = 'cascade-device'
      const db = getTestDb()
      await ensureSearchPath()

      // Create user with device and session
      await insertUser({userId, email: 'cascade@example.com', firstName: 'Cascade'})
      await insertDevice({deviceId})
      await linkUserDevice(userId, deviceId)

      const expiresAt = new Date(Date.now() + 86400 * 1000)
      await db.insert(sessions).values({id: sessionId, userId, token: 'cascade-token', expiresAt})

      // Delete associations first (application-layer cascade)
      await db.delete(userDevices).where(eq(userDevices.userId, userId))
      await db.delete(sessions).where(eq(sessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))

      // Verify cleanup
      const userResult = await getUser(userId)
      const deviceAssocs = await db.select().from(userDevices).where(eq(userDevices.userId, userId))
      const sessionResults = await db.select().from(sessions).where(eq(sessions.userId, userId))

      expect(userResult).toBeNull()
      expect(deviceAssocs).toHaveLength(0)
      expect(sessionResults).toHaveLength(0)
    })
  })
})
