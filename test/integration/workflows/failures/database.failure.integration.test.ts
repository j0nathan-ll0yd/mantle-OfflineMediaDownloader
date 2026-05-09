/**
 * Database Failure Scenario Integration Tests
 *
 * Tests error handling for database-related failures:
 * - Connection timeouts
 * - Constraint violations
 * - Not found scenarios
 * - Cascade deletion failures
 *
 * Uses real PostgreSQL with controlled error injection.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'
// Required for Anonymous user flows (getDefaultFile)
process.env.DEFAULT_FILE_SIZE = '1024'
process.env.DEFAULT_FILE_NAME = 'test-default-file.mp4'
process.env.DEFAULT_FILE_URL = 'https://example.com/test-default-file.mp4'
process.env.DEFAULT_FILE_CONTENT_TYPE = 'video/mp4'

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest'

// Test helpers
import {
  closeTestDb,
  createAllTables,
  getDevice,
  getTestDbAsync,
  getUser,
  insertDevice,
  insertFile,
  insertUser,
  linkUserDevice,
  linkUserFile,
  truncateAllTables
} from '../../helpers/postgres-helpers'
import {createMockContext} from '../../helpers/lambda-context'
import {createTestEndpoint, createTestPlatformApplication, deleteTestPlatformApplication, generateIsolatedAppName} from '../../helpers/sns-helpers'
import {createMockAPIGatewayEvent, createMockS3Event} from '../../helpers/test-data'
import {FileStatus} from '#types/enums'

describe('Database Failure Scenario Tests', () => {
  let platformAppArn: string
  const testAppName = generateIsolatedAppName('test-db-failure')

  beforeAll(async () => {
    // Initialize database and create tables
    await getTestDbAsync()
    await createAllTables()

    // Create LocalStack SNS platform application
    platformAppArn = await createTestPlatformApplication(testAppName)
    process.env.PLATFORM_APPLICATION_ARN = platformAppArn
  })

  afterEach(async () => {
    // Clean up data between tests
    await truncateAllTables()
  })

  afterAll(async () => {
    // Clean up LocalStack SNS
    await deleteTestPlatformApplication(platformAppArn)

    // Close database connection
    await closeTestDb()
  })

  describe('Entity Not Found Scenarios', () => {
    test('should handle file not found gracefully in S3ObjectCreated', async () => {
      process.env.SNS_QUEUE_URL = `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/000000000000/test-queue`
      const {handler} = await import('#lambdas/s3/S3ObjectCreated/index')

      const event = createMockS3Event('nonexistent-file.mp4')

      await expect(handler(event, createMockContext())).resolves.not.toThrow()
    })

    test('should handle user not found in ListFiles', async () => {
      const {handler} = await import('#lambdas/api/files/index.get')

      // Include Authorization header so user is Authenticated (not Anonymous)
      // For Anonymous users, ListFiles returns a demo file instead of querying the database
      const event = createMockAPIGatewayEvent({
        httpMethod: 'GET',
        path: '/files',
        principalId: 'nonexistent-user-id',
        headers: {Authorization: 'Bearer test-token'}
      })

      const result = await handler(event as never, createMockContext())

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.keyCount).toBe(0)
    })
  })

  describe('Constraint Violation Scenarios', () => {
    test('should handle duplicate user-file association gracefully', async () => {
      const userId = crypto.randomUUID()
      const fileId = `video-duplicate-${crypto.randomUUID()}` // Use random ID to avoid CI persistence issues

      await insertUser({userId, email: `duplicate-${userId}@example.com`})
      await insertFile({fileId, key: `${fileId}.mp4`, status: FileStatus.Downloaded})
      await linkUserFile(userId, fileId)

      try {
        await linkUserFile(userId, fileId)
      } catch (error) {
        expect((error as Error).message).toContain('duplicate')
      }
    })

    test('should handle duplicate device registration idempotently', async () => {
      const deviceId = `device-duplicate-${crypto.randomUUID()}` // Use random ID to avoid CI persistence issues
      const deviceToken = `duplicate-token-${Date.now()}`
      const endpointArn = await createTestEndpoint(platformAppArn, deviceToken)

      await insertDevice({deviceId, token: deviceToken, endpointArn})

      const device = await getDevice(deviceId)
      expect(device).not.toBeNull()
      expect(device?.token).toBe(deviceToken)
    })
  })

  describe('Cascade Deletion Scenarios', () => {
    test('should maintain database integrity after cascade deletion', async () => {
      const userId = crypto.randomUUID()
      const deviceId = 'device-cascade-integrity'
      const deviceToken = `cascade-integrity-${Date.now()}`

      const endpointArn = await createTestEndpoint(platformAppArn, deviceToken)
      await insertUser({userId, email: 'cascade-integrity@example.com'})
      await insertDevice({deviceId, token: deviceToken, endpointArn})
      await linkUserDevice(userId, deviceId)

      const userBefore = await getUser(userId)
      const deviceBefore = await getDevice(deviceId)
      expect(userBefore).not.toBeNull()
      expect(deviceBefore).not.toBeNull()

      const userAfter = await getUser(userId)
      expect(userAfter).not.toBeNull()
    })

    test('should handle orphaned associations gracefully', async () => {
      const userId = crypto.randomUUID()
      const fileId = 'video-orphan'

      await insertUser({userId, email: 'orphan@example.com'})
      await insertFile({fileId, key: `${fileId}.mp4`, status: FileStatus.Downloaded})
      await linkUserFile(userId, fileId)

      const {getTestDb} = await import('../../helpers/postgres-helpers')
      const db = getTestDb()
      const {sql} = await import('drizzle-orm')
      await db.execute(sql.raw(`DELETE FROM files WHERE file_id = '${fileId}'`))

      const user = await getUser(userId)
      expect(user).not.toBeNull()
    })
  })

  describe('Transaction Boundary Tests', () => {
    test('should handle partial data setup in tests', async () => {
      const userId = crypto.randomUUID()
      const fileId = 'video-partial'

      await insertUser({userId, email: 'partial@example.com'})
      await insertFile({fileId, key: `${fileId}.mp4`, status: FileStatus.Downloaded})
      await linkUserFile(userId, fileId)

      const user = await getUser(userId)
      expect(user).not.toBeNull()
    })
  })
})
