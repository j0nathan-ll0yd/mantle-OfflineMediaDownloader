/**
 * Download Orchestrator
 *
 * Core download processing logic for StartFileUpload Lambda.
 * Coordinates the full download lifecycle: S3 check, video info fetch,
 * S3 upload, metadata update, and event emission.
 */
import {getFileDownload, updateFile} from '#entities/queries'
import {emitEvent, isOk, S3BucketName} from '@mantleframework/core'
import {logDebug, logInfo, metrics, MetricUnit} from '@mantleframework/observability'
import type {File} from '#types/domainModels'
import type {DownloadCompletedDetail} from '#types/events'
import type {ValidatedDownloadQueueMessage} from '#types/schemas'
import {DownloadStatus, FileStatus} from '#types/enums'
import {getRequiredEnv} from '@mantleframework/env'
import {UnexpectedError} from '@mantleframework/errors'
import {
  dispatchDownloadProgressNotifications,
  dispatchDownloadStartedNotifications,
  dispatchMetadataNotifications
} from '#services/notification/dispatchService'
import {handleDownloadFailure, tryCloseCookieExpirationIssue} from './failureHandler.js'
import {updateDownloadState} from '#services/download/stateManager'
import {checkS3FileExists, recoverFromS3} from './s3Recovery.js'
import {downloadVideoToS3Traced, fetchVideoInfoTraced} from '#services/download/youtubeTracing'
import {upsertFile} from './fileHelpers.js'

/**
 * Process a single download request from SQS.
 *
 * Flow:
 * 1. Check S3 for existing file (recovery path)
 * 2. Fetch video info via yt-dlp
 * 3. Stream video to S3
 * 4. Update File entity with metadata
 * 5. Publish DownloadCompleted event
 *
 * @param message - The download request from SQS
 * @param receiveCount - SQS ApproximateReceiveCount
 * @throws Error if the download should be retried via SQS
 */
export async function processDownloadRequest(message: ValidatedDownloadQueueMessage, receiveCount: number = 1): Promise<void> {
  const {fileId, correlationId, sourceUrl} = message
  const fileUrl = sourceUrl || `https://www.youtube.com/watch?v=${fileId}`
  const isRetry = receiveCount > 1
  const bucket = S3BucketName(getRequiredEnv('BUCKET'))
  const fileName = `${fileId}.mp4`

  // Check if file already exists in S3 (recovery path)
  const s3Check = await checkS3FileExists(bucket, fileName)
  if (s3Check.exists) {
    logInfo('File already exists in S3, recovering database state', {fileId, correlationId, s3Size: s3Check.size})
    await recoverFromS3(message, s3Check.size)
    return
  }

  if (isRetry) {
    logInfo('RETRY: Processing download request', {fileId, correlationId, receiveCount, isRetry: true})
    metrics.addMetric('DownloadRetryAttempt', MetricUnit.Count, 1)
  } else {
    logInfo('Processing download request', {fileId, correlationId, receiveCount})
  }

  const {retryCount: existingRetryCount, maxRetries: existingMaxRetries} = await getExistingDownloadState(fileId)

  await updateDownloadState(fileId, DownloadStatus.InProgress, undefined, existingRetryCount)

  // Step 1: Fetch video info
  logDebug('fetchVideoInfo <=', {fileUrl})
  const videoInfoResult = await fetchVideoInfoTraced(fileUrl, fileId)

  if (!isOk(videoInfoResult)) {
    const error = videoInfoResult.error.error ?? new UnexpectedError('Failed to fetch video info')
    const result = await handleDownloadFailure(fileId, fileUrl, error, correlationId, videoInfoResult, existingRetryCount, existingMaxRetries)
    if (result.shouldRetry) {
      throw error
    }
    return
  }

  const videoInfo = videoInfoResult.value
  logDebug('fetchVideoInfo =>', {id: videoInfo.id, title: videoInfo.title, duration: videoInfo.duration, formatCount: videoInfo.formats?.length})

  await dispatchMetadataNotifications(fileId, videoInfo)
  await updateFile(fileId, {status: FileStatus.Downloading})

  // Dispatch DownloadStartedNotification; capture userIds for progress notifications
  const notifyUserIds = await dispatchDownloadStartedNotifications(fileId, videoInfo)

  // Step 2: Download video to S3
  logDebug('downloadVideoToS3 <=', {url: fileUrl, bucket, key: fileName})
  let uploadResult
  let lastDispatchedPercent = 0
  try {
    uploadResult = await downloadVideoToS3Traced(fileUrl, bucket, fileName, (percent) => {
      if (percent <= lastDispatchedPercent) {
        return
      }
      lastDispatchedPercent = percent
      // mantle-ignore: C58 — fire-and-forget; Lambda has 900s timeout, progress notifications are advisory
      dispatchDownloadProgressNotifications(fileId, percent, notifyUserIds).catch((err) => {
        logDebug('DownloadProgressNotification dispatch failed (non-critical)', {fileId, percent, error: err instanceof Error ? err.message : String(err)})
      })
    })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const result = await handleDownloadFailure(fileId, fileUrl, err, correlationId, videoInfoResult, existingRetryCount, existingMaxRetries)
    if (result.shouldRetry) {
      throw err
    }
    return
  }
  logDebug('downloadVideoToS3 =>', uploadResult)

  // Step 3: Update permanent File entity with metadata
  const cloudfrontDomain = getRequiredEnv('CLOUDFRONT_DOMAIN')
  const fileData: File = {
    fileId: videoInfo.id,
    key: fileName,
    size: uploadResult.fileSize,
    authorName: videoInfo.uploader || 'Unknown',
    authorUser: (videoInfo.uploader || 'unknown').toLowerCase().replace(/\s+/g, '_'),
    title: videoInfo.title,
    description: videoInfo.description || '',
    publishDate: videoInfo.upload_date || new Date().toISOString(),
    contentType: 'video/mp4',
    status: FileStatus.Downloaded,
    url: `https://${cloudfrontDomain}/${fileName}`,
    duration: videoInfo.duration,
    uploadDate: videoInfo.upload_date,
    viewCount: videoInfo.view_count,
    thumbnailUrl: videoInfo.thumbnail
  }

  logDebug('upsertFile <=', fileData as unknown as Record<string, unknown>)
  await upsertFile(fileData)
  await updateDownloadState(fileId, DownloadStatus.Completed, undefined, existingRetryCount)

  // Step 4: Publish completion event
  const completedDetail: DownloadCompletedDetail = {
    fileId,
    correlationId,
    s3Key: fileName,
    fileSize: uploadResult.fileSize,
    completedAt: new Date().toISOString()
  }
  await emitEvent({detailType: 'DownloadCompleted', detail: completedDetail})

  metrics.addMetric('LambdaExecutionSuccess', MetricUnit.Count, 1)
  tryCloseCookieExpirationIssue()

  logInfo('Download completed successfully', {fileId, correlationId, fileSize: uploadResult.fileSize})
}

/**
 * Retrieve existing download state for retry counting.
 * Returns default values if no prior download record exists.
 */
async function getExistingDownloadState(fileId: string): Promise<{retryCount: number; maxRetries: number}> {
  logDebug('getFileDownload <=', {fileId})
  const existingDownload = await getFileDownload(fileId)
  logDebug('getFileDownload =>', (existingDownload as unknown as Record<string, unknown>) ?? {found: false})

  if (!existingDownload) {
    return {retryCount: 0, maxRetries: 5}
  }

  if (existingDownload.lastError) {
    logInfo('Previous failure state', {
      fileId,
      previousStatus: existingDownload.status,
      previousError: existingDownload.lastError,
      errorCategory: existingDownload.errorCategory,
      retryCount: existingDownload.retryCount ?? 0,
      maxRetries: existingDownload.maxRetries ?? 5
    })
  }

  return {retryCount: existingDownload.retryCount ?? 0, maxRetries: existingDownload.maxRetries ?? 5}
}
