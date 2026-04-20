/**
 * Unit tests for PruneDevices Lambda (scheduled handler)
 *
 * Tests device pruning logic based on APNS health checks.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core',
  () => ({defineLambda: vi.fn(), defineScheduledHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('@mantleframework/env', () => ({
  getRequiredEnv: vi.fn((key: string) => {
    const envs: Record<string, string> = {APNS_TEAM: 'TEAM123', APNS_KEY_ID: 'KEY123', APNS_SIGNING_KEY: 'signing-key', APNS_DEFAULT_TOPIC: 'com.app.test'}
    return envs[key] ?? 'mock-value'
  }),
  getOptionalEnv: vi.fn((_key: string, defaultVal: string) => defaultVal)
}))

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

vi.mock('@mantleframework/observability',
  () => ({
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => ({}))
  }))

vi.mock('#entities/queries', () => ({deleteUserDevicesByDeviceId: vi.fn(), getAllDevices: vi.fn()}))

vi.mock('#errors/custom-errors', () => ({
  Apns2Error: class Apns2Error extends Error {
    reason: string
    statusCode: number
    notification: unknown
    constructor(reason: string, statusCode: number, notification: unknown) {
      super()
      this.reason = reason
      this.statusCode = statusCode
      this.notification = notification
    }
  }
}))

vi.mock('#services/device/deviceService', () => ({deleteDevice: vi.fn()}))

// Shared mock send function that tests can configure per-test
const mockApnsSend = vi.fn().mockResolvedValue({})

// Mock the dynamic import of apns2 with a real class
vi.mock('apns2', () => {
  class MockApnsClient {
    send = mockApnsSend
  }
  return {ApnsClient: MockApnsClient, Notification: vi.fn(), Priority: {throttled: 5}, PushType: {background: 'background'}}
})

const {handler} = (await import('#lambdas/scheduled/PruneDevices/index.js')) as any
import {deleteUserDevicesByDeviceId, getAllDevices} from '#entities/queries'
import {deleteDevice} from '#services/device/deviceService'
import {metrics} from '@mantleframework/observability'

describe('PruneDevices Lambda', () => {
  const mockDevice = {
    deviceId: 'dev-1',
    name: 'iPhone',
    token: 'apns-token',
    systemVersion: '17.0',
    systemName: 'iOS',
    endpointArn: 'arn:aws:sns:endpoint/dev-1'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockApnsSend.mockReset()
    mockApnsSend.mockResolvedValue({})
    vi.mocked(getAllDevices).mockResolvedValue([])
  })

  it('should return zero counts when no devices exist', async () => {
    const result = await handler()

    expect(result.devicesChecked).toBe(0)
    expect(result.devicesPruned).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(metrics.addMetric).toHaveBeenCalledWith('PruneDevicesRun', 'Count', 1)
  })

  it('should check all devices and not prune healthy ones', async () => {
    vi.mocked(getAllDevices).mockResolvedValue([mockDevice])
    mockApnsSend.mockResolvedValue({})

    const result = await handler()

    expect(result.devicesChecked).toBe(1)
    expect(result.devicesPruned).toBe(0)
  })

  it('should prune disabled device (APNS 410)', async () => {
    vi.mocked(getAllDevices).mockResolvedValue([mockDevice])
    mockApnsSend.mockRejectedValue({reason: 'Unregistered', statusCode: 410})
    vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined as never)
    vi.mocked(deleteDevice).mockResolvedValue(undefined)

    const result = await handler()

    expect(result.devicesChecked).toBe(1)
    expect(result.devicesPruned).toBe(1)
    expect(deleteUserDevicesByDeviceId).toHaveBeenCalledWith('dev-1')
    expect(deleteDevice).toHaveBeenCalledWith(mockDevice)
    expect(metrics.addMetric).toHaveBeenCalledWith('DevicesPruned', 'Count', 1)
  })

  it('should record error when device deletion fails', async () => {
    vi.mocked(getAllDevices).mockResolvedValue([mockDevice])
    mockApnsSend.mockRejectedValue({reason: 'Unregistered', statusCode: 410})
    vi.mocked(deleteUserDevicesByDeviceId).mockRejectedValue(new Error('DB error'))

    const result = await handler()

    expect(result.devicesChecked).toBe(1)
    expect(result.devicesPruned).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Failed to properly remove device dev-1')
  })

  it('should throw UnexpectedError for non-APNS errors', async () => {
    vi.mocked(getAllDevices).mockResolvedValue([mockDevice])
    mockApnsSend.mockRejectedValue(new Error('network failure'))

    await expect(handler()).rejects.toThrow('Unexpected result from APNS')
  })

  it('should process multiple devices independently', async () => {
    const device2 = {...mockDevice, deviceId: 'dev-2', token: 'apns-token-2'}
    vi.mocked(getAllDevices).mockResolvedValue([mockDevice, device2])
    let callCount = 0
    mockApnsSend.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({})
      }
      return Promise.reject({reason: 'Unregistered', statusCode: 410})
    })
    vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined as never)
    vi.mocked(deleteDevice).mockResolvedValue(undefined)

    const result = await handler()

    expect(result.devicesChecked).toBe(2)
    expect(result.devicesPruned).toBe(1)
  })
})
