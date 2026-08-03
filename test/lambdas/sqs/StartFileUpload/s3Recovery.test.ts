// covers: media-download#s3-recovery-before-download
// covers: file-lifecycle#s3-idempotency-via-recovery-check
/**
 * Unit tests for StartFileUpload s3Recovery.
 *
 * Pins the recovery semantics that make StartFileUpload idempotent under SQS
 * redelivery:
 *  - checkS3FileExists reports exists:true only when headObject returns a
 *    positive ContentLength, and treats a zero-byte object or a headObject
 *    error as "not present" (so recovery never masks a genuinely missing file);
 *  - recoverFromS3 reconstructs File + FileDownload state and emits a
 *    DownloadCompleted event, and remains resilient when YouTube metadata is
 *    unavailable — a metadata miss or throw falls back to minimal metadata and
 *    still completes the recovery.
 *
 * headObject (@j0nathan-ll0yd/aws), the youtube tracer, dispatch service, and
 * fileHelpers.upsertFile are mocked at their boundaries.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {FetchVideoInfoResult} from '#types/video'
import type {YtDlpVideoInfo} from '#types/youtube'
import type {ValidatedDownloadQueueMessage} from '#types/schemas'
import {DownloadStatus} from '#types/enums'

vi.mock('@j0nathan-ll0yd/aws', () => ({headObject: vi.fn()}))

vi.mock('@j0nathan-ll0yd/core',
  () => ({
    CloudFrontDistributionId: (s: string) => s,
    S3BucketName: (s: string) => s,
    emitEvent: vi.fn(() => Promise.resolve()),
    isOk: vi.fn((r: {ok?: boolean}) => r?.ok === true)
  }))

vi.mock('@j0nathan-ll0yd/observability',
  () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn(), singleMetric: vi.fn(() => ({addDimension: vi.fn(), addMetric: vi.fn()}))},
    MetricUnit: {Count: 'Count'}
  }))

vi.mock('@j0nathan-ll0yd/env', () => ({getRequiredEnv: vi.fn(() => 'cdn.example.com')}))

vi.mock('#services/notification/dispatchService', () => ({dispatchMetadataNotifications: vi.fn(() => Promise.resolve())}))

vi.mock('#services/download/stateManager', () => ({updateDownloadState: vi.fn(() => Promise.resolve())}))

vi.mock('#services/download/youtubeTracing', () => ({fetchVideoInfoTraced: vi.fn()}))

vi.mock('#lambdas/sqs/StartFileUpload/fileHelpers', () => ({upsertFile: vi.fn(() => Promise.resolve())}))

import {checkS3FileExists, recoverFromS3} from '#lambdas/sqs/StartFileUpload/s3Recovery.js'
import {headObject} from '@j0nathan-ll0yd/aws'
import {emitEvent, S3BucketName} from '@j0nathan-ll0yd/core'
import {dispatchMetadataNotifications} from '#services/notification/dispatchService'
import {updateDownloadState} from '#services/download/stateManager'
import {fetchVideoInfoTraced} from '#services/download/youtubeTracing'
import {upsertFile} from '#lambdas/sqs/StartFileUpload/fileHelpers'

const makeMessage = (): ValidatedDownloadQueueMessage => ({
  fileId: 'dQw4w9WgXcQ',
  correlationId: 'corr-1',
  sourceUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
  userId: 'user-1',
  attempt: 1
})

const bucket = S3BucketName('test-bucket')

const makeVideoInfo = (): YtDlpVideoInfo => ({
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  formats: [],
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  duration: 213,
  description: 'Official video',
  uploader: 'Rick Astley',
  upload_date: '20091025'
})

const okVideoInfo = (): FetchVideoInfoResult => ({ok: true, value: makeVideoInfo()})
const missVideoInfo = (): FetchVideoInfoResult => ({ok: false, error: {error: new Error('not found'), isCookieError: false}})

describe('checkS3FileExists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports the object present with its size when headObject returns a positive ContentLength', async () => {
    vi.mocked(headObject).mockResolvedValue({ContentLength: 61548900, $metadata: {}})

    const result = await checkS3FileExists(bucket, 'dQw4w9WgXcQ.mp4')

    expect(result).toEqual({exists: true, size: 61548900})
    expect(headObject).toHaveBeenCalledWith({Bucket: 'test-bucket', Key: 'dQw4w9WgXcQ.mp4'})
  })

  it('reports not present for a zero-byte object (guards against empty placeholder objects)', async () => {
    vi.mocked(headObject).mockResolvedValue({ContentLength: 0, $metadata: {}})

    const result = await checkS3FileExists(bucket, 'dQw4w9WgXcQ.mp4')

    expect(result).toEqual({exists: false})
  })

  it('reports not present when ContentLength is absent', async () => {
    vi.mocked(headObject).mockResolvedValue({$metadata: {}})

    const result = await checkS3FileExists(bucket, 'dQw4w9WgXcQ.mp4')

    expect(result).toEqual({exists: false})
  })

  it('swallows a headObject error and reports not present (missing object, not a crash)', async () => {
    vi.mocked(headObject).mockRejectedValue(new Error('NotFound'))

    const result = await checkS3FileExists(bucket, 'dQw4w9WgXcQ.mp4')

    expect(result).toEqual({exists: false})
  })
})

describe('recoverFromS3', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchVideoInfoTraced).mockResolvedValue(okVideoInfo())
  })

  it('reconstructs state with full metadata and emits DownloadCompleted when YouTube info is available', async () => {
    await recoverFromS3(makeMessage(), 61548900)

    expect(dispatchMetadataNotifications).toHaveBeenCalled()
    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({fileId: 'dQw4w9WgXcQ', size: 61548900, title: 'Never Gonna Give You Up', authorName: 'Rick Astley'})
    )
    expect(updateDownloadState).toHaveBeenCalledWith('dQw4w9WgXcQ', DownloadStatus.Completed)
    expect(emitEvent).toHaveBeenCalledWith({
      detailType: 'DownloadCompleted',
      detail: expect.objectContaining({fileId: 'dQw4w9WgXcQ', s3Key: 'dQw4w9WgXcQ.mp4', fileSize: 61548900})
    })
  })

  it('emits DownloadCompleted only after the File entity is upserted', async () => {
    await recoverFromS3(makeMessage(), 61548900)

    const upsertOrder = vi.mocked(upsertFile).mock.invocationCallOrder[0]!
    const emitOrder = vi.mocked(emitEvent).mock.invocationCallOrder[0]!
    expect(upsertOrder).toBeLessThan(emitOrder)
  })

  it('falls back to minimal metadata when YouTube info is missing but still completes recovery', async () => {
    vi.mocked(fetchVideoInfoTraced).mockResolvedValue(missVideoInfo())

    await recoverFromS3(makeMessage(), 1234)

    // No metadata to notify with, but recovery still upserts (title defaults to the fileId) and emits completion.
    expect(dispatchMetadataNotifications).not.toHaveBeenCalled()
    expect(upsertFile).toHaveBeenCalledWith(expect.objectContaining({fileId: 'dQw4w9WgXcQ', size: 1234, title: 'dQw4w9WgXcQ', authorName: 'Unknown'}))
    expect(emitEvent).toHaveBeenCalledWith({detailType: 'DownloadCompleted', detail: expect.objectContaining({fileSize: 1234})})
  })

  it('remains resilient when the metadata fetch throws — recovery still completes', async () => {
    vi.mocked(fetchVideoInfoTraced).mockRejectedValue(new Error('yt-dlp crashed'))

    await expect(recoverFromS3(makeMessage(), 999)).resolves.toBeUndefined()

    expect(upsertFile).toHaveBeenCalledWith(expect.objectContaining({fileId: 'dQw4w9WgXcQ', size: 999, title: 'dQw4w9WgXcQ'}))
    expect(emitEvent).toHaveBeenCalledWith({detailType: 'DownloadCompleted', detail: expect.objectContaining({fileSize: 999})})
  })
})
