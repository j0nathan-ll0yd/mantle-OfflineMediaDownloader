/**
 * Unit tests for APNS Endpoint Cleanup Service
 *
 * Tests cleanup of disabled APNS endpoints including single device cleanup,
 * lookup-based cleanup, and batch operations.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockDevice} from '#test/helpers/entity-fixtures'

vi.mock('#entities/queries', () => ({deleteDevice: vi.fn(), deleteUserDevicesByDeviceId: vi.fn(), getDevice: vi.fn()}))

vi.mock('@j0nathan-ll0yd/aws', () => ({deleteEndpoint: vi.fn()}))

vi.mock('@j0nathan-ll0yd/observability', () => ({logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn()}))

vi.mock('@j0nathan-ll0yd/core',
  () => ({
    ok: vi.fn((value: unknown) => ({success: true, value})),
    err: vi.fn((error: unknown) => ({success: false, error})),
    isOk: vi.fn((result: {success: boolean}) => result.success)
  }))

const {cleanupDisabledEndpoint, cleanupDisabledEndpointByDeviceId, cleanupDisabledEndpoints} = await import(
  '#lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js'
)
import {deleteDevice as deleteDeviceRecord, deleteUserDevicesByDeviceId, getDevice} from '#entities/queries'
import {deleteEndpoint} from '@j0nathan-ll0yd/aws'
import {logError, logInfo} from '@j0nathan-ll0yd/observability'

describe('Endpoint Cleanup Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('cleanupDisabledEndpoint', () => {
    const deviceId = 'device-123'
    const endpointArn = 'arn:aws:sns:us-west-2:123456789012:endpoint/APNS_SANDBOX/app/device-123'

    it('should cleanup all resources in order and return ok result', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockResolvedValue(undefined)

      const result = await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(result).toEqual({success: true, value: {deviceId, endpointArn}})

      // Verify order: junction records first, then SNS endpoint, then device
      const deleteUserDevicesCall = vi.mocked(deleteUserDevicesByDeviceId).mock.invocationCallOrder[0]
      const deleteEndpointCall = vi.mocked(deleteEndpoint).mock.invocationCallOrder[0]
      const deleteDeviceCall = vi.mocked(deleteDeviceRecord).mock.invocationCallOrder[0]
      expect(deleteUserDevicesCall).toBeLessThan(deleteEndpointCall!)
      expect(deleteEndpointCall).toBeLessThan(deleteDeviceCall!)
    })

    it('should log info messages on start and completion', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockResolvedValue(undefined)

      await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(logInfo).toHaveBeenCalledWith('Cleaning up disabled endpoint', {deviceId, endpointArn})
      expect(logInfo).toHaveBeenCalledWith('Successfully cleaned up disabled endpoint', {deviceId})
    })

    it('should return err result when deleteUserDevicesByDeviceId fails', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockRejectedValue(new Error('DB connection lost'))

      const result = await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(result).toEqual({success: false, error: {deviceId, endpointArn, error: 'DB connection lost'}})
      expect(deleteEndpoint).not.toHaveBeenCalled()
      expect(deleteDeviceRecord).not.toHaveBeenCalled()
    })

    it('should return err result when deleteEndpoint fails', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockRejectedValue(new Error('SNS error'))

      const result = await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(result).toEqual({success: false, error: {deviceId, endpointArn, error: 'SNS error'}})
      expect(deleteDeviceRecord).not.toHaveBeenCalled()
    })

    it('should return err result when deleteDeviceRecord fails', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockRejectedValue(new Error('Device not found'))

      const result = await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(result).toEqual({success: false, error: {deviceId, endpointArn, error: 'Device not found'}})
    })

    it('should log error when cleanup fails', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockRejectedValue(new Error('Timeout'))

      await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(logError).toHaveBeenCalledWith('Failed to cleanup disabled endpoint', {deviceId, endpointArn, error: 'Timeout'})
    })

    it('should handle non-Error thrown values', async () => {
      vi.mocked(deleteUserDevicesByDeviceId).mockRejectedValue('string error')

      const result = await cleanupDisabledEndpoint(deviceId, endpointArn)

      expect(result).toEqual({success: false, error: {deviceId, endpointArn, error: 'string error'}})
    })
  })

  describe('cleanupDisabledEndpointByDeviceId', () => {
    it('should look up device and clean up endpoint', async () => {
      const device = createMockDevice({deviceId: 'device-456'})
      vi.mocked(getDevice).mockResolvedValue(device)
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockResolvedValue(undefined)

      const result = await cleanupDisabledEndpointByDeviceId('device-456')

      expect(result).toEqual({success: true, value: {deviceId: 'device-456', endpointArn: device.endpointArn}})
      expect(getDevice).toHaveBeenCalledWith('device-456')
    })

    it('should return undefined when device is not found', async () => {
      vi.mocked(getDevice).mockResolvedValue(null)

      const result = await cleanupDisabledEndpointByDeviceId('nonexistent')

      expect(result).toBeUndefined()
      expect(logInfo).toHaveBeenCalledWith('Device not found for cleanup', {deviceId: 'nonexistent'})
      expect(deleteUserDevicesByDeviceId).not.toHaveBeenCalled()
    })

    it('should return undefined when device has no endpoint ARN', async () => {
      const device = createMockDevice({deviceId: 'device-no-arn', endpointArn: ''})
      vi.mocked(getDevice).mockResolvedValue(device)

      const result = await cleanupDisabledEndpointByDeviceId('device-no-arn')

      expect(result).toBeUndefined()
      expect(logInfo).toHaveBeenCalledWith('Device has no endpoint ARN', {deviceId: 'device-no-arn'})
      expect(deleteUserDevicesByDeviceId).not.toHaveBeenCalled()
    })
  })

  describe('cleanupDisabledEndpoints', () => {
    it('should return empty array for empty input', async () => {
      const results = await cleanupDisabledEndpoints([])

      expect(results).toEqual([])
      expect(getDevice).not.toHaveBeenCalled()
    })

    it('should process multiple devices in parallel', async () => {
      const device1 = createMockDevice({deviceId: 'dev-1'})
      const device2 = createMockDevice({deviceId: 'dev-2'})

      vi.mocked(getDevice).mockResolvedValueOnce(device1).mockResolvedValueOnce(device2)
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockResolvedValue(undefined)

      const results = await cleanupDisabledEndpoints(['dev-1', 'dev-2'])

      expect(results).toHaveLength(2)
      expect(getDevice).toHaveBeenCalledTimes(2)
    })

    it('should skip devices not found (no result added)', async () => {
      vi.mocked(getDevice).mockResolvedValue(null)

      const results = await cleanupDisabledEndpoints(['missing-1', 'missing-2'])

      // Not found devices return undefined from cleanupDisabledEndpointByDeviceId,
      // which are filtered out in the results
      expect(results).toHaveLength(0)
    })

    it('should include err results for rejected promises', async () => {
      vi.mocked(getDevice).mockRejectedValue(new Error('DB down'))

      const results = await cleanupDisabledEndpoints(['dev-fail'])

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({success: false, error: {deviceId: 'dev-fail', endpointArn: '', error: 'DB down'}})
    })

    it('should log batch summary', async () => {
      vi.mocked(getDevice).mockResolvedValue(null)

      await cleanupDisabledEndpoints(['dev-1'])

      expect(logInfo).toHaveBeenCalledWith('Starting batch endpoint cleanup', {deviceCount: 1})
      expect(logInfo).toHaveBeenCalledWith('Batch endpoint cleanup complete', expect.objectContaining({total: 1}))
    })

    it('should handle mix of successes and failures', async () => {
      const device1 = createMockDevice({deviceId: 'dev-ok'})
      vi.mocked(getDevice).mockResolvedValueOnce(device1).mockRejectedValueOnce(new Error('fail'))
      vi.mocked(deleteUserDevicesByDeviceId).mockResolvedValue(undefined)
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceRecord).mockResolvedValue(undefined)

      const results = await cleanupDisabledEndpoints(['dev-ok', 'dev-fail'])

      expect(results).toHaveLength(2)
      expect(logInfo).toHaveBeenCalledWith('Batch endpoint cleanup complete', expect.objectContaining({total: 2, cleaned: 1, failed: 1}))
    })
  })
})
