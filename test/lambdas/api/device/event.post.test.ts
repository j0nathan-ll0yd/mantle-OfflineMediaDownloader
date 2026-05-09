/**
 * Unit tests for DeviceEvent Lambda (POST /device/event)
 *
 * Tests event logging, metrics, and device validation.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as EventMod from '#lambdas/api/device/event.post.js'

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, code) => ({statusCode: code}))}))

vi.mock('@mantleframework/observability',
  () => ({
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
  }))

vi.mock('@mantleframework/validation', async () => {
  const {z} = await import('zod')
  return {z, defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}
})

vi.mock('#entities/queries', () => ({
  createDeviceEvents: vi.fn(() => [{id: 'evt-1'}]),
  getUserDevicesByDeviceId: vi.fn(() => [{userId: 'user-1', deviceId: 'dev-123'}]),
  updateDevice: vi.fn(),
}))

const {handler} = (await import('#lambdas/api/device/event.post.js')) as unknown as MockedModule<typeof EventMod>
import {logInfo, metrics} from '@mantleframework/observability'
import {createDeviceEvents, updateDevice} from '#entities/queries'

describe('DeviceEvent Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const makeCtx = (deviceId?: string, userId?: string) => ({
    event: {headers: deviceId ? {'x-device-uuid': deviceId} : {}},
    context: {awsRequestId: 'req-1'},
    userId,
    body: {events: [{eventType: 'push_delivered' as const, timestamp: '2026-05-09T12:00:00Z', correlationId: 'notif-1'}]},
  })

  it('should insert events and return 204', async () => {
    const result = await handler(makeCtx('dev-123'))

    expect(createDeviceEvents).toHaveBeenCalledWith([
      expect.objectContaining({deviceId: 'dev-123', eventType: 'push_delivered', correlationId: 'notif-1'}),
    ])
    expect(updateDevice).toHaveBeenCalledWith('dev-123', expect.objectContaining({lastSeenAt: expect.any(Date)}))
    expect(result.statusCode).toBe(204)
  })

  it('should return 400 when deviceId header is missing', async () => {
    const result = await handler(makeCtx())

    expect(result.statusCode).toBe(400)
    expect(createDeviceEvents).not.toHaveBeenCalled()
  })

  it('should track DeviceEventReceived metric', async () => {
    await handler(makeCtx('dev-123'))

    expect(metrics.addMetric).toHaveBeenCalledWith('DeviceEventReceived', 'Count', 1)
    expect(metrics.addMetric).toHaveBeenCalledWith('DeviceEventBatchSize', 'Count', 1)
  })

  it('should log ingested events', async () => {
    await handler(makeCtx('dev-123'))

    expect(logInfo).toHaveBeenCalledWith('Device events ingested', {deviceId: 'dev-123', received: 1, inserted: 1})
  })
})
