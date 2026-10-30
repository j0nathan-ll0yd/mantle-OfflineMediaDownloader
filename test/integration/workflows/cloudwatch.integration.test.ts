/**
 * CloudWatch Logs Integration Tests
 *
 * Tests CloudWatch Logs operations via LocalStack including
 * log group/stream creation, log event writing and retrieval.
 *
 * Note: Tests will skip gracefully if CloudWatch Logs service
 * is not enabled in LocalStack (requires 'logs' in SERVICES env).
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'

import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {
  CLOUDWATCH_LOGS_NOT_ENABLED,
  createTestLogGroup,
  createTestLogStream,
  deleteTestLogGroup,
  getTestLogEvents,
  isCloudWatchLogsAvailable,
  putTestLogEvents,
  waitForLogEvents
} from '../helpers/cloudwatch-helpers'

describe('CloudWatch Logs Integration Tests', () => {
  const testLogGroupName = `test-log-group-${Date.now()}`
  const testLogStreamName = `test-log-stream-${Date.now()}`
  let cloudWatchAvailable = false

  beforeAll(async () => {
    cloudWatchAvailable = await isCloudWatchLogsAvailable()
    if (!cloudWatchAvailable) {
      console.log(`CloudWatch Logs tests will be skipped: ${CLOUDWATCH_LOGS_NOT_ENABLED}`)
      return
    }

    // Create test log group and stream
    await createTestLogGroup(testLogGroupName)
    await createTestLogStream(testLogGroupName, testLogStreamName)
  })

  afterAll(async () => {
    if (cloudWatchAvailable) {
      // Clean up test resources
      await deleteTestLogGroup(testLogGroupName)
    }
  })

  test('should create log group and stream', async ({skip}) => {
    if (!cloudWatchAvailable) {
      skip(CLOUDWATCH_LOGS_NOT_ENABLED)
      return
    }

    // Create a new log group and stream for this test
    const groupName = `test-group-create-${Date.now()}`
    const streamName = `test-stream-create-${Date.now()}`

    await createTestLogGroup(groupName)
    await createTestLogStream(groupName, streamName)

    // Verify by putting and getting a log event
    await putTestLogEvents(groupName, streamName, ['test message'])
    const events = await getTestLogEvents(groupName, streamName)

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.message).toBe('test message')

    // Clean up
    await deleteTestLogGroup(groupName)
  })

  test('should write and retrieve log events', async ({skip}) => {
    if (!cloudWatchAvailable) {
      skip(CLOUDWATCH_LOGS_NOT_ENABLED)
      return
    }

    const messages = ['First log message', 'Second log message', 'Third log message']

    await putTestLogEvents(testLogGroupName, testLogStreamName, messages)

    const events = await waitForLogEvents(testLogGroupName, testLogStreamName, 3)

    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.map((e) => e.message)).toContain('First log message')
    expect(events.map((e) => e.message)).toContain('Second log message')
    expect(events.map((e) => e.message)).toContain('Third log message')
  })

  test('should handle empty log stream', async ({skip}) => {
    if (!cloudWatchAvailable) {
      skip(CLOUDWATCH_LOGS_NOT_ENABLED)
      return
    }

    const emptyStreamName = `test-empty-stream-${Date.now()}`
    await createTestLogStream(testLogGroupName, emptyStreamName)

    const events = await getTestLogEvents(testLogGroupName, emptyStreamName)

    expect(events).toEqual([])
  })

  test('should write JSON log events', async ({skip}) => {
    if (!cloudWatchAvailable) {
      skip(CLOUDWATCH_LOGS_NOT_ENABLED)
      return
    }

    const jsonStreamName = `test-json-stream-${Date.now()}`
    await createTestLogStream(testLogGroupName, jsonStreamName)

    const jsonMessages = [
      JSON.stringify({level: 'INFO', message: 'Application started', timestamp: Date.now()}),
      JSON.stringify({level: 'ERROR', message: 'Something went wrong', errorCode: 'ERR001'})
    ]

    await putTestLogEvents(testLogGroupName, jsonStreamName, jsonMessages)

    const events = await waitForLogEvents(testLogGroupName, jsonStreamName, 2)

    expect(events.length).toBeGreaterThanOrEqual(2)

    // Parse JSON messages and verify structure
    const parsedEvents = events.map((e) => JSON.parse(e.message || '{}'))
    expect(parsedEvents.some((e) => e.level === 'INFO')).toBe(true)
    expect(parsedEvents.some((e) => e.level === 'ERROR')).toBe(true)
  })
})
