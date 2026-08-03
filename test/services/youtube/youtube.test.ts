import {beforeEach, describe, expect, type Mock, test, vi} from 'vitest'
import {EventEmitter} from 'events'
import {Readable} from 'stream'
import type {S3BucketName as S3BucketNameType} from '@j0nathan-ll0yd/core'

// Type-only import + local helper avoids triggering @j0nathan-ll0yd/core module load
// at test-file eval time, which would fire the hoisted vi.mock('@j0nathan-ll0yd/aws')
// factory before `const mockCreateUpload` is initialized (temporal dead zone error).
const S3BucketName = (s: string): S3BucketNameType => s as S3BucketNameType

// Mock child_process for yt-dlp spawning
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({spawn: mockSpawn}))

// Helper to create mock yt-dlp process
interface MockProcess extends EventEmitter {
  stdout: Readable
  stderr: EventEmitter
  kill: Mock
}

function createMockProcess(): MockProcess {
  const process = new EventEmitter() as MockProcess
  process.stdout = new Readable({read() {}})
  process.stderr = new EventEmitter()
  process.kill = vi.fn()
  return process
}

// Mock fs - for temp file operations
const mockCopyFile = vi.fn<(src: string, dest: string) => Promise<void>>()
const mockStat = vi.fn<(path: string) => Promise<{size: number}>>()
const mockUnlink = vi.fn<(path: string) => Promise<void>>()
const mockCreateReadStream = vi.fn()
vi.mock('fs/promises', () => ({copyFile: mockCopyFile, stat: mockStat, unlink: mockUnlink}))
vi.mock('fs', () => ({createReadStream: mockCreateReadStream}))

// Mock S3 Upload - simplified (no EventEmitter progress tracking needed)
const mockUploadDone = vi.fn<() => Promise<{Location: string}>>()
const mockCreateUpload = vi.fn(() => ({done: mockUploadDone}))

vi.mock('@j0nathan-ll0yd/aws', () => ({
  createUpload: mockCreateUpload,
  // Stub other commonly imported AWS functions to avoid import errors
  putObject: vi.fn(),
  headObject: vi.fn(),
  sendMessage: vi.fn(),
  publish: vi.fn(),
  putEvents: vi.fn(),
  invoke: vi.fn(),
  setTestS3Client: vi.fn(),
  setTestSQSClient: vi.fn(),
  setTestSNSClient: vi.fn(),
  setTestEventBridgeClient: vi.fn(),
  setTestLambdaClient: vi.fn(),
  setTestDynamoDBClient: vi.fn(),
  setTestApiGatewayClient: vi.fn(),
  setTestCloudWatchClient: vi.fn()
}))

vi.mock('@j0nathan-ll0yd/observability',
  () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    metrics: {
      addMetric: vi.fn(),
      addDimension: vi.fn(),
      publishStoredMetrics: vi.fn(),
      singleMetric: vi.fn(() => ({addDimension: vi.fn(), addMetric: vi.fn()}))
    },
    MetricUnit: {Count: 'Count', Seconds: 'Seconds', Milliseconds: 'Milliseconds', Bytes: 'Bytes'}
  }))

vi.mock('@j0nathan-ll0yd/env',
  () => ({
    getRequiredEnv: vi.fn((key: string) => process.env[key] ?? `mock-${key}`),
    getOptionalEnv: vi.fn((key: string, defaultVal?: string) => process.env[key] ?? defaultVal)
  }))

// Set up environment variables before importing
process.env.YTDLP_BINARY_PATH = '/opt/bin/yt-dlp_linux'
process.env.AWS_REGION = 'us-west-2'

// Import after mocking
const {downloadVideoToS3, getVideoID, isCookieExpirationError, classifyCookieError, isSabrError} = await import('#services/youtube/youtube.js')

describe('#Vendor:YouTube', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCopyFile.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({size: 52428800}) // 50MB default
    mockUnlink.mockResolvedValue(undefined)
    mockCreateReadStream.mockReturnValue(new Readable({read() {}}))
    mockUploadDone.mockResolvedValue({Location: 's3://test-bucket/test.mp4'})
  })

  describe('downloadVideoToS3', () => {
    test('should download to temp file and stream to S3', async () => {
      const mockYtdlp = createMockProcess()
      mockSpawn.mockReturnValue(mockYtdlp)

      const resultPromise = downloadVideoToS3('https://www.youtube.com/watch?v=test123', S3BucketName('test-bucket'), 'test123.mp4')

      // Simulate successful yt-dlp exit
      await new Promise((resolve) => setTimeout(resolve, 10))
      mockYtdlp.emit('exit', 0)

      const result = await resultPromise

      // Verify yt-dlp was called with file output (NOT -o -)
      expect(mockSpawn).toHaveBeenCalledWith('/opt/bin/yt-dlp_linux',
        expect.arrayContaining(['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', '/tmp/test123.mp4']),
        {cwd: '/tmp'})

      // Verify cookies were copied
      expect(mockCopyFile).toHaveBeenCalledWith('/opt/cookies/youtube-cookies.txt', '/tmp/youtube-cookies.txt')

      // Verify temp file was read and uploaded
      expect(mockCreateReadStream).toHaveBeenCalledWith('/tmp/test123.mp4')
      expect(mockCreateUpload).toHaveBeenCalledWith('test-bucket', 'test123.mp4', expect.any(Object),
        expect.objectContaining({contentType: 'video/mp4', partSize: 10 * 1024 * 1024}))

      // Verify cleanup
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/test123.mp4')

      expect(result).toEqual({fileSize: 52428800, s3Url: 's3://test-bucket/test123.mp4', duration: expect.any(Number)})
    })

    test('should clean up temp file on yt-dlp failure', async () => {
      const mockYtdlp = createMockProcess()
      mockSpawn.mockReturnValue(mockYtdlp)

      const resultPromise = downloadVideoToS3('https://www.youtube.com/watch?v=test123', S3BucketName('test-bucket'), 'test123.mp4')

      await new Promise((resolve) => setTimeout(resolve, 10))
      mockYtdlp.stderr.emit('data', Buffer.from('ERROR: Video unavailable'))
      mockYtdlp.emit('exit', 1)

      await expect(resultPromise).rejects.toThrow('yt-dlp')

      // Verify cleanup attempted
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/test123.mp4')
    })

    test('should detect cookie expiration in stderr', async () => {
      const mockYtdlp = createMockProcess()
      mockSpawn.mockReturnValue(mockYtdlp)

      const resultPromise = downloadVideoToS3('https://www.youtube.com/watch?v=test123', S3BucketName('test-bucket'), 'test123.mp4')

      await new Promise((resolve) => setTimeout(resolve, 10))
      mockYtdlp.stderr.emit('data', Buffer.from("Sign in to confirm you're not a bot"))
      mockYtdlp.emit('exit', 1)

      await expect(resultPromise).rejects.toThrow('cookie')
    })

    test('should clean up temp file on S3 upload failure', async () => {
      const mockYtdlp = createMockProcess()
      mockSpawn.mockReturnValue(mockYtdlp)
      mockUploadDone.mockRejectedValue(new Error('S3 upload failed'))

      const resultPromise = downloadVideoToS3('https://www.youtube.com/watch?v=test123', S3BucketName('test-bucket'), 'test123.mp4')

      await new Promise((resolve) => setTimeout(resolve, 10))
      mockYtdlp.emit('exit', 0)

      await expect(resultPromise).rejects.toThrow('S3')
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/test123.mp4')
    })

    test('should handle yt-dlp process spawn error', async () => {
      const mockYtdlp = createMockProcess()
      mockSpawn.mockReturnValue(mockYtdlp)

      const resultPromise = downloadVideoToS3('https://www.youtube.com/watch?v=test123', S3BucketName('test-bucket'), 'test123.mp4')

      await new Promise((resolve) => setTimeout(resolve, 10))
      mockYtdlp.emit('error', new Error('spawn ENOENT'))

      await expect(resultPromise).rejects.toThrow('spawn ENOENT')
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/test123.mp4')
    })
  })

  describe('isCookieExpirationError', () => {
    test('should detect bot detection message', () => {
      expect(isCookieExpirationError("Sign in to confirm you're not a bot")).toBe(true)
    })

    test('should detect 403 Forbidden', () => {
      expect(isCookieExpirationError('HTTP Error 403: Forbidden')).toBe(true)
    })

    test('should detect cookie-related errors', () => {
      expect(isCookieExpirationError('cookies have expired')).toBe(true)
    })

    test('should not match unrelated errors', () => {
      expect(isCookieExpirationError('Video not available')).toBe(false)
    })
  })

  describe('getVideoID', () => {
    test('should extract video ID from standard watch URL', () => {
      expect(getVideoID('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    })

    test('should extract video ID from short URL', () => {
      expect(getVideoID('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    })

    test('should extract video ID from embed URL', () => {
      expect(getVideoID('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    })

    test('should extract video ID from v/ URL', () => {
      expect(getVideoID('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    })

    test('should throw error for invalid URL', () => {
      expect(() => getVideoID('https://example.com/video')).toThrow('Invalid YouTube URL format')
    })

    test('should extract video ID from URL with extra query params', () => {
      expect(getVideoID('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120')).toBe('dQw4w9WgXcQ')
    })

    test('should throw for empty string', () => {
      expect(() => getVideoID('')).toThrow('Invalid YouTube URL format')
    })

    test('should throw for non-URL string', () => {
      expect(() => getVideoID('not-a-url')).toThrow('Invalid YouTube URL format')
    })

    test('should throw for YouTube URL without video ID', () => {
      expect(() => getVideoID('https://www.youtube.com/channel/UCtest')).toThrow('Invalid YouTube URL format')
    })
  })

  describe('classifyCookieError', () => {
    test('should classify bot detection errors', () => {
      expect(classifyCookieError("Sign in to confirm you're not a bot")).toBe('bot_detection')
      expect(classifyCookieError('This helps protect our community')).toBe('bot_detection')
      expect(classifyCookieError('bot detection triggered')).toBe('bot_detection')
      expect(classifyCookieError('confirm your human identity')).toBe('bot_detection')
      expect(classifyCookieError('confirm you are human please')).toBe('bot_detection')
    })

    test('should classify cookie expired errors', () => {
      expect(classifyCookieError('HTTP Error 403: Forbidden')).toBe('cookie_expired')
      expect(classifyCookieError('cookies have expired')).toBe('cookie_expired')
      expect(classifyCookieError('session expired, please log in again')).toBe('cookie_expired')
      expect(classifyCookieError('login required to continue')).toBe('cookie_expired')
    })

    test('should classify rate limited errors', () => {
      expect(classifyCookieError('HTTP Error 429')).toBe('rate_limited')
      expect(classifyCookieError('Too many requests')).toBe('rate_limited')
      expect(classifyCookieError('rate limit exceeded')).toBe('rate_limited')
      expect(classifyCookieError('temporarily blocked')).toBe('rate_limited')
    })

    test('should return null for non-cookie errors', () => {
      expect(classifyCookieError('Video not available')).toBeNull()
      expect(classifyCookieError('Network timeout')).toBeNull()
      expect(classifyCookieError('')).toBeNull()
    })

    test('should be case-insensitive', () => {
      expect(classifyCookieError('HTTP ERROR 403')).toBe('cookie_expired')
      expect(classifyCookieError('TOO MANY REQUESTS')).toBe('rate_limited')
      expect(classifyCookieError('BOT DETECTION')).toBe('bot_detection')
    })
  })

  describe('isSabrError', () => {
    test('should detect SABR streaming errors', () => {
      expect(isSabrError('SABR streaming is enforced')).toBe(true)
      expect(isSabrError('Error: missing a url for format')).toBe(true)
      expect(isSabrError('Some formats have been skipped')).toBe(true)
      expect(isSabrError('YouTube is forcing SABR mode')).toBe(true)
    })

    test('should return false for non-SABR errors', () => {
      expect(isSabrError('Video unavailable')).toBe(false)
      expect(isSabrError('HTTP Error 403')).toBe(false)
      expect(isSabrError('')).toBe(false)
    })

    test('should be case-insensitive', () => {
      expect(isSabrError('sabr streaming')).toBe(true)
      expect(isSabrError('MISSING A URL')).toBe(true)
    })
  })

  describe('isCookieExpirationError (extended)', () => {
    test('should return true for all cookie error categories', () => {
      // bot_detection
      expect(isCookieExpirationError("Sign in to confirm you're not a bot")).toBe(true)
      // cookie_expired
      expect(isCookieExpirationError('HTTP Error 403')).toBe(true)
      // rate_limited
      expect(isCookieExpirationError('HTTP Error 429')).toBe(true)
    })

    test('should return false for empty string', () => {
      expect(isCookieExpirationError('')).toBe(false)
    })
  })
})
