/**
 * Unit tests for Device Service Functions
 *
 * Tests device management including registration, deletion, and SNS subscriptions.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock dependencies BEFORE importing the module under test
vi.mock('#entities/queries', () => ({deleteDevice: vi.fn(), deleteUserDevice: vi.fn(), getUserDevicesByUserId: vi.fn()}))

vi.mock('@j0nathan-ll0yd/observability', () => ({logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn()}))

vi.mock('@j0nathan-ll0yd/aws', () => ({deleteEndpoint: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn()}))

// Import after mocking
const {deleteUserDevice, deleteDevice, getUserDevices, subscribeEndpointToTopic, unsubscribeEndpointToTopic} = await import(
  '#services/device/deviceService.js'
)
import {deleteDevice as deleteDeviceQuery, deleteUserDevice as deleteUserDeviceQuery, getUserDevicesByUserId} from '#entities/queries'
import {deleteEndpoint, subscribe, unsubscribe} from '@j0nathan-ll0yd/aws'
import {logDebug} from '@j0nathan-ll0yd/observability'

describe('Device Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('deleteUserDevice', () => {
    it('should delete a user-device association', async () => {
      vi.mocked(deleteUserDeviceQuery).mockResolvedValue(undefined)

      await deleteUserDevice('user-123', 'device-456')

      expect(deleteUserDeviceQuery).toHaveBeenCalledWith('user-123', 'device-456')
      expect(logDebug).toHaveBeenCalledWith('deleteUserDevice <=', {userId: 'user-123', deviceId: 'device-456'})
      expect(logDebug).toHaveBeenCalledWith('deleteUserDevice => done')
    })

    it('should propagate errors from the query', async () => {
      vi.mocked(deleteUserDeviceQuery).mockRejectedValue(new Error('Database error'))

      await expect(deleteUserDevice('user-123', 'device-456')).rejects.toThrow('Database error')
    })
  })

  describe('deleteDevice', () => {
    const mockDevice = {
      deviceId: 'device-123',
      endpointArn: 'arn:aws:sns:us-east-1:123456789:endpoint/APNS/app/device-123',
      deviceToken: 'token-123',
      platform: 'ios' as const,
      lastActive: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      name: 'Test iPhone',
      token: 'apns-token-123',
      systemVersion: '17.0',
      systemName: 'iOS'
    }

    it('should delete SNS endpoint and device record', async () => {
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceQuery).mockResolvedValue(undefined)

      await deleteDevice(mockDevice)

      expect(deleteEndpoint).toHaveBeenCalledWith(mockDevice.endpointArn)
      expect(deleteDeviceQuery).toHaveBeenCalledWith(mockDevice.deviceId)
      expect(logDebug).toHaveBeenCalledWith('deleteDevice.deleteEndpoint <=', {endpointArn: mockDevice.endpointArn})
      expect(logDebug).toHaveBeenCalledWith('deleteDevice.deleteEndpoint =>', {$metadata: {}})
      expect(logDebug).toHaveBeenCalledWith('deleteDevice.deleteItem <=', {deviceId: mockDevice.deviceId})
      expect(logDebug).toHaveBeenCalledWith('deleteDevice.deleteItem => done')
    })

    it('should propagate SNS endpoint deletion errors', async () => {
      vi.mocked(deleteEndpoint).mockRejectedValue(new Error('SNS error'))

      await expect(deleteDevice(mockDevice)).rejects.toThrow('SNS error')
      expect(deleteDeviceQuery).not.toHaveBeenCalled()
    })

    it('should propagate device deletion errors', async () => {
      vi.mocked(deleteEndpoint).mockResolvedValue({$metadata: {}})
      vi.mocked(deleteDeviceQuery).mockRejectedValue(new Error('DB error'))

      await expect(deleteDevice(mockDevice)).rejects.toThrow('DB error')
    })
  })

  describe('getUserDevices', () => {
    it('should return user devices from database', async () => {
      const mockUserDevices = [
        {userId: 'user-123', deviceId: 'device-1', createdAt: new Date()},
        {userId: 'user-123', deviceId: 'device-2', createdAt: new Date()}
      ]
      vi.mocked(getUserDevicesByUserId).mockResolvedValue(mockUserDevices)

      const result = await getUserDevices('user-123')

      expect(result).toEqual(mockUserDevices)
      expect(getUserDevicesByUserId).toHaveBeenCalledWith('user-123')
      expect(logDebug).toHaveBeenCalledWith('getUserDevices <=', {userId: 'user-123'})
      expect(logDebug).toHaveBeenCalledWith('getUserDevices =>', {count: 2})
    })

    it('should return empty array when user has no devices', async () => {
      vi.mocked(getUserDevicesByUserId).mockResolvedValue([])

      const result = await getUserDevices('user-123')

      expect(result).toEqual([])
    })

    it('should propagate database errors', async () => {
      vi.mocked(getUserDevicesByUserId).mockRejectedValue(new Error('Connection error'))

      await expect(getUserDevices('user-123')).rejects.toThrow('Connection error')
    })
  })

  describe('subscribeEndpointToTopic', () => {
    it('should subscribe an endpoint to an SNS topic', async () => {
      const mockResponse = {SubscriptionArn: 'arn:aws:sns:us-east-1:123456789:subscription/app/sub-123', $metadata: {}}
      vi.mocked(subscribe).mockResolvedValue(mockResponse)

      const result = await subscribeEndpointToTopic('arn:aws:sns:endpoint', 'arn:aws:sns:topic')

      expect(result).toEqual(mockResponse)
      expect(subscribe).toHaveBeenCalledWith('arn:aws:sns:topic', 'application', 'arn:aws:sns:endpoint')
      expect(logDebug).toHaveBeenCalledWith('subscribe <=', {endpointArn: 'arn:aws:sns:endpoint', topicArn: 'arn:aws:sns:topic'})
    })

    it('should propagate SNS subscription errors', async () => {
      vi.mocked(subscribe).mockRejectedValue(new Error('SNS subscription failed'))

      await expect(subscribeEndpointToTopic('arn:aws:sns:endpoint', 'arn:aws:sns:topic')).rejects.toThrow('SNS subscription failed')
    })
  })

  describe('unsubscribeEndpointToTopic', () => {
    it('should unsubscribe from an SNS topic', async () => {
      const mockResponse = {$metadata: {}}
      vi.mocked(unsubscribe).mockResolvedValue(mockResponse)

      const result = await unsubscribeEndpointToTopic('arn:aws:sns:subscription/sub-123')

      expect(result).toEqual(mockResponse)
      expect(unsubscribe).toHaveBeenCalledWith('arn:aws:sns:subscription/sub-123')
      expect(logDebug).toHaveBeenCalledWith('unsubscribeEndpointToTopic <=', {subscriptionArn: 'arn:aws:sns:subscription/sub-123'})
      expect(logDebug).toHaveBeenCalledWith('unsubscribeEndpointToTopic =>', mockResponse)
    })

    it('should propagate SNS unsubscription errors', async () => {
      vi.mocked(unsubscribe).mockRejectedValue(new Error('SNS unsubscribe failed'))

      await expect(unsubscribeEndpointToTopic('arn:aws:sns:subscription/sub-123')).rejects.toThrow('SNS unsubscribe failed')
    })
  })
})
