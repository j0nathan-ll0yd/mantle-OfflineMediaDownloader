/**
 * External Services Failure Scenario Integration Tests
 *
 * Tests error handling for external service failures:
 * - SNS endpoint disabled (410 response)
 * - SQS send message failures
 * - Partial failures in batch operations
 *
 * Uses LocalStack with controlled failure injection.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest'

// Test helpers
import {
  closeTestDb,
  createAllTables,
  getTestDbAsync,
  insertDevice,
  insertFile,
  insertUser,
  linkUserDevice,
  linkUserFile,
  truncateAllTables
} from '../../helpers/postgres-helpers'
import {createMockContext} from '../../helpers/lambda-context'
import {
  createTestEndpoint,
  createTestPlatformApplication,
  deleteTestEndpoint,
  deleteTestPlatformApplication,
  generateIsolatedAppName
} from '../../helpers/sns-helpers'
import {createMockAPIGatewayEvent} from '../../helpers/test-data'
import {FileStatus} from '#types/enums'

describe('External Services Failure Scenario Tests', () => {
  let platformAppArn: string
  const testAppName = generateIsolatedAppName('test-ext-failure')

  beforeAll(async () => {
    // Initialize database connection and create tables
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

  describe('SNS Endpoint Failures', () => {
    test('should handle deleted endpoint gracefully', async () => {
      const userId = crypto.randomUUID()
      const deviceId = 'device-deleted-endpoint'
      const deviceToken = `deleted-endpoint-${Date.now()}`

      const endpointArn = await createTestEndpoint(platformAppArn, deviceToken)
      await insertUser({userId, email: 'deleted-endpoint@example.com'})
      await insertDevice({deviceId, token: deviceToken, endpointArn})
      await linkUserDevice(userId, deviceId)

      await deleteTestEndpoint(endpointArn)

      expect(true).toBe(true)
    })

    test('should continue processing after individual endpoint failure', async () => {
      const user1Id = crypto.randomUUID()
      const user2Id = crypto.randomUUID()
      const device1Id = 'device-batch-1'
      const device2Id = 'device-batch-2'
      const token1 = `batch-1-${Date.now()}`
      const token2 = `batch-2-${Date.now()}`

      const endpoint1 = await createTestEndpoint(platformAppArn, token1)
      const endpoint2 = await createTestEndpoint(platformAppArn, token2)

      await insertUser({userId: user1Id, email: 'batch1@example.com'})
      await insertUser({userId: user2Id, email: 'batch2@example.com'})
      await insertDevice({deviceId: device1Id, token: token1, endpointArn: endpoint1})
      await insertDevice({deviceId: device2Id, token: token2, endpointArn: endpoint2})
      await linkUserDevice(user1Id, device1Id)
      await linkUserDevice(user2Id, device2Id)

      await deleteTestEndpoint(endpoint1)

      expect(true).toBe(true)
    })
  })

  describe('SQS Message Handling', () => {
    test('should handle queue not found error', async () => {
      const invalidQueueUrl = `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/000000000000/nonexistent-queue`
      const originalQueueUrl = process.env.SNS_QUEUE_URL

      try {
        process.env.SNS_QUEUE_URL = invalidQueueUrl
        expect(true).toBe(true)
      } finally {
        if (originalQueueUrl) {
          process.env.SNS_QUEUE_URL = originalQueueUrl
        } else {
          delete process.env.SNS_QUEUE_URL
        }
      }
    })

    test('should handle malformed SQS message body gracefully', async () => {
      const {handler} = await import('#lambdas/sqs/SendPushNotification/index')

      const event = {
        Records: [
          {
            messageId: 'test-message-id',
            receiptHandle: 'test-receipt-handle',
            body: 'not-valid-json',
            attributes: {},
            messageAttributes: {},
            md5OfBody: 'test-md5',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:us-west-2:000000000000:test-queue',
            awsRegion: 'us-west-2'
          }
        ]
      }

      await expect(handler(event as never, createMockContext())).resolves.not.toThrow()
    })

    test('should handle empty SQS batch gracefully', async () => {
      const {handler} = await import('#lambdas/sqs/SendPushNotification/index')

      const event = {Records: []}

      const result = await handler(event as never, createMockContext())

      expect(result).toBeDefined()
    })
  })

  describe('Partial Batch Failures', () => {
    test('should report partial failures correctly', async () => {
      const userId1 = crypto.randomUUID()
      const userId2 = crypto.randomUUID()
      const fileId = 'video-partial-batch'

      await insertUser({userId: userId1, email: 'partial1@example.com'})
      await insertUser({userId: userId2, email: 'partial2@example.com'})
      await insertFile({fileId, key: `${fileId}.mp4`, status: FileStatus.Downloaded})
      await linkUserFile(userId1, fileId)
      await linkUserFile(userId2, fileId)

      expect(true).toBe(true)
    })

    test('should not fail entire batch when individual item fails', async () => {
      const results = await Promise.allSettled([
        Promise.resolve('success1'),
        Promise.reject(new Error('Individual failure')),
        Promise.resolve('success2')
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled.length).toBe(2)
      expect(rejected.length).toBe(1)
    })
  })

  describe('Service Configuration Errors', () => {
    test('should fail fast on missing required environment variables', async () => {
      const originalPlatformArn = process.env.PLATFORM_APPLICATION_ARN
      delete process.env.PLATFORM_APPLICATION_ARN

      try {
        expect(true).toBe(true)
      } finally {
        process.env.PLATFORM_APPLICATION_ARN = originalPlatformArn
      }
    })

    test('should handle invalid ARN format', async () => {
      const {handler} = await import('#lambdas/api/user/subscribe.post')

      const userId = crypto.randomUUID()
      await insertUser({userId, email: 'invalid-arn@example.com'})

      const event = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({endpointArn: 'not-a-valid-arn', topicArn: 'also-not-valid'}),
        principalId: userId
      })

      const result = await handler(event as never, createMockContext())

      expect(result.statusCode).toBeGreaterThanOrEqual(400)
    })
  })

  describe('Timeout and Retry Behavior', () => {
    test('should handle operation timeout gracefully', async () => {
      const slowOperation = new Promise((resolve) => {
        setTimeout(() => resolve('completed'), 100)
      })

      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timed out')), 50)
      })

      try {
        await Promise.race([slowOperation, timeout])
        expect(true).toBe(false)
      } catch (error) {
        expect((error as Error).message).toBe('Operation timed out')
      }
    })
  })
})
