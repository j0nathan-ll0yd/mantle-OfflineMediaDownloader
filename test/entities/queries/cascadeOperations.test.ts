// covers: cascade-deletion#children-deleted-before-parent
// covers: cascade-deletion#orphan-check-before-file-removal
/**
 * Unit tests for Cascade Operations
 *
 * Tests mutable logic: conditional branching in deleteFileCascade
 * (!existing -> early return, remaining.length > 0 -> partial return).
 * Also verifies cascade deletion ORDER (children before parents) for
 * deleteUserCascade and deleteFileCascade.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockUserFile} from '#test/helpers/entity-fixtures'
import {accounts, fileDownloads, files, sessions, userDevices, userFiles, users} from '#db/schema'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema',
  () => ({
    userFiles: {userId: 'userId', fileId: 'fileId'},
    userDevices: {userId: 'userId', deviceId: 'deviceId'},
    sessions: {userId: 'userId'},
    accounts: {userId: 'userId'},
    users: {id: 'id'},
    files: {fileId: 'fileId'},
    fileDownloads: {fileId: 'fileId'}
  }))
vi.mock('@j0nathan-ll0yd/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@j0nathan-ll0yd/database/orm', () => ({and: vi.fn((...args: unknown[]) => args), eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition')}))

const {deleteUserCascade, deleteUserRelationships, deleteUserAuthRecords, deleteFileCascade} = await import('#entities/queries/cascadeOperations')

describe('Cascade Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('deleteUserCascade', () => {
    it('should delete all related records', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteUserCascade('user-1')).resolves.toBeUndefined()

      // Should call delete 5 times: userFiles, userDevices, sessions, accounts, users
      expect(mockDb.delete).toHaveBeenCalledTimes(5)
    })

    it('deletes junction tables before auth records, and auth records before the User record', async () => {
      mockDb._setDeleteResult([])

      await deleteUserCascade('user-1')

      const deletedTables = mockDb.delete.mock.calls.map((args) => args[0])
      expect(deletedTables[0]).toBe(userFiles)
      expect(deletedTables[1]).toBe(userDevices)
      expect(deletedTables[2]).toBe(sessions)
      expect(deletedTables[3]).toBe(accounts)
      expect(deletedTables[4]).toBe(users)
    })
  })

  describe('deleteUserRelationships', () => {
    it('should delete junction table records', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteUserRelationships('user-1')).resolves.toBeUndefined()

      // Should call delete 2 times: userFiles, userDevices
      expect(mockDb.delete).toHaveBeenCalledTimes(2)
    })
  })

  describe('deleteUserAuthRecords', () => {
    it('should delete auth records', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteUserAuthRecords('user-1')).resolves.toBeUndefined()

      // Should call delete 2 times: sessions, accounts
      expect(mockDb.delete).toHaveBeenCalledTimes(2)
    })
  })

  describe('deleteFileCascade', () => {
    it('should return existed:false when user-file link does not exist', async () => {
      // First select returns empty (no existing link)
      mockDb._setSelectResult([])

      const result = await deleteFileCascade('user-1', 'file-1')

      expect(result).toEqual({existed: false, fileRemoved: false})
      // Should not call delete since link doesn't exist
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('should return fileRemoved:false when other users still linked', async () => {
      const existingLink = createMockUserFile()
      const otherLink = createMockUserFile({userId: 'user-2'})

      // Track select call count to return different results
      let selectCallCount = 0
      mockDb.select.mockImplementation(() => {
        selectCallCount++
        const result = selectCallCount === 1
          ? [existingLink] // First: existing link found
          : [otherLink] // Third: remaining links
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                  try {
                    resolve(await Promise.resolve(result))
                  } catch (error) {
                    reject?.(error)
                  }
                }
              }),
              then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                try {
                  resolve(await Promise.resolve(result))
                } catch (error) {
                  reject?.(error)
                }
              }
            }),
            then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
              try {
                resolve(await Promise.resolve(result))
              } catch (error) {
                reject?.(error)
              }
            }
          })
        }
      })
      mockDb._setDeleteResult([])

      const result = await deleteFileCascade('user-1', 'file-1')

      expect(result).toEqual({existed: true, fileRemoved: false})
    })

    it('should return fileRemoved:true when file becomes orphaned', async () => {
      const existingLink = createMockUserFile()

      // Track select call count to return different results
      let selectCallCount = 0
      mockDb.select.mockImplementation(() => {
        selectCallCount++
        const result = selectCallCount === 1
          ? [existingLink] // First: existing link found
          : [] // Third: no remaining links (orphaned)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                  try {
                    resolve(await Promise.resolve(result))
                  } catch (error) {
                    reject?.(error)
                  }
                }
              }),
              then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                try {
                  resolve(await Promise.resolve(result))
                } catch (error) {
                  reject?.(error)
                }
              }
            }),
            then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
              try {
                resolve(await Promise.resolve(result))
              } catch (error) {
                reject?.(error)
              }
            }
          })
        }
      })
      mockDb._setDeleteResult([])

      const result = await deleteFileCascade('user-1', 'file-1')

      expect(result).toEqual({existed: true, fileRemoved: true})
    })

    it('removes FileDownload records before the File record when the file is orphaned', async () => {
      const existingLink = createMockUserFile()

      let selectCallCount = 0
      mockDb.select.mockImplementation(() => {
        selectCallCount++
        const result = selectCallCount === 1 ? [existingLink] : []
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                  try {
                    resolve(await Promise.resolve(result))
                  } catch (error) {
                    reject?.(error)
                  }
                }
              }),
              then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                try {
                  resolve(await Promise.resolve(result))
                } catch (error) {
                  reject?.(error)
                }
              }
            }),
            then: async (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
              try {
                resolve(await Promise.resolve(result))
              } catch (error) {
                reject?.(error)
              }
            }
          })
        }
      })
      mockDb._setDeleteResult([])

      await deleteFileCascade('user-1', 'file-1')

      const deletedTables = mockDb.delete.mock.calls.map((args) => args[0])
      expect(deletedTables[0]).toBe(userFiles)
      expect(deletedTables[1]).toBe(fileDownloads)
      expect(deletedTables[2]).toBe(files)
    })
  })
})
