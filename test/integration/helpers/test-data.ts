/**
 * Test Data Helpers
 *
 * Reusable factory functions for creating mock test data across integration tests.
 * Reduces inline JSON and provides consistent test data patterns.
 */

import type {APIGatewayProxyEvent, APIGatewayRequestAuthorizerEvent, S3Event, ScheduledEvent, SQSEvent} from 'aws-lambda'
import {FileStatus, UserStatus} from '#types/enums'
import type {Device, File, User} from '#types/domainModels'

/**
 * Creates a mock file object with sensible defaults
 * Provides ALL required fields for database operations
 * @param id - File ID (e.g., 'video-123')
 * @param status - File status from FileStatus enum
 * @param partial - Partial file data to override defaults
 */
export function createMockFile(id: string, status: FileStatus, partial?: Partial<File>): Partial<File> {
  const base: Partial<File> = {
    fileId: id,
    status,
    title: `Test Video ${id}`,
    authorName: 'Test Channel',
    authorUser: 'testchannel',
    publishDate: new Date().toISOString(),
    description: `Test description for ${id}`,
    contentType: 'video/mp4',
    size: 0,
    key: `${id}.mp4`
  }

  // Add Downloaded-specific fields (downloaded files)
  if (status === FileStatus.Downloaded) {
    base.size = 5242880
    base.url = `https://example.com/${id}.mp4`
  }

  return {...base, ...partial}
}

/**
 * Creates a mock Device record with endpoint ARN.
 * @param partial - Partial device fields to override defaults
 */
export function createMockDevice(partial?: Partial<Device>): Partial<Device> {
  const deviceId = partial?.deviceId || `device-${Math.random().toString(36).slice(7)}`
  return {
    deviceId,
    name: partial?.name || 'Test iPhone',
    token: partial?.token || `token-${deviceId}`,
    systemVersion: partial?.systemVersion || '17.0',
    systemName: partial?.systemName || 'iOS',
    endpointArn: partial?.endpointArn || `arn:aws:sns:us-west-2:123456789012:endpoint/APNS/MyApp/${deviceId}`,
    ...partial
  }
}

/**
 * Creates a mock User record with sensible defaults
 * @param partial - Partial user data to override defaults
 */
export function createMockUser(partial?: Partial<User> & {userId?: string}): Partial<User> {
  // Support both 'id' (domain type) and 'userId' (legacy tests) for backwards compatibility
  const id = partial?.id || partial?.userId || `user-${Math.random().toString(36).slice(7)}`
  return {
    id,
    email: partial?.email || `${id}@example.com`,
    emailVerified: partial?.emailVerified ?? true,
    firstName: partial?.firstName || 'Test',
    lastName: partial?.lastName || 'User',
    ...partial
  }
}

/**
 * Creates an SQS FileNotification event
 * @param userId - User ID to send notification to
 * @param fileId - File ID for the notification
 * @param partial - Partial file data to override defaults in message attributes
 * @param notificationType - Notification type (default: 'DownloadReadyNotification')
 */
export function createMockSQSFileNotificationEvent(
  userId: string,
  fileId: string,
  partial?: {title?: string; size?: number; url?: string},
  notificationType = 'DownloadReadyNotification'
): SQSEvent {
  const file = createMockFile(fileId, FileStatus.Downloaded, partial)

  // Body must be JSON matching what createDownloadReadyNotification produces
  // SendPushNotification parses this with JSON.parse in transformToAPNSNotification
  const messageBody = JSON.stringify({
    file: {fileId, key: file.key || `${fileId}.mp4`, size: file.size || 5242880, url: file.url || `https://example.com/${fileId}.mp4`},
    notificationType
  })

  return {
    Records: [{
      messageId: `test-message-${fileId}`,
      receiptHandle: `test-receipt-${fileId}`,
      body: messageBody,
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: String(Date.now()),
        SenderId: 'test-sender',
        ApproximateFirstReceiveTimestamp: String(Date.now())
      },
      messageAttributes: {
        notificationType: {stringValue: notificationType, dataType: 'String'},
        userId: {stringValue: userId, dataType: 'String'},
        fileId: {stringValue: fileId, dataType: 'String'},
        key: {stringValue: file.key || `${fileId}.mp4`, dataType: 'String'},
        publishDate: {stringValue: file.publishDate || new Date().toISOString(), dataType: 'String'},
        size: {stringValue: String(file.size || 5242880), dataType: 'String'},
        url: {stringValue: file.url || `https://example.com/${fileId}.mp4`, dataType: 'String'},
        title: {stringValue: file.title || 'Test Video', dataType: 'String'}
      },
      md5OfBody: 'test-md5',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-west-2:123456789012:test-queue',
      awsRegion: 'us-west-2'
    }]
  }
}

/**
 * Creates a CloudWatch Events / EventBridge scheduled event
 * @param eventId - Unique event ID
 * @param ruleName - Name of the EventBridge rule (default: 'ScheduledEvent')
 */
export function createMockScheduledEvent(eventId: string, ruleName = 'ScheduledEvent'): ScheduledEvent {
  return {
    id: eventId,
    version: '0',
    account: '123456789012',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    time: new Date().toISOString(),
    region: 'us-west-2',
    resources: [`arn:aws:events:us-west-2:123456789012:rule/${ruleName}`],
    detail: {}
  }
}

/**
 * Creates an S3 object created event
 * @param objectKey - The S3 object key (will be URL-encoded in the event)
 * @param options - Optional bucket name and region
 */
export function createMockS3Event(objectKey: string, options?: {bucket?: string; region?: string}): S3Event {
  const bucket = options?.bucket ?? 'test-bucket'
  const region = options?.region ?? 'us-west-2'

  return {
    Records: [{
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: region,
      eventTime: new Date().toISOString(),
      eventName: 'ObjectCreated:Put',
      userIdentity: {principalId: 'EXAMPLE'},
      requestParameters: {sourceIPAddress: '127.0.0.1'},
      responseElements: {'x-amz-request-id': 'test-request-id', 'x-amz-id-2': 'test-id-2'},
      s3: {
        s3SchemaVersion: '1.0',
        configurationId: 'test-config',
        bucket: {name: bucket, ownerIdentity: {principalId: 'EXAMPLE'}, arn: `arn:aws:s3:::${bucket}`},
        object: {key: encodeURIComponent(objectKey), size: 1024, eTag: 'test-etag', sequencer: '123456789'}
      }
    }]
  }
}

/**
 * Creates a basic API Gateway proxy event with authorizer context
 * @param options - Event configuration
 */
export function createMockAPIGatewayProxyEvent(
  options: {path: string; httpMethod: string; headers?: Record<string, string>; body?: string | null; userId?: string}
): APIGatewayProxyEvent {
  return {
    body: options.body ?? null,
    headers: options.headers ?? {},
    multiValueHeaders: {},
    httpMethod: options.httpMethod,
    isBase64Encoded: false,
    path: options.path,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      protocol: 'HTTP/1.1',
      httpMethod: options.httpMethod,
      path: options.path,
      stage: 'test',
      requestId: 'test-request',
      requestTime: '01/Jan/2024:00:00:00 +0000',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: options.path,
      identity: {
        sourceIp: '127.0.0.1',
        userAgent: 'test-agent',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null
      },
      authorizer: {integrationLatency: 0, principalId: options.userId ?? 'unknown'}
    },
    resource: options.path
  } as unknown as APIGatewayProxyEvent
}

/**
 * Creates an API Gateway request authorizer event (for custom authorizer Lambda)
 * @param options - Event configuration
 */
export function createMockAPIGatewayRequestAuthorizerEvent(
  options?: {token?: string; path?: string; httpMethod?: string; apiKey?: string}
): APIGatewayRequestAuthorizerEvent {
  const path = options?.path ?? '/resource'
  const httpMethod = options?.httpMethod ?? 'GET'
  const headers: Record<string, string> = options?.token
    ? {Authorization: `Bearer ${options.token}`, 'User-Agent': 'iOS/17.0'}
    : {'User-Agent': 'iOS/17.0'}
  // Default ApiKey for authorizer tests - Lambda requires this in query params
  const queryStringParameters = {ApiKey: options?.apiKey ?? 'test-api-key'}

  return {
    type: 'REQUEST',
    methodArn: `arn:aws:execute-api:us-west-2:123456789012:api-id/stage/${httpMethod}${path}`,
    resource: path,
    path,
    httpMethod,
    headers,
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      protocol: 'HTTP/1.1',
      httpMethod,
      path,
      stage: 'test',
      requestId: `test-${Date.now()}`,
      requestTime: '01/Jan/2024:00:00:00 +0000',
      requestTimeEpoch: Date.now(),
      resourceId: 'resource-id',
      resourcePath: path,
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: options?.apiKey ?? 'test-api-key',
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: 'iOS/17.0 TestApp/1.0',
        userArn: null
      }
    }
  } as unknown as APIGatewayRequestAuthorizerEvent
}

/**
 * Creates a custom API Gateway event with authorizer context (for authenticated endpoints)
 * @param options - Event configuration including user status from authorizer
 */
export function createMockCustomAPIGatewayEvent(
  options: {path: string; httpMethod: string; userId?: string; userStatus: UserStatus; body?: string | null; headers?: Record<string, string>}
): APIGatewayProxyEvent {
  const principalId = options.userStatus === UserStatus.Anonymous
    ? 'anonymous'
    : options.userId || 'unknown'

  const defaultHeaders: Record<string, string> = options.userId && options.userStatus === UserStatus.Authenticated
    ? {Authorization: 'Bearer test-token'}
    : {}

  return {
    body: options.body ?? null,
    headers: {...defaultHeaders, ...options.headers},
    multiValueHeaders: {},
    httpMethod: options.httpMethod,
    isBase64Encoded: false,
    path: options.path,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      protocol: 'HTTP/1.1',
      httpMethod: options.httpMethod,
      path: options.path,
      stage: 'test',
      requestId: 'test-request',
      requestTime: '01/Jan/2024:00:00:00 +0000',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: options.path,
      authorizer: {
        principalId,
        userId: options.userStatus === UserStatus.Authenticated ? options.userId : undefined,
        userStatus: options.userStatus,
        integrationLatency: 100
      },
      identity: {sourceIp: '127.0.0.1', userAgent: 'test-agent'}
    },
    resource: options.path
  } as unknown as APIGatewayProxyEvent
}

/**
 * Creates a mock API Gateway event for integration tests
 * Supports principalId for authenticated requests via authorizer context
 * @param options - Event configuration
 */
export function createMockAPIGatewayEvent(
  options: {
    httpMethod: string
    path: string
    body?: string | null
    headers?: Record<string, string>
    principalId?: string
    queryStringParameters?: Record<string, string> | null
  }
) {
  return {
    httpMethod: options.httpMethod,
    path: options.path,
    body: options.body ?? null,
    headers: options.headers ?? {'Content-Type': 'application/json'},
    multiValueHeaders: {},
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: options.queryStringParameters ?? null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      authorizer: options.principalId ? {principalId: options.principalId} : undefined,
      httpMethod: options.httpMethod,
      identity: {sourceIp: '127.0.0.1', userAgent: 'test'} as never,
      path: options.path,
      protocol: 'HTTP/1.1',
      requestId: 'test-request-id',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: options.path,
      stage: 'test'
    },
    resource: options.path
  }
}
