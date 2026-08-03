/**
 * S3 Recovery Service
 *
 * Handles recovery of file state when S3 objects exist but database records are missing.
 * Used when a download completed but the database update failed.
 */
import {headObject} from '@j0nathan-ll0yd/aws'
import {CloudFrontDistributionId, emitEvent, isOk, S3BucketName} from '@j0nathan-ll0yd/core'
import {logDebug, logInfo, metrics, MetricUnit} from '@j0nathan-ll0yd/observability'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import type {File} from '#types/domainModels'
import type {DownloadCompletedDetail} from '#types/events'
import type {YtDlpVideoInfo} from '#types/youtube'
import type {ValidatedDownloadQueueMessage} from '#types/schemas'
import {DownloadStatus, FileStatus} from '#types/enums'
import {dispatchMetadataNotifications} from '#services/notification/dispatchService'
import {updateDownloadState} from '#services/download/stateManager'
import {fetchVideoInfoTraced} from '#services/download/youtubeTracing'
import {upsertFile} from './fileHelpers.js'

/**
 * Check if a file already exists in S3 and return its metadata.
 * Used for recovery when database records are missing but S3 file exists.
 *
 * @param bucket - The S3 bucket name
 * @param key - The S3 object key (e.g., 'dQw4w9WgXcQ.mp4')
 * @returns Object with exists flag and size, or exists: false if not found
 */
export async function checkS3FileExists(bucket: S3BucketName, key: string): Promise<{exists: true; size: number} | {exists: false}> {
  try {
    const response = await headObject({Bucket: bucket, Key: key})
    const size = response.ContentLength ?? 0
    if (size > 0) {
      return {exists: true, size}
    }
    return {exists: false}
  } catch {
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
export async function recoverFromS3(message: ValidatedDownloadQueueMessage, s3Size: number): Promise<void> {
  const {fileId, correlationId, sourceUrl} = message
  const fileUrl = sourceUrl || `https://www.youtube.com/watch?v=${fileId}`
  const fileName = `${fileId}.mp4`
  const cloudfrontDomain = CloudFrontDistributionId(getRequiredEnv('CLOUDFRONT_DOMAIN'))

  logInfo('Recovering file from S3', {fileId, correlationId, s3Size})
  metrics.addMetric('S3FileRecoveryAttempt', MetricUnit.Count, 1)

  let videoInfo: YtDlpVideoInfo | undefined
  try {
    const videoInfoResult = await fetchVideoInfoTraced(fileUrl, fileId)
    if (isOk(videoInfoResult)) {
      videoInfo = videoInfoResult.value
      await dispatchMetadataNotifications(fileId, videoInfo)
    }
  } catch (error) {
    logInfo('YouTube metadata fetch failed during recovery, using minimal metadata', {fileId, error: String(error)})
  }

  const fileData: File = {
    fileId,
    key: fileName,
    size: s3Size,
    authorName: videoInfo?.uploader || 'Unknown',
    authorUser: (videoInfo?.uploader || 'unknown').toLowerCase().replaceAll(/\s+/g, '_'),
    title: videoInfo?.title || fileId,
    description: videoInfo?.description || '',
    publishDate: videoInfo?.upload_date || new Date().toISOString(),
    contentType: 'video/mp4',
    status: FileStatus.Downloaded,
    url: `https://${cloudfrontDomain}/${fileName}`
  }

  logDebug('upsertFile (recovery) <=', fileData as unknown as Record<string, unknown>)
  await upsertFile(fileData)

  await updateDownloadState(fileId, DownloadStatus.Completed)

  const completedDetail: DownloadCompletedDetail = {fileId, correlationId, s3Key: fileName, fileSize: s3Size, completedAt: new Date().toISOString()}
  await emitEvent({detailType: 'DownloadCompleted', detail: completedDetail})

  metrics.addMetric('S3FileRecoverySuccess', MetricUnit.Count, 1)
  logInfo('File recovered from S3 successfully', {fileId, correlationId, s3Size, hasYouTubeMetadata: !!videoInfo})
}
