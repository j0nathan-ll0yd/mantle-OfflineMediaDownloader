/**
 * Push Notification Types
 *
 * Defines the payload structures for iOS push notifications sent via APNS.
 * These notifications inform the iOS app about file download progress.
 *
 * TypeScript interfaces are derived from Zod schemas in notification-schemas.ts.
 * Edit the schemas there — these types are inferred automatically.
 *
 * @see SendPushNotification Lambda for delivery implementation
 * @see notification-schemas.ts for Zod schema definitions
 * @see {@link https://github.com/j0nathan-ll0yd/mantle-OfflineMediaDownloader/wiki/iOS/Push-Notifications | Push Notification Guide}
 */
import type {Result} from '@j0nathan-ll0yd/core'
import type {z} from '@j0nathan-ll0yd/validation'
import type {
  downloadProgressPayloadSchema,
  downloadReadyPayloadSchema,
  downloadStartedPayloadSchema,
  failurePayloadSchema,
  metadataPayloadSchema,
  notificationTypeSchema
} from '#types/notification-schemas'

/**
 * Discriminated union type for file notification payloads.
 * Derived from notificationTypeSchema — edit the schema to add new types.
 * Used in SQS message attributes to route to appropriate handler.
 */
export type FileNotificationType = z.infer<typeof notificationTypeSchema>

/**
 * Notification sent when video metadata is fetched but download not yet complete.
 * Allows iOS app to show video info (title, author) while download proceeds.
 *
 * Sent by: StartFileUpload Lambda (after yt-dlp fetches video info)
 * Received by: iOS app to update UI with video metadata
 */
export type MetadataNotification = z.infer<typeof metadataPayloadSchema>

/**
 * Notification sent when the server begins downloading the video to S3.
 * Allows iOS app to show "downloading on server" status.
 *
 * Sent by: StartFileUpload Lambda (after metadata fetch, before S3 download)
 * Received by: iOS app to show server-side download progress indicator
 */
export type DownloadStartedNotification = z.infer<typeof downloadStartedPayloadSchema>

/**
 * Notification sent at 25%/50%/75% download milestones.
 * Allows iOS app to show server-side download progress.
 *
 * Sent by: StartFileUpload Lambda (during yt-dlp download, at 25% intervals)
 * Received by: iOS app to update progress indicator
 */
export type DownloadProgressNotification = z.infer<typeof downloadProgressPayloadSchema>

/**
 * Notification sent when download is complete and file is ready for streaming.
 * Allows iOS app to enable playback and show file size.
 *
 * Sent by: S3ObjectCreated Lambda (triggered by S3 upload completion)
 * Received by: iOS app to enable video playback
 */
export type DownloadReadyNotification = z.infer<typeof downloadReadyPayloadSchema>

/**
 * Notification sent when a download permanently fails.
 * Displayed as an alert notification to notify the user of the failure.
 *
 * Sent by: StartFileUpload Lambda (when download fails permanently)
 * Received by: iOS app to display failure alert
 */
export type FailureNotification = z.infer<typeof failurePayloadSchema>

/**
 * Success payload when a notification is delivered to a device.
 */
export interface DeviceNotified {
  /** Device ID that was targeted */
  deviceId: string
}

/**
 * Error payload when a notification fails to deliver to a device.
 */
export interface DeviceNotifyError {
  /** Device ID that was targeted */
  deviceId: string
  /** Error message describing the failure */
  error: string
  /** Whether the APNS endpoint is disabled (device unregistered) */
  endpointDisabled?: boolean
}

/**
 * Result of sending a notification to a single device.
 * Used by SendPushNotification handler to track delivery status.
 */
export type DeviceNotificationResult = Result<DeviceNotified, DeviceNotifyError>
