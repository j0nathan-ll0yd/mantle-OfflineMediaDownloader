/**
 * Lambda Handler Types
 *
 * Type definitions for Lambda handler wrappers and their parameters.
 * These types enable type-safe middleware composition.
 *
 * Handler Flow:
 * 1. External event (API Gateway, S3, CloudWatch) triggers Lambda
 * 2. Wrapper extracts event, context, and creates metadata
 * 3. Handler receives typed params with guaranteed fields
 *
 * @see src/lib/lambda/middleware/ for wrapper implementations
 * @see {@link https://github.com/j0nathan-ll0yd/mantle-OfflineMediaDownloader/wiki/TypeScript/Lambda-Middleware-Patterns | Middleware Guide}
 */

import type {APIGatewayRequestAuthorizerEvent, Context, ScheduledEvent} from 'aws-lambda'
import type {CustomAPIGatewayRequestAuthorizerEvent} from './infrastructureTypes'
import type {ResponseStatus, UserStatus} from './enums'
import type {VideoErrorClassification} from './video'

// ============================================================================
// Wrapper Parameter Types
// ============================================================================

/**
 * Metadata passed to all wrapped handlers.
 * Used for distributed tracing and request correlation.
 */
export type WrapperMetadata = {
  /** AWS request ID for this Lambda invocation */
  traceId: string
  /** Correlation ID for end-to-end request tracing across services */
  correlationId: string
}

/**
 * Parameters passed to wrapped API Gateway handlers.
 * Used with wrapApiHandler for unauthenticated or custom auth handlers.
 *
 * @see wrapApiHandler for implementation
 */
export type ApiHandlerParams<TEvent = CustomAPIGatewayRequestAuthorizerEvent> = {
  /** Original API Gateway event with request data */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
}

/**
 * Parameters passed to wrapped authorizer handlers.
 * Used for API Gateway custom authorizers.
 *
 * @see ApiGatewayAuthorizer Lambda for implementation
 */
export type AuthorizerParams = {
  /** API Gateway authorizer event with token/identity */
  event: APIGatewayRequestAuthorizerEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
}

/**
 * Parameters passed to wrapped event handlers (S3, SQS).
 * Processes one record at a time from a batch.
 *
 * @see wrapS3EventHandler for S3 events
 * @see wrapSQSHandler for SQS messages
 */
export type EventHandlerParams<TRecord> = {
  /** Single record from the event batch */
  record: TRecord
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
}

/**
 * Parameters passed to wrapped scheduled handlers.
 * Used for CloudWatch Events/EventBridge scheduled invocations.
 *
 * @see wrapScheduledHandler for implementation
 * @see FileCoordinator, PruneDevices for examples
 */
export type ScheduledHandlerParams = {
  /** CloudWatch scheduled event with time and resources */
  event: ScheduledEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
}

/**
 * Parameters passed to Lambda-to-Lambda invoke handlers.
 * Used for async invocations between Lambdas.
 *
 * @see wrapLambdaInvokeHandler for implementation
 * @see StartFileUpload for example (invoked by FileCoordinator)
 */
export type LambdaInvokeHandlerParams<TEvent> = {
  /** Custom event payload from invoking Lambda */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
}

/**
 * Parameters passed to authenticated API handlers.
 *
 * userId is guaranteed to be a string (not optional) - the wrapper enforces this
 * by rejecting Unauthenticated and Anonymous users before the handler runs.
 *
 * @see wrapAuthenticatedHandler for implementation
 */
export type AuthenticatedApiParams<TEvent = CustomAPIGatewayRequestAuthorizerEvent> = {
  /** Original API Gateway event */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
  /** Authenticated user ID (guaranteed non-null) */
  userId: string
}

/**
 * Parameters passed to optional-auth API handlers.
 *
 * Allows both Anonymous and Authenticated users (rejects only Unauthenticated).
 * Handler receives userStatus to differentiate behavior.
 *
 * @see wrapOptionalAuthHandler for implementation
 * @see ListFiles for example (returns demo file for anonymous users)
 */
export type OptionalAuthApiParams<TEvent = CustomAPIGatewayRequestAuthorizerEvent> = {
  /** Original API Gateway event */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
  /** User ID (undefined for anonymous users) */
  userId: string | undefined
  /** Authentication status for conditional logic */
  userStatus: UserStatus
}

/**
 * Parameters passed to validated API handlers.
 * Used with wrapValidatedHandler for automatic request body validation.
 *
 * @see wrapValidatedHandler for implementation
 */
export type ValidatedApiParams<TBody, TEvent = CustomAPIGatewayRequestAuthorizerEvent> = {
  /** Original API Gateway event */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
  /** Validated and typed request body */
  body: TBody
}

/**
 * Parameters passed to authenticated + validated API handlers.
 * Combines authentication enforcement with request body validation.
 *
 * @see wrapAuthenticatedValidatedHandler for implementation
 */
export type AuthenticatedValidatedParams<TBody, TEvent = CustomAPIGatewayRequestAuthorizerEvent> = {
  /** Original API Gateway event */
  event: TEvent
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
  /** Authenticated user ID (guaranteed non-null) */
  userId: string
  /** Validated and typed request body */
  body: TBody
}

// ============================================================================
// SQS Batch Processing Types
// ============================================================================

/**
 * Parameters passed to SQS batch handlers for each record.
 * Used with wrapSqsBatchHandler for standardized batch processing.
 *
 * @see wrapSqsBatchHandler for implementation
 */
export type SqsRecordParams<TBody = unknown> = {
  /** Original SQS record */
  record: import('aws-lambda').SQSRecord
  /** Parsed and typed message body */
  body: TBody
  /** AWS Lambda execution context */
  context: Context
  /** Tracing metadata */
  metadata: WrapperMetadata
  /** SQS message attributes */
  messageAttributes: import('aws-lambda').SQSRecord['messageAttributes']
}

/**
 * Options for SQS batch handler wrapper.
 */
export interface SqsBatchOptions {
  /** Parse body as JSON (default: true) */
  parseBody?: boolean
  /** Stop on first error instead of continuing (default: false) */
  stopOnError?: boolean
}

// ============================================================================
// Handler Base Class Types (used by class-based handlers)
// ============================================================================

/**
 * Context passed to SQS record processors in class-based handlers.
 * Similar to SqsRecordParams but designed for class method signatures.
 */
export interface SqsRecordContext<TBody = unknown> {
  /** The SQS record being processed */
  record: import('aws-lambda').SQSRecord
  /** Parsed body (if parseBody is true) */
  body: TBody
  /** Lambda context */
  context: import('aws-lambda').Context
  /** Correlation metadata */
  metadata: WrapperMetadata
  /** SQS message attributes */
  messageAttributes: import('aws-lambda').SQSMessageAttributes
}

/**
 * Context passed to S3 record processors in class-based handlers.
 */
export interface S3RecordContext {
  /** The S3 event record being processed */
  record: import('aws-lambda').S3EventRecord
  /** Lambda context */
  context: import('aws-lambda').Context
  /** Correlation metadata */
  metadata: WrapperMetadata
}

/**
 * Result type for scheduled handlers.
 * Used by ScheduledHandler base class.
 */
export interface ScheduledResult {
  /** Number of items processed */
  processed?: number
  /** Number of items deleted/cleaned up */
  deleted?: number
  /** Any additional result data */
  [key: string]: unknown
}

// ============================================================================
// Sanitization Types
// ============================================================================

/**
 * Options for input sanitization middleware.
 * Controls which sanitization rules are applied to request bodies.
 */
export interface SanitizationOptions {
  /** Fields to skip sanitization (e.g., password, token) */
  skipFields?: string[]
  /** Maximum string length (truncate longer) */
  maxLength?: number
  /** Remove HTML tags completely (default: true) */
  stripHtml?: boolean
  /** Remove control characters (default: true) */
  stripControlChars?: boolean
}

// ============================================================================
// Security Headers Types
// ============================================================================

/**
 * Options for security headers middleware.
 * Configures security-related HTTP headers.
 *
 * NOTE: CORS options are intentionally omitted. This is a mobile-only API
 * (iOS app uses native HTTP) which doesn't require CORS.
 */
export interface SecurityHeadersOptions {
  /** Content-Security-Policy value */
  csp?: string
  /** X-Frame-Options value (default: 'DENY') */
  frameOptions?: 'DENY' | 'SAMEORIGIN'
  /** Custom headers to add */
  customHeaders?: Record<string, string>
}

// ============================================================================
// Operation Result Types
// ============================================================================

/**
 * Result of the PruneDevices scheduled operation.
 * Returned to indicate cleanup statistics.
 *
 * @see PruneDevices Lambda for implementation
 */
export interface PruneDevicesResult {
  /** Total devices checked for staleness */
  devicesChecked: number
  /** Number of stale devices removed */
  devicesPruned: number
  /** Error messages for any failed operations */
  errors: string[]
  [key: string]: unknown
}

/**
 * Result of the CleanupExpiredRecords scheduled operation.
 * Returned to indicate cleanup statistics for expired records.
 *
 * @see CleanupExpiredRecords Lambda for implementation
 */
export interface CleanupResult {
  /** Number of file downloads deleted */
  fileDownloadsDeleted: number
  /** Number of sessions deleted */
  sessionsDeleted: number
  /** Number of verification tokens deleted */
  verificationTokensDeleted: number
  /** Number of device events deleted (90-day retention) */
  deviceEventsDeleted: number
  /** Error messages for any failed operations */
  errors: string[]
  [key: string]: unknown
}

/**
 * Response from Apple Push Notification Service.
 * Used to track delivery success/failure.
 *
 * @see SendPushNotification Lambda for usage
 */
export interface ApplePushNotificationResponse {
  /** HTTP status code from APNS (200 = success) */
  statusCode: number
  /** Error reason if status is not 200 */
  reason?: string
}

// ============================================================================
// Download Types
// ============================================================================

/**
 * Result of handling a download failure.
 * Used to determine whether to throw (causing SQS retry) or return success.
 */
export interface DownloadFailureResult {
  /** Whether the error is retryable via SQS visibility timeout */
  shouldRetry: boolean
  /** Error classification details */
  classification: VideoErrorClassification
}

// ============================================================================
// Webhook Types
// ============================================================================

/**
 * Input for webhook processing.
 * Internal type for WebhookFeedly handler.
 */
export interface WebhookProcessingInput {
  /** YouTube video ID */
  fileId: string
  /** User ID who requested the download */
  userId: string
  /** Original YouTube URL */
  articleURL: string
  /** Correlation ID for tracing */
  correlationId: string
}

/**
 * Result of webhook processing.
 * Returned by WebhookFeedly handler.
 */
export interface WebhookProcessingResult {
  /** HTTP status code to return */
  statusCode: number
  /** Response status enum value */
  status: ResponseStatus
}
