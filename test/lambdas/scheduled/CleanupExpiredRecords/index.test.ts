/**
 * Unit tests for CleanupExpiredRecords Lambda (scheduled handler)
 *
 * Tests cleanup of expired file downloads, sessions, and verification tokens.
 * CRITICAL: This Lambda uses getDrizzleClient() directly, not defineQuery.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core', () => ({defineScheduledHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('@mantleframework/observability',
  () => ({
    addMetadata: vi.fn(),
    endSpan: vi.fn(),
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    metrics: {addMetric: vi.fn()},
    MetricUnit: {Count: 'Count'},
    startSpan: vi.fn(() => ({}))
  }))

vi.mock('@mantleframework/database/orm',
  () => ({
    and: vi.fn((...args: unknown[]) => ({type: 'and', conditions: args})),
    eq: vi.fn((col: unknown, val: unknown) => ({type: 'eq', col, val})),
    lt: vi.fn((col: unknown, val: unknown) => ({type: 'lt', col, val})),
    or: vi.fn((...args: unknown[]) => ({type: 'or', conditions: args}))
  }))

// Create chainable mock for Drizzle client
function createChainableMock(returnValue: unknown[] = []) {
  const chain = {returning: vi.fn(() => Promise.resolve(returnValue)), where: vi.fn(() => chain)}
  const deleteMethod = vi.fn(() => chain)
  return {db: {delete: deleteMethod}, chain, deleteMethod}
}

const drizzleMock = createChainableMock()

vi.mock('#db/client', () => ({getDrizzleClient: vi.fn(() => Promise.resolve(drizzleMock.db))}))

vi.mock('#db/schema',
  () => ({
    fileDownloads: {fileId: 'fileId', status: 'status', updatedAt: 'updatedAt'},
    sessions: {id: 'id', expiresAt: 'expiresAt'},
    verification: {id: 'id', expiresAt: 'expiresAt'}
  }))

vi.mock('#types/enums', () => ({DownloadStatus: {Completed: 'Completed', Failed: 'Failed'}}))

vi.mock('#utils/time', () => ({secondsAgo: vi.fn(() => new Date('2024-01-01T00:00:00Z')), TIME: {DAY_SEC: 86400}}))

const {handler} = (await import('#lambdas/scheduled/CleanupExpiredRecords/index.js')) as any
import {getDrizzleClient} from '#db/client'
import {metrics} from '@mantleframework/observability'

describe('CleanupExpiredRecords Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Reset the chainable mock for each test
    const freshMock = createChainableMock()
    vi.mocked(getDrizzleClient).mockResolvedValue(freshMock.db as never)
  })

  it('should cleanup all record types successfully', async () => {
    // Each cleanup call returns different counts
    const fileDownloadsMock = createChainableMock([{fileId: 'f1'}, {fileId: 'f2'}])
    const sessionsMock = createChainableMock([{id: 's1'}])
    const verificationMock = createChainableMock([{id: 'v1'}, {id: 'v2'}, {id: 'v3'}])

    let callCount = 0
    vi.mocked(getDrizzleClient).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(fileDownloadsMock.db as never)
      }
      if (callCount === 2) {
        return Promise.resolve(sessionsMock.db as never)
      }
      return Promise.resolve(verificationMock.db as never)
    })

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(2)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(3)
    expect(result.errors).toHaveLength(0)
    expect(metrics.addMetric).toHaveBeenCalledWith('RecordsCleanedUp', 'Count', 6)
  })

  it('should return zero counts when nothing to cleanup', async () => {
    const emptyMock = createChainableMock([])
    vi.mocked(getDrizzleClient).mockResolvedValue(emptyMock.db as never)

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('should continue cleanup when fileDownloads fails', async () => {
    const failingMock = createChainableMock()
    failingMock.chain.returning.mockRejectedValue(new Error('DB timeout'))
    const successMock = createChainableMock([{id: 's1'}])

    let callCount = 0
    vi.mocked(getDrizzleClient).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(failingMock.db as never)
      }
      return Promise.resolve(successMock.db as never)
    })

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('FileDownloads cleanup failed')
  })

  it('should continue cleanup when sessions fails', async () => {
    const successMock = createChainableMock([{fileId: 'f1'}])
    const failingMock = createChainableMock()
    failingMock.chain.returning.mockRejectedValue(new Error('Session table locked'))
    const verifyMock = createChainableMock([{id: 'v1'}])

    let callCount = 0
    vi.mocked(getDrizzleClient).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(successMock.db as never)
      }
      if (callCount === 2) {
        return Promise.resolve(failingMock.db as never)
      }
      return Promise.resolve(verifyMock.db as never)
    })

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(1)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Sessions cleanup failed')
  })

  it('should continue cleanup when verification fails', async () => {
    const successMock = createChainableMock([{fileId: 'f1'}])
    const sessionMock = createChainableMock([{id: 's1'}])
    const failingMock = createChainableMock()
    failingMock.chain.returning.mockRejectedValue(new Error('Verification error'))

    let callCount = 0
    vi.mocked(getDrizzleClient).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(successMock.db as never)
      }
      if (callCount === 2) {
        return Promise.resolve(sessionMock.db as never)
      }
      return Promise.resolve(failingMock.db as never)
    })

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(1)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Verification cleanup failed')
  })

  it('should record errors for all failures but not throw', async () => {
    const failingMock = createChainableMock()
    failingMock.chain.returning.mockRejectedValue(new Error('Total failure'))
    vi.mocked(getDrizzleClient).mockResolvedValue(failingMock.db as never)

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.errors).toHaveLength(3)
    expect(metrics.addMetric).toHaveBeenCalledWith('RecordsCleanedUp', 'Count', 0)
  })

  it('should emit CleanupRun metric', async () => {
    const emptyMock = createChainableMock([])
    vi.mocked(getDrizzleClient).mockResolvedValue(emptyMock.db as never)

    await handler()

    expect(metrics.addMetric).toHaveBeenCalledWith('CleanupRun', 'Count', 1)
  })
})
