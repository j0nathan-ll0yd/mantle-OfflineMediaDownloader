/**
 * Unit tests for CleanupExpiredRecords Lambda (scheduled handler)
 *
 * Tests cleanup of expired file downloads, sessions, verification tokens, and
 * device events. The handler orchestrates entity queries (defineQuery) — each
 * delete is a mocked query returning a count, so these tests verify the
 * per-section error isolation and aggregate metrics rather than raw SQL.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as CleanupMod from '#lambdas/scheduled/CleanupExpiredRecords/index.js'

vi.mock('@j0nathan-ll0yd/core', () => ({defineScheduledHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('@j0nathan-ll0yd/observability',
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

vi.mock('#entities/queries',
  () => ({
    deleteExpiredFileDownloads: vi.fn(() => Promise.resolve(0)),
    deleteExpiredSessions: vi.fn(() => Promise.resolve(0)),
    deleteExpiredVerifications: vi.fn(() => Promise.resolve(0)),
    deleteExpiredDeviceEvents: vi.fn(() => Promise.resolve(0))
  }))

vi.mock('#types/enums', () => ({DownloadStatus: {Pending: 'Pending', InProgress: 'InProgress', Completed: 'Completed', Failed: 'Failed'}}))

vi.mock('#utils/time', () => ({secondsAgo: vi.fn(() => new Date('2024-01-01T00:00:00Z')), TIME: {DAY_SEC: 86400}}))

const {handler} = (await import('#lambdas/scheduled/CleanupExpiredRecords/index.js')) as unknown as MockedModule<typeof CleanupMod>
import {deleteExpiredDeviceEvents, deleteExpiredFileDownloads, deleteExpiredSessions, deleteExpiredVerifications} from '#entities/queries'
import {metrics} from '@j0nathan-ll0yd/observability'

describe('CleanupExpiredRecords Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks resets call history but not implementations — restore the
    // zero-count defaults so each test starts from a clean baseline.
    vi.mocked(deleteExpiredFileDownloads).mockResolvedValue(0)
    vi.mocked(deleteExpiredSessions).mockResolvedValue(0)
    vi.mocked(deleteExpiredVerifications).mockResolvedValue(0)
    vi.mocked(deleteExpiredDeviceEvents).mockResolvedValue(0)
  })

  it('should cleanup all record types successfully', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockResolvedValue(2)
    vi.mocked(deleteExpiredSessions).mockResolvedValue(1)
    vi.mocked(deleteExpiredVerifications).mockResolvedValue(3)
    vi.mocked(deleteExpiredDeviceEvents).mockResolvedValue(4)

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(2)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(3)
    expect(result.deviceEventsDeleted).toBe(4)
    expect(result.errors).toHaveLength(0)
    expect(metrics.addMetric).toHaveBeenCalledWith('RecordsCleanedUp', 'Count', 10)
  })

  it('should pass the terminal statuses and a cutoff to deleteExpiredFileDownloads', async () => {
    await handler()

    expect(deleteExpiredFileDownloads).toHaveBeenCalledWith(new Date('2024-01-01T00:00:00Z'), ['Completed', 'Failed'])
  })

  it('should return zero counts when nothing to cleanup', async () => {
    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.deviceEventsDeleted).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('should continue cleanup when fileDownloads fails', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockRejectedValue(new Error('DB timeout'))
    vi.mocked(deleteExpiredSessions).mockResolvedValue(1)
    vi.mocked(deleteExpiredVerifications).mockResolvedValue(1)

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect((result.errors as string[])[0]).toContain('FileDownloads cleanup failed')
  })

  it('should continue cleanup when sessions fails', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockResolvedValue(1)
    vi.mocked(deleteExpiredSessions).mockRejectedValue(new Error('Session table locked'))
    vi.mocked(deleteExpiredVerifications).mockResolvedValue(1)

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(1)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect((result.errors as string[])[0]).toContain('Sessions cleanup failed')
  })

  it('should continue cleanup when verification fails', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockResolvedValue(1)
    vi.mocked(deleteExpiredSessions).mockResolvedValue(1)
    vi.mocked(deleteExpiredVerifications).mockRejectedValue(new Error('Verification error'))

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(1)
    expect(result.sessionsDeleted).toBe(1)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect((result.errors as string[])[0]).toContain('Verification cleanup failed')
  })

  it('should continue cleanup when device events fails', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockResolvedValue(1)
    vi.mocked(deleteExpiredSessions).mockResolvedValue(1)
    vi.mocked(deleteExpiredVerifications).mockResolvedValue(1)
    vi.mocked(deleteExpiredDeviceEvents).mockRejectedValue(new Error('DeviceEvents error'))

    const result = await handler()

    expect(result.deviceEventsDeleted).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect((result.errors as string[])[0]).toContain('DeviceEvents cleanup failed')
  })

  it('should record errors for all failures but not throw', async () => {
    vi.mocked(deleteExpiredFileDownloads).mockRejectedValue(new Error('Total failure'))
    vi.mocked(deleteExpiredSessions).mockRejectedValue(new Error('Total failure'))
    vi.mocked(deleteExpiredVerifications).mockRejectedValue(new Error('Total failure'))
    vi.mocked(deleteExpiredDeviceEvents).mockRejectedValue(new Error('Total failure'))

    const result = await handler()

    expect(result.fileDownloadsDeleted).toBe(0)
    expect(result.sessionsDeleted).toBe(0)
    expect(result.verificationTokensDeleted).toBe(0)
    expect(result.deviceEventsDeleted).toBe(0)
    expect(result.errors).toHaveLength(4)
    expect(metrics.addMetric).toHaveBeenCalledWith('RecordsCleanedUp', 'Count', 0)
  })

  it('should emit CleanupRun metric', async () => {
    await handler()

    expect(metrics.addMetric).toHaveBeenCalledWith('CleanupRun', 'Count', 1)
  })
})
