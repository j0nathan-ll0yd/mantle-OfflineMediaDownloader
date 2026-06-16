/**
 * Notification Transformers
 *
 * Transforms domain objects into AWS-specific message formats for SQS and SNS/APNS.
 * This is an adapter layer that bridges domain models to infrastructure message formats.
 */
import {randomUUID} from 'node:crypto'
import type {File} from '#types/domainModels'
import type {DownloadReadyNotification, FailureNotification} from '#types/notificationTypes'
import {
  downloadProgressPayloadSchema,
  downloadReadyPayloadSchema,
  downloadStartedPayloadSchema,
  failurePayloadSchema,
  metadataPayloadSchema
} from '#types/notification-schemas'
import type {YtDlpVideoInfo} from '#types/youtube'
import {stringAttribute} from '@mantleframework/aws'

// PublishCommandInput is the SNS publish params shape
type PublishCommandInput = {
  Message: string
  MessageAttributes?: Record<string, {DataType: string; StringValue: string}>
  MessageStructure?: string
  TargetArn?: string
}
import type {MessageAttributeValue} from '@mantleframework/aws'

const MAX_DESCRIPTION_LENGTH = 500

/**
 * Truncates description to MAX_DESCRIPTION_LENGTH to fit within APNS payload limits
 */
export function truncateDescription(description: string): string {
  if (!description || description.length <= MAX_DESCRIPTION_LENGTH) {
    return description || ''
  }
  return description.slice(0, Math.max(0, MAX_DESCRIPTION_LENGTH - 3)) + '...'
}

/**
 * Creates MetadataNotification - full details, sent after fetchVideoInfo succeeds
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 * @param userId - User ID to send notification to
 * @returns SQS message body and attributes for routing
 */
export function createMetadataNotification(
  fileId: string,
  videoInfo: YtDlpVideoInfo,
  userId: string
): {messageBody: string; messageAttributes: Record<string, MessageAttributeValue>} {
  const file = metadataPayloadSchema.parse({
    fileId,
    key: `${fileId}.mp4`,
    title: videoInfo.title || '',
    authorName: videoInfo.uploader || 'Unknown',
    authorUser: (videoInfo.uploader || 'unknown').toLowerCase().replaceAll(/\s+/g, '_'),
    description: truncateDescription(videoInfo.description || ''),
    publishDate: videoInfo.upload_date || (new Date().toISOString().split('T')[0] ?? new Date().toISOString()),
    contentType: 'video/mp4',
    status: 'pending',
    thumbnailUrl: videoInfo.thumbnail || undefined
  })
  return {
    messageBody: JSON.stringify({file, notificationType: 'MetadataNotification', notificationId: randomUUID()}),
    messageAttributes: {userId: stringAttribute(userId), notificationType: stringAttribute('MetadataNotification')}
  }
}

/**
 * Creates DownloadStartedNotification - sent when S3 download begins
 * @param fileId - The video ID
 * @param videoInfo - Video metadata from yt-dlp
 * @param userId - User ID to send notification to
 * @returns SQS message body and attributes for routing
 */
export function createDownloadStartedNotification(
  fileId: string,
  videoInfo: YtDlpVideoInfo,
  userId: string
): {messageBody: string; messageAttributes: Record<string, MessageAttributeValue>} {
  const file = downloadStartedPayloadSchema.parse({fileId, title: videoInfo.title || '', thumbnailUrl: videoInfo.thumbnail})
  return {
    messageBody: JSON.stringify({file, notificationType: 'DownloadStartedNotification', notificationId: randomUUID()}),
    messageAttributes: {userId: stringAttribute(userId), notificationType: stringAttribute('DownloadStartedNotification')}
  }
}

/**
 * Creates DownloadProgressNotification - sent at 25%/50%/75% download milestones
 * @param fileId - The video ID
 * @param percent - Download progress percentage (25, 50, or 75)
 * @param userId - User ID to send notification to
 * @returns SQS message body and attributes for routing
 */
export function createDownloadProgressNotification(
  fileId: string,
  percent: number,
  userId: string
): {messageBody: string; messageAttributes: Record<string, MessageAttributeValue>} {
  const file = downloadProgressPayloadSchema.parse({fileId, progressPercent: percent})
  return {
    messageBody: JSON.stringify({file, notificationType: 'DownloadProgressNotification', notificationId: randomUUID()}),
    messageAttributes: {userId: stringAttribute(userId), notificationType: stringAttribute('DownloadProgressNotification')}
  }
}

/**
 * Creates DownloadReadyNotification - minimal, sent after S3 upload completes
 * @param dbFile - File record from DynamoDB
 * @param userId - User ID to send notification to
 * @returns SQS message body and attributes for routing
 */
export function createDownloadReadyNotification(
  dbFile: File,
  userId: string
): {messageBody: string; messageAttributes: Record<string, MessageAttributeValue>} {
  const file = downloadReadyPayloadSchema.parse({fileId: dbFile.fileId, key: dbFile.key, size: dbFile.size, url: dbFile.url})
  return {
    messageBody: JSON.stringify({file, notificationType: 'DownloadReadyNotification', notificationId: randomUUID()}),
    messageAttributes: {userId: stringAttribute(userId), notificationType: stringAttribute('DownloadReadyNotification')}
  }
}

/**
 * Creates FailureNotification - sent when download permanently fails
 * @param fileId - The video ID
 * @param errorCategory - Error category (e.g., 'permanent', 'cookie_expired')
 * @param errorMessage - Human-readable error message
 * @param retryExhausted - Whether retry attempts have been exhausted
 * @param userId - User ID to send notification to
 * @param title - Optional video title (if available from metadata fetch)
 * @returns SQS message body and attributes for routing
 */
export function createFailureNotification(
  fileId: string,
  errorCategory: string,
  errorMessage: string,
  retryExhausted: boolean,
  userId: string,
  title?: string
): {messageBody: string; messageAttributes: Record<string, MessageAttributeValue>} {
  const file = failurePayloadSchema.parse({fileId, title, errorCategory, errorMessage, retryExhausted})
  return {
    messageBody: JSON.stringify({file, notificationType: 'FailureNotification', notificationId: randomUUID()}),
    messageAttributes: {userId: stringAttribute(userId), notificationType: stringAttribute('FailureNotification')}
  }
}

/**
 * Transform SQS message body (JSON) to APNS background push notification
 * Supports MetadataNotification and DownloadReadyNotification types
 * @param messageBody - JSON string containing file and notificationType
 * @param targetArn - SNS endpoint ARN for the device
 * @returns SNS PublishInput for APNS background notification
 */
export function transformToAPNSNotification(messageBody: string, targetArn: string): PublishCommandInput {
  const payload = JSON.parse(messageBody)
  return {
    Message: JSON.stringify({
      APNS_SANDBOX: JSON.stringify({
        aps: {'content-available': 1},
        notificationType: payload.notificationType,
        notificationId: payload.notificationId,
        file: payload.file
      }),
      default: 'Default message'
    }),
    MessageAttributes: {
      'AWS.SNS.MOBILE.APNS.PRIORITY': {DataType: 'String', StringValue: '5'},
      'AWS.SNS.MOBILE.APNS.PUSH_TYPE': {DataType: 'String', StringValue: 'background'}
    },
    MessageStructure: 'json',
    TargetArn: targetArn
  }
}

/**
 * Transform SQS message body (JSON) to APNS alert push notification
 * Used for FailureNotification and DownloadReadyNotification types that require user attention
 * @param messageBody - JSON string containing file and notificationType
 * @param targetArn - SNS endpoint ARN for the device
 * @returns SNS PublishInput for APNS alert notification
 */
export function transformToAPNSAlertNotification(messageBody: string, targetArn: string): PublishCommandInput {
  const payload = JSON.parse(messageBody)
  const notificationType = payload.notificationType as string

  let title: string
  let subtitle: string
  let body: string

  if (notificationType === 'DownloadReadyNotification') {
    const file = payload.file as DownloadReadyNotification
    title = 'Download Ready'
    subtitle = file.key
    body = 'Your file is ready to play.'
  } else {
    // FailureNotification
    const file = payload.file as FailureNotification
    title = 'Download Failed'
    subtitle = file.title || file.fileId
    body = file.retryExhausted
      ? `Failed after multiple attempts: ${file.errorMessage}`
      : `Unable to download: ${file.errorMessage}`
  }

  return {
    Message: JSON.stringify({
      APNS_SANDBOX: JSON.stringify({
        aps: {alert: {title, subtitle, body}, sound: 'default', 'mutable-content': 1},
        notificationType: payload.notificationType,
        notificationId: payload.notificationId,
        file: payload.file
      }),
      default: 'Default message'
    }),
    MessageAttributes: {
      'AWS.SNS.MOBILE.APNS.PRIORITY': {DataType: 'String', StringValue: '10'},
      'AWS.SNS.MOBILE.APNS.PUSH_TYPE': {DataType: 'String', StringValue: 'alert'}
    },
    MessageStructure: 'json',
    TargetArn: targetArn
  }
}
