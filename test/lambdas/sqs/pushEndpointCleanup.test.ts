// covers: push-notification#disabled-endpoint-cleanup-on-invalid-token
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {SQSRecord} from 'aws-lambda'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as PushNotificationMod from '#lambdas/sqs/SendPushNotification/index.js'

vi.mock('@mantleframework/core',
  () => ({defineSqsHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler), isErr: (r: {ok: boolean}) => !r.ok}))

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    MetricUnit: {Count: 'Count'},
    metrics: {addMetric: vi.fn()},
    startSpan: vi.fn().mockReturnValue({})
  }))

vi.mock('@mantleframework/validation', async () => {
  const {z} = await import('zod')
  return {validateSchema: vi.fn(), z}
})

vi.mock('../../../src/lambdas/sqs/SendPushNotification/pushHelpers.js',
  () => ({
    getDevice: vi.fn(),
    getDeviceIdsForUser: vi.fn(),
    mapSettledToDeviceResults: vi.fn(),
    processNotificationResults: vi.fn(),
    sendNotificationToDevice: vi.fn()
  }))

vi.mock('../../../src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js', () => ({cleanupDisabledEndpoints: vi.fn()}))

const {handler} = (await import('#lambdas/sqs/SendPushNotification/index.js')) as unknown as MockedModule<typeof PushNotificationMod>

import {validateSchema} from '@mantleframework/validation'
import {cleanupDisabledEndpoints} from '../../../src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js'
import {getDeviceIdsForUser, mapSettledToDeviceResults, processNotificationResults} from '../../../src/lambdas/sqs/SendPushNotification/pushHelpers.js'

const DEVICE_ID = 'device-disabled-123'
const USER_ID = 'user-abc-456'

const disabledEndpointResult = {error: {deviceId: DEVICE_ID, endpointDisabled: true, error: 'EndpointDisabled'}, ok: false as const}

function makeSqsRecord(userId: string, notificationType: string): SQSRecord {
  return {
    awsRegion: 'us-east-1',
    attributes: {} as SQSRecord['attributes'],
    body: '{}',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:push-queue',
    md5OfBody: '',
    messageAttributes: {notificationType: {dataType: 'String', stringValue: notificationType}, userId: {dataType: 'String', stringValue: userId}},
    messageId: 'push-test-msg-id',
    receiptHandle: ''
  }
}

describe('SendPushNotification — disabled endpoint cleanup', () => {
  beforeEach(() => {
    vi.mocked(validateSchema).mockReturnValue({data: {notificationType: 'DownloadReadyNotification', userId: USER_ID}, success: true})
    vi.mocked(getDeviceIdsForUser).mockResolvedValue([DEVICE_ID])
    vi.mocked(mapSettledToDeviceResults).mockReturnValue([disabledEndpointResult])
    vi.mocked(processNotificationResults).mockReturnValue({disabledEndpoints: [disabledEndpointResult], failed: [disabledEndpointResult], succeeded: []})
    vi.mocked(cleanupDisabledEndpoints).mockResolvedValue([])
  })

  it('initiates disabled endpoint cleanup when APNs signals an invalid device token', async () => {
    await expect(handler(makeSqsRecord(USER_ID, 'DownloadReadyNotification'))).rejects.toThrow()

    expect(cleanupDisabledEndpoints).toHaveBeenCalledWith([DEVICE_ID])
  })
})
