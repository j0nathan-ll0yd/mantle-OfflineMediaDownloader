/**
 * Drizzle ORM Schema Definitions for Aurora DSQL
 *
 * This module defines all database tables for the MediaDownloader service.
 * All tables are normalized (no JSONB, as Aurora DSQL doesn't support it).
 *
 * Better Auth Integration:
 * - Tables: users, sessions, accounts, verification (Better Auth core tables)
 * - Primary keys: 'id' field (Better Auth convention)
 * - Timestamps: All use TIMESTAMP WITH TIME ZONE (Better Auth expects Date objects)
 *
 * Key changes from DynamoDB:
 * - GSI patterns become PostgreSQL indexes
 * - Single-table design becomes normalized relational tables
 * - TTL attribute becomes scheduled cleanup Lambda
 */
import {bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid} from 'drizzle-orm/pg-core'

/**
 * Users table - Core user account management (Better Auth).
 *
 * Extends the framework auth user columns with instance-specific firstName/lastName fields.
 * Base columns match AUTH_USER_COLUMNS from \@mantleframework/auth/schema.
 *
 * Indexes:
 * - usersEmailIdx: Lookup by email (login flow)
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [
  index('users_email_idx').on(table.email)
])

/**
 * Files table - Video metadata storage.
 *
 * Stores permanent metadata about downloaded media files.
 * Status transitions: Queued, Downloading, Downloaded, Failed
 *
 * Indexes:
 * - filesKeyIdx: Lookup by S3 object key (S3ObjectCreated Lambda)
 */
export const files = pgTable('files', {
  fileId: text('file_id').primaryKey(),
  size: bigint('file_size', {mode: 'number'}).notNull().default(0),
  authorName: text('author_name').notNull(),
  authorUser: text('author_user').notNull(),
  publishDate: text('publish_date').notNull(),
  description: text('description').notNull(),
  key: text('key').notNull(),
  url: text('url'),
  contentType: text('content_type').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('Queued'),
  /** Video duration in seconds */
  duration: integer('duration'),
  /** Original YouTube upload date (ISO 8601) */
  uploadDate: text('upload_date'),
  /** View count at download time */
  viewCount: integer('view_count'),
  /** YouTube thumbnail URL */
  thumbnailUrl: text('thumbnail_url')
}, (table) => [
  index('files_key_idx').on(table.key)
])

/**
 * FileDownloads table - Download orchestration state.
 *
 * Tracks transient download state (retries, scheduling, errors).
 * Separated from Files to keep permanent metadata clean.
 *
 * Cleanup: Handled by scheduled CleanupExpiredRecords Lambda (no TTL in DSQL).
 *
 * Indexes:
 * - fileDownloadsStatusIdx: Query by status and retryAfter (scheduler)
 */
export const fileDownloads = pgTable('file_downloads', {
  fileId: text('file_id').primaryKey(),
  status: text('status').notNull().default('Pending'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(5),
  retryAfter: timestamp('retry_after', {withTimezone: true}),
  errorCategory: text('error_category'),
  lastError: text('last_error'),
  scheduledReleaseTime: timestamp('scheduled_release_time', {withTimezone: true}),
  sourceUrl: text('source_url'),
  correlationId: text('correlation_id'),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [
  index('file_downloads_status_idx').on(table.status, table.retryAfter)
])

/**
 * Devices table - iOS device registration for push notifications.
 *
 * Stores APNS device tokens and SNS endpoint ARNs.
 * Lifecycle managed by RegisterDevice and PruneDevices Lambdas.
 */
export const devices = pgTable('devices', {
  deviceId: text('device_id').primaryKey(),
  name: text('name').notNull(),
  token: text('token').notNull(),
  systemVersion: text('system_version').notNull(),
  systemName: text('system_name').notNull(),
  endpointArn: text('endpoint_arn').notNull(),
  lastSeenAt: timestamp('last_seen_at', {withTimezone: true})
})

/**
 * DeviceEvents table - Client-side event log from iOS devices.
 *
 * Stores typed events reported by the iOS app for push delivery confirmation,
 * download pipeline telemetry, and device health monitoring.
 * Properties stored as JSON-serialized text (Aurora DSQL has no JSONB).
 *
 * Cleanup: Handled by CleanupExpiredRecords Lambda (90-day retention).
 */
export const deviceEvents = pgTable('device_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: text('device_id').notNull(),
  eventType: text('event_type').notNull(),
  timestamp: timestamp('timestamp', {withTimezone: true}).notNull(),
  properties: text('properties'),
  correlationId: uuid('correlation_id'),
  receivedAt: timestamp('received_at', {withTimezone: true}).notNull().defaultNow()
}, (table) => [
  index('device_events_device_idx').on(table.deviceId),
  index('device_events_received_at_idx').on(table.receivedAt),
  unique('device_events_device_correlation_unique').on(table.deviceId, table.correlationId)
])

/**
 * Sessions table - Better Auth user session management.
 * Re-exported from framework (no instance extensions needed).
 * Includes: sessions_token_unique, sessions_user_idx, sessions_token_idx
 */
export { authSessions as sessions } from '@mantleframework/auth/schema'

/**
 * Accounts table - Better Auth OAuth account storage.
 * Re-exported from framework (no instance extensions needed).
 * Includes: accounts_user_idx, accounts_provider_idx
 */
export { authAccounts as accounts } from '@mantleframework/auth/schema'

/**
 * Verification table - Better Auth verification tokens.
 * Re-exported from framework (no instance extensions needed).
 * Includes: verification_identifier_idx
 */
export { authVerification as verification } from '@mantleframework/auth/schema'

/**
 * UserFiles table - Many-to-many relationship between users and files.
 *
 * Enables bidirectional queries:
 * - "What files does this user have?" (userFilesUserIdx)
 * - "What users have this file?" (userFilesFileIdx)
 *
 * Foreign keys to users/files enforced at application layer.
 */
export const userFiles = pgTable('user_files', {
  userId: uuid('user_id').notNull(),
  fileId: text('file_id').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [
  primaryKey({columns: [table.userId, table.fileId]}),
  index('user_files_user_idx').on(table.userId),
  index('user_files_file_idx').on(table.fileId)
])

/**
 * UserDevices table - Many-to-many relationship between users and devices.
 *
 * Enables bidirectional queries:
 * - "What devices does this user have?" (userDevicesUserIdx)
 * - "What users are on this device?" (userDevicesDeviceIdx)
 *
 * Foreign keys to users/devices enforced at application layer.
 */
export const userDevices = pgTable('user_devices', {
  userId: uuid('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
}, (table) => [
  primaryKey({columns: [table.userId, table.deviceId]}),
  index('user_devices_user_idx').on(table.userId),
  index('user_devices_device_idx').on(table.deviceId)
])
