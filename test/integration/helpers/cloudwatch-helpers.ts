/**
 * CloudWatch Logs Test Helpers
 *
 * Utilities for creating log groups/streams and managing log events in LocalStack.
 * Used for integration testing CloudWatch Logs workflows.
 */
import {createLogGroup, createLogStream, deleteLogGroup, getLogEvents, putLogEvents} from '../lib/vendor/AWS/CloudWatch'
import type {OutputLogEvent} from '@aws-sdk/client-cloudwatch-logs'
import {waitFor} from './wait-utils'
import {POLLING, TIMEOUTS} from './timeout-config'

let cloudWatchAvailableCache: boolean | null = null

/**
 * The emulator error when 'logs' is missing from its SERVICES list. Tests skip with this note.
 */
export const CLOUDWATCH_LOGS_NOT_ENABLED = "Service 'logs' is not enabled"

/**
 * Checks if CloudWatch Logs service is available in LocalStack.
 * Results are cached to avoid repeated checks.
 * @returns False only when the emulator reports that the logs service is not enabled
 * @throws Any other error (for example, credentials or connection errors), so the suite fails instead of skipping
 */
export async function isCloudWatchLogsAvailable(): Promise<boolean> {
  if (cloudWatchAvailableCache !== null) {
    return cloudWatchAvailableCache
  }

  try {
    // Try to create and delete a test log group to verify service availability
    const testGroupName = `availability-check-${Date.now()}`
    await createLogGroup(testGroupName)
    await deleteLogGroup(testGroupName)
    cloudWatchAvailableCache = true
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes(CLOUDWATCH_LOGS_NOT_ENABLED)) {
      cloudWatchAvailableCache = false
      return false
    }
    throw error
  }
}

/**
 * Creates a test log group in LocalStack
 * @param logGroupName - Name of the log group
 */
export async function createTestLogGroup(logGroupName: string): Promise<string> {
  try {
    await createLogGroup(logGroupName)
  } catch (error) {
    // Ignore if already exists
    if (error instanceof Error && !error.name.includes('ResourceAlreadyExistsException')) {
      throw error
    }
  }
  return logGroupName
}

/**
 * Deletes a test log group from LocalStack
 * @param logGroupName - Name of the log group
 */
export async function deleteTestLogGroup(logGroupName: string): Promise<void> {
  try {
    await deleteLogGroup(logGroupName)
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Creates a test log stream in LocalStack
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 */
export async function createTestLogStream(logGroupName: string, logStreamName: string): Promise<string> {
  try {
    await createLogStream(logGroupName, logStreamName)
  } catch (error) {
    // Ignore if already exists
    if (error instanceof Error && !error.name.includes('ResourceAlreadyExistsException')) {
      throw error
    }
  }
  return logStreamName
}

/**
 * Puts test log events to a log stream
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param messages - Array of log messages to put
 * @returns The next sequence token
 */
export async function putTestLogEvents(logGroupName: string, logStreamName: string, messages: string[]): Promise<string | undefined> {
  const events = messages.map((message, index) => ({
    timestamp: Date.now() + index, // Ensure unique, ascending timestamps
    message
  }))
  return putLogEvents(logGroupName, logStreamName, events)
}

/**
 * Waits for log events to arrive in a log stream with exponential backoff.
 *
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param expectedCount - Number of events to wait for
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Array of log events
 */
export async function waitForLogEvents(logGroupName: string, logStreamName: string, expectedCount: number, timeoutMs?: number): Promise<OutputLogEvent[]> {
  const effectiveTimeout = timeoutMs ?? TIMEOUTS.sqsMessage

  const result = await waitFor(async () => {
    const events = await getLogEvents(logGroupName, logStreamName, expectedCount * 2)
    return events.length >= expectedCount ? events : null
  }, {
    initialDelayMs: POLLING.initialDelay,
    maxDelayMs: POLLING.maxDelay,
    maxTotalMs: effectiveTimeout,
    jitterFactor: POLLING.jitterFactor,
    description: `${expectedCount} CloudWatch log event(s)`
  })

  return result.value
}

/**
 * Gets all log events from a log stream
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param limit - Maximum number of events to retrieve
 */
export async function getTestLogEvents(logGroupName: string, logStreamName: string, limit = 100): Promise<OutputLogEvent[]> {
  return getLogEvents(logGroupName, logStreamName, limit)
}
