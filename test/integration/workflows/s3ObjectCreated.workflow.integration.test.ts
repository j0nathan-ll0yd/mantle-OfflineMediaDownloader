/**
 * S3ObjectCreated Workflow Integration Tests
 *
 * Tests the S3 object creation workflow including file lookup,
 * user association queries, and notification dispatch.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from 'vitest'
import type {Context} from 'aws-lambda'
import {FileStatus} from '#types/enums'

// Test helpers
import {createMockContext} from '../helpers/lambda-context'
import {createMockS3Event} from '../helpers/test-data'
import {clearTestQueue, createTestQueue, deleteTestQueue, receiveAndDeleteMessages} from '../helpers/sqs-helpers'
import {closeTestDb, createAllTables, getTestDbAsync, insertFile, insertUser, insertUserFile, truncateAllTables} from '../helpers/postgres-helpers'
import {generateTestResourceName} from '../helpers/resource-naming'

const {handler} = await import('#lambdas/s3/S3ObjectCreated/index')

describe('S3ObjectCreated Workflow Integration Tests', () => {
  let mockContext: Context
  let queueUrl: string
  const testQueueName = generateTestResourceName('test-s3-object-queue')

  beforeAll(async () => {
    mockContext = createMockContext()

    // Initialize database connection and create tables
    await getTestDbAsync()
    await createAllTables()

    // Create real LocalStack SQS queue
    const queue = await createTestQueue(testQueueName)
    queueUrl = queue.queueUrl
    process.env.SNS_QUEUE_URL = queueUrl
  })

  beforeEach(async () => {
    // Clear any messages from previous tests
    await clearTestQueue(queueUrl)
  })

  afterEach(async () => {
    // Clean up database between tests
    await truncateAllTables()
  })

  afterAll(async () => {
    // Clean up LocalStack resources
    await deleteTestQueue(queueUrl)
    // Close database connection
    await closeTestDb()
  })

  test('should dispatch notification to user when file is uploaded using real LocalStack SQS', async () => {
    const userId = crypto.randomUUID()
    const fileId = `file-${Date.now()}`
    const fileKey = 'videos/test-video.mp4'

    await insertUser({userId, email: `s3test-${Date.now()}@example.com`})
    await insertFile({fileId, key: fileKey, title: 'Test Video', status: FileStatus.Downloaded, size: 1000})
    await insertUserFile({userId, fileId})

    await handler(createMockS3Event(fileKey), mockContext)

    const messages = await receiveAndDeleteMessages(queueUrl, 10, 2)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.attributes.userId).toBe(userId)
  })

  test('should dispatch notifications to multiple users for shared file', async () => {
    const userId1 = crypto.randomUUID()
    const userId2 = crypto.randomUUID()
    const userId3 = crypto.randomUUID()
    const fileId = `shared-file-${Date.now()}`
    const fileKey = 'videos/shared-video.mp4'

    await insertUser({userId: userId1, email: `shared1-${Date.now()}@example.com`})
    await insertUser({userId: userId2, email: `shared2-${Date.now()}@example.com`})
    await insertUser({userId: userId3, email: `shared3-${Date.now()}@example.com`})
    await insertFile({fileId, key: fileKey, title: 'Shared Video', status: FileStatus.Downloaded, size: 2000})
    await insertUserFile({userId: userId1, fileId})
    await insertUserFile({userId: userId2, fileId})
    await insertUserFile({userId: userId3, fileId})

    await handler(createMockS3Event(fileKey), mockContext)

    const messages = await receiveAndDeleteMessages(queueUrl, 10, 2)
    expect(messages).toHaveLength(3)

    const userIds = messages.map((m) => m.attributes.userId).sort()
    expect(userIds).toEqual([userId1, userId2, userId3].sort())
  })

  test('should handle file with no users gracefully', async () => {
    const fileId = `orphan-file-${Date.now()}`
    const fileKey = 'videos/orphan-video.mp4'

    await insertFile({fileId, key: fileKey, title: 'Orphan Video', status: FileStatus.Downloaded, size: 500})

    await handler(createMockS3Event(fileKey), mockContext)

    const messages = await receiveAndDeleteMessages(queueUrl, 10, 1)
    expect(messages).toHaveLength(0)
  })

  test('should handle URL-encoded S3 keys correctly', async () => {
    const userId = crypto.randomUUID()
    const fileId = `spaced-file-${Date.now()}`
    const fileKey = 'videos/file with spaces.mp4'

    await insertUser({userId, email: `spaces-${Date.now()}@example.com`})
    await insertFile({fileId, key: fileKey, title: 'File With Spaces', status: FileStatus.Downloaded, size: 750})
    await insertUserFile({userId, fileId})

    await handler(createMockS3Event(fileKey), mockContext)

    const messages = await receiveAndDeleteMessages(queueUrl, 10, 2)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.attributes.userId).toBe(userId)
  })

  test('should include notification type in message attributes', async () => {
    const userId = crypto.randomUUID()
    const fileId = `notify-file-${Date.now()}`
    const fileKey = 'videos/notify-type-test.mp4'

    await insertUser({userId, email: `notify-${Date.now()}@example.com`})
    await insertFile({fileId, key: fileKey, title: 'Notification Type Test', status: FileStatus.Downloaded, size: 1500})
    await insertUserFile({userId, fileId})

    await handler(createMockS3Event(fileKey), mockContext)

    const messages = await receiveAndDeleteMessages(queueUrl, 10, 2)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.attributes.notificationType).toBe('DownloadReadyNotification')
  })
})
