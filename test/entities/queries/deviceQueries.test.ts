/**
 * Unit tests for Device Queries
 *
 * Tests mutable logic: null coalescing (result[0] ?? null),
 * empty array early return (deviceIds.length === 0),
 * and non-null assertions on returning().
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockDevice} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema', () => ({devices: {deviceId: 'deviceId'}}))
vi.mock('#db/zodSchemas',
  () => ({deviceInsertSchema: {parse: vi.fn((v: unknown) => v)}, deviceUpdateSchema: {partial: vi.fn(() => ({parse: vi.fn((v: unknown) => v)}))}}))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm',
  () => ({eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition'), inArray: vi.fn((_col: unknown, _vals: unknown) => 'inArray-condition')}))

const {getDevice, getDevicesBatch, createDevice, upsertDevice, updateDevice, deleteDevice, getAllDevices} = await import('#entities/queries/deviceQueries')

describe('Device Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDevice', () => {
    it('should return device when found', async () => {
      const mockDevice = createMockDevice()
      mockDb._setSelectResult([mockDevice])

      const result = await getDevice('device-1')

      expect(result).toEqual(mockDevice)
    })

    it('should return null when device not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getDevice('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getDevicesBatch', () => {
    it('should return empty array for empty input (early return)', async () => {
      const result = await getDevicesBatch([])

      expect(result).toEqual([])
      expect(mockDb.select).not.toHaveBeenCalled()
    })

    it('should return devices for non-empty input', async () => {
      const devices = [createMockDevice(), createMockDevice({deviceId: 'device-2'})]
      mockDb._setSelectResult(devices)

      const result = await getDevicesBatch(['device-1', 'device-2'])

      expect(result).toEqual(devices)
    })
  })

  describe('createDevice', () => {
    it('should return the created device', async () => {
      const mockDevice = createMockDevice()
      mockDb._setInsertResult([mockDevice])

      const result = await createDevice({
        deviceId: 'device-1',
        name: 'iPhone',
        token: 'token-1',
        systemVersion: '17.0',
        systemName: 'iOS',
        endpointArn: 'arn:endpoint'
      })

      expect(result).toEqual(mockDevice)
    })
  })

  describe('upsertDevice', () => {
    it('should return the upserted device', async () => {
      const mockDevice = createMockDevice()
      mockDb._setInsertResult([mockDevice])

      const result = await upsertDevice({
        deviceId: 'device-1',
        name: 'iPhone',
        token: 'token-1',
        systemVersion: '17.0',
        systemName: 'iOS',
        endpointArn: 'arn:endpoint'
      })

      expect(result).toEqual(mockDevice)
    })
  })

  describe('updateDevice', () => {
    it('should return the updated device', async () => {
      const mockDevice = createMockDevice({name: 'Updated iPhone'})
      mockDb._setUpdateResult([mockDevice])

      const result = await updateDevice('device-1', {name: 'Updated iPhone'})

      expect(result).toEqual(mockDevice)
    })
  })

  describe('deleteDevice', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteDevice('device-1')).resolves.toBeUndefined()
    })
  })

  describe('getAllDevices', () => {
    it('should return all devices', async () => {
      const devices = [createMockDevice(), createMockDevice({deviceId: 'device-2'})]
      mockDb._setSelectResult(devices)

      const result = await getAllDevices()

      expect(result).toEqual(devices)
    })

    it('should return empty array when no devices exist', async () => {
      mockDb._setSelectResult([])

      const result = await getAllDevices()

      expect(result).toEqual([])
    })
  })
})
