/**
 * Unit tests for LogoutUser Lambda (POST /user/logout)
 *
 * Tests token extraction, session expiry, and auth error paths.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {MockedModule} from '#test/helpers/handler-test-types'
import type * as LogoutMod from '#lambdas/api/user/logout.post.js'

vi.mock('@j0nathan-ll0yd/auth', () => ({expireSession: vi.fn(), extractBearerToken: vi.fn()}))

vi.mock('@j0nathan-ll0yd/core', () => ({buildValidatedResponse: vi.fn((_ctx, code) => ({statusCode: code})), defineLambda: vi.fn()}))

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

vi.mock('@j0nathan-ll0yd/observability', () => ({logDebug: vi.fn(), logInfo: vi.fn()}))

vi.mock('@j0nathan-ll0yd/validation', () => ({defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler)}))

vi.mock('#db/client', () => ({getDrizzleClient: vi.fn()}))

vi.mock('#domain/auth/authInstance', () => ({getAuthInstance: vi.fn()}))

const {handler} = (await import('#lambdas/api/user/logout.post.js')) as unknown as MockedModule<typeof LogoutMod>
import {expireSession, extractBearerToken} from '@j0nathan-ll0yd/auth'
import {getAuthInstance} from '#domain/auth/authInstance'
import {getDrizzleClient} from '#db/client'
import {buildValidatedResponse} from '@j0nathan-ll0yd/core'

describe('LogoutUser Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw UnauthorizedError when bearer token is missing', async () => {
    vi.mocked(extractBearerToken).mockReturnValue(null as never)

    await expect(handler({event: {headers: {}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow('Missing Authorization header')
  })

  it('should expire session and return 204', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('my-token')
    vi.mocked(getAuthInstance).mockResolvedValue({} as never)
    vi.mocked(getDrizzleClient).mockResolvedValue({} as never)
    vi.mocked(expireSession).mockResolvedValue(undefined as never)

    const result = await handler({event: {headers: {Authorization: 'Bearer my-token'}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})

    expect(expireSession).toHaveBeenCalledWith({}, 'my-token', {})
    expect(buildValidatedResponse).toHaveBeenCalledWith({awsRequestId: 'req-1'}, 204)
    expect(result.statusCode).toBe(204)
  })

  it('should propagate expireSession errors', async () => {
    vi.mocked(extractBearerToken).mockReturnValue('my-token')
    vi.mocked(getAuthInstance).mockResolvedValue({} as never)
    vi.mocked(getDrizzleClient).mockResolvedValue({} as never)
    vi.mocked(expireSession).mockRejectedValue(new Error('Session not found'))

    await expect(handler({event: {headers: {Authorization: 'Bearer my-token'}}, context: {awsRequestId: 'req-1'}, userId: 'user-1'})).rejects.toThrow(
      'Session not found'
    )
  })
})
