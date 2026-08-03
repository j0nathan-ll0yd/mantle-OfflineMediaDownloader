/**
 * Download Failure Handler
 *
 * Classifies download errors, updates state, publishes events,
 * and determines whether to retry or permanently fail.
 */
import {getFile, updateFile} from '#entities/queries'
import {emitEvent, isOk} from '@j0nathan-ll0yd/core'
import {logDebug, logInfo, metrics, MetricUnit} from '@j0nathan-ll0yd/observability'
import type {DownloadFailedDetail} from '#types/events'
import type {DownloadFailureResult} from '#types/lambda'
import type {FetchVideoInfoResult} from '#types/video'
import {DownloadStatus, FileStatus} from '#types/enums'
import {classifyVideoError, isRetryExhausted} from '#domain/video/errorClassifier'
import {closeCookieExpirationIssueIfResolved, createCookieExpirationIssue, createVideoDownloadFailureIssue} from '#integrations/github/issueService'
import {dispatchFailureNotifications} from '#services/notification/dispatchService'
import {updateDownloadState} from '#services/download/stateManager'

/**
 * Handle download failure: classify error, update state, publish event, and determine next action.
 *
 * For SQS-triggered downloads:
 * - Transient errors: Update state, publish DownloadFailed event, throw to trigger SQS retry
 * - Permanent errors: Update state, publish DownloadFailed event, return success (removes from queue)
 *
 * @param fileId - The file ID that failed to download
 * @param fileUrl - The source video URL
 * @param error - The error that occurred
 * @param correlationId - Correlation ID for tracing
 * @param videoInfoResult - The video info fetch result
 * @param existingRetryCount - Current retry count for this download
 * @param existingMaxRetries - Maximum retries allowed
 * @returns Result indicating whether to retry
 */
export async function handleDownloadFailure(
  fileId: string,
  fileUrl: string,
  error: Error,
  correlationId: string,
  videoInfoResult: FetchVideoInfoResult,
  existingRetryCount: number,
  existingMaxRetries: number
): Promise<DownloadFailureResult> {
  const classification = classifyVideoError(error, isOk(videoInfoResult) ? videoInfoResult.value : undefined, existingRetryCount)
  const newRetryCount = existingRetryCount + 1
  const maxRetries = classification.maxRetries ?? existingMaxRetries

  logInfo('Download failure classified', {
    fileId,
    correlationId,
    category: classification.category,
    retryable: classification.retryable,
    reason: classification.reason,
    retryCount: newRetryCount,
    maxRetries
  })

  const failedDetail: DownloadFailedDetail = {
    fileId,
    correlationId,
    errorCategory: classification.category,
    errorMessage: classification.reason,
    retryable: classification.retryable && !isRetryExhausted(newRetryCount, maxRetries),
    retryCount: newRetryCount,
    failedAt: new Date().toISOString()
  }
  await emitEvent({detailType: 'DownloadFailed', detail: failedDetail})

  if (classification.retryable && !isRetryExhausted(newRetryCount, maxRetries)) {
    await updateDownloadState(fileId, DownloadStatus.Scheduled, classification, newRetryCount)

    metrics.addMetric('ScheduledVideoDetected', MetricUnit.Count, 1)
    const retryMetric = metrics.singleMetric()
    retryMetric.addDimension('Category', classification.category)
    retryMetric.addMetric('RetryScheduled', MetricUnit.Count, 1)

    logInfo(`Will retry via SQS for ${fileId}`, {reason: classification.reason, retryCount: newRetryCount})

    return {shouldRetry: true, classification}
  }

  await updateDownloadState(fileId, DownloadStatus.Failed, classification, newRetryCount)

  try {
    const existingFile = await getFile(fileId)
    if (existingFile) {
      await updateFile(fileId, {status: FileStatus.Failed})
    }
  } catch (updateError) {
    const message = updateError instanceof Error ? updateError.message : String(updateError)
    logDebug('Failed to update File entity status', {message})
  }

  const videoTitle = isOk(videoInfoResult) ? videoInfoResult.value.title : undefined
  await dispatchFailureNotifications(fileId, classification.category, classification.reason, isRetryExhausted(newRetryCount, maxRetries), videoTitle)

  const failureMetric = metrics.singleMetric()
  failureMetric.addDimension('ErrorType', error.constructor.name)
  failureMetric.addMetric('LambdaExecutionFailure', MetricUnit.Count, 1)

  if (classification.category === 'cookie_expired') {
    const cookieMetric = metrics.singleMetric()
    cookieMetric.addDimension('VideoId', fileId)
    cookieMetric.addMetric('CookieAuthenticationFailure', MetricUnit.Count, 1)
    await createCookieExpirationIssue(fileId, fileUrl, error)
  } else if (classification.category === 'permanent') {
    await createVideoDownloadFailureIssue(fileId, fileUrl, error, classification.reason)
  } else if (isRetryExhausted(newRetryCount, maxRetries)) {
    const exhaustedMetric = metrics.singleMetric()
    exhaustedMetric.addDimension('Category', classification.category)
    exhaustedMetric.addMetric('RetryExhausted', MetricUnit.Count, 1)
    logInfo(`Retry exhausted for ${fileId}`, {category: classification.category, retryCount: newRetryCount, maxRetries})
  }

  return {shouldRetry: false, classification}
}

/**
 * Close any open cookie expiration GitHub issues if download succeeds.
 * Best-effort, non-blocking operation.
 */
export function tryCloseCookieExpirationIssue(): void {
  void closeCookieExpirationIssueIfResolved().catch(() => {
    // Ignore errors - this is non-critical
  })
}
