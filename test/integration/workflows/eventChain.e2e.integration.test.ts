/**
 * Event Chain End-to-End Integration Tests
 *
 * Tests the complete event-driven workflow with LocalStack:
 * 1. EventBridge receives DownloadRequested event
 * 2. Rule routes event to SQS DownloadQueue
 * 3. Message arrives with correct structure and correlation ID
 * 4. Full E2E chain with database operations and message processing
 *
 * These tests verify the event-driven pipeline using LocalStack
 * for EventBridge and SQS emulation.
 *
 * @see docs/wiki/Integration/LocalStack-Testing.md
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest'
import {
  createTestEventBus,
  createTestRuleWithSqsTarget,
  deleteTestEventBus,
  publishDownloadRequestedEvent,
  waitForEventBridgeReady
} from '../helpers/eventbridge-helpers'
import {clearTestQueue, createTestQueue, deleteTestQueue, waitForMessages} from '../helpers/sqs-helpers'
import {TIMEOUTS} from '../helpers/timeout-config'
import {generateTestResourceName} from '../helpers/resource-naming'
import {
  closeTestDb,
  createAllTables,
  getFile,
  getTestDbAsync,
  insertFile,
  insertFileDownload,
  insertUser,
  linkUserFile,
  truncateAllTables
} from '../helpers/postgres-helpers'
import {FileStatus} from '#types/enums'

const TEST_EVENT_BUS = generateTestResourceName('test-bus')
const TEST_QUEUE = generateTestResourceName('test-queue')
const TEST_RULE = generateTestResourceName('test-rule')

describe('Event Chain E2E Integration Tests', () => {
  let queueUrl: string
  let queueArn: string

  beforeAll(async () => {
    // Initialize PostgreSQL for full E2E tests
    await getTestDbAsync()
    await createAllTables()

    // Wait for EventBridge to be ready (with retry logic for LocalStack startup)
    await waitForEventBridgeReady(TIMEOUTS.eventBridgeReady)

    // Create test infrastructure
    const queueInfo = await createTestQueue(TEST_QUEUE)
    queueUrl = queueInfo.queueUrl
    queueArn = queueInfo.queueArn

    await createTestEventBus(TEST_EVENT_BUS)
    await createTestRuleWithSqsTarget(TEST_EVENT_BUS, TEST_RULE, 'DownloadRequested', queueArn)
  })

  afterEach(async () => {
    // Clear messages and database between tests
    await clearTestQueue(queueUrl)
    await truncateAllTables()
  })

  afterAll(async () => {
    // Clean up test infrastructure
    await deleteTestEventBus(TEST_EVENT_BUS)
    await deleteTestQueue(queueUrl)
    await closeTestDb()
  })

  describe('EventBridge to SQS Routing', () => {
    test('should route DownloadRequested event to SQS queue', async () => {
      const fileId = 'test-video-123'
      const fileUrl = 'https://www.youtube.com/watch?v=test-video-123'
      const correlationId = `test-correlation-${Date.now()}`

      // Publish event to EventBridge
      const failedCount = await publishDownloadRequestedEvent(TEST_EVENT_BUS, fileId, fileUrl, correlationId)
      expect(failedCount).toBe(0)

      // Wait for message to arrive in SQS
      const messages = await waitForMessages(queueUrl, 1, TIMEOUTS.sqsMessage)
      expect(messages.length).toBe(1)

      // Verify message structure
      const message = messages[0]!
      expect(message.Body).toBeDefined()

      const body = JSON.parse(message.Body!)
      expect(body.source).toBe('media-downloader')
      expect(body['detail-type']).toBe('DownloadRequested')
      expect(body.detail.fileId).toBe(fileId)
      expect(body.detail.fileUrl).toBe(fileUrl)
      expect(body.detail.correlationId).toBe(correlationId)
    })

    test('should handle multiple concurrent events', async () => {
      const events = [
        {fileId: 'video-1', fileUrl: 'https://youtube.com/watch?v=video-1', correlationId: 'corr-1'},
        {fileId: 'video-2', fileUrl: 'https://youtube.com/watch?v=video-2', correlationId: 'corr-2'},
        {fileId: 'video-3', fileUrl: 'https://youtube.com/watch?v=video-3', correlationId: 'corr-3'}
      ]

      // Publish all events concurrently
      const results = await Promise.all(events.map((e) => publishDownloadRequestedEvent(TEST_EVENT_BUS, e.fileId, e.fileUrl, e.correlationId)))

      // All should succeed
      expect(results.every((r) => r === 0)).toBe(true)

      // Wait for all messages
      const messages = await waitForMessages(queueUrl, 3, TIMEOUTS.sqsMultipleMessages)
      expect(messages.length).toBe(3)

      // Verify all events arrived
      const fileIds = messages.map((m) => {
        const body = JSON.parse(m.Body!)
        return body.detail.fileId
      })
      expect(fileIds.sort()).toEqual(['video-1', 'video-2', 'video-3'])
    })

    test('should preserve correlation ID through event chain', async () => {
      const correlationId = `trace-${Date.now()}-${Math.random().toString(36).slice(7)}`

      await publishDownloadRequestedEvent(TEST_EVENT_BUS, 'correlation-test', 'https://youtube.com/watch?v=test', correlationId)

      const messages = await waitForMessages(queueUrl, 1, TIMEOUTS.sqsMessage)
      expect(messages.length).toBe(1)

      const body = JSON.parse(messages[0]!.Body!)
      expect(body.detail.correlationId).toBe(correlationId)
    })
  })

  describe('Event Filtering', () => {
    test('should only route DownloadRequested events, not other types', async () => {
      // Publish a non-matching event directly using putEvents
      const {putEvents} = await import('../lib/vendor/AWS/EventBridge')
      await putEvents([
        {EventBusName: TEST_EVENT_BUS, Source: 'media-downloader', DetailType: 'SomeOtherEvent', Detail: JSON.stringify({test: 'data'}), Time: new Date()}
      ])

      // Should not receive any messages (short timeout - expected to timeout)
      // waitForMessages throws on timeout, so we expect zero messages
      let unexpectedMessages: Awaited<ReturnType<typeof waitForMessages>> = []
      try {
        unexpectedMessages = await waitForMessages(queueUrl, 1, 3000)
      } catch {
        // Expected - no messages should arrive for non-matching event type
      }
      expect(unexpectedMessages.length).toBe(0)

      // Now publish a matching event
      await publishDownloadRequestedEvent(TEST_EVENT_BUS, 'filter-test', 'https://youtube.com/test', 'filter-corr')

      // Should receive the matching event
      const matchingMessages = await waitForMessages(queueUrl, 1, TIMEOUTS.sqsMessage)
      expect(matchingMessages.length).toBe(1)
    })
  })

  describe('Full E2E Chain with Database', () => {
    test('should route event for existing file record and verify message structure', async () => {
      // 1. Set up database state - create file and user association
      const userId = crypto.randomUUID()
      const fileId = `e2e-video-${Date.now()}`
      const correlationId = `e2e-correlation-${Date.now()}`
      const fileUrl = `https://www.youtube.com/watch?v=${fileId}`

      await insertUser({userId, email: `e2e-${Date.now()}@example.com`})
      await insertFile({fileId, status: FileStatus.Queued, title: 'E2E Test Video'})
      await linkUserFile(userId, fileId)

      // 2. Publish DownloadRequested event to EventBridge
      const failedCount = await publishDownloadRequestedEvent(TEST_EVENT_BUS, fileId, fileUrl, correlationId)
      expect(failedCount).toBe(0)

      // 3. Wait for message in SQS
      const messages = await waitForMessages(queueUrl, 1, TIMEOUTS.sqsMessage)
      expect(messages.length).toBe(1)

      // 4. Verify message contains correct file data
      const body = JSON.parse(messages[0]!.Body!)
      expect(body.detail.fileId).toBe(fileId)
      expect(body.detail.fileUrl).toBe(fileUrl)
      expect(body.detail.correlationId).toBe(correlationId)

      // 5. Verify file exists in database with correct state
      const file = await getFile(fileId)
      expect(file).not.toBeNull()
      expect(file?.status).toBe(FileStatus.Queued)
    })

    test('should handle E2E chain with file download record tracking', async () => {
      // 1. Set up database state with download tracking
      const userId = crypto.randomUUID()
      const fileId = `download-track-${Date.now()}`
      const correlationId = `download-correlation-${Date.now()}`
      const fileUrl = `https://www.youtube.com/watch?v=${fileId}`

      await insertUser({userId, email: `download-track-${Date.now()}@example.com`})
      await insertFile({fileId, status: FileStatus.Queued, title: 'Download Tracking Video'})
      await insertFileDownload({fileId, status: 'Pending', correlationId, sourceUrl: fileUrl})
      await linkUserFile(userId, fileId)

      // 2. Publish event
      const failedCount = await publishDownloadRequestedEvent(TEST_EVENT_BUS, fileId, fileUrl, correlationId)
      expect(failedCount).toBe(0)

      // 3. Verify message arrives with matching correlation ID
      const messages = await waitForMessages(queueUrl, 1, TIMEOUTS.sqsMessage)
      expect(messages.length).toBe(1)

      const body = JSON.parse(messages[0]!.Body!)
      expect(body.detail.correlationId).toBe(correlationId)

      // 4. Verify database state is ready for processing
      const file = await getFile(fileId)
      expect(file).not.toBeNull()
    })

    test('should route multiple file events with distinct database records', async () => {
      const userId = crypto.randomUUID()
      const files = [
        {fileId: `multi-1-${Date.now()}`, title: 'Multi File 1'},
        {fileId: `multi-2-${Date.now()}`, title: 'Multi File 2'},
        {fileId: `multi-3-${Date.now()}`, title: 'Multi File 3'}
      ]

      // 1. Set up database state for all files
      await insertUser({userId, email: `multi-${Date.now()}@example.com`})
      for (const f of files) {
        await insertFile({fileId: f.fileId, status: FileStatus.Queued, title: f.title})
        await linkUserFile(userId, f.fileId)
      }

      // 2. Publish events for all files concurrently
      const publishResults = await Promise.all(
        files.map((f) => publishDownloadRequestedEvent(TEST_EVENT_BUS, f.fileId, `https://youtube.com/watch?v=${f.fileId}`, `corr-${f.fileId}`))
      )
      expect(publishResults.every((r) => r === 0)).toBe(true)

      // 3. Wait for all messages
      const messages = await waitForMessages(queueUrl, 3, TIMEOUTS.sqsMultipleMessages)
      expect(messages.length).toBe(3)

      // 4. Verify all files match what's in database
      const receivedFileIds = messages.map((m) => JSON.parse(m.Body!).detail.fileId).sort()
      const expectedFileIds = files.map((f) => f.fileId).sort()
      expect(receivedFileIds).toEqual(expectedFileIds)

      // 5. Verify all files exist in database
      for (const f of files) {
        const file = await getFile(f.fileId)
        expect(file).not.toBeNull()
        expect(file?.title).toBe(f.title)
      }
    })
  })
})
