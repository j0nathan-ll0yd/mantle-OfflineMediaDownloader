/**
 * Push Notification Types
 *
 * Defines the payload structures for iOS push notifications sent via APNS.
 * These notifications inform the iOS app about file download progress.
 *
 * @see SendPushNotification Lambda for delivery implementation
 * @see {@link https://github.com/j0nathan-ll0yd/mantle-OfflineMediaDownloader/wiki/iOS/Push-Notifications | Push Notification Guide}
 */
import type {Result} from '@mantleframework/core'

/**
 * Discriminated union type for file notification payloads.
 * Used in SQS message attributes to route to appropriate handler.
 */
export type FileNotificationType = 'MetadataNotification' | 'DownloadReadyNotification' | 'FailureNotification' | 'DownloadStartedNotification'

/**
 * Notification sent when video metadata is fetched but download not yet complete.
 * Allows iOS app to show video info (title, author) while download proceeds.
 *
 * Sent by: StartFileUpload Lambda (after yt-dlp fetches video info)
 * Received by: iOS app to update UI with video metadata
 */
export interface MetadataNotification {
  /** YouTube video ID (e.g., 'dQw4w9WgXcQ') */
  fileId: string
  /** S3 object key (e.g., 'dQw4w9WgXcQ.mp4') */
  key: string
  /** Video title from YouTube */
  title: string
  /** YouTube channel name */
  authorName: string
  /** Normalized channel username for URL construction */
  authorUser: string
  /** Video description (may be truncated) */
  description: string
  /** ISO 8601 date string of video publish date */
  publishDate: string
  /** MIME type, always 'video/mp4' */
  contentType: string
  /** Status indicator for iOS app (always 'pending' for this notification type) */
  status: 'pending'
}

/**
 * Notification sent when the server begins downloading the video to S3.
 * Allows iOS app to show "downloading on server" status.
 *
 * Sent by: StartFileUpload Lambda (after metadata fetch, before S3 download)
 * Received by: iOS app to show server-side download progress indicator
 */
export interface DownloadStartedNotification {
  /** YouTube video ID (e.g., 'dQw4w9WgXcQ') */
  fileId: string
  /** Video title (available since metadata was already fetched) */
  title: string
  /** YouTube thumbnail URL (if available) */
  thumbnailUrl?: string
}

/**
 * Notification sent when download is complete and file is ready for streaming.
 * Allows iOS app to enable playback and show file size.
 *
 * Sent by: S3ObjectCreated Lambda (triggered by S3 upload completion)
 * Received by: iOS app to enable video playback
 */
export interface DownloadReadyNotification {
  /** YouTube video ID (e.g., 'dQw4w9WgXcQ') */
  fileId: string
  /** S3 object key (e.g., 'dQw4w9WgXcQ.mp4') */
  key: string
  /** File size in bytes */
  size: number
  /** CloudFront URL for streaming (uses transfer acceleration) */
  url: string
}

/**
 * Notification sent when a download permanently fails.
 * Displayed as an alert notification to notify the user of the failure.
 *
 * Sent by: StartFileUpload Lambda (when download fails permanently)
 * Received by: iOS app to display failure alert
 */
export interface FailureNotification {
  /** YouTube video ID (e.g., 'dQw4w9WgXcQ') */
  fileId: string
  /** Video title (optional, if available from metadata fetch) */
  title?: string
  /** Error category (e.g., 'permanent', 'cookie_expired', 'rate_limited') */
  errorCategory: string
  /** Human-readable error message */
  errorMessage: string
  /** Whether retry attempts have been exhausted */
  retryExhausted: boolean
}

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
