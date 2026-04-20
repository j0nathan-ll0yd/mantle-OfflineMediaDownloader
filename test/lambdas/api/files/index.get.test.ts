/**
 * Unit tests for ListFiles Lambda (GET /files)
 *
 * Tests the toFile helper, anonymous demo mode, status filtering, and sorting.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core',
  () => ({
    buildValidatedResponse: vi.fn((_ctx, _code, data) => data),
    defineLambda: vi.fn(),
    UserStatus: {Authenticated: 'Authenticated', Anonymous: 'Anonymous'},
    getStaticAsset: vi.fn(() => ({size: 100, key: 'default.mp4', url: 'https://cdn.example.com/default.mp4', contentType: 'video/mp4'}))
  }))

vi.mock('@mantleframework/observability', () => ({logDebug: vi.fn(), metrics: {addMetric: vi.fn()}, MetricUnit: {Count: 'Count'}}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({optional: vi.fn(() => ({default: vi.fn()}))})), string: vi.fn(() => ({optional: vi.fn(() => ({default: vi.fn()}))}))}
  }))

vi.mock('#config/constants',
  () => ({
    getDefaultFile: vi.fn(() => ({
      fileId: 'default',
      size: 100,
      authorName: 'Lifegames',
      authorUser: 'sxephil',
      publishDate: new Date().toISOString(),
      description: 'Description',
      key: 'default.mp4',
      url: 'https://cdn.example.com/default.mp4',
      contentType: 'video/mp4',
      title: 'Welcome! Tap to download.',
      status: 'Downloaded'
    }))
  }))

vi.mock('#entities/queries', () => ({getFilesForUser: vi.fn()}))

vi.mock('#types/api-schema', () => ({fileListResponseSchema: {}}))

vi.mock('#types/enums', () => ({FileStatus: {Queued: 'Queued', Downloading: 'Downloading', Downloaded: 'Downloaded', Failed: 'Failed'}}))

const {handler} = (await import('#lambdas/api/files/index.get.js')) as any
import {getFilesForUser} from '#entities/queries'
import {getDefaultFile} from '#config/constants'
import {buildValidatedResponse} from '@mantleframework/core'
import {metrics} from '@mantleframework/observability'

describe('ListFiles Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('toFile helper (via handler)', () => {
    it('should convert null optional fields to undefined', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([{
        fileId: 'abc123',
        size: 1000,
        authorName: 'Author',
        authorUser: 'author',
        publishDate: '2024-01-01',
        description: 'Desc',
        key: 'abc123.mp4',
        contentType: 'video/mp4',
        title: 'Title',
        status: 'Downloaded',
        url: null,
        duration: null,
        uploadDate: null,
        viewCount: null,
        thumbnailUrl: null
      }])

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(result.contents[0].url).toBeUndefined()
      expect(result.contents[0].duration).toBeUndefined()
      expect(result.contents[0].uploadDate).toBeUndefined()
      expect(result.contents[0].viewCount).toBeUndefined()
      expect(result.contents[0].thumbnailUrl).toBeUndefined()
    })

    it('should preserve non-null optional fields', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([{
        fileId: 'abc123',
        size: 1000,
        authorName: 'Author',
        authorUser: 'author',
        publishDate: '2024-01-01',
        description: 'Desc',
        key: 'abc123.mp4',
        contentType: 'video/mp4',
        title: 'Title',
        status: 'Downloaded',
        url: 'https://cdn.example.com/abc123.mp4',
        duration: 300,
        uploadDate: '20240101',
        viewCount: 5000,
        thumbnailUrl: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg'
      }])

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(result.contents[0].url).toBe('https://cdn.example.com/abc123.mp4')
      expect(result.contents[0].duration).toBe(300)
      expect(result.contents[0].uploadDate).toBe('20240101')
      expect(result.contents[0].viewCount).toBe(5000)
      expect(result.contents[0].thumbnailUrl).toBe('https://i.ytimg.com/vi/abc123/maxresdefault.jpg')
    })

    it('should cast status to File status type', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([{
        fileId: 'abc123',
        size: 0,
        authorName: 'Author',
        authorUser: 'author',
        publishDate: '2024-01-01',
        description: 'Desc',
        key: 'abc123.mp4',
        contentType: 'video/mp4',
        title: 'Title',
        status: 'Queued',
        url: null,
        duration: null,
        uploadDate: null,
        viewCount: null,
        thumbnailUrl: null
      }])

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'all'}})

      expect(result.contents[0].status).toBe('Queued')
    })
  })

  describe('anonymous user', () => {
    it('should return default file for anonymous users', async () => {
      await handler({context: {awsRequestId: 'req-1'}, userId: undefined, userStatus: 'Anonymous', query: {status: 'downloaded'}})

      expect(getDefaultFile).toHaveBeenCalled()
      expect(getFilesForUser).not.toHaveBeenCalled()
      expect(buildValidatedResponse).toHaveBeenCalledWith({awsRequestId: 'req-1'}, 200, expect.objectContaining({keyCount: 1}), expect.anything())
    })
  })

  describe('status filtering', () => {
    const mockFiles = [
      {
        fileId: 'file-1',
        size: 1000,
        authorName: 'A',
        authorUser: 'a',
        publishDate: '2024-01-02',
        description: 'D',
        key: 'file-1.mp4',
        contentType: 'video/mp4',
        title: 'Downloaded Video',
        status: 'Downloaded',
        url: null,
        duration: null,
        uploadDate: null,
        viewCount: null,
        thumbnailUrl: null
      },
      {
        fileId: 'file-2',
        size: 0,
        authorName: 'B',
        authorUser: 'b',
        publishDate: '2024-01-01',
        description: 'D',
        key: 'file-2.mp4',
        contentType: 'video/mp4',
        title: 'Queued Video',
        status: 'Queued',
        url: null,
        duration: null,
        uploadDate: null,
        viewCount: null,
        thumbnailUrl: null
      }
    ]

    it('should filter to Downloaded files by default', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue(mockFiles)

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].status).toBe('Downloaded')
      expect(result.keyCount).toBe(1)
    })

    it('should return all files when status=all', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue(mockFiles)

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'all'}})

      expect(result.contents).toHaveLength(2)
      expect(result.keyCount).toBe(2)
    })

    it('should use default status when query.status is undefined', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue(mockFiles)

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {}})

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].status).toBe('Downloaded')
    })
  })

  describe('sorting', () => {
    it('should sort files by publishDate descending (newest first)', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([
        {
          fileId: 'old',
          size: 1000,
          authorName: 'A',
          authorUser: 'a',
          publishDate: '2024-01-01',
          description: 'D',
          key: 'old.mp4',
          contentType: 'video/mp4',
          title: 'Old Video',
          status: 'Downloaded',
          url: null,
          duration: null,
          uploadDate: null,
          viewCount: null,
          thumbnailUrl: null
        },
        {
          fileId: 'new',
          size: 2000,
          authorName: 'B',
          authorUser: 'b',
          publishDate: '2024-06-15',
          description: 'D',
          key: 'new.mp4',
          contentType: 'video/mp4',
          title: 'New Video',
          status: 'Downloaded',
          url: null,
          duration: null,
          uploadDate: null,
          viewCount: null,
          thumbnailUrl: null
        }
      ])

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(result.contents[0].fileId).toBe('new')
      expect(result.contents[1].fileId).toBe('old')
    })
  })

  describe('metrics', () => {
    it('should emit FilesReturned metric for authenticated users', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([])

      await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(metrics.addMetric).toHaveBeenCalledWith('FilesReturned', 'Count', 0)
    })
  })

  describe('empty results', () => {
    it('should return empty array when user has no files', async () => {
      vi.mocked(getFilesForUser).mockResolvedValue([])

      const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', query: {status: 'downloaded'}})

      expect(result.contents).toHaveLength(0)
      expect(result.keyCount).toBe(0)
    })
  })
})
