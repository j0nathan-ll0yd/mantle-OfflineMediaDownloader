import {z} from '@mantleframework/validation'
import {notificationTypeSchema} from '#types/notification-schemas'

export const clientEventTypeSchema = z.enum([
  'push_delivered',
  'push_received',
  'push_opened',
  'download_completed_locally',
  'playback_started',
  'playback_completed',
  'file_sync_mismatch',
  'certificate_pinning_failed',
  'token_refresh_succeeded',
  'token_refresh_failed',
  'session_expired',
  'background_task_completed',
  'background_task_expired',
  'app_launched',
  'network_error'
])

export const pushDeliveredEventSchema = z.object({
  eventType: z.literal('push_delivered'),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  notificationType: notificationTypeSchema.optional()
})

export const pushReceivedEventSchema = z.object({
  eventType: z.literal('push_received'),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  notificationType: notificationTypeSchema.optional()
})

export const pushOpenedEventSchema = z.object({
  eventType: z.literal('push_opened'),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  notificationType: notificationTypeSchema.optional()
})

export const downloadCompletedLocallyEventSchema = z.object({
  eventType: z.literal('download_completed_locally'),
  timestamp: z.string().datetime(),
  fileId: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative()
})

export const playbackStartedEventSchema = z.object({
  eventType: z.literal('playback_started'),
  timestamp: z.string().datetime(),
  fileId: z.string(),
  durationSec: z.number().nonnegative().optional()
})

export const playbackCompletedEventSchema = z.object({
  eventType: z.literal('playback_completed'),
  timestamp: z.string().datetime(),
  fileId: z.string(),
  playbackDurationSec: z.number().nonnegative()
})

export const fileSyncMismatchEventSchema = z.object({
  eventType: z.literal('file_sync_mismatch'),
  timestamp: z.string().datetime(),
  localCount: z.number().int().nonnegative(),
  serverCount: z.number().int().nonnegative(),
  missingFileIds: z.array(z.string()).optional()
})

export const tokenRefreshSucceededEventSchema = z.object({
  eventType: z.literal('token_refresh_succeeded'),
  timestamp: z.string().datetime(),
  sessionId: z.string().optional()
})

export const tokenRefreshFailedEventSchema = z.object({
  eventType: z.literal('token_refresh_failed'),
  timestamp: z.string().datetime(),
  errorType: z.string(),
  errorMessage: z.string()
})

export const sessionExpiredEventSchema = z.object({
  eventType: z.literal('session_expired'),
  timestamp: z.string().datetime(),
  sessionId: z.string().optional()
})

export const appLaunchedEventSchema = z.object({
  eventType: z.literal('app_launched'),
  timestamp: z.string().datetime(),
  appVersion: z.string(),
  buildNumber: z.string(),
  osVersion: z.string(),
  deviceModel: z.string()
})

export const certificatePinningFailedEventSchema = z.object({
  eventType: z.literal('certificate_pinning_failed'),
  timestamp: z.string().datetime(),
  host: z.string(),
  errorMessage: z.string()
})

export const backgroundTaskCompletedEventSchema = z.object({
  eventType: z.literal('background_task_completed'),
  timestamp: z.string().datetime(),
  taskName: z.string(),
  durationMs: z.number().int().nonnegative()
})

export const backgroundTaskExpiredEventSchema = z.object({
  eventType: z.literal('background_task_expired'),
  timestamp: z.string().datetime(),
  taskName: z.string()
})

export const networkErrorEventSchema = z.object({
  eventType: z.literal('network_error'),
  timestamp: z.string().datetime(),
  endpoint: z.string(),
  statusCode: z.number().int().optional(),
  errorMessage: z.string()
})

export const clientEventSchema = z.discriminatedUnion('eventType', [
  pushDeliveredEventSchema,
  pushReceivedEventSchema,
  pushOpenedEventSchema,
  downloadCompletedLocallyEventSchema,
  playbackStartedEventSchema,
  playbackCompletedEventSchema,
  fileSyncMismatchEventSchema,
  tokenRefreshSucceededEventSchema,
  tokenRefreshFailedEventSchema,
  sessionExpiredEventSchema,
  appLaunchedEventSchema,
  certificatePinningFailedEventSchema,
  backgroundTaskCompletedEventSchema,
  backgroundTaskExpiredEventSchema,
  networkErrorEventSchema
])

export const clientEventBatchRequestSchema = z.object({events: z.array(clientEventSchema).min(1).max(100)})

export type ClientEvent = z.infer<typeof clientEventSchema>
export type ClientEventBatchRequest = z.infer<typeof clientEventBatchRequestSchema>
