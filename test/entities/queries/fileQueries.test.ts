/**
 * Unit tests for File Queries
 *
 * Tests mutable logic: null coalescing (result[0] ?? null, result[0]?.status ?? null),
 * empty array early return (fileIds.length === 0), size default (input.size ?? 0),
 * and non-null assertions on returning().
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockFile, createMockFileDownload} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema', () => ({files: {fileId: 'fileId', key: 'key', status: 'status'}, fileDownloads: {fileId: 'fileId'}}))
vi.mock('#db/zodSchemas',
  () => ({
    fileInsertSchema: {parse: vi.fn((v: unknown) => v)},
    fileUpdateSchema: {partial: vi.fn(() => ({parse: vi.fn((v: unknown) => v)}))},
    fileDownloadInsertSchema: {parse: vi.fn((v: unknown) => v)},
    fileDownloadUpdateSchema: {partial: vi.fn(() => ({parse: vi.fn((v: unknown) => v)}))}
  }))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm',
  () => ({eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition'), inArray: vi.fn((_col: unknown, _vals: unknown) => 'inArray-condition')}))

const {
  getFile,
  getFileStatus,
  getFilesBatch,
  getFilesByKey,
  createFile,
  upsertFile,
  updateFile,
  deleteFile,
  getFileDownload,
  createFileDownload,
  upsertFileDownload,
  updateFileDownload,
  deleteFileDownload
} = await import('#entities/queries/fileQueries')

describe('File Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // File Operations

  describe('getFile', () => {
    it('should return file when found', async () => {
      const mockFile = createMockFile()
      mockDb._setSelectResult([mockFile])

      const result = await getFile('file-1')

      expect(result).toEqual(mockFile)
    })

    it('should return null when file not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getFile('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getFileStatus', () => {
    it('should return status when file found', async () => {
      mockDb._setSelectResult([{status: 'Downloaded'}])

      const result = await getFileStatus('file-1')

      expect(result).toBe('Downloaded')
    })

    it('should return null when file not found (optional chaining + null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getFileStatus('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getFilesBatch', () => {
    it('should return empty array for empty input (early return)', async () => {
      const result = await getFilesBatch([])

      expect(result).toEqual([])
      expect(mockDb.select).not.toHaveBeenCalled()
    })

    it('should return files for non-empty input', async () => {
      const files = [createMockFile(), createMockFile({fileId: 'file-2'})]
      mockDb._setSelectResult(files)

      const result = await getFilesBatch(['file-1', 'file-2'])

      expect(result).toEqual(files)
    })
  })

  describe('getFilesByKey', () => {
    it('should return matching files', async () => {
      const files = [createMockFile()]
      mockDb._setSelectResult(files)

      const result = await getFilesByKey('test.mp4')

      expect(result).toEqual(files)
    })
  })

  describe('createFile', () => {
    it('should return the created file', async () => {
      const mockFile = createMockFile()
      mockDb._setInsertResult([mockFile])

      const result = await createFile({
        fileId: 'file-1',
        authorName: 'Author',
        authorUser: 'user',
        publishDate: '2021-01-01',
        description: 'desc',
        key: 'file.mp4',
        url: null,
        contentType: 'video/mp4',
        title: 'Test',
        status: 'Queued'
      })

      expect(result).toEqual(mockFile)
    })
  })

  describe('upsertFile', () => {
    it('should return the upserted file', async () => {
      const mockFile = createMockFile()
      mockDb._setInsertResult([mockFile])

      const result = await upsertFile({
        fileId: 'file-1',
        authorName: 'Author',
        authorUser: 'user',
        publishDate: '2021-01-01',
        description: 'desc',
        key: 'file.mp4',
        url: null,
        contentType: 'video/mp4',
        title: 'Test',
        status: 'Queued'
      })

      expect(result).toEqual(mockFile)
    })
  })

  describe('updateFile', () => {
    it('should return the updated file', async () => {
      const mockFile = createMockFile({title: 'Updated'})
      mockDb._setUpdateResult([mockFile])

      const result = await updateFile('file-1', {title: 'Updated'})

      expect(result).toEqual(mockFile)
    })
  })

  describe('deleteFile', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteFile('file-1')).resolves.toBeUndefined()
    })
  })

  // FileDownload Operations

  describe('getFileDownload', () => {
    it('should return file download when found', async () => {
      const mockDownload = createMockFileDownload()
      mockDb._setSelectResult([mockDownload])

      const result = await getFileDownload('file-1')

      expect(result).toEqual(mockDownload)
    })

    it('should return null when not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getFileDownload('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('createFileDownload', () => {
    it('should return the created file download', async () => {
      const mockDownload = createMockFileDownload()
      mockDb._setInsertResult([mockDownload])

      const result = await createFileDownload({fileId: 'file-1', status: 'Pending', retryCount: 0, maxRetries: 5})

      expect(result).toEqual(mockDownload)
    })
  })

  describe('upsertFileDownload', () => {
    it('should return the upserted file download', async () => {
      const mockDownload = createMockFileDownload()
      mockDb._setInsertResult([mockDownload])

      const result = await upsertFileDownload({fileId: 'file-1', status: 'Pending', retryCount: 0, maxRetries: 5})

      expect(result).toEqual(mockDownload)
    })
  })

  describe('updateFileDownload', () => {
    it('should return the updated file download', async () => {
      const mockDownload = createMockFileDownload({status: 'Downloading'})
      mockDb._setUpdateResult([mockDownload])

      const result = await updateFileDownload('file-1', {status: 'Downloading'})

      expect(result).toEqual(mockDownload)
    })
  })

  describe('deleteFileDownload', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteFileDownload('file-1')).resolves.toBeUndefined()
    })
  })
})
