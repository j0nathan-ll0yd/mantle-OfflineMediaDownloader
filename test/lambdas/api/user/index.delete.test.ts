/**
 * Unit tests for UserDelete Lambda (DELETE /user)
 *
 * Tests cascade deletion ordering, partial failures, and GitHub issue creation on error.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data})), defineLambda: vi.fn()}))

vi.mock('@mantleframework/errors', () => {
  class UnauthorizedError extends Error {
    statusCode = 401
    constructor(message: string) {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  class UnexpectedError extends Error {
    statusCode = 500
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {UnauthorizedError, UnexpectedError}
})

vi.mock('@mantleframework/observability', () => ({logDebug: vi.fn(), logError: vi.fn()}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({})), number: vi.fn(() => ({}))}
  }))

vi.mock('#entities/queries', () => ({deleteUser: vi.fn(), deleteUserDevicesByUserId: vi.fn(), deleteUserFilesByUserId: vi.fn(), getDevicesBatch: vi.fn()}))

vi.mock('#errors/custom-errors', () => ({providerFailureErrorMessage: 'AWS request failed'}))

vi.mock('#integrations/github/issueService', () => ({createFailedUserDeletionIssue: vi.fn()}))

vi.mock('#services/device/deviceService', () => ({deleteDevice: vi.fn(), getUserDevices: vi.fn()}))

const {handler} = (await import('#lambdas/api/user/index.delete.js')) as any
import {deleteUser, deleteUserDevicesByUserId, deleteUserFilesByUserId, getDevicesBatch} from '#entities/queries'
import {createFailedUserDeletionIssue} from '#integrations/github/issueService'
import {deleteDevice, getUserDevices} from '#services/device/deviceService'
import {buildValidatedResponse} from '@mantleframework/core'

describe('UserDelete Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw UnauthorizedError when userId is missing', async () => {
    await expect(handler({context: {awsRequestId: 'req-1'}, userId: undefined})).rejects.toThrow('Authentication required')
  })

  it('should throw UnauthorizedError when userId is empty string', async () => {
    await expect(handler({context: {awsRequestId: 'req-1'}, userId: ''})).rejects.toThrow('Authentication required')
  })

  it('should delete user with no devices successfully', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([])
    vi.mocked(deleteUserFilesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUser).mockResolvedValue(undefined as never)

    await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(buildValidatedResponse).toHaveBeenCalledWith({awsRequestId: 'req-1'}, 204)
    expect(getDevicesBatch).not.toHaveBeenCalled()
  })

  it('should throw UnexpectedError when getDevicesBatch returns empty for known devices', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])
    vi.mocked(getDevicesBatch).mockResolvedValue([])

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow('AWS request failed')
  })

  it('should return 207 when relation deletions fail', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([])
    vi.mocked(deleteUserFilesByUserId).mockRejectedValue(new Error('DB error'))
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(result.statusCode).toBe(207)
    expect(result.message).toContain('Partial deletion')
    expect(result.failedOperations).toBe(1)
  })

  it('should return 207 when device deletions fail', async () => {
    const mockDevice = {deviceId: 'dev-1', name: 'iPhone', token: 'tok', systemVersion: '17', systemName: 'iOS', endpointArn: 'arn:aws:sns:endpoint'}
    vi.mocked(getUserDevices).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])
    vi.mocked(getDevicesBatch).mockResolvedValue([mockDevice])
    vi.mocked(deleteUserFilesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteDevice).mockRejectedValue(new Error('SNS error'))

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(result.statusCode).toBe(207)
    expect(result.message).toContain('devices could not be removed')
  })

  it('should create GitHub issue and throw when deleteUser fails', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([])
    vi.mocked(deleteUserFilesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUser).mockRejectedValue(new Error('DB constraint error'))
    vi.mocked(createFailedUserDeletionIssue).mockResolvedValue(undefined as never)

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow('Operation failed unexpectedly; but logged for resolution')

    expect(createFailedUserDeletionIssue).toHaveBeenCalledWith('user-1', [], expect.any(Error), 'req-1')
  })

  it('should handle non-Error thrown from deleteUser', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([])
    vi.mocked(deleteUserFilesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUser).mockRejectedValue('string error')
    vi.mocked(createFailedUserDeletionIssue).mockResolvedValue(undefined as never)

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow('Operation failed unexpectedly')

    expect(createFailedUserDeletionIssue).toHaveBeenCalledWith('user-1', [], expect.objectContaining({message: 'string error'}), 'req-1')
  })

  it('should delete user and devices in correct cascade order', async () => {
    const mockDevice = {deviceId: 'dev-1', name: 'iPhone', token: 'tok', systemVersion: '17', systemName: 'iOS', endpointArn: 'arn:aws:sns:endpoint'}
    vi.mocked(getUserDevices).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])
    vi.mocked(getDevicesBatch).mockResolvedValue([mockDevice])
    vi.mocked(deleteUserFilesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteUserDevicesByUserId).mockResolvedValue(undefined as never)
    vi.mocked(deleteDevice).mockResolvedValue(undefined as never)
    vi.mocked(deleteUser).mockResolvedValue(undefined as never)

    await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    // Relations deleted first, then devices, then user last
    expect(deleteUserFilesByUserId).toHaveBeenCalled()
    expect(deleteUserDevicesByUserId).toHaveBeenCalled()
    expect(deleteDevice).toHaveBeenCalledWith(mockDevice)
    expect(deleteUser).toHaveBeenCalled()
    expect(buildValidatedResponse).toHaveBeenCalledWith({awsRequestId: 'req-1'}, 204)
  })
})
