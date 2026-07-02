// covers: cascade-deletion#children-deleted-before-parent
// covers: cascade-deletion#batch-cleanup-isolates-partial-failures
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core',
  () => ({
    err: (error: unknown) => ({error, ok: false as const}),
    isOk: (result: {ok: boolean}) => result.ok,
    ok: (value: unknown) => ({ok: true as const, value})
  }))

vi.mock('@mantleframework/observability', () => ({logDebug: vi.fn(), logError: vi.fn(), logInfo: vi.fn()}))

vi.mock('#entities/queries', () => ({deleteDevice: vi.fn(), deleteUserDevicesByDeviceId: vi.fn(), getDevice: vi.fn()}))

vi.mock('@mantleframework/aws', () => ({deleteEndpoint: vi.fn()}))

import {cleanupDisabledEndpoint, cleanupDisabledEndpoints} from '#lambdas/sqs/SendPushNotification/endpointCleanupHelpers.js'
import {deleteDevice, deleteUserDevicesByDeviceId, getDevice} from '#entities/queries'
import {deleteEndpoint} from '@mantleframework/aws'

const DEVICE_ID = 'device-abc-123'
const ENDPOINT_ARN = 'arn:aws:sns:us-east-1:123456789012:endpoint/APNS/MyApp/device-abc-123'

const mockDevice = {
  deviceId: DEVICE_ID,
  endpointArn: ENDPOINT_ARN,
  lastSeenAt: null,
  name: 'iPhone 15',
  systemName: 'iOS',
  systemVersion: '17.4',
  token: 'apns-token-abc'
}

describe('cascade deletion ordering — endpoint cleanup', () => {
  const callOrder: string[] = []

  beforeEach(() => {
    callOrder.length = 0

    vi.mocked(deleteUserDevicesByDeviceId).mockImplementation(() => {
      callOrder.push('deleteUserDevicesByDeviceId')
      return Promise.resolve()
    })
    vi.mocked(deleteEndpoint).mockImplementation(() => {
      callOrder.push('deleteEndpoint')
      return Promise.resolve({$metadata: {}})
    })
    vi.mocked(deleteDevice).mockImplementation(() => {
      callOrder.push('deleteDevice')
      return Promise.resolve()
    })
  })

  describe('cleanupDisabledEndpoint', () => {
    it('deletes UserDevice records before the SNS endpoint, and the SNS endpoint before the Device record', async () => {
      await cleanupDisabledEndpoint(DEVICE_ID, ENDPOINT_ARN)

      expect(callOrder).toEqual(['deleteUserDevicesByDeviceId', 'deleteEndpoint', 'deleteDevice'])
    })

    it('passes the correct identifiers to each deletion step', async () => {
      await cleanupDisabledEndpoint(DEVICE_ID, ENDPOINT_ARN)

      expect(deleteUserDevicesByDeviceId).toHaveBeenCalledWith(DEVICE_ID)
      expect(deleteEndpoint).toHaveBeenCalledWith(ENDPOINT_ARN)
      expect(deleteDevice).toHaveBeenCalledWith(DEVICE_ID)
    })
  })

  describe('cleanupDisabledEndpoints', () => {
    it('uses Promise.allSettled so one rejection does not prevent cleanup of remaining devices', async () => {
      const secondDeviceId = 'device-def-456'
      const secondEndpointArn = 'arn:aws:sns:us-east-1:123456789012:endpoint/APNS/MyApp/device-def-456'

      vi.mocked(getDevice).mockRejectedValueOnce(new Error('DB connection failed')).mockResolvedValueOnce({
        ...mockDevice,
        deviceId: secondDeviceId,
        endpointArn: secondEndpointArn
      })

      const results = await cleanupDisabledEndpoints([DEVICE_ID, secondDeviceId])

      expect(getDevice).toHaveBeenCalledWith(DEVICE_ID)
      expect(getDevice).toHaveBeenCalledWith(secondDeviceId)
      expect(results).toHaveLength(2)
      expect(results.filter((r) => !r.ok)).toHaveLength(1)
      expect(results.filter((r) => r.ok)).toHaveLength(1)
    })
  })
})
