/**
 * Unit tests for WebhookFeedly Lambda (POST /feedly/webhook)
 *
 * Tests auth validation, video ID extraction, idempotency, and error paths.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as WebhookMod from '#lambdas/api/feedly/webhook.post.js'

vi.mock('@j0nathan-ll0yd/aws', () => ({sendMessage: vi.fn()}))

vi.mock('@j0nathan-ll0yd/core',
  () => ({
    defineLambda: vi.fn(),
    buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data})),
    emitEvent: vi.fn(),
    SqsQueueUrl: (s: string) => s
  }))

vi.mock('@j0nathan-ll0yd/env', () => ({getRequiredEnv: vi.fn(() => 'https://sqs.us-west-2.amazonaws.com/123/queue')}))

vi.mock('@j0nathan-ll0yd/errors', () => {
  class UnauthorizedError extends Error {
    statusCode = 401
    constructor(message: string) {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  return {UnauthorizedError}
})

vi.mock('@j0nathan-ll0yd/observability',
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

vi.mock('@j0nathan-ll0yd/resilience', () => {
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

vi.mock('@j0nathan-ll0yd/validation',
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

const {handler} = (await import('#lambdas/api/feedly/webhook.post.js')) as unknown as MockedModule<typeof WebhookMod>
import {getVideoID} from '#services/youtube/youtube'
import {createFile, createFileDownload, getFile} from '#entities/queries'
import {associateFileToUser} from '#domain/user/userFileService'
import {emitEvent} from '@j0nathan-ll0yd/core'
import {sendMessage} from '@j0nathan-ll0yd/aws'
import {metrics} from '@j0nathan-ll0yd/observability'

describe('WebhookFeedly Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVideoID).mockReturnValue('dQw4w9WgXcQ')
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

  it('should propagate associateFileToUser failure as error', async () => {
    vi.mocked(associateFileToUser).mockRejectedValue(new Error('DB error'))
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockResolvedValue(undefined as never)
    vi.mocked(createFileDownload).mockResolvedValue(undefined as never)
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    await expect(
      handler({
        context: {awsRequestId: 'req-1'},
        userId: 'user-1',
        body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
        metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
      })
    ).rejects.toThrow('DB error')

    // File should be created before association is attempted
    expect(createFile).toHaveBeenCalled()
    expect(createFileDownload).toHaveBeenCalled()
    // Event should NOT be emitted since association failed
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('should call associateFileToUser AFTER addFile for new files', async () => {
    const callOrder: string[] = []
    vi.mocked(getFile).mockResolvedValue(null as never)
    vi.mocked(createFile).mockImplementation(async () => {
      callOrder.push('createFile')
      return undefined as never
    })
    vi.mocked(createFileDownload).mockImplementation(async () => {
      callOrder.push('createFileDownload')
      return undefined as never
    })
    vi.mocked(associateFileToUser).mockImplementation(async () => {
      callOrder.push('associateFileToUser')
      return undefined as never
    })
    vi.mocked(emitEvent).mockResolvedValue(undefined as never)

    await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    // Association MUST happen after file creation to avoid orphaned user_files rows
    expect(callOrder.indexOf('createFile')).toBeLessThan(callOrder.indexOf('associateFileToUser'))
    expect(callOrder.indexOf('createFileDownload')).toBeLessThan(callOrder.indexOf('associateFileToUser'))
  })

  it('should associate file to user even for already-downloaded files', async () => {
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

    await handler({
      context: {awsRequestId: 'req-1'},
      userId: 'user-1',
      body: {articleURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
      metadata: {correlationId: 'corr-1', traceId: 'trace-1'}
    })

    // Association must always be called, even for existing downloaded files
    // (handles the case where a second user requests an already-downloaded file)
    expect(associateFileToUser).toHaveBeenCalledWith('dQw4w9WgXcQ', 'user-1')
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
