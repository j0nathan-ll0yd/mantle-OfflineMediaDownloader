// covers: media-download#s3-recovery-before-download
// covers: media-download#download-pipeline-sequence
// covers: media-download#retriable-failure-propagates-for-sqs-retry
// covers: file-lifecycle#s3-idempotency-via-recovery-check
// covers: file-lifecycle#download-completed-event-emitted-after-s3-upload
/**
 * Unit tests for StartFileUpload downloadOrchestrator (processDownloadRequest).
 *
 * Pins the download pipeline's safety-critical ordering and idempotency:
 *  - the S3 recovery check short-circuits BEFORE any yt-dlp work, so an SQS
 *    redelivery of an already-uploaded file does not re-download it;
 *  - the happy path runs fetch → download → upsert → DownloadCompleted event in
 *    that fixed order, and the completion event is emitted only AFTER a
 *    successful S3 upload and File upsert;
 *  - a failure at either the fetch or the download stage routes through
 *    handleDownloadFailure and re-throws (for SQS retry) or returns quietly,
 *    never emitting DownloadCompleted.
 *
 * All sibling modules (s3Recovery, failureHandler, fileHelpers) and services
 * are mocked at their boundaries; the orchestrator under test is not mocked.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {FetchVideoInfoResult, VideoErrorClassification} from '#types/video'
import type {YtDlpVideoInfo} from '#types/youtube'
import type {ValidatedDownloadQueueMessage} from '#types/schemas'
import {createMockFileDownload} from '#test/helpers/entity-fixtures'
import {DownloadStatus, FileStatus} from '#types/enums'

vi.mock('@mantleframework/core',
  () => ({
    CloudFrontDistributionId: (s: string) => s,
    S3BucketName: (s: string) => s,
    emitEvent: vi.fn(() => Promise.resolve()),
    isOk: vi.fn((r: {ok?: boolean}) => r?.ok === true)
  }))

vi.mock('@mantleframework/observability',
  () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn(), singleMetric: vi.fn(() => ({addDimension: vi.fn(), addMetric: vi.fn()}))},
    MetricUnit: {Count: 'Count'}
  }))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn((name: string) => (name === 'CLOUDFRONT_DOMAIN' ? 'cdn.example.com' : 'test-bucket'))}))

vi.mock('@mantleframework/errors', () => {
  class UnexpectedError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {UnexpectedError}
})

vi.mock('#entities/queries', () => ({getFileDownload: vi.fn(), updateFile: vi.fn(() => Promise.resolve())}))

vi.mock('#services/notification/dispatchService',
  () => ({
    dispatchDownloadProgressNotifications: vi.fn(() => Promise.resolve()),
    dispatchDownloadStartedNotifications: vi.fn(() => Promise.resolve(['user-1'])),
    dispatchMetadataNotifications: vi.fn(() => Promise.resolve())
  }))

vi.mock('#services/download/stateManager', () => ({updateDownloadState: vi.fn(() => Promise.resolve())}))

vi.mock('#services/download/youtubeTracing', () => ({downloadVideoToS3Traced: vi.fn(), fetchVideoInfoTraced: vi.fn()}))

vi.mock('#lambdas/sqs/StartFileUpload/s3Recovery', () => ({checkS3FileExists: vi.fn(), recoverFromS3: vi.fn(() => Promise.resolve())}))

vi.mock('#lambdas/sqs/StartFileUpload/failureHandler', () => ({handleDownloadFailure: vi.fn(), tryCloseCookieExpirationIssue: vi.fn()}))

vi.mock('#lambdas/sqs/StartFileUpload/fileHelpers', () => ({upsertFile: vi.fn(() => Promise.resolve())}))

import {processDownloadRequest} from '#lambdas/sqs/StartFileUpload/downloadOrchestrator.js'
import {emitEvent} from '@mantleframework/core'
import {getFileDownload, updateFile} from '#entities/queries'
import {dispatchMetadataNotifications} from '#services/notification/dispatchService'
import {updateDownloadState} from '#services/download/stateManager'
import {downloadVideoToS3Traced, fetchVideoInfoTraced} from '#services/download/youtubeTracing'
import {checkS3FileExists, recoverFromS3} from '#lambdas/sqs/StartFileUpload/s3Recovery'
import {handleDownloadFailure} from '#lambdas/sqs/StartFileUpload/failureHandler'
import {upsertFile} from '#lambdas/sqs/StartFileUpload/fileHelpers'

const makeMessage = (): ValidatedDownloadQueueMessage => ({fileId: 'dQw4w9WgXcQ', correlationId: 'corr-1', sourceUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ', userId: 'user-1', attempt: 1})

const makeVideoInfo = (): YtDlpVideoInfo => ({
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  formats: [],
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  duration: 213,
  description: 'Official video',
  uploader: 'Rick Astley',
  upload_date: '20091025',
  view_count: 1000000000
})

const okVideoInfo = (): FetchVideoInfoResult => ({ok: true, value: makeVideoInfo()})
const failedVideoInfo = (err: Error): FetchVideoInfoResult => ({ok: false, error: {error: err, isCookieError: false}})

const retriable: VideoErrorClassification = {category: 'transient', retryable: true, maxRetries: 5, reason: 'transient', createIssue: false}
const permanent: VideoErrorClassification = {category: 'permanent', retryable: false, maxRetries: 0, reason: 'permanent', createIssue: true}

describe('processDownloadRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFileDownload).mockResolvedValue(null)
    vi.mocked(fetchVideoInfoTraced).mockResolvedValue(okVideoInfo())
    vi.mocked(downloadVideoToS3Traced).mockResolvedValue({fileSize: 61548900, s3Url: 'https://cdn.example.com/dQw4w9WgXcQ.mp4', duration: 213})
  })

  describe('S3 recovery short-circuit (idempotency)', () => {
    it('recovers from S3 and returns without downloading when the object already exists', async () => {
      vi.mocked(checkS3FileExists).mockResolvedValue({exists: true, size: 61548900})

      await processDownloadRequest(makeMessage(), 2)

      expect(recoverFromS3).toHaveBeenCalledWith(expect.objectContaining({fileId: 'dQw4w9WgXcQ'}), 61548900)
      // Idempotency: an existing S3 object must skip yt-dlp entirely.
      expect(fetchVideoInfoTraced).not.toHaveBeenCalled()
      expect(downloadVideoToS3Traced).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
      expect(updateDownloadState).not.toHaveBeenCalled()
    })

    it('proceeds to download when no S3 object exists', async () => {
      vi.mocked(checkS3FileExists).mockResolvedValue({exists: false})

      await processDownloadRequest(makeMessage(), 1)

      expect(recoverFromS3).not.toHaveBeenCalled()
      expect(fetchVideoInfoTraced).toHaveBeenCalled()
      expect(downloadVideoToS3Traced).toHaveBeenCalled()
    })
  })

  describe('happy-path pipeline sequence', () => {
    beforeEach(() => {
      vi.mocked(checkS3FileExists).mockResolvedValue({exists: false})
    })

    it('runs fetch → download → upsert → DownloadCompleted in a fixed order', async () => {
      await processDownloadRequest(makeMessage(), 1)

      const fetchOrder = vi.mocked(fetchVideoInfoTraced).mock.invocationCallOrder[0]!
      const downloadOrder = vi.mocked(downloadVideoToS3Traced).mock.invocationCallOrder[0]!
      const upsertOrder = vi.mocked(upsertFile).mock.invocationCallOrder[0]!
      const emitOrder = vi.mocked(emitEvent).mock.invocationCallOrder[0]!

      // Metadata is fetched before the video is streamed to S3.
      expect(fetchOrder).toBeLessThan(downloadOrder)
      // The File entity is upserted after the upload and before the completion event.
      expect(downloadOrder).toBeLessThan(upsertOrder)
      expect(upsertOrder).toBeLessThan(emitOrder)
    })

    it('emits an awaited DownloadCompleted event only after a successful upload and upsert', async () => {
      await processDownloadRequest(makeMessage(), 1)

      expect(emitEvent).toHaveBeenCalledWith({
        detailType: 'DownloadCompleted',
        detail: expect.objectContaining({fileId: 'dQw4w9WgXcQ', s3Key: 'dQw4w9WgXcQ.mp4', fileSize: 61548900})
      })
      // Completion is preceded by the terminal Completed state transition.
      expect(updateDownloadState).toHaveBeenCalledWith('dQw4w9WgXcQ', DownloadStatus.Completed, undefined, 0)
    })

    it('transitions the file to Downloading before streaming and marks download InProgress first', async () => {
      await processDownloadRequest(makeMessage(), 1)

      expect(updateDownloadState).toHaveBeenCalledWith('dQw4w9WgXcQ', DownloadStatus.InProgress, undefined, 0)
      expect(updateFile).toHaveBeenCalledWith('dQw4w9WgXcQ', {status: FileStatus.Downloading})
      expect(dispatchMetadataNotifications).toHaveBeenCalled()
    })
  })

  describe('failure propagation', () => {
    beforeEach(() => {
      vi.mocked(checkS3FileExists).mockResolvedValue({exists: false})
    })

    it('re-throws when metadata fetch fails and the failure is retriable (SQS redelivery)', async () => {
      const error = new Error('http error 429')
      vi.mocked(fetchVideoInfoTraced).mockResolvedValue(failedVideoInfo(error))
      vi.mocked(handleDownloadFailure).mockResolvedValue({shouldRetry: true, classification: retriable})

      await expect(processDownloadRequest(makeMessage(), 1)).rejects.toThrow('http error 429')

      // Retriable fetch failure must not proceed to download or completion.
      expect(downloadVideoToS3Traced).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
    })

    it('returns without throwing when metadata fetch fails permanently', async () => {
      vi.mocked(fetchVideoInfoTraced).mockResolvedValue(failedVideoInfo(new Error('this video is private')))
      vi.mocked(handleDownloadFailure).mockResolvedValue({shouldRetry: false, classification: permanent})

      await expect(processDownloadRequest(makeMessage(), 1)).resolves.toBeUndefined()

      expect(downloadVideoToS3Traced).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
    })

    it('re-throws when the S3 download stage fails and the failure is retriable', async () => {
      const error = new Error('connection reset')
      vi.mocked(downloadVideoToS3Traced).mockRejectedValue(error)
      vi.mocked(handleDownloadFailure).mockResolvedValue({shouldRetry: true, classification: retriable})

      await expect(processDownloadRequest(makeMessage(), 1)).rejects.toThrow('connection reset')

      // A failed upload must never upsert the File or emit DownloadCompleted.
      expect(upsertFile).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
    })

    it('returns without throwing when the S3 download stage fails permanently', async () => {
      vi.mocked(downloadVideoToS3Traced).mockRejectedValue(new Error('no space left on device'))
      vi.mocked(handleDownloadFailure).mockResolvedValue({shouldRetry: false, classification: permanent})

      await expect(processDownloadRequest(makeMessage(), 1)).resolves.toBeUndefined()

      expect(upsertFile).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
    })

    it('passes the existing retry state from FileDownload into the failure handler', async () => {
      vi.mocked(getFileDownload).mockResolvedValue(createMockFileDownload({fileId: 'dQw4w9WgXcQ', status: DownloadStatus.Scheduled, retryCount: 2, maxRetries: 4, lastError: 'prev', errorCategory: 'transient'}))
      const error = new Error('http error 503')
      vi.mocked(fetchVideoInfoTraced).mockResolvedValue(failedVideoInfo(error))
      vi.mocked(handleDownloadFailure).mockResolvedValue({shouldRetry: false, classification: retriable})

      await processDownloadRequest(makeMessage(), 2)

      expect(handleDownloadFailure).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.any(String), error, 'corr-1', expect.anything(), 2, 4)
    })
  })
})
