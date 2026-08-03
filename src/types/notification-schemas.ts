/**
 * Notification Payload Schemas
 *
 * Zod schemas for each push notification payload type.
 * Used for pre-send validation in transformers and as the source of truth
 * for TypeScript interfaces in notificationTypes.ts.
 *
 * @see notificationTypes.ts for derived TypeScript types
 * @see src/services/notification/transformers.ts for pre-send validation usage
 */
import {z} from '@j0nathan-ll0yd/validation'

/**
 * Notification type string enum — single source of truth for all valid types.
 * Replaces the inline z.enum([...]) in pushNotificationAttributesSchema.
 */
export const notificationTypeSchema = z.enum([
  'MetadataNotification',
  'DownloadStartedNotification',
  'DownloadProgressNotification',
  'DownloadReadyNotification',
  'FailureNotification'
])

/** MetadataNotification payload — full video details sent after yt-dlp metadata fetch */
export const metadataPayloadSchema = z.object({
  fileId: z.string(),
  key: z.string(),
  title: z.string(),
  authorName: z.string(),
  authorUser: z.string(),
  description: z.string(),
  publishDate: z.string(),
  contentType: z.string(),
  status: z.literal('pending'),
  thumbnailUrl: z.string().optional()
})

/** DownloadStartedNotification payload — sent when server begins downloading */
export const downloadStartedPayloadSchema = z.object({fileId: z.string(), title: z.string(), thumbnailUrl: z.string().optional()})

/** DownloadProgressNotification payload — sent at 25%/50%/75% milestones */
export const downloadProgressPayloadSchema = z.object({fileId: z.string(), progressPercent: z.number().int()})

/** DownloadReadyNotification payload — sent when S3 upload completes */
export const downloadReadyPayloadSchema = z.object({fileId: z.string(), key: z.string(), size: z.number().int(), url: z.string().url()})

/** FailureNotification payload — sent when download permanently fails */
export const failurePayloadSchema = z.object({
  fileId: z.string(),
  title: z.string().optional(),
  errorCategory: z.string(),
  errorMessage: z.string(),
  retryExhausted: z.boolean()
})
