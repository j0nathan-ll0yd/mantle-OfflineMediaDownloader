/**
 * Unit tests for FileDelete Lambda (DELETE /files/{fileId})
 *
 * Tests cascade deletion, S3 cleanup, not-found errors, and S3 failure resilience.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core',
  () => ({
    buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data})),
    defineLambda: vi.fn(),
    S3BucketName: vi.fn((name: string) => name)
  }))

vi.mock('@mantleframework/aws', () => ({deleteObject: vi.fn()}))

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

vi.mock('@mantleframework/observability', () => ({logError: vi.fn(), logInfo: vi.fn()}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({})), boolean: vi.fn(() => ({}))}
  }))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn(() => 'test-bucket')}))

vi.mock('#entities/queries', () => ({deleteFileCascade: vi.fn()}))

const {handler} = (await import('#lambdas/api/files/[fileId]/index.delete.js')) as any
import {deleteFileCascade} from '#entities/queries'
import {deleteObject} from '@mantleframework/aws'
import {logError, logInfo} from '@mantleframework/observability'

describe('FileDelete Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw NotFoundError when file does not exist for user', async () => {
    vi.mocked(deleteFileCascade).mockResolvedValue({existed: false, fileRemoved: false})

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})).rejects.toThrow('File not found for this user')
  })

  it('should delete file link without S3 cleanup when other users linked', async () => {
    vi.mocked(deleteFileCascade).mockResolvedValue({existed: true, fileRemoved: false})

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})

    expect(deleteObject).not.toHaveBeenCalled()
    expect(result.deleted).toBe(true)
    expect(result.fileRemoved).toBe(false)
  })

  it('should delete S3 object when file is orphaned', async () => {
    vi.mocked(deleteFileCascade).mockResolvedValue({existed: true, fileRemoved: true})
    vi.mocked(deleteObject).mockResolvedValue(undefined as never)

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})

    expect(deleteObject).toHaveBeenCalledWith({Bucket: 'test-bucket', Key: 'abc123.mp4'})
    expect(logInfo).toHaveBeenCalledWith('Deleted orphaned S3 object', {fileId: 'abc123', key: 'abc123.mp4'})
    expect(result.deleted).toBe(true)
    expect(result.fileRemoved).toBe(true)
  })

  it('should continue successfully when S3 deletion fails (orphaned object)', async () => {
    vi.mocked(deleteFileCascade).mockResolvedValue({existed: true, fileRemoved: true})
    vi.mocked(deleteObject).mockRejectedValue(new Error('S3 access denied'))

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})

    expect(logError).toHaveBeenCalledWith('Failed to delete S3 object (orphaned)', expect.objectContaining({fileId: 'abc123', error: 'S3 access denied'}))
    expect(result.deleted).toBe(true)
    expect(result.fileRemoved).toBe(true)
  })

  it('should handle non-Error S3 failures gracefully', async () => {
    vi.mocked(deleteFileCascade).mockResolvedValue({existed: true, fileRemoved: true})
    vi.mocked(deleteObject).mockRejectedValue('string error')

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})

    expect(logError).toHaveBeenCalledWith('Failed to delete S3 object (orphaned)', expect.objectContaining({error: 'string error'}))
    expect(result.deleted).toBe(true)
  })

  it('should propagate database errors from deleteFileCascade', async () => {
    vi.mocked(deleteFileCascade).mockRejectedValue(new Error('DB connection failed'))

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', path: {fileId: 'abc123'}})).rejects.toThrow('DB connection failed')
  })
})
