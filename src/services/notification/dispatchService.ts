/**
 * Notification Dispatch Service
 *
 * Dispatches push notifications to users via SQS.
 * Handles metadata, download-started, and failure notifications.
 *
 * @see {@link file://../transformers.ts} for notification message construction
 */
import {getUserFilesByFileId} from '#entities/queries'
import {sendMessage} from '@j0nathan-ll0yd/aws'
import {logDebug, logInfo} from '@j0nathan-ll0yd/observability'
import {SqsQueueUrl} from '@j0nathan-ll0yd/core'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {
  createDownloadProgressNotification,
  createDownloadStartedNotification,
  createFailureNotification,
  createMetadataNotification
} from '#services/notification/transformers'
import type {YtDlpVideoInfo} from '#types/youtube'

/**
 * Dispatch MetadataNotification to all users waiting for a file.
 * Sends notifications via SQS to the push notification queue.
 *
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 */
export async function dispatchMetadataNotifications(fileId: string, videoInfo: YtDlpVideoInfo): Promise<void> {
  const queueUrl = SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))

  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping MetadataNotification')
    return
  }

  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createMetadataNotification(fileId, videoInfo, userId)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched MetadataNotifications', {fileId, succeeded: userIds.length - failed, failed})
}

/**
 * Dispatch DownloadStartedNotification to all users waiting for a file.
 * Sent when S3 download is about to begin (after metadata fetch succeeded).
 *
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 * @returns The list of userIds that were notified (for reuse in progress notifications)
 */
export async function dispatchDownloadStartedNotifications(fileId: string, videoInfo: YtDlpVideoInfo): Promise<string[]> {
  const queueUrl = SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))

  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping DownloadStartedNotification')
    return []
  }

  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createDownloadStartedNotification(fileId, videoInfo, userId)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched DownloadStartedNotifications', {fileId, succeeded: userIds.length - failed, failed})
  return userIds
}

/**
 * Dispatch DownloadProgressNotification to a pre-fetched list of users.
 * Reuses the userIds from dispatchDownloadStartedNotifications to avoid a DB round-trip per milestone.
 *
 * @param fileId - The video ID
 * @param progressPercent - Milestone percentage (25, 50, or 75)
 * @param userIds - Pre-fetched list of userIds waiting for this file
 */
export async function dispatchDownloadProgressNotifications(fileId: string, progressPercent: number, userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return
  }

  const queueUrl = SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))

  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createDownloadProgressNotification(fileId, progressPercent, userId)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched DownloadProgressNotifications', {fileId, percent: progressPercent, succeeded: userIds.length - failed, failed})
}

/**
 * Dispatch FailureNotification to all users waiting for a file.
 * Sends alert notifications via SQS to the push notification queue.
 *
 * @param fileId - The video ID
 * @param errorCategory - Error category (e.g., 'permanent', 'cookie_expired')
 * @param errorMessage - Human-readable error message
 * @param retryExhausted - Whether retry attempts have been exhausted
 * @param title - Optional video title (if available from metadata fetch)
 */
export async function dispatchFailureNotifications(
  fileId: string,
  errorCategory: string,
  errorMessage: string,
  retryExhausted: boolean,
  title?: string
): Promise<void> {
  const queueUrl = SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))

  const userFiles = await getUserFilesByFileId(fileId)
  const userIds = userFiles.map((uf) => uf.userId)

  if (userIds.length === 0) {
    logDebug('No users waiting for file, skipping FailureNotification')
    return
  }

  const results = await Promise.allSettled(userIds.map((userId) => {
    const {messageBody, messageAttributes} = createFailureNotification(fileId, errorCategory, errorMessage, retryExhausted, userId, title)
    return sendMessage({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes})
  }))
  const failed = results.filter((r) => r.status === 'rejected').length

  logInfo('Dispatched FailureNotifications', {fileId, succeeded: userIds.length - failed, failed})
}
