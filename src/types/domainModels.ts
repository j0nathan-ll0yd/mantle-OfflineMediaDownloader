/**
 * Domain Model Types
 *
 * Core business entities representing users, files, devices, and authentication.
 * These are the "clean" domain types, separate from persistence (Drizzle) types.
 *
 * @see src/entities/queries/ for Drizzle query functions
 * @see src/types/persistence-types.d.ts for relationship types
 */

import {FileStatus} from './enums'

/**
 * User account information.
 *
 * Created via Sign In With Apple or Better Auth registration.
 * Links to files via UserFiles and devices via UserDevices entities.
 *
 * @see Users entity for persistence
 * @see wrapAuthenticatedHandler for access control
 */
export interface User {
  /** Unique user identifier (UUID format) - Better Auth uses 'id' convention */
  id: string
  /** User's email address (from Apple ID or registration) */
  email: string
  /** Whether email has been verified */
  emailVerified: boolean
  /** User's display name (Better Auth convention) */
  name?: string
  /** User's profile image URL (Better Auth convention) */
  image?: string
  /** User's first name (from Apple ID or registration) */
  firstName?: string
  /** User's last name (optional, from Apple ID) */
  lastName?: string
  /** Timestamp when user was created */
  createdAt?: Date
  /** Timestamp when user was last updated */
  updatedAt?: Date
}

/**
 * Media file metadata.
 *
 * Represents a downloaded YouTube video stored in S3.
 * Status transitions: Queued → Downloading → Downloaded | Failed
 *
 * @see Files entity for persistence
 * @see FileStatus enum for status values
 * @see StartFileUpload Lambda for download process
 */
export interface File {
  /** YouTube video ID (e.g., 'dQw4w9WgXcQ') */
  fileId: string
  /** File size in bytes (set after download completes) */
  size: number
  /** YouTube channel display name */
  authorName: string
  /** Normalized channel username for URL construction */
  authorUser: string
  /** ISO 8601 date string of video publish date */
  publishDate: string
  /** Video description (may be truncated) */
  description: string
  /** S3 object key (e.g., 'dQw4w9WgXcQ.mp4') */
  key: string
  /** CloudFront URL for streaming (set after download completes) */
  url?: string
  /** MIME type, always 'video/mp4' */
  contentType: string
  /** Video title from YouTube */
  title: string
  /** Current download/availability status */
  status: FileStatus
  /** Video duration in seconds */
  duration?: number
  /** Original YouTube upload date (ISO 8601) */
  uploadDate?: string
  /** View count at time of download */
  viewCount?: number
  /** YouTube thumbnail URL */
  thumbnailUrl?: string
}

/**
 * iOS device information for push notifications.
 *
 * Registered via the iOS app when user enables notifications.
 * Used to send APNS push notifications about download progress.
 *
 * @see Devices entity for persistence
 * @see RegisterDevice Lambda for registration
 * @see SendPushNotification Lambda for notification delivery
 */
export interface Device {
  /** Device display name (e.g., 'John's iPhone') */
  name: string
  /** APNS device token (hex string from iOS) */
  token: string
  /** iOS version (e.g., '17.2.1') */
  systemVersion: string
  /** Unique device identifier (UUID from iOS) */
  deviceId: string
  /** Operating system name (e.g., 'iOS') */
  systemName: string
  /** SNS endpoint ARN for this device's push notifications */
  endpointArn: string
  /** Last time the device reported an event to the server */
  lastSeenAt?: Date | null
}
