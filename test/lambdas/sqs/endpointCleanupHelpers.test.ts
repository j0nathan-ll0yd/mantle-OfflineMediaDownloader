import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {SQSRecord} from 'aws-lambda'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as EndpointMod from '#lambdas/sqs/EndpointCleanupHelpers/index.js'

vi.mock('@mantleframework/core', () => ({defineSqsHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('@mantleframework/observability', () => ({logError: vi.fn(), logInfo: vi.fn(), metrics: {addMetric: vi.fn()}, MetricUnit: {Count: 'Count'}}))

vi.mock('@mantleframework/validation', async () => {
  const {z} = await import('zod')
  return {z}
})

vi.mock('#entities/queries', () => ({getDeviceByEndpointArn: vi.fn()}))
vi.mock('../../../src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js', () => ({cleanupDisabledEndpoint: vi.fn()}))

const {handler} = (await import('#lambdas/sqs/EndpointCleanupHelpers/index.js')) as unknown as MockedModule<typeof EndpointMod>
import {getDeviceByEndpointArn} from '#entities/queries'
import {cleanupDisabledEndpoint} from '../../../src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js'
import {logError, logInfo} from '@mantleframework/observability'

function makeSqsRecord(body: string): SQSRecord {
  return {
    messageId: 'test-message-id',
    receiptHandle: '',
    body,
    attributes: {} as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: '',
    awsRegion: 'us-east-1'
  }
}

function makeSnsWrappedEvent(event: Record<string, unknown>): string {
  return JSON.stringify({Message: JSON.stringify(event)})
}

describe('EndpointCleanupHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should use EndpointArn (not Resource) for device lookup', async () => {
    const endpointArn = 'arn:aws:sns:us-east-1:123456789:endpoint/APNS/MyApp/device-uuid'
    const platformAppArn = 'arn:aws:sns:us-east-1:123456789:app/APNS/MyApp'

    vi.mocked(getDeviceByEndpointArn).mockResolvedValue({
      deviceId: 'device-123',
      name: 'iPhone',
      token: 'token',
      endpointArn,
      systemVersion: '17.0',
      systemName: 'iOS',
      lastSeenAt: null
    })
    vi.mocked(cleanupDisabledEndpoint).mockResolvedValue({ok: true, value: {deviceId: 'device-123', endpointArn}} as never)

    const body = makeSnsWrappedEvent({
      EventType: 'EndpointDisabled',
      EndpointArn: endpointArn,
      Resource: platformAppArn,
      Service: 'SNS',
      Time: '2026-05-09T12:00:00.000Z'
    })

    await handler(makeSqsRecord(body))

    expect(getDeviceByEndpointArn).toHaveBeenCalledWith(endpointArn)
    expect(getDeviceByEndpointArn).not.toHaveBeenCalledWith(platformAppArn)
    expect(cleanupDisabledEndpoint).toHaveBeenCalledWith('device-123', endpointArn)
  })

  it('should ignore non-EndpointDisabled events', async () => {
    const body = makeSnsWrappedEvent({
      EventType: 'EndpointUpdated',
      EndpointArn: 'arn:aws:sns:us-east-1:123:endpoint/APNS/MyApp/uuid',
      Resource: 'arn:aws:sns:us-east-1:123:app/APNS/MyApp'
    })

    await handler(makeSqsRecord(body))

    expect(getDeviceByEndpointArn).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('Ignoring non-EndpointDisabled event', {eventType: 'EndpointUpdated'})
  })

  it('should log error on invalid JSON body', async () => {
    await handler(makeSqsRecord('not-json'))

    expect(logError).toHaveBeenCalledWith('Failed to parse SQS record body as JSON', {messageId: 'test-message-id'})
    expect(getDeviceByEndpointArn).not.toHaveBeenCalled()
  })

  it('should log error when SNS message fails schema validation', async () => {
    const body = JSON.stringify({Message: JSON.stringify({EventType: 'EndpointDisabled'})})

    await handler(makeSqsRecord(body))

    expect(logError).toHaveBeenCalledWith('SNS message failed schema validation', expect.objectContaining({messageId: 'test-message-id'}))
    expect(getDeviceByEndpointArn).not.toHaveBeenCalled()
  })

  it('should handle no device found for endpoint', async () => {
    vi.mocked(getDeviceByEndpointArn).mockResolvedValue(null)

    const body = makeSnsWrappedEvent({
      EventType: 'EndpointDisabled',
      EndpointArn: 'arn:aws:sns:us-east-1:123:endpoint/APNS/MyApp/unknown',
      Resource: 'arn:aws:sns:us-east-1:123:app/APNS/MyApp'
    })

    await handler(makeSqsRecord(body))

    expect(cleanupDisabledEndpoint).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('No device found for disabled endpoint', expect.objectContaining({endpointArn: expect.any(String)}))
  })
})
