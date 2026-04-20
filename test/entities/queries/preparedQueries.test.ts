/**
 * Unit tests for Prepared Queries
 *
 * Tests mutable logic: null coalescing (results[0] ?? null)
 * and map transform (results.map(r => r.file)).
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockFile, createMockSession} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema', () => ({files: {fileId: 'fileId', key: 'key'}, sessions: {id: 'id', token: 'token'}, userFiles: {userId: 'userId', fileId: 'fileId'}}))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm',
  () => ({eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition'), sql: {placeholder: vi.fn((name: string) => ({placeholder: name}))}}))

const {getFileByKeyPrepared, getUserFilesPrepared, getSessionByTokenPrepared} = await import('#entities/queries/preparedQueries')

describe('Prepared Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getFileByKeyPrepared', () => {
    it('should return file when found', async () => {
      const mockFile = createMockFile()
      // Prepared queries call db.select().from().where().prepare() then execute()
      // Our mock needs to handle the prepare+execute chain
      const executeMock = vi.fn().mockResolvedValue([mockFile])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({from: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({prepare: prepareMock})})}))

      const result = await getFileByKeyPrepared('test.mp4')

      expect(result).toEqual(mockFile)
    })

    it('should return null when file not found (null coalescing)', async () => {
      const executeMock = vi.fn().mockResolvedValue([])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({from: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({prepare: prepareMock})})}))

      const result = await getFileByKeyPrepared('nonexistent.mp4')

      expect(result).toBeNull()
    })
  })

  describe('getUserFilesPrepared', () => {
    it('should return mapped file objects from join', async () => {
      const file1 = createMockFile({fileId: 'file-1'})
      const file2 = createMockFile({fileId: 'file-2'})
      const executeMock = vi.fn().mockResolvedValue([{file: file1}, {file: file2}])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({innerJoin: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({prepare: prepareMock})})})
      }))

      const result = await getUserFilesPrepared('user-1')

      expect(result).toEqual([file1, file2])
    })

    it('should return empty array when user has no files', async () => {
      const executeMock = vi.fn().mockResolvedValue([])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({innerJoin: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({prepare: prepareMock})})})
      }))

      const result = await getUserFilesPrepared('user-1')

      expect(result).toEqual([])
    })
  })

  describe('getSessionByTokenPrepared', () => {
    it('should return session when found', async () => {
      const mockSession = createMockSession()
      const executeMock = vi.fn().mockResolvedValue([mockSession])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({limit: vi.fn().mockReturnValue({prepare: prepareMock})})})
      }))

      const result = await getSessionByTokenPrepared('valid-token')

      expect(result).toEqual(mockSession)
    })

    it('should return null when token not found (null coalescing)', async () => {
      const executeMock = vi.fn().mockResolvedValue([])
      const prepareMock = vi.fn().mockReturnValue({execute: executeMock})
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({limit: vi.fn().mockReturnValue({prepare: prepareMock})})})
      }))

      const result = await getSessionByTokenPrepared('invalid-token')

      expect(result).toBeNull()
    })
  })
})
