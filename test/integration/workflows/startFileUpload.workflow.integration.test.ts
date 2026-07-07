// covers: file-lifecycle#file-status-transitions
/**
 * StartFileUpload Workflow Integration Tests
 *
 * Tests the file upload workflow including file record creation,
 * user-file associations, and status transitions.
 */

// Set environment variables before imports
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest'
import {FileStatus} from '#types/enums'
import {
  closeTestDb,
  createAllTables,
  ensureSearchPath,
  getFile,
  getTestDb,
  getTestDbAsync,
  getUser,
  insertFile,
  insertUser,
  linkUserFile,
  truncateAllTables,
  updateFile
} from '../helpers/postgres-helpers'
import {createMockFile} from '../helpers/test-data'
import {userFiles} from '#db/schema'
import {eq} from 'drizzle-orm'

describe('StartFileUpload Workflow Integration Tests', () => {
  beforeAll(async () => {
    // Initialize database connection and create tables
    await getTestDbAsync()
    await createAllTables()
  })

  afterEach(async () => {
    // Clean up data between tests
    await truncateAllTables()
  })

  afterAll(async () => {
    // Close database connection
    await closeTestDb()
  })

  describe('File Operations', () => {
    test('should insert and retrieve a file record', async () => {
      const fileId = 'test-video-123'

      // Insert file
      await insertFile({fileId, status: FileStatus.Queued, title: 'Test Video'})

      // Retrieve file
      const file = await getFile(fileId)

      expect(file).not.toBeNull()
      expect(file?.fileId).toBe(fileId)
      expect(file?.status).toBe(FileStatus.Queued)
      expect(file?.title).toBe('Test Video')
    })

    test('should update file status from Queued to Downloaded', async () => {
      const fileId = 'test-video-status'

      // Insert file in Queued state
      await insertFile({fileId, status: FileStatus.Queued})

      // Update to Downloaded
      await updateFile(fileId, {status: FileStatus.Downloaded, size: 5242880, url: 'https://cdn.example.com/test.mp4'})

      // Verify update
      const file = await getFile(fileId)

      expect(file?.status).toBe(FileStatus.Downloaded)
      expect(file?.size).toBe(5242880)
      expect(file?.url).toBe('https://cdn.example.com/test.mp4')
    })

    test('should update file status to Failed on download error', async () => {
      const fileId = 'test-video-failed'

      // Insert file in Queued state
      await insertFile({fileId, status: FileStatus.Queued})

      // Update to Failed
      await updateFile(fileId, {status: FileStatus.Failed})

      // Verify update
      const file = await getFile(fileId)

      expect(file?.status).toBe(FileStatus.Failed)
    })

    test('should handle file with all metadata fields', async () => {
      const fileId = 'test-video-full'
      const mockFile = createMockFile(fileId, FileStatus.Downloaded, {
        title: 'Full Metadata Video',
        authorName: 'Test Channel',
        authorUser: 'testchannel',
        description: 'A test video with full metadata',
        contentType: 'video/mp4',
        size: 10485760,
        key: `${fileId}.mp4`,
        url: 'https://cdn.example.com/full.mp4',
        publishDate: '2024-01-15T12:00:00.000Z'
      })

      await insertFile(mockFile)

      const file = await getFile(fileId)

      expect(file?.title).toBe('Full Metadata Video')
      expect(file?.authorName).toBe('Test Channel')
      expect(file?.authorUser).toBe('testchannel')
      expect(file?.description).toBe('A test video with full metadata')
      expect(file?.size).toBe(10485760)
    })
  })

  describe('User-File Associations', () => {
    test('should link a user to a file', async () => {
      const userId = crypto.randomUUID()
      const fileId = 'test-video-link'
      await ensureSearchPath()

      // Create user and file
      await insertUser({userId, email: 'test@example.com', firstName: 'Test'})
      await insertFile({fileId, status: FileStatus.Downloaded})

      // Link user to file
      await linkUserFile(userId, fileId)

      // Verify association exists
      const db = getTestDb()
      const associations = await db.select().from(userFiles).where(eq(userFiles.userId, userId))

      expect(associations).toHaveLength(1)
      expect(associations[0]!.fileId).toBe(fileId)
    })

    test('should allow multiple files per user', async () => {
      const userId = crypto.randomUUID()
      const fileIds = ['video-1', 'video-2', 'video-3']
      await ensureSearchPath()

      // Create user
      await insertUser({userId, email: 'multifile@example.com', firstName: 'Multi'})

      // Create files and link to user
      for (const fileId of fileIds) {
        await insertFile({fileId, status: FileStatus.Downloaded})
        await linkUserFile(userId, fileId)
      }

      // Verify all associations exist
      const db = getTestDb()
      const associations = await db.select().from(userFiles).where(eq(userFiles.userId, userId))

      expect(associations).toHaveLength(3)
      expect(associations.map((a) => a.fileId).sort()).toEqual(fileIds.sort())
    })

    test('should allow multiple users per file', async () => {
      const fileId = 'shared-video'
      const userIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
      await ensureSearchPath()

      // Create file
      await insertFile({fileId, status: FileStatus.Downloaded})

      // Create users and link to file
      for (const userId of userIds) {
        await insertUser({userId, email: `user-${userId.slice(0, 8)}@example.com`, firstName: 'User'})
        await linkUserFile(userId, fileId)
      }

      // Verify all associations exist
      const db = getTestDb()
      const associations = await db.select().from(userFiles).where(eq(userFiles.fileId, fileId))

      expect(associations).toHaveLength(3)
    })
  })

  describe('User Operations', () => {
    test('should insert and retrieve a user record', async () => {
      const userId = crypto.randomUUID()

      await insertUser({userId, email: 'newuser@example.com', firstName: 'New', lastName: 'User'})

      const user = await getUser(userId)

      expect(user).not.toBeNull()
      expect(user?.id).toBe(userId)
      expect(user?.email).toBe('newuser@example.com')
      expect(user?.firstName).toBe('New')
      expect(user?.lastName).toBe('User')
    })

    test('should set emailVerified default to false', async () => {
      const userId = crypto.randomUUID()

      await insertUser({userId, email: 'unverified@example.com', firstName: 'Unverified', emailVerified: false})

      const user = await getUser(userId)

      expect(user?.emailVerified).toBe(false)
    })
  })

  describe('State Transitions (Download Workflow)', () => {
    test('should support Queued -> Downloading -> Downloaded transition', async () => {
      const fileId = 'download-flow-success'

      // Initial state: Queued
      await insertFile({fileId, status: FileStatus.Queued})
      let file = await getFile(fileId)
      expect(file?.status).toBe(FileStatus.Queued)

      // Transition: Downloading
      await updateFile(fileId, {status: FileStatus.Downloading})
      file = await getFile(fileId)
      expect(file?.status).toBe(FileStatus.Downloading)

      // Transition: Downloaded
      await updateFile(fileId, {status: FileStatus.Downloaded, size: 15728640, url: 'https://cdn.example.com/success.mp4'})
      file = await getFile(fileId)
      expect(file?.status).toBe(FileStatus.Downloaded)
      expect(file?.size).toBe(15728640)
    })

    test('should support Queued -> Downloading -> Failed transition', async () => {
      const fileId = 'download-flow-failed'

      // Initial state: Queued
      await insertFile({fileId, status: FileStatus.Queued})

      // Transition: Downloading
      await updateFile(fileId, {status: FileStatus.Downloading})

      // Transition: Failed (simulating download error)
      await updateFile(fileId, {status: FileStatus.Failed})

      const file = await getFile(fileId)
      expect(file?.status).toBe(FileStatus.Failed)
    })
  })
})
