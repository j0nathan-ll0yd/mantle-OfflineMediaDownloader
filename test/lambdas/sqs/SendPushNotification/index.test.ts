/**
 * Unit tests for SendPushNotification Lambda (SQS handler)
 *
 * Tests push notification delivery to user devices via SNS/APNS.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core',
  () => ({
    defineSqsHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    err: vi.fn((error) => ({ok: false, error})),
    isErr: vi.fn((result) => !result.ok),
    isOk: vi.fn((result) => result.ok),
    ok: vi.fn((value) => ({ok: true, value}))
  }))

vi.mock('@mantleframework/aws', () => ({publish: vi.fn()}))

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => ({}))
  }))

vi.mock('@mantleframework/validation', () => ({validateSchema: vi.fn()}))

vi.mock('@mantleframework/errors', () => {
  class UnexpectedError extends Error {
    statusCode = 500
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {UnexpectedError}
})

vi.mock('#entities/queries', () => ({getDevice: vi.fn(), getUserDevicesByUserId: vi.fn()}))

vi.mock('#errors/custom-errors', () => ({providerFailureErrorMessage: 'AWS request failed'}))

vi.mock('#services/notification/transformers',
  () => ({
    transformToAPNSAlertNotification: vi.fn(() => ({Message: 'alert', TargetArn: 'arn:test'})),
    transformToAPNSNotification: vi.fn(() => ({Message: 'background', TargetArn: 'arn:test'}))
  }))

vi.mock('#services/notification/endpointCleanup', () => ({cleanupDisabledEndpoints: vi.fn(() => Promise.resolve([]))}))

vi.mock('#types/schemas', () => ({pushNotificationAttributesSchema: {}}))

const {handler} = (await import('#lambdas/sqs/SendPushNotification/index.js')) as any
import {publish} from '@mantleframework/aws'
import {validateSchema} from '@mantleframework/validation'
import {getDevice, getUserDevicesByUserId} from '#entities/queries'
import {transformToAPNSAlertNotification, transformToAPNSNotification} from '#services/notification/transformers'
import {cleanupDisabledEndpoints} from '#services/notification/endpointCleanup'
import {metrics} from '@mantleframework/observability'

describe('SendPushNotification Lambda', () => {
  const makeRecord = (notificationType = 'DownloadReadyNotification', userId = 'user-1') => ({
    messageId: 'msg-1',
    body: JSON.stringify({file: {fileId: 'file-1'}, notificationType}),
    messageAttributes: {notificationType: {stringValue: notificationType}, userId: {stringValue: userId}}
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validateSchema).mockReturnValue({success: true, data: {notificationType: 'DownloadReadyNotification', userId: 'user-1'}})
    vi.mocked(getUserDevicesByUserId).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])
    vi.mocked(getDevice).mockResolvedValue({
      deviceId: 'dev-1',
      name: 'iPhone',
      token: 'tok',
      systemVersion: '17',
      systemName: 'iOS',
      endpointArn: 'arn:aws:sns:endpoint/dev-1'
    })
    vi.mocked(publish).mockResolvedValue({MessageId: 'msg-pub-1', $metadata: {}})
  })

  it('should send background notification to a single device', async () => {
    await handler(makeRecord())

    expect(getUserDevicesByUserId).toHaveBeenCalledWith('user-1')
    expect(getDevice).toHaveBeenCalledWith('dev-1')
    expect(transformToAPNSNotification).toHaveBeenCalled()
    expect(publish).toHaveBeenCalled()
    expect(metrics.addMetric).toHaveBeenCalledWith('PushNotificationsSent', 'Count', 1)
  })

  it('should send alert notification for FailureNotification type', async () => {
    vi.mocked(validateSchema).mockReturnValue({success: true, data: {notificationType: 'FailureNotification', userId: 'user-1'}})

    await handler(makeRecord('FailureNotification'))

    expect(transformToAPNSAlertNotification).toHaveBeenCalled()
    expect(transformToAPNSNotification).not.toHaveBeenCalled()
  })

  it('should return early when no devices registered for user', async () => {
    vi.mocked(getUserDevicesByUserId).mockResolvedValue([])

    await handler(makeRecord())

    expect(getDevice).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('should discard message with invalid attributes', async () => {
    vi.mocked(validateSchema).mockReturnValue({success: false, errors: {field: ['invalid']}})

    await handler(makeRecord())

    expect(getUserDevicesByUserId).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('should handle partial success with multiple devices', async () => {
    vi.mocked(getUserDevicesByUserId).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(getDevice).mockResolvedValueOnce({
      deviceId: 'dev-1',
      name: 'iPhone',
      token: 'tok1',
      systemVersion: '17',
      systemName: 'iOS',
      endpointArn: 'arn:aws:sns:endpoint/dev-1'
    }).mockResolvedValueOnce({
      deviceId: 'dev-2',
      name: 'iPad',
      token: 'tok2',
      systemVersion: '17',
      systemName: 'iPadOS',
      endpointArn: 'arn:aws:sns:endpoint/dev-2'
    })
    vi.mocked(publish).mockResolvedValueOnce({MessageId: 'msg-1', $metadata: {}}).mockRejectedValueOnce(new Error('SNS failure'))

    await handler(makeRecord())

    expect(metrics.addMetric).toHaveBeenCalledWith('PushNotificationsSent', 'Count', 1)
    expect(metrics.addMetric).toHaveBeenCalledWith('PushNotificationsFailed', 'Count', 1)
  })

  it('should throw when all devices fail', async () => {
    vi.mocked(publish).mockRejectedValue(new Error('SNS failure'))

    await expect(handler(makeRecord())).rejects.toThrow('All 1 device notifications failed')
  })

  it('should detect disabled endpoints and trigger cleanup', async () => {
    vi.mocked(publish).mockRejectedValue(new Error('EndpointDisabled'))

    await expect(handler(makeRecord())).rejects.toThrow('All 1 device notifications failed')

    expect(metrics.addMetric).toHaveBeenCalledWith('DisabledEndpointsDetected', 'Count', 1)
    expect(cleanupDisabledEndpoints).toHaveBeenCalledWith(['dev-1'])
  })

  it('should skip device with no endpoint ARN', async () => {
    vi.mocked(getDevice).mockResolvedValue({deviceId: 'dev-1', name: 'iPhone', token: 'tok', systemVersion: '17', systemName: 'iOS', endpointArn: ''})

    await expect(handler(makeRecord())).rejects.toThrow('All 1 device notifications failed')

    expect(publish).not.toHaveBeenCalled()
  })

  it('should succeed when at least one device succeeds out of multiple', async () => {
    vi.mocked(getUserDevicesByUserId).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(getDevice).mockResolvedValueOnce({
      deviceId: 'dev-1',
      name: 'iPhone',
      token: 'tok1',
      systemVersion: '17',
      systemName: 'iOS',
      endpointArn: 'arn:endpoint/dev-1'
    }).mockResolvedValueOnce({deviceId: 'dev-2', name: 'iPad', token: 'tok2', systemVersion: '17', systemName: 'iPadOS', endpointArn: 'arn:endpoint/dev-2'})
    vi.mocked(publish).mockResolvedValueOnce({MessageId: 'msg-1', $metadata: {}}).mockRejectedValueOnce(new Error('fail'))

    await expect(handler(makeRecord())).resolves.toBeUndefined()
  })

  it('should handle getDevice throwing UnexpectedError', async () => {
    vi.mocked(getDevice).mockRejectedValue(new Error('AWS request failed'))

    await expect(handler(makeRecord())).rejects.toThrow('All 1 device notifications failed')
  })

  it('should send to MetadataNotification as background notification', async () => {
    vi.mocked(validateSchema).mockReturnValue({success: true, data: {notificationType: 'MetadataNotification', userId: 'user-1'}})

    await handler(makeRecord('MetadataNotification'))

    expect(transformToAPNSNotification).toHaveBeenCalled()
    expect(transformToAPNSAlertNotification).not.toHaveBeenCalled()
  })

  it('should handle endpoint disabled detection with alternative message', async () => {
    vi.mocked(publish).mockRejectedValue(new Error('endpoint is disabled'))

    await expect(handler(makeRecord())).rejects.toThrow('All 1 device notifications failed')
    expect(metrics.addMetric).toHaveBeenCalledWith('DisabledEndpointsDetected', 'Count', 1)
  })

  it('should not fail when async cleanup throws', async () => {
    vi.mocked(getUserDevicesByUserId).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(getDevice).mockResolvedValueOnce({
      deviceId: 'dev-1',
      name: 'iPhone',
      token: 'tok1',
      systemVersion: '17',
      systemName: 'iOS',
      endpointArn: 'arn:endpoint/dev-1'
    }).mockResolvedValueOnce({deviceId: 'dev-2', name: 'iPad', token: 'tok2', systemVersion: '17', systemName: 'iPadOS', endpointArn: 'arn:endpoint/dev-2'})
    // First device succeeds, second has disabled endpoint
    vi.mocked(publish).mockResolvedValueOnce({MessageId: 'msg-1', $metadata: {}}).mockRejectedValueOnce(new Error('EndpointDisabled'))
    vi.mocked(cleanupDisabledEndpoints).mockRejectedValue(new Error('cleanup failed'))

    // Should not throw because at least one device succeeded
    await expect(handler(makeRecord())).resolves.toBeUndefined()
  })
})
