/**
 * Unit tests for WebhookFeedly Lambda (POST /feedly/webhook)
 *
 * Tests auth validation, video ID extraction, idempotency, and error paths.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/aws', () => ({sendMessage: vi.fn()}))

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data})), emitEvent: vi.fn()}))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn(() => 'https://sqs.us-west-2.amazonaws.com/123/queue')}))

vi.mock('@mantleframework/errors', () => {
  class UnauthorizedError extends Error {
    statusCode = 401
    constructor(message: string) {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  return {UnauthorizedError}
})

vi.mock('@mantleframework/observability',
  () => ({
    addAnnotation: vi.fn(),
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => 'mock-span')
  }))

vi.mock('@mantleframework/resilience', () => {
  class MockIdempotencyConfig {
    registerLambdaContext = vi.fn()
    constructor() {}
  }
  return {
    createIdempotencyStore: vi.fn(() => ({})),
    IdempotencyConfig: MockIdempotencyConfig,
    makeIdempotent: vi.fn((fn: (...a: unknown[]) => unknown) => fn)
  }
})

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({}))}
  }))

vi.mock('#domain/user/userFileService', () => ({associateFileToUser: vi.fn()}))

vi.mock('#entities/queries', () => ({createFile: vi.fn(), createFileDownload: vi.fn(), getFile: vi.fn()}))

vi.mock('#services/notification/transformers', () => ({createDownloadReadyNotification: vi.fn(() => ({messageBody: '{}', messageAttributes: {}}))}))

vi.mock('#services/youtube/youtube', () => ({getVideoID: vi.fn()}))

vi.mock('#types/api-schema', () => ({webhookResponseSchema: {}}))

vi.mock('#types/enums',
  () => ({
    DownloadStatus: {Pending: 'Pending'},
    FileStatus: {Queued: 'Queued', Downloaded: 'Downloaded', Failed: 'Failed'},
    ResponseStatus: {Dispatched: 'Dispatched', Accepted: 'Accepted', Initiated: 'Initiated'}
  }))

const {handler} = (await import('#lambdas/api/feedly/webhook.post.js')) as any
import {getVideoID} from '#services/youtube/youtube'
import {createFile, createFileDownload, getFile} from '#entities/queries'
import {associateFileToUser} from '#domain/user/userFileService'
import {emitEvent} from '@mantleframework/core'
import {sendMessage} from '@mantleframework/aws'
import {metrics} from '@mantleframework/observability'

describe('WebhookFeedly Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVideoID).mockReturnValue('dQw4w9WgXcQ')
  })

  it('should throw UnauthorizedError when userId is missing', async () => {
    await expect(
      handler({
        context: {awsRequestId: 'req-1'},
        userId: undefined,
        body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
        metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
      })
    ).rejects.toThrow('Authentication required')
  })

  it('should emit DownloadRequested event for new file', async () => {
    vi.mocked(associateFileToUser).mockResolvedValue(undefined as never)
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockResolvedValue(undefined as never)
    vi.mocked(createFileDownload).mockResolvedValue(undefined as never)
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    const result = await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    expect(createFile).toHaveBeenCalled()
    expect(createFileDownload).toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({detailType: 'DownloadRequested'}))
    expect(result.statusCode).toBe(202)
    expect(result.status).toBe('Accepted')
  })

  it('should send notification and return Dispatched for already-downloaded file', async () => {
    vi.mocked(associateFileToUser).mockResolvedValue(undefined as never)
    vi.mocked(getFile).mockResolvedValue(
      {
        fileId: 'dQw4w9WgXcQ',
        size: 1000,
        authorName: 'A',
        authorUser: 'a',
        publishDate: '2024-01-01',
        description: 'D',
        key: 'dQw4w9WgXcQ.mp4',
        contentType: 'video/mp4',
        title: 'Test',
        status: 'Downloaded',
        url: 'https://cdn/file.mp4'
      } as never
    )
    vi.mocked(sendMessage).mockResolvedValue({MessageId: 'msg-1'} as never)

    const result = await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    expect(sendMessage).toHaveBeenCalled()
    expect(createFile).not.toHaveBeenCalled()
    expect(result.statusCode).toBe(200)
    expect(result.status).toBe('Dispatched')
  })

  it('should emit event without creating file when file exists but not downloaded', async () => {
    vi.mocked(associateFileToUser).mockResolvedValue(undefined as never)
    vi.mocked(getFile).mockResolvedValue(
      {
        fileId: 'dQw4w9WgXcQ',
        size: 0,
        authorName: 'A',
        authorUser: 'a',
        publishDate: '2024-01-01',
        description: 'D',
        key: 'dQw4w9WgXcQ.mp4',
        contentType: 'video/mp4',
        title: 'Test',
        status: 'Queued'
      } as never
    )
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    const result = await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    expect(createFile).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalled()
    expect(result.statusCode).toBe(202)
  })

  it('should track WebhookReceived and WebhookProcessed metrics', async () => {
    vi.mocked(associateFileToUser).mockResolvedValue(undefined as never)
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockResolvedValue(undefined as never)
    vi.mocked(createFileDownload).mockResolvedValue(undefined as never)
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    expect(metrics.addMetric).toHaveBeenCalledWith('WebhookReceived', 'Count', 1)
    expect(metrics.addMetric).toHaveBeenCalledWith('WebhookProcessed', 'Count', 1)
  })

  it('should handle associateFileToUser failure gracefully', async () => {
    vi.mocked(associateFileToUser).mockRejectedValue(new Error('DB error'))
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockResolvedValue(undefined as never)
    vi.mocked(createFileDownload).mockResolvedValue(undefined as never)
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    const result = await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    // Should still process successfully despite association failure
    expect(result.statusCode).toBe(202)
  })

  it('should extract videoID from article URL', async () => {
    vi.mocked(associateFileToUser).mockResolvedValue(undefined as never)
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockResolvedValue(undefined as never)
    vi.mocked(createFileDownload).mockResolvedValue(undefined as never)
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=xyzABC12345'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    expect(getVideoID).toHaveBeenCalledWith('https://www.youtube.com/watch?v=xyzABC12345')
  })
})
