/**
 * Unit tests for RefreshToken Lambda (POST /user/refresh)
 *
 * Tests token extraction, session validation, and auth error paths.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/auth', () => ({extractBearerToken: vi.fn(), validateSession: vi.fn()}))

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, _code, data) => data), defineLambda: vi.fn()}))

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

vi.mock('@mantleframework/observability', () => ({logDebug: vi.fn(), logInfo: vi.fn()}))

vi.mock('@mantleframework/validation', () => ({defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('#domain/auth/authInstance', () => ({getAuthInstance: vi.fn()}))

vi.mock('#types/api-schema', () => ({userLoginResponseSchema: {}}))

const {handler} = (await import('#lambdas/api/user/refresh.post.js')) as any
import {extractBearerToken, validateSession} from '@mantleframework/auth'
import {getAuthInstance} from '#domain/auth/authInstance'

describe('RefreshToken Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw UnauthorizedError when userId is missing', async () => {
    await expect(handler({event: {headers: {Authorization: 'Bearer token'}}, context: {awsRequestId: 'req-1'}, userId: undefined})).rejects.toThrow(
      'Authentication required'
    )
  })

  it('should throw UnauthorizedError when bearer token is missing', async () => {
    vi.mocked(extractBearerToken).mockReturnValue(null as never)

    await expect(handler({event: {headers: {}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow('Missing Authorization header')
  })

  it('should return refreshed session info on success', async () => {
    const expiresAt = new Date(Date.now() + 86400000)
    vi.mocked(extractBearerToken).mockReturnValue('my-token')
    vi.mocked(getAuthInstance).mockResolvedValue({} as never)
    vi.mocked(validateSession).mockResolvedValue({
      session: {id: 'session-1', expiresAt, token: 'my-token'},
      user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test'}
    })

    const result = await handler({event: {headers: {Authorization: 'Bearer my-token'}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(result).toEqual({token: 'my-token', expiresAt: expiresAt.toISOString(), sessionId: 'session-1', userId: 'user-1'})
  })

  it('should check lowercase authorization header', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('my-token')
    vi.mocked(getAuthInstance).mockResolvedValue({} as never)
    vi.mocked(validateSession).mockResolvedValue({
      session: {id: 's-1', expiresAt: new Date(), token: 'my-token'},
      user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test'}
    })

    await handler({event: {headers: {authorization: 'Bearer my-token'}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(extractBearerToken).toHaveBeenCalledWith('Bearer my-token')
  })

  it('should propagate validateSession errors', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('my-token')
    vi.mocked(getAuthInstance).mockResolvedValue({} as never)
    vi.mocked(validateSession).mockRejectedValue(new Error('Session expired'))

    await expect(handler({event: {headers: {Authorization: 'Bearer my-token'}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow(
      'Session expired'
    )
  })
})
