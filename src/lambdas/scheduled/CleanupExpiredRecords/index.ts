/**
 * CleanupExpiredRecords Lambda
 *
 * Scheduled Lambda that replaces DynamoDB TTL functionality.
 * Runs daily to delete expired records from Aurora DSQL.
 *
 * Trigger: CloudWatch Schedule (cron: daily at 3 AM UTC)
 * Input: ScheduledEvent
 * Output: CleanupResult with deletion counts
 */
import {defineScheduledHandler} from '@mantleframework/core'
import {addMetadata, endSpan, logDebug, logError, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
import {deleteExpiredDeviceEvents, deleteExpiredFileDownloads, deleteExpiredSessions, deleteExpiredVerifications} from '#entities/queries'
import {DownloadStatus} from '#types/enums'
import type {CleanupResult} from '#types/lambda'
import {secondsAgo, TIME} from '#utils/time'

export type { CleanupResult }

/** Terminal download statuses eligible for cleanup once past the retention window. */
const TERMINAL_DOWNLOAD_STATUSES: string[] = [DownloadStatus.Completed, DownloadStatus.Failed]

/** Retention window for device events before they are purged. */
const DEVICE_EVENT_RETENTION_DAYS = 90

const scheduled = defineScheduledHandler({operationName: 'CleanupExpiredRecords', schedule: {expression: 'cron(0 3 * * ? *)'}, timeout: 60})

export const handler = scheduled(async (): Promise<CleanupResult> => {
  metrics.addMetric('CleanupRun', MetricUnit.Count, 1)
  const span = startSpan('cleanup-records')
  const result: CleanupResult = {fileDownloadsDeleted: 0, sessionsDeleted: 0, verificationTokensDeleted: 0, deviceEventsDeleted: 0, errors: []}

  logInfo('CleanupExpiredRecords starting')

  try {
    result.fileDownloadsDeleted = await deleteExpiredFileDownloads(secondsAgo(TIME.DAY_SEC), TERMINAL_DOWNLOAD_STATUSES)
    logDebug('Cleaned up file downloads', {count: result.fileDownloadsDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup file downloads', {error: message})
    result.errors.push(`FileDownloads cleanup failed: ${message}`)
  }

  try {
    result.sessionsDeleted = await deleteExpiredSessions()
    logDebug('Cleaned up sessions', {count: result.sessionsDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup sessions', {error: message})
    result.errors.push(`Sessions cleanup failed: ${message}`)
  }

  try {
    result.verificationTokensDeleted = await deleteExpiredVerifications()
    logDebug('Cleaned up verification tokens', {count: result.verificationTokensDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup verification tokens', {error: message})
    result.errors.push(`Verification cleanup failed: ${message}`)
  }

  try {
    const cutoffTime = secondsAgo(DEVICE_EVENT_RETENTION_DAYS * TIME.DAY_SEC)
    result.deviceEventsDeleted = await deleteExpiredDeviceEvents(cutoffTime)
    logDebug('Cleaned up device events', {count: result.deviceEventsDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup device events', {error: message})
    result.errors.push(`DeviceEvents cleanup failed: ${message}`)
  }

  const totalDeleted = result.fileDownloadsDeleted + result.sessionsDeleted + result.verificationTokensDeleted + result.deviceEventsDeleted
  metrics.addMetric('RecordsCleanedUp', MetricUnit.Count, totalDeleted)
  addMetadata(span, 'fileDownloadsDeleted', result.fileDownloadsDeleted)
  addMetadata(span, 'sessionsDeleted', result.sessionsDeleted)
  addMetadata(span, 'verificationTokensDeleted', result.verificationTokensDeleted)
  addMetadata(span, 'deviceEventsDeleted', result.deviceEventsDeleted)
  addMetadata(span, 'totalDeleted', totalDeleted)
  addMetadata(span, 'errors', result.errors.length)
  endSpan(span)

  logInfo('CleanupExpiredRecords completed', result as unknown as Record<string, unknown>)
  return result
})
