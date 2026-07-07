// covers: media-download#retriable-failure-propagates-for-sqs-retry
// covers: media-download#permanent-failure-files-github-issue
/**
 * Unit tests for StartFileUpload failureHandler.
 *
 * Pins the retry-vs-terminate decision that governs whether SQS redelivers a
 * failed download: a retriable classification within limits returns
 * shouldRetry:true (the orchestrator re-throws so SQS retries), while a
 * permanent/exhausted classification returns shouldRetry:false and routes to
 * the correct terminal side effects (GitHub issue, File status = Failed,
 * failure notifications). The error classifier is mocked at its module
 * boundary so each category can be exercised deterministically; the real
 * isRetryExhausted comparison is preserved.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {FetchVideoInfoResult, VideoErrorClassification} from '#types/video'
import type {YtDlpVideoInfo} from '#types/youtube'
import {createMockFile} from '#test/helpers/entity-fixtures'
import {DownloadStatus, FileStatus} from '#types/enums'

vi.mock('@mantleframework/core', () => ({emitEvent: vi.fn(() => Promise.resolve()), isOk: vi.fn((r: {ok?: boolean}) => r?.ok === true)}))

vi.mock('@mantleframework/observability',
  () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn(), singleMetric: vi.fn(() => ({addDimension: vi.fn(), addMetric: vi.fn()}))},
    MetricUnit: {Count: 'Count'}
  }))

vi.mock('#entities/queries', () => ({getFile: vi.fn(), updateFile: vi.fn()}))

vi.mock('#domain/video/errorClassifier',
  () => ({
    classifyVideoError: vi.fn(),
    // Preserve the real exhaustion comparison so retry-count boundaries are genuinely exercised.
    isRetryExhausted: vi.fn((retryCount: number, maxRetries: number) => retryCount >= maxRetries)
  }))

vi.mock('#integrations/github/issueService',
  () => ({
    closeCookieExpirationIssueIfResolved: vi.fn(() => Promise.resolve()),
    createCookieExpirationIssue: vi.fn(() => Promise.resolve()),
    createVideoDownloadFailureIssue: vi.fn(() => Promise.resolve())
  }))

vi.mock('#services/notification/dispatchService', () => ({dispatchFailureNotifications: vi.fn(() => Promise.resolve())}))

vi.mock('#services/download/stateManager', () => ({updateDownloadState: vi.fn(() => Promise.resolve())}))

import {handleDownloadFailure, tryCloseCookieExpirationIssue} from '#lambdas/sqs/StartFileUpload/failureHandler.js'
import {emitEvent} from '@mantleframework/core'
import {getFile, updateFile} from '#entities/queries'
import {classifyVideoError} from '#domain/video/errorClassifier'
import {closeCookieExpirationIssueIfResolved, createCookieExpirationIssue, createVideoDownloadFailureIssue} from '#integrations/github/issueService'
import {dispatchFailureNotifications} from '#services/notification/dispatchService'
import {updateDownloadState} from '#services/download/stateManager'

const makeClassification = (overrides: Partial<VideoErrorClassification> = {}): VideoErrorClassification => ({
  category: 'transient',
  retryable: true,
  maxRetries: 5,
  reason: 'transient error',
  createIssue: false,
  ...overrides
})

const makeVideoInfo = (title: string): YtDlpVideoInfo => ({id: 'vid-1', title, formats: [], thumbnail: 'https://thumb/x.jpg', duration: 100})
const okResult = (title: string): FetchVideoInfoResult => ({ok: true, value: makeVideoInfo(title)})
const errResult = (): FetchVideoInfoResult => ({ok: false, error: {error: new Error('fetch failed'), isCookieError: false}})

describe('handleDownloadFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFile).mockResolvedValue(createMockFile({fileId: 'file-1', status: FileStatus.Downloading}))
  })

  it('returns shouldRetry:true and schedules a retry when the failure is retriable within limits', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'transient', retryable: true, maxRetries: 5}))

    const result = await handleDownloadFailure('file-1', 'https://yt/v', new Error('http error 429'), 'corr-1', errResult(), 0, 5)

    expect(result.shouldRetry).toBe(true)
    // Retriable path parks the download as Scheduled with the incremented retry count.
    expect(updateDownloadState).toHaveBeenCalledWith('file-1', DownloadStatus.Scheduled, expect.objectContaining({category: 'transient'}), 1)
    // Retriable path must NOT terminate: no issue, no File-status change, no failure notification.
    expect(createVideoDownloadFailureIssue).not.toHaveBeenCalled()
    expect(createCookieExpirationIssue).not.toHaveBeenCalled()
    expect(updateFile).not.toHaveBeenCalled()
    expect(dispatchFailureNotifications).not.toHaveBeenCalled()
  })

  it('emits a DownloadFailed event with retryable:true before deciding to retry', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'transient', retryable: true, maxRetries: 5}))

    await handleDownloadFailure('file-1', 'https://yt/v', new Error('econnreset'), 'corr-1', errResult(), 0, 5)

    expect(emitEvent).toHaveBeenCalledWith({
      detailType: 'DownloadFailed',
      detail: expect.objectContaining({fileId: 'file-1', retryable: true, retryCount: 1, errorCategory: 'transient'})
    })
  })

  it('files a video-download GitHub issue and marks the file Failed on a permanent classification', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0, reason: 'video is private'}))
    const error = new Error('this video is private')

    const result = await handleDownloadFailure('file-1', 'https://yt/v', error, 'corr-1', errResult(), 0, 5)

    expect(result.shouldRetry).toBe(false)
    expect(updateDownloadState).toHaveBeenCalledWith('file-1', DownloadStatus.Failed, expect.objectContaining({category: 'permanent'}), 1)
    expect(updateFile).toHaveBeenCalledWith('file-1', {status: FileStatus.Failed})
    expect(createVideoDownloadFailureIssue).toHaveBeenCalledWith('file-1', 'https://yt/v', error, 'video is private')
    expect(createCookieExpirationIssue).not.toHaveBeenCalled()
    expect(dispatchFailureNotifications).toHaveBeenCalledWith('file-1', 'permanent', 'video is private', true, undefined)
  })

  it('emits DownloadFailed with retryable:false on the terminal path', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0}))

    await handleDownloadFailure('file-1', 'https://yt/v', new Error('gone'), 'corr-1', errResult(), 0, 5)

    expect(emitEvent).toHaveBeenCalledWith({detailType: 'DownloadFailed', detail: expect.objectContaining({retryable: false})})
  })

  it('files a cookie-expiration issue (not a generic issue) for the cookie_expired category', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'cookie_expired', retryable: false, maxRetries: 0, reason: 'cookie expired'}))
    const error = new Error("sign in to confirm you're not a bot")

    const result = await handleDownloadFailure('file-1', 'https://yt/v', error, 'corr-1', errResult(), 0, 5)

    expect(result.shouldRetry).toBe(false)
    expect(createCookieExpirationIssue).toHaveBeenCalledWith('file-1', 'https://yt/v', error)
    expect(createVideoDownloadFailureIssue).not.toHaveBeenCalled()
  })

  it('terminates without filing any issue when a retriable category has exhausted its retries', async () => {
    // retryable:true but retry count (3+1=4) meets maxRetries (3): exhausted, so shouldRetry flips to false.
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'transient', retryable: true, maxRetries: 3}))

    const result = await handleDownloadFailure('file-1', 'https://yt/v', new Error('timeout'), 'corr-1', errResult(), 3, 3)

    expect(result.shouldRetry).toBe(false)
    expect(createVideoDownloadFailureIssue).not.toHaveBeenCalled()
    expect(createCookieExpirationIssue).not.toHaveBeenCalled()
    // Exhausted retriable failures still update state to Failed and notify with retryExhausted=true.
    expect(updateDownloadState).toHaveBeenCalledWith('file-1', DownloadStatus.Failed, expect.anything(), 4)
    expect(dispatchFailureNotifications).toHaveBeenCalledWith('file-1', 'transient', expect.any(String), true, undefined)
    // The emitted event's retryable flag reflects exhaustion, not the raw category.
    expect(emitEvent).toHaveBeenCalledWith({detailType: 'DownloadFailed', detail: expect.objectContaining({retryable: false, retryCount: 4})})
  })

  it('skips the File-status update when no File record exists', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0}))
    vi.mocked(getFile).mockResolvedValue(null)

    await handleDownloadFailure('file-1', 'https://yt/v', new Error('gone'), 'corr-1', errResult(), 0, 5)

    expect(updateFile).not.toHaveBeenCalled()
    // Missing File record must not block issue filing.
    expect(createVideoDownloadFailureIssue).toHaveBeenCalled()
  })

  it('swallows a File-status update error and still completes the terminal path', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0}))
    vi.mocked(updateFile).mockRejectedValue(new Error('DSQL write failed'))

    const result = await handleDownloadFailure('file-1', 'https://yt/v', new Error('gone'), 'corr-1', errResult(), 0, 5)

    expect(result.shouldRetry).toBe(false)
    expect(createVideoDownloadFailureIssue).toHaveBeenCalled()
  })

  it('passes the resolved video title to failure notifications when video info is available', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0, reason: 'gone'}))

    await handleDownloadFailure('file-1', 'https://yt/v', new Error('gone'), 'corr-1', okResult('My Video'), 0, 5)

    expect(dispatchFailureNotifications).toHaveBeenCalledWith('file-1', 'permanent', 'gone', true, 'My Video')
  })

  it('emits the DownloadFailed event before filing the terminal GitHub issue', async () => {
    vi.mocked(classifyVideoError).mockReturnValue(makeClassification({category: 'permanent', retryable: false, maxRetries: 0}))

    await handleDownloadFailure('file-1', 'https://yt/v', new Error('gone'), 'corr-1', errResult(), 0, 5)

    const emitOrder = vi.mocked(emitEvent).mock.invocationCallOrder[0]!
    const issueOrder = vi.mocked(createVideoDownloadFailureIssue).mock.invocationCallOrder[0]!
    expect(emitOrder).toBeLessThan(issueOrder)
  })
})

describe('tryCloseCookieExpirationIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('attempts to close any open cookie-expiration issue without throwing', () => {
    expect(() => tryCloseCookieExpirationIssue()).not.toThrow()
    expect(closeCookieExpirationIssueIfResolved).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the close routine rejects (fire-and-forget)', () => {
    vi.mocked(closeCookieExpirationIssueIfResolved).mockRejectedValue(new Error('GitHub API down'))
    expect(() => tryCloseCookieExpirationIssue()).not.toThrow()
  })
})
