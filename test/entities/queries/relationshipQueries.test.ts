/**
 * Unit tests for Relationship Queries
 *
 * Tests mutable logic: null coalescing (result[0] ?? null),
 * map transforms (result.map(r => r.file)), empty array early returns,
 * and upsert branching (result.length === 0 -> fetch existing).
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockDevice, createMockFile, createMockUserDevice, createMockUserFile} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema',
  () => ({
    userFiles: {userId: 'userId', fileId: 'fileId'},
    userDevices: {userId: 'userId', deviceId: 'deviceId'},
    files: {fileId: 'fileId'},
    devices: {deviceId: 'deviceId'},
    users: {id: 'id'}
  }))
vi.mock('#db/zodSchemas', () => ({userFileInsertSchema: {parse: vi.fn((v: unknown) => v)}, userDeviceInsertSchema: {parse: vi.fn((v: unknown) => v)}}))
vi.mock('#db/fkEnforcement',
  () => ({
    assertUserExists: vi.fn().mockResolvedValue(undefined),
    assertFileExists: vi.fn().mockResolvedValue(undefined),
    assertDeviceExists: vi.fn().mockResolvedValue(undefined)
  }))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm',
  () => ({
    and: vi.fn((...args: unknown[]) => args),
    eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition'),
    or: vi.fn((...args: unknown[]) => args),
    inArray: vi.fn((_col: unknown, _vals: unknown) => 'inArray-condition')
  }))

const {
  getUserFile,
  getUserFilesByUserId,
  getUserFileIdsByUserId,
  getUserFilesByFileId,
  getFilesForUser,
  createUserFile,
  upsertUserFile,
  deleteUserFile,
  deleteUserFilesByUserId,
  deleteUserFilesBatch,
  getUserDevice,
  getUserDevicesByUserId,
  getUserDeviceIdsByUserId,
  getUserDevicesByDeviceId,
  getDevicesForUser,
  getDeviceIdsForUsers,
  createUserDevice,
  upsertUserDevice,
  deleteUserDevice,
  deleteUserDevicesByUserId,
  deleteUserDevicesByDeviceId
} = await import('#entities/queries/relationshipQueries')

describe('Relationship Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // UserFile Operations

  describe('getUserFile', () => {
    it('should return user-file when found', async () => {
      const mockUf = createMockUserFile()
      mockDb._setSelectResult([mockUf])

      const result = await getUserFile('user-1', 'file-1')

      expect(result).toEqual(mockUf)
    })

    it('should return null when not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getUserFile('user-1', 'nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getUserFilesByUserId', () => {
    it('should return user files', async () => {
      const ufs = [createMockUserFile(), createMockUserFile({fileId: 'file-2'})]
      mockDb._setSelectResult(ufs)

      const result = await getUserFilesByUserId('user-1')

      expect(result).toEqual(ufs)
    })
  })

  describe('getUserFileIdsByUserId', () => {
    it('should return mapped file IDs', async () => {
      mockDb._setSelectResult([{fileId: 'file-1'}, {fileId: 'file-2'}])

      const result = await getUserFileIdsByUserId('user-1')

      expect(result).toEqual(['file-1', 'file-2'])
    })

    it('should return empty array when no files', async () => {
      mockDb._setSelectResult([])

      const result = await getUserFileIdsByUserId('user-1')

      expect(result).toEqual([])
    })
  })

  describe('getUserFilesByFileId', () => {
    it('should return user files for file', async () => {
      const ufs = [createMockUserFile()]
      mockDb._setSelectResult(ufs)

      const result = await getUserFilesByFileId('file-1')

      expect(result).toEqual(ufs)
    })
  })

  describe('getFilesForUser', () => {
    it('should return mapped file objects from join', async () => {
      const file1 = createMockFile({fileId: 'file-1'})
      const file2 = createMockFile({fileId: 'file-2'})
      mockDb._setSelectResult([{file: file1}, {file: file2}])

      const result = await getFilesForUser('user-1')

      expect(result).toEqual([file1, file2])
    })

    it('should return empty array when user has no files', async () => {
      mockDb._setSelectResult([])

      const result = await getFilesForUser('user-1')

      expect(result).toEqual([])
    })
  })

  describe('createUserFile', () => {
    it('should return the created user-file', async () => {
      const mockUf = createMockUserFile()
      mockDb._setInsertResult([mockUf])

      const result = await createUserFile({userId: 'user-1', fileId: 'file-1'})

      expect(result).toEqual(mockUf)
    })
  })

  describe('upsertUserFile', () => {
    it('should return new row when insert succeeds (no conflict)', async () => {
      const mockUf = createMockUserFile()
      mockDb._setInsertResult([mockUf])

      const result = await upsertUserFile({userId: 'user-1', fileId: 'file-1'})

      expect(result).toEqual(mockUf)
    })

    it('should fetch existing row when conflict occurs (empty insert result)', async () => {
      const existingUf = createMockUserFile()
      // Insert returns empty (conflict, DO NOTHING)
      mockDb._setInsertResult([])
      // Select returns the existing record
      mockDb._setSelectResult([existingUf])

      const result = await upsertUserFile({userId: 'user-1', fileId: 'file-1'})

      expect(result).toEqual(existingUf)
    })
  })

  describe('deleteUserFile', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteUserFile('user-1', 'file-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteUserFilesByUserId', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteUserFilesByUserId('user-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteUserFilesBatch', () => {
    it('should return early for empty keys array (early return)', async () => {
      await deleteUserFilesBatch([])

      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('should delete for non-empty keys', async () => {
      mockDb._setDeleteResult([])

      await deleteUserFilesBatch([{userId: 'user-1', fileId: 'file-1'}])

      expect(mockDb.delete).toHaveBeenCalled()
    })
  })

  // UserDevice Operations

  describe('getUserDevice', () => {
    it('should return user-device when found', async () => {
      const mockUd = createMockUserDevice()
      mockDb._setSelectResult([mockUd])

      const result = await getUserDevice('user-1', 'device-1')

      expect(result).toEqual(mockUd)
    })

    it('should return null when not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getUserDevice('user-1', 'nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getUserDevicesByUserId', () => {
    it('should return user devices', async () => {
      const uds = [createMockUserDevice()]
      mockDb._setSelectResult(uds)

      const result = await getUserDevicesByUserId('user-1')

      expect(result).toEqual(uds)
    })
  })

  describe('getUserDeviceIdsByUserId', () => {
    it('should return mapped device IDs', async () => {
      mockDb._setSelectResult([{deviceId: 'device-1'}, {deviceId: 'device-2'}])

      const result = await getUserDeviceIdsByUserId('user-1')

      expect(result).toEqual(['device-1', 'device-2'])
    })

    it('should return empty array when no devices', async () => {
      mockDb._setSelectResult([])

      const result = await getUserDeviceIdsByUserId('user-1')

      expect(result).toEqual([])
    })
  })

  describe('getUserDevicesByDeviceId', () => {
    it('should return user devices for device', async () => {
      const uds = [createMockUserDevice()]
      mockDb._setSelectResult(uds)

      const result = await getUserDevicesByDeviceId('device-1')

      expect(result).toEqual(uds)
    })
  })

  describe('getDevicesForUser', () => {
    it('should return mapped device objects from join', async () => {
      const device1 = createMockDevice({deviceId: 'device-1'})
      const device2 = createMockDevice({deviceId: 'device-2'})
      mockDb._setSelectResult([{device: device1}, {device: device2}])

      const result = await getDevicesForUser('user-1')

      expect(result).toEqual([device1, device2])
    })

    it('should return empty array when user has no devices', async () => {
      mockDb._setSelectResult([])

      const result = await getDevicesForUser('user-1')

      expect(result).toEqual([])
    })
  })

  describe('getDeviceIdsForUsers', () => {
    it('should return empty array for empty input (early return)', async () => {
      const result = await getDeviceIdsForUsers([])

      expect(result).toEqual([])
      expect(mockDb.select).not.toHaveBeenCalled()
    })

    it('should return mapped device IDs for non-empty input', async () => {
      mockDb._setSelectResult([{deviceId: 'device-1'}, {deviceId: 'device-2'}])

      const result = await getDeviceIdsForUsers(['user-1', 'user-2'])

      expect(result).toEqual(['device-1', 'device-2'])
    })
  })

  describe('createUserDevice', () => {
    it('should return the created user-device', async () => {
      const mockUd = createMockUserDevice()
      mockDb._setInsertResult([mockUd])

      const result = await createUserDevice({userId: 'user-1', deviceId: 'device-1'})

      expect(result).toEqual(mockUd)
    })
  })

  describe('upsertUserDevice', () => {
    it('should return new row when insert succeeds (no conflict)', async () => {
      const mockUd = createMockUserDevice()
      mockDb._setInsertResult([mockUd])

      const result = await upsertUserDevice({userId: 'user-1', deviceId: 'device-1'})

      expect(result).toEqual(mockUd)
    })

    it('should fetch existing row when conflict occurs (empty insert result)', async () => {
      const existingUd = createMockUserDevice()
      // Insert returns empty (conflict, DO NOTHING)
      mockDb._setInsertResult([])
      // Select returns the existing record
      mockDb._setSelectResult([existingUd])

      const result = await upsertUserDevice({userId: 'user-1', deviceId: 'device-1'})

      expect(result).toEqual(existingUd)
    })
  })

  describe('deleteUserDevice', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteUserDevice('user-1', 'device-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteUserDevicesByUserId', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteUserDevicesByUserId('user-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteUserDevicesByDeviceId', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteUserDevicesByDeviceId('device-1')).resolves.toBeUndefined()
    })
  })
})
