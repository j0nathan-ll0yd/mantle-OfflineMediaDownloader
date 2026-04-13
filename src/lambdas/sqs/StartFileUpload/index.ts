/**
 * StartFileUpload Lambda
 *
 * Downloads YouTube videos to S3 using yt-dlp. Processes messages from
 * the download queue, handles retries, and publishes completion events.
 *
 * Trigger: SQS DownloadQueue (via EventBridge)
 * Input: SQSEvent with DownloadQueueMessage records
 * Output: SQSBatchResponse with item failures for retry
 */
import {createFileDownload, getFile, getFileDownload, getUserFilesByFileId, updateFile, updateFileDownload} from '#entities/queries'
import {headObject} from '@mantleframework/aws'
import {sendMessage} from '@mantleframework/aws'
import {defineLambda, emitEvent, isOk, S3BucketName} from '@mantleframework/core'
import {defineSqsHandler} from '@mantleframework/core'
import {addAnnotation, addMetadata, endSpan, logDebug, logError, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
import {downloadVideoToS3, fetchVideoInfo} from '#services/youtube/youtube'
import type {File} from '#types/domainModels'
import type {DownloadCompletedDetail, DownloadFailedDetail} from '#types/events'
import type {DownloadFailureResult} from '#types/lambda'
import type {FetchVideoInfoResult, VideoErrorClassification} from '#types/video'
import type {YtDlpVideoInfo} from '#types/youtube'
import {downloadQueueMessageSchema, type ValidatedDownloadQueueMessage} from '#types/schemas'
import {DownloadStatus, FileStatus} from '#types/enums'
import {validateSchema} from '@mantleframework/validation'
import {getRequiredEnv} from '@mantleframework/env'
import {UnexpectedError} from '@mantleframework/errors'
import {closeCookieExpirationIssueIfResolved, createCookieExpirationIssue, createVideoDownloadFailureIssue} from '#integrations/github/issueService'
import {createDownloadStartedNotification, createFailureNotification, createMetadataNotification} from '#services/notification/transformers'
import {classifyVideoError, isRetryExhausted} from '#domain/video/errorClassifier'
import {CircuitBreaker} from '@mantleframework/resilience'

defineLambda({
  packageType: 'container',
  dockerfile: 'Dockerfile.download',
  architecture: 'x86_64',
  memorySize: 2048,
  ephemeralStorage: 10240,
  timeout: 900,
  reservedConcurrency: 1,
  secrets: {GITHUB_PERSONAL_TOKEN: 'github.issue.token'},
  staticEnvVars: {
    YTDLP_BINARY_PATH: '/opt/bin/yt-dlp',
    YTDLP_COOKIES_PATH: '/opt/cookies/youtube-cookies.txt',
    YTDLP_SLEEP_REQUESTS: '1',
    YTDLP_SLEEP_INTERVAL: '2',
    YTDLP_MAX_SLEEP_INTERVAL: '5',
    AWS_SDK_UA_APP_ID: 'StartFileUpload'
  }
})

const youtubeCircuitBreaker = new CircuitBreaker({name: 'youtube'})
import {upsertFile} from './file-helpers'

/**
 * Fetch video info with OpenTelemetry tracing and circuit breaker protection.
 * Wraps fetchVideoInfo with circuit breaker to prevent cascading failures
 * when YouTube/yt-dlp is degraded.
 *
 * @param fileUrl - The video URL to fetch info for
 * @param fileId - The file ID for annotation
 * @returns The video info result
 * @throws CircuitBreakerOpenError if circuit is open
 */
async function fetchVideoInfoTraced(fileUrl: string, fileId: string): Promise<FetchVideoInfoResult> {
  const span = startSpan('yt-dlp-fetch-info')

  // Use circuit breaker to protect against cascading failures from YouTube/yt-dlp.
  // Circuit breaker tracks actual exceptions (network errors, timeouts, rate limits).
  // Business-level failures (success: false) are handled by the caller, not the circuit breaker.
  const result = await youtubeCircuitBreaker.execute(() => fetchVideoInfo(fileUrl)) as FetchVideoInfoResult

  addAnnotation(span, 'videoId', fileId)
  addMetadata(span, 'videoUrl', fileUrl)
  addMetadata(span, 'success', isOk(result))
  endSpan(span)

  return result
}

/**
 * Download video to S3 with OpenTelemetry tracing and circuit breaker protection.
 * Wraps downloadVideoToS3 with circuit breaker to prevent cascading failures
 * when YouTube/yt-dlp is degraded.
 *
 * @param fileUrl - The video URL to download
 * @param bucket - The S3 bucket to upload to
 * @param fileName - The S3 object key
 * @returns Object with fileSize, s3Url, and duration
 * @throws CircuitBreakerOpenError if circuit is open
 */
async function downloadVideoToS3Traced(
  fileUrl: string,
  bucket: S3BucketName,
  fileName: string
): Promise<{fileSize: number; s3Url: string; duration: number}> {
  const span = startSpan('yt-dlp-download-to-s3')
  try {
    // Use circuit breaker to protect against cascading failures
    const result = await youtubeCircuitBreaker.execute(() => downloadVideoToS3(fileUrl, bucket, fileName)) as {
      fileSize: number
      s3Url: string
      duration: number
    }
    addAnnotation(span, 's3Bucket', bucket)
    addAnnotation(span, 's3Key', fileName)
    addMetadata(span, 'fileSize', result.fileSize)
    addMetadata(span, 'duration', result.duration)
    endSpan(span)
    return result
  } catch (error) {
    endSpan(span, error as Error)
    throw error
  }
}

/**
 * Check if a file already exists in S3 and return its metadata.
 * Used for recovery when database records are missing but S3 file exists.
 *
 * @param bucket - The S3 bucket name
 * @param key - The S3 object key (e.g., 'dQw4w9WgXcQ.mp4')
 * @returns Object with exists flag and size, or exists: false if not found
 */
async function checkS3FileExists(bucket: S3BucketName, key: string): Promise<{exists: true; size: number} | {exists: false}> {
  try {
    const response = await headObject({Bucket: bucket, Key: key})
    const size = response.ContentLength ?? 0
    if (size > 0) {
      return {exists: true, size}
    }
    // Zero-size file is treated as not existing (likely corrupted)
    return {exists: false}
  } catch {
    // NotFound or other errors - file doesn't exist
    return {exists: false}
  }
}

/**
 * Recover file state from S3 when database records are missing.
 * Creates File and FileDownload records, sends notifications to users.
 *
 * @param message - The download request message
 * @param s3Size - File size from S3 headObject
 */
async function recoverFromS3(message: ValidatedDownloadQueueMessage, s3Size: number): Promise<void> {
  const {fileId, correlationId, sourceUrl} = message
  const fileUrl = sourceUrl || `https://www.youtube.com/watch?v=${fileId}`
  const fileName = `${fileId}.mp4`
  const cloudfrontDomain = getRequiredEnv('CLOUDFRONT_DOMAIN')

  logInfo('Recovering file from S3', {fileId, correlationId, s3Size})
  metrics.addMetric('S3FileRecoveryAttempt', MetricUnit.Count, 1)

  // Try to fetch video metadata from YouTube for better user experience
  let videoInfo: YtDlpVideoInfo | undefined
  try {
    const videoInfoResult = await fetchVideoInfoTraced(fileUrl, fileId)
    if (isOk(videoInfoResult)) {
      videoInfo = videoInfoResult.value
      // Send MetadataNotification to users
      await dispatchMetadataNotifications(fileId, videoInfo)
    }
  } catch (error) {
    logInfo('YouTube metadata fetch failed during recovery, using minimal metadata', {fileId, error: String(error)})
  }

  // Create File record with either YouTube metadata or minimal S3 metadata
  const fileData: File = {
    fileId,
    key: fileName,
    size: s3Size,
    authorName: videoInfo?.uploader || 'Unknown',
    authorUser: (videoInfo?.uploader || 'unknown').toLowerCase().replace(/\s+/g, '_'),
    title: videoInfo?.title || fileId,
    description: videoInfo?.description || '',
    publishDate: videoInfo?.upload_date || new Date().toISOString(),
    contentType: 'video/mp4',
    status: FileStatus.Downloaded,
    url: `https://${cloudfrontDomain}/${fileName}`
  }

  logDebug('upsertFile (recovery) <=', fileData as unknown as Record<string, unknown>)
  await upsertFile(fileData)

  // Create FileDownload record marked as Completed
  await updateDownloadState(fileId, DownloadStatus.Completed)

  // Publish DownloadCompleted event for observability
  const completedDetail: DownloadCompletedDetail = {fileId, correlationId, s3Key: fileName, fileSize: s3Size, completedAt: new Date().toISOString()}
  await emitEvent({detailType: 'DownloadCompleted', detail: completedDetail})

  metrics.addMetric('S3FileRecoverySuccess', MetricUnit.Count, 1)
  logInfo('File recovered from S3 successfully', {fileId, correlationId, s3Size, hasYouTubeMetadata: !!videoInfo})
}

/**
 * Update FileDownload entity with current download state.
 * This is the transient state that tracks retry attempts, errors, and scheduling.
 * Cleanup handled by CleanupExpiredRecords scheduled Lambda.
 */
async function updateDownloadState(fileId: string, status: DownloadStatus, classification?: VideoErrorClassification, retryCount = 0): Promise<void> {
  const update: Record<string, unknown> = {status, retryCount}
  if (classification) {
    update.errorCategory = classification.category
    update.lastError = classification.reason
    update.maxRetries = classification.maxRetries ?? 5
    if (classification.retryAfter) {
      // Convert Unix epoch timestamp to Date
      update.retryAfter = new Date(classification.retryAfter * 1000)
    }
  }

  // Check if record exists
  const existing = await getFileDownload(fileId)

  if (existing) {
    logDebug('updateFileDownload <=', {fileId, update})
    const result = await updateFileDownload(fileId, update)
    logDebug('updateFileDownload =>', result)
  } else {
    // Create new record
    const createData = {
      fileId,
      status,
      retryCount,
      maxRetries: classification?.maxRetries ?? 5,
      errorCategory: classification?.category,
      lastError: classification?.reason,
      retryAfter: classification?.retryAfter ? new Date(classification.retryAfter * 1000) : null,
      sourceUrl: `https://www.youtube.com/watch?v=${fileId}`
    }
    logDebug('createFileDownload <=', createData)
    const result = await createFileDownload(createData)
    logDebug('createFileDownload =>', result)
  }
}

/**
 * Dispatch MetadataNotification to all users waiting for this file.
 * Sends notifications via SQS to the push notification queue.
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 */
async function dispatchMetadataNotifications(fileId: string, videoInfo: YtDlpVideoInfo): Promise<void> {
  const queueUrl = getRequiredEnv('SNS_QUEUE_URL')

  // Get all users waiting for this file
  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping MetadataNotification')
    return
  }

  // Send MetadataNotification to each user
  // Use Promise.allSettled so one SQS error doesn't stop other user notifications
  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createMetadataNotification(fileId, videoInfo, userId)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched MetadataNotifications', {fileId, succeeded: userIds.length - failed, failed})
}

/**
 * Dispatch DownloadStartedNotification to all users waiting for this file.
 * Sent when S3 download is about to begin (after metadata fetch succeeded).
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 */
async function dispatchDownloadStartedNotifications(fileId: string, videoInfo: YtDlpVideoInfo): Promise<void> {
  const queueUrl = getRequiredEnv('SNS_QUEUE_URL')

  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping DownloadStartedNotification')
    return
  }

  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createDownloadStartedNotification(fileId, videoInfo, userId)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched DownloadStartedNotifications', {fileId, succeeded: userIds.length - failed, failed})
}

/**
 * Dispatch FailureNotification to all users waiting for this file.
 * Sends alert notifications via SQS to the push notification queue.
 * @param fileId - The video ID
 * @param errorCategory - Error category (e.g., 'permanent', 'cookie_expired')
 * @param errorMessage - Human-readable error message
 * @param retryExhausted - Whether retry attempts have been exhausted
 * @param title - Optional video title (if available from metadata fetch)
 */
async function dispatchFailureNotifications(
  fileId: string,
  errorCategory: string,
  errorMessage: string,
  retryExhausted: boolean,
  title?: string
): Promise<void> {
  const queueUrl = getRequiredEnv('SNS_QUEUE_URL')

  // Get all users waiting for this file
  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping FailureNotification')
    return
  }

  // Send FailureNotification to each user
  // Use Promise.allSettled so one SQS error doesn't stop other user notifications
  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createFailureNotification(fileId, errorCategory, errorMessage, retryExhausted, userId, title)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched FailureNotifications', {fileId, succeeded: userIds.length - failed, failed})
}

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
async function handleDownloadFailure(
  fileId: string,
  fileUrl: string,
  error: Error,
  correlationId: string,
  videoInfoResult: FetchVideoInfoResult,
  existingRetryCount: number,
  existingMaxRetries: number
): Promise<DownloadFailureResult> {
  // Classify the error to determine retry strategy
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

  // Publish DownloadFailed event for observability
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

  // Handle retryable errors - let SQS handle retry via visibility timeout
  if (classification.retryable && !isRetryExhausted(newRetryCount, maxRetries)) {
    await updateDownloadState(fileId, DownloadStatus.Scheduled, classification, newRetryCount)

    metrics.addMetric('ScheduledVideoDetected', MetricUnit.Count, 1)
    const retryMetric = metrics.singleMetric()
    retryMetric.addDimension('Category', classification.category)
    retryMetric.addMetric('RetryScheduled', MetricUnit.Count, 1)

    logInfo(`Will retry via SQS for ${fileId}`, {reason: classification.reason, retryCount: newRetryCount})

    return {shouldRetry: true, classification}
  }

  // Handle permanent failures or retry exhaustion
  await updateDownloadState(fileId, DownloadStatus.Failed, classification, newRetryCount)

  // Update File entity status to Failed (only if file record exists)
  // We can't upsert with just fileId+status since schema requires all fields
  try {
    const existingFile = await getFile(fileId)
    if (existingFile) {
      await updateFile(fileId, {status: FileStatus.Failed})
    }
  } catch (updateError) {
    const message = updateError instanceof Error ? updateError.message : String(updateError)
    logDebug('Failed to update File entity status', {message})
  }

  // Dispatch FailureNotification to all users waiting for this file
  const videoTitle = isOk(videoInfoResult) ? videoInfoResult.value.title : undefined
  await dispatchFailureNotifications(fileId, classification.category, classification.reason, isRetryExhausted(newRetryCount, maxRetries), videoTitle)

  const failureMetric = metrics.singleMetric()
  failureMetric.addDimension('ErrorType', error.constructor.name)
  failureMetric.addMetric('LambdaExecutionFailure', MetricUnit.Count, 1)

  // Create GitHub issues for actionable failures
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
 * Process a single download request from SQS.
 *
 * Architecture:
 * - FileDownloads entity: Tracks transient download state (retries, scheduling, errors)
 * - Files entity: Stores permanent media metadata (only updated on success)
 *
 * Flow:
 * 1. Mark download as in_progress
 * 2. Fetch video info (safe - never throws)
 * 3. If fetch failed -\> classify -\> throw for SQS retry or return for removal
 * 4. If fetch succeeded -\> stream to S3
 * 5. If stream failed -\> classify -\> throw for SQS retry or return for removal
 * 6. If stream succeeded -\> update Files entity, publish DownloadCompleted event
 *
 * @param message - The download request from SQS
 * @param receiveCount - SQS ApproximateReceiveCount
 * @throws Error if the download should be retried via SQS
 */
async function processDownloadRequest(message: ValidatedDownloadQueueMessage, receiveCount: number = 1): Promise<void> {
  const {fileId, correlationId, sourceUrl} = message
  const fileUrl = sourceUrl || `https://www.youtube.com/watch?v=${fileId}`
  const isRetry = receiveCount > 1

  // Check if file already exists in S3 (recovery path for missing DB records)
  const bucket = S3BucketName(getRequiredEnv('BUCKET'))
  const fileName = `${fileId}.mp4`
  const s3Check = await checkS3FileExists(bucket, fileName)

  if (s3Check.exists) {
    logInfo('File already exists in S3, recovering database state', {fileId, correlationId, s3Size: s3Check.size})
    await recoverFromS3(message, s3Check.size)
    return // Skip download - file already in S3
  }

  // Log prominently if this is a retry attempt
  if (isRetry) {
    logInfo('RETRY: Processing download request', {fileId, correlationId, receiveCount, isRetry: true})
    metrics.addMetric('DownloadRetryAttempt', MetricUnit.Count, 1)
  } else {
    logInfo('Processing download request', {fileId, correlationId, receiveCount})
  }

  // Get existing download state for retry counting
  let existingRetryCount = 0
  let existingMaxRetries = 5
  logDebug('getFileDownload <=', {fileId})
  const existingDownload = await getFileDownload(fileId)
  logDebug('getFileDownload =>', (existingDownload as unknown as Record<string, unknown>) ?? {found: false})
  if (existingDownload) {
    existingRetryCount = existingDownload.retryCount ?? 0
    existingMaxRetries = existingDownload.maxRetries ?? 5
    // Log the previous failure state for visibility
    if (existingDownload.lastError) {
      logInfo('Previous failure state', {
        fileId,
        previousStatus: existingDownload.status,
        previousError: existingDownload.lastError,
        errorCategory: existingDownload.errorCategory,
        retryCount: existingRetryCount,
        maxRetries: existingMaxRetries
      })
    }
  }

  // Mark download as in_progress
  await updateDownloadState(fileId, DownloadStatus.InProgress, undefined, existingRetryCount)

  // Step 1: Fetch video info (safe - never throws)
  logDebug('fetchVideoInfo <=', {fileUrl})
  const videoInfoResult = await fetchVideoInfoTraced(fileUrl, fileId)

  if (!isOk(videoInfoResult)) {
    const error = videoInfoResult.error.error ?? new UnexpectedError('Failed to fetch video info')
    const result = await handleDownloadFailure(fileId, fileUrl, error, correlationId, videoInfoResult, existingRetryCount, existingMaxRetries)
    if (result.shouldRetry) {
      throw error // Throw to trigger SQS retry
    }
    return // Permanent failure - remove from queue
  }

  const videoInfo = videoInfoResult.value
  logDebug('fetchVideoInfo =>', {
    id: videoInfo.id,
    title: videoInfo.title,
    duration: videoInfo.duration,
    formatCount: videoInfo.formats?.length,
    upload_date: videoInfo.upload_date,
    view_count: videoInfo.view_count
  })

  // Dispatch MetadataNotification to all users waiting for this file
  await dispatchMetadataNotifications(fileId, videoInfo)

  // Set file status to Downloading (fills the existing enum gap)
  await updateFile(fileId, {status: FileStatus.Downloading})

  // Dispatch DownloadStartedNotification to all users
  await dispatchDownloadStartedNotifications(fileId, videoInfo)

  // Step 2: Prepare for download (bucket already declared above for S3 check)

  // Step 3: Download video to S3
  logDebug('downloadVideoToS3 <=', {url: fileUrl, bucket, key: fileName})
  let uploadResult
  try {
    uploadResult = await downloadVideoToS3Traced(fileUrl, bucket, fileName)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const result = await handleDownloadFailure(fileId, fileUrl, err, correlationId, videoInfoResult, existingRetryCount, existingMaxRetries)
    if (result.shouldRetry) {
      throw err // Throw to trigger SQS retry
    }
    return // Permanent failure - remove from queue
  }
  logDebug('downloadVideoToS3 =>', uploadResult)

  // Step 4: Update permanent File entity with metadata (only on success)
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
    // Rich metadata fields (Issue #151)
    duration: videoInfo.duration,
    uploadDate: videoInfo.upload_date,
    viewCount: videoInfo.view_count,
    thumbnailUrl: videoInfo.thumbnail
  }

  logDebug('upsertFile <=', fileData as unknown as Record<string, unknown>)
  await upsertFile(fileData)

  // Step 5: Mark download as completed
  await updateDownloadState(fileId, DownloadStatus.Completed, undefined, existingRetryCount)

  // Step 6: Publish DownloadCompleted event
  const completedDetail: DownloadCompletedDetail = {
    fileId,
    correlationId,
    s3Key: fileName,
    fileSize: uploadResult.fileSize,
    completedAt: new Date().toISOString()
  }
  await emitEvent({detailType: 'DownloadCompleted', detail: completedDetail})

  metrics.addMetric('LambdaExecutionSuccess', MetricUnit.Count, 1)

  // Asynchronously close any open cookie expiration issues (self-healing)
  // Don't await - this is best-effort and shouldn't block the response
  closeCookieExpirationIssueIfResolved().catch(() => {
    // Ignore errors - this is non-critical
  })

  logInfo('Download completed successfully', {fileId, correlationId, fileSize: uploadResult.fileSize})
}

const sqs = defineSqsHandler({operationName: 'StartFileUpload', parseBody: true, timeout: 900, memorySize: 2048, queue: 'DownloadQueue'})

export const handler = sqs(async (record) => {
  // SQS provides ApproximateReceiveCount - how many times this message has been received
  const receiveCount = parseInt(record.attributes?.ApproximateReceiveCount ?? '1', 10)

  // Validate body against schema
  const validationResult = validateSchema(downloadQueueMessageSchema, record.body)
  if (!validationResult.success) {
    // Log invalid message format and return (don't throw - malformed messages will never succeed)
    logError('Invalid SQS message format - discarding', {messageId: record.messageId, errors: validationResult.errors})
    return
  }

  const message = validationResult.data as ValidatedDownloadQueueMessage
  await processDownloadRequest(message, receiveCount)
})
