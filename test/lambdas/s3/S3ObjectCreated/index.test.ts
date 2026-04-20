/**
 * Unit tests for S3ObjectCreated Lambda (S3 handler)
 *
 * Tests S3 object creation event processing and push notification dispatch.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core', () => ({defineS3Handler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('@mantleframework/aws', () => ({sendMessage: vi.fn()}))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn(() => 'https://sqs.us-west-2.amazonaws.com/123/queue')}))

vi.mock('@mantleframework/errors', () => {
  class NotFoundError extends Error {
    statusCode = 404
    constructor(message: string) {
      super(message)
      this.name = 'NotFoundError'
    }
  }
  return {NotFoundError}
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
    startSpan: vi.fn(() => ({}))
  }))

vi.mock('#entities/queries', () => ({getFilesByKey: vi.fn(), getUserFilesByFileId: vi.fn()}))

vi.mock('#services/notification/transformers',
  () => ({
    createDownloadReadyNotification: vi.fn(() => ({
      messageBody: JSON.stringify({file: {fileId: 'file-1'}, notificationType: 'DownloadReadyNotification'}),
      messageAttributes: {
        userId: {DataType: 'String', StringValue: 'user-1'},
        notificationType: {DataType: 'String', StringValue: 'DownloadReadyNotification'}
      }
    }))
  }))

const {handler} = (await import('#lambdas/s3/S3ObjectCreated/index.js')) as any
import {sendMessage} from '@mantleframework/aws'
import {getFilesByKey, getUserFilesByFileId} from '#entities/queries'
import {createDownloadReadyNotification} from '#services/notification/transformers'
import {metrics} from '@mantleframework/observability'

describe('S3ObjectCreated Lambda', () => {
  const makeRecord = (key = 'dQw4w9WgXcQ.mp4') => ({key})

  const mockFile = {
    fileId: 'dQw4w9WgXcQ',
    size: 61548900,
    authorName: 'Philip DeFranco',
    authorUser: 'sxephil',
    publishDate: '2021-01-22T00:00:00.000Z',
    description: 'Test video',
    key: 'dQw4w9WgXcQ.mp4',
    url: 'https://example.cloudfront.net/dQw4w9WgXcQ.mp4',
    contentType: 'video/mp4',
    title: 'Test Video',
    status: 'Downloaded',
    duration: null,
    uploadDate: null,
    viewCount: null,
    thumbnailUrl: null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFilesByKey).mockResolvedValue([mockFile])
    vi.mocked(getUserFilesByFileId).mockResolvedValue([{userId: 'user-1', fileId: 'dQw4w9WgXcQ', createdAt: new Date()}])
    vi.mocked(sendMessage).mockResolvedValue({MessageId: 'msg-1', $metadata: {}})
  })

  it('should find file by key and dispatch notification', async () => {
    await handler(makeRecord())

    expect(getFilesByKey).toHaveBeenCalledWith('dQw4w9WgXcQ.mp4')
    expect(getUserFilesByFileId).toHaveBeenCalledWith('dQw4w9WgXcQ')
    expect(createDownloadReadyNotification).toHaveBeenCalledWith(mockFile, 'user-1')
    expect(sendMessage).toHaveBeenCalled()
  })

  it('should throw NotFoundError when file not found in database', async () => {
    vi.mocked(getFilesByKey).mockResolvedValue([])

    await expect(handler(makeRecord())).rejects.toThrow('Unable to locate file')
  })

  it('should return early when no users associated with file', async () => {
    vi.mocked(getUserFilesByFileId).mockResolvedValue([])

    await handler(makeRecord())

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('should dispatch notifications to multiple users', async () => {
    vi.mocked(getUserFilesByFileId).mockResolvedValue([
      {userId: 'user-1', fileId: 'dQw4w9WgXcQ', createdAt: new Date()},
      {userId: 'user-2', fileId: 'dQw4w9WgXcQ', createdAt: new Date()}
    ])

    await handler(makeRecord())

    expect(createDownloadReadyNotification).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(metrics.addMetric).toHaveBeenCalledWith('NotificationsSent', 'Count', 2)
  })

  it('should emit metrics for successful notifications', async () => {
    await handler(makeRecord())

    expect(metrics.addMetric).toHaveBeenCalledWith('NotificationsSent', 'Count', 1)
  })

  it('should handle partial failures when dispatching to multiple users', async () => {
    vi.mocked(getUserFilesByFileId).mockResolvedValue([
      {userId: 'user-1', fileId: 'dQw4w9WgXcQ', createdAt: new Date()},
      {userId: 'user-2', fileId: 'dQw4w9WgXcQ', createdAt: new Date()}
    ])
    vi.mocked(sendMessage).mockResolvedValueOnce({MessageId: 'msg-1', $metadata: {}}).mockRejectedValueOnce(new Error('SQS failure'))

    await handler(makeRecord())

    expect(metrics.addMetric).toHaveBeenCalledWith('NotificationsSent', 'Count', 1)
    expect(metrics.addMetric).toHaveBeenCalledWith('NotificationsFailed', 'Count', 1)
  })

  it('should log all notifications dispatched successfully message', async () => {
    const {logInfo} = await import('@mantleframework/observability')

    await handler(makeRecord())

    expect(logInfo).toHaveBeenCalledWith('All notifications dispatched successfully', expect.objectContaining({fileId: 'dQw4w9WgXcQ'}))
  })

  it('should rethrow errors from getFileByFilename', async () => {
    vi.mocked(getFilesByKey).mockRejectedValue(new Error('DB connection error'))

    await expect(handler(makeRecord())).rejects.toThrow('DB connection error')
  })
})
