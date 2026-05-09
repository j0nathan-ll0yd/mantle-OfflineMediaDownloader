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
import {and, eq, lt, or} from '@mantleframework/database/orm'
import {addMetadata, endSpan, logDebug, logError, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
import {getDrizzleClient} from '#db/client'
import {deleteExpiredDeviceEvents} from '#entities/queries'
import {fileDownloads, sessions, verification} from '#db/schema'
import {DownloadStatus} from '#types/enums'
import type {CleanupResult} from '#types/lambda'
import {secondsAgo, TIME} from '#utils/time'

export type { CleanupResult }

/**
 * Deletes completed or failed FileDownloads older than 24 hours.
 * @returns Count of deleted records
 */
async function cleanupFileDownloads(): Promise<number> {
  const db = await getDrizzleClient()
  const cutoffTime = secondsAgo(TIME.DAY_SEC)

  // mantle-ignore: grandfathered(C10, #88, expires:2026-07-20)
  const result = await db.delete(fileDownloads).where(
    and(or(eq(fileDownloads.status, DownloadStatus.Completed), eq(fileDownloads.status, DownloadStatus.Failed)), lt(fileDownloads.updatedAt, cutoffTime))
  ).returning({fileId: fileDownloads.fileId})

  return result.length
}

/**
 * Deletes expired sessions.
 * Sessions now use TIMESTAMP WITH TIME ZONE for expiresAt.
 * @returns Count of deleted records
 */
async function cleanupSessions(): Promise<number> {
  const db = await getDrizzleClient()
  const now = new Date()

  // mantle-ignore: grandfathered(C10, #88, expires:2026-07-20)
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({id: sessions.id})

  return result.length
}

/**
 * Deletes expired verification tokens.
 * Verification table uses TIMESTAMP WITH TIME ZONE for expiresAt.
 * @returns Count of deleted records
 */
async function cleanupVerificationTokens(): Promise<number> {
  const db = await getDrizzleClient()
  const now = new Date()

  // mantle-ignore: grandfathered(C10, #88, expires:2026-07-20)
  const result = await db.delete(verification).where(lt(verification.expiresAt, now)).returning({id: verification.id})

  return result.length
}

const scheduled = defineScheduledHandler({operationName: 'CleanupExpiredRecords', schedule: {expression: 'cron(0 3 * * ? *)'}, timeout: 60})

export const handler = scheduled(async (): Promise<CleanupResult> => {
  metrics.addMetric('CleanupRun', MetricUnit.Count, 1)
  const span = startSpan('cleanup-records')
  const result: CleanupResult = {fileDownloadsDeleted: 0, sessionsDeleted: 0, verificationTokensDeleted: 0, deviceEventsDeleted: 0, errors: []}

  logInfo('CleanupExpiredRecords starting')

  try {
    result.fileDownloadsDeleted = await cleanupFileDownloads()
    logDebug('Cleaned up file downloads', {count: result.fileDownloadsDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup file downloads', {error: message})
    result.errors.push(`FileDownloads cleanup failed: ${message}`)
  }

  try {
    result.sessionsDeleted = await cleanupSessions()
    logDebug('Cleaned up sessions', {count: result.sessionsDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup sessions', {error: message})
    result.errors.push(`Sessions cleanup failed: ${message}`)
  }

  try {
    result.verificationTokensDeleted = await cleanupVerificationTokens()
    logDebug('Cleaned up verification tokens', {count: result.verificationTokensDeleted})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup verification tokens', {error: message})
    result.errors.push(`Verification cleanup failed: ${message}`)
  }

  try {
    const cutoffTime = secondsAgo(90 * TIME.DAY_SEC)
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
