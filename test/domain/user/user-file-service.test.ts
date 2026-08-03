/**
 * Unit tests for User-File Service Functions
 *
 * Tests file association management including idempotent behavior.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock dependencies BEFORE importing the module under test
vi.mock('#entities/queries', () => ({upsertUserFile: vi.fn()}))
vi.mock('@j0nathan-ll0yd/observability', () => ({logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn()}))

// Import after mocking
const {associateFileToUser} = await import('#domain/user/userFileService.js')
import {upsertUserFile} from '#entities/queries'
import {logDebug} from '@j0nathan-ll0yd/observability'

describe('User-File Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('associateFileToUser', () => {
    it('should create a user-file association successfully', async () => {
      const mockResponse = {userId: 'user-123', fileId: 'file-456', createdAt: new Date()}
      vi.mocked(upsertUserFile).mockResolvedValue(mockResponse)

      const result = await associateFileToUser('file-456', 'user-123')

      expect(result).toEqual(mockResponse)
      expect(upsertUserFile).toHaveBeenCalledWith({userId: 'user-123', fileId: 'file-456'})
      expect(logDebug).toHaveBeenCalledWith('associateFileToUser <=', {fileId: 'file-456', userId: 'user-123'})
      expect(logDebug).toHaveBeenCalledWith('associateFileToUser =>', mockResponse)
    })

    it('should return existing record on duplicate (idempotent via upsert)', async () => {
      // Upsert returns existing record when conflict occurs
      const existingRecord = {userId: 'user-123', fileId: 'file-456', createdAt: new Date('2024-01-01')}
      vi.mocked(upsertUserFile).mockResolvedValue(existingRecord)

      const result = await associateFileToUser('file-456', 'user-123')

      expect(result).toEqual(existingRecord)
      expect(upsertUserFile).toHaveBeenCalledWith({userId: 'user-123', fileId: 'file-456'})
    })

    it('should propagate database errors', async () => {
      const dbError = new Error('connection timeout')
      vi.mocked(upsertUserFile).mockRejectedValue(dbError)

      await expect(associateFileToUser('file-456', 'user-123')).rejects.toThrow('connection timeout')
    })
  })
})
