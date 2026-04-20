/**
 * Unit tests for DeviceEvent Lambda (POST /device/event)
 *
 * Tests event logging, metrics, and tracing span management.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, code) => ({statusCode: code}))}))

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    endSpan: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => 'mock-span')
  }))

vi.mock('@mantleframework/validation', () => ({defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

const {handler} = (await import('#lambdas/api/device/event.post.js')) as any
import {addAnnotation, endSpan, logInfo, metrics, startSpan} from '@mantleframework/observability'

describe('DeviceEvent Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should log event with deviceId from header', async () => {
    const result = await handler({event: {headers: {'x-device-uuid': 'dev-123'}, body: '{"action":"download_started"}'}, context: {awsRequestId: 'req-1'}})

    expect(logInfo).toHaveBeenCalledWith('Event received', {deviceId: 'dev-123', message: '{"action":"download_started"}'})
    expect(addAnnotation).toHaveBeenCalledWith('mock-span', 'deviceId', 'dev-123')
    expect(result.statusCode).toBe(204)
  })

  it('should handle missing deviceId header', async () => {
    await handler({event: {headers: {}, body: 'test message'}, context: {awsRequestId: 'req-1'}})

    expect(addAnnotation).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('Event received', {deviceId: undefined, message: 'test message'})
  })

  it('should track DeviceEventReceived metric', async () => {
    await handler({event: {headers: {}, body: 'test'}, context: {awsRequestId: 'req-1'}})

    expect(metrics.addMetric).toHaveBeenCalledWith('DeviceEventReceived', 'Count', 1)
  })

  it('should start and end tracing span', async () => {
    await handler({event: {headers: {}, body: 'test'}, context: {awsRequestId: 'req-1'}})

    expect(startSpan).toHaveBeenCalledWith('device-event-log')
    expect(endSpan).toHaveBeenCalledWith('mock-span')
  })
})
