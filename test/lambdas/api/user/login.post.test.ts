/**
 * Unit tests for LoginUser Lambda (POST /user/login)
 *
 * Tests sign-in flow, session retrieval, and error paths.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/auth', () => ({getAuth: vi.fn()}))

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, _code, data) => data), defineLambda: vi.fn()}))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn(() => 'mock-value')}))

vi.mock('@mantleframework/errors', () => {
  class UnexpectedError extends Error {
    statusCode = 500
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {UnexpectedError}
})

vi.mock('@mantleframework/observability', () => ({logInfo: vi.fn()}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({}))}
  }))

vi.mock('#db/client', () => ({getDrizzleClient: vi.fn()}))

vi.mock('#db/schema', () => ({accounts: {}, sessions: {}, users: {}, verification: {}}))

vi.mock('#types/api-schema', () => ({userLoginResponseSchema: {}}))

const {handler} = (await import('#lambdas/api/user/login.post.js')) as any
import {getAuth} from '@mantleframework/auth'

function createMockAuth(overrides: {signInSocialResult?: object; getSessionResult?: object | null} = {}) {
  const now = new Date()
  const signInSocialResult = overrides.signInSocialResult ??
    {
      redirect: false,
      token: 'test-token',
      user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
    }
  const getSessionResult = overrides.getSessionResult !== undefined
    ? overrides.getSessionResult
    : {
      session: {id: 'session-1', token: 'test-token', userId: 'user-1', expiresAt: new Date(Date.now() + 86400000), createdAt: now, updatedAt: now},
      user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
    }
  return {api: {signInSocial: vi.fn().mockResolvedValue(signInSocialResult), getSession: vi.fn().mockResolvedValue(getSessionResult)}}
}

describe('LoginUser Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw UnexpectedError when getSession returns null', async () => {
    const mockAuth = createMockAuth({getSessionResult: null})
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await expect(
      handler({
        event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
        context: {awsRequestId: 'req-1'},
        body: {idToken: 'test-id-token'}
      })
    ).rejects.toThrow('signInSocial succeeded but getSession returned null')
  })

  it('should throw when session object is missing', async () => {
    const mockAuth = createMockAuth({getSessionResult: {session: null, user: {id: 'user-1'}}})
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await expect(
      handler({
        event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
        context: {awsRequestId: 'req-1'},
        body: {idToken: 'test-id-token'}
      })
    ).rejects.toThrow('signInSocial succeeded but getSession returned null')
  })

  it('should return token, expiresAt, sessionId, and userId on success', async () => {
    const expiresAt = new Date(Date.now() + 86400000)
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'my-token',
        user: {id: 'user-42', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: new Date(), updatedAt: new Date()}
      },
      getSessionResult: {
        session: {id: 'session-99', token: 'my-token', userId: 'user-42', expiresAt, createdAt: new Date(), updatedAt: new Date()},
        user: {id: 'user-42', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: new Date(), updatedAt: new Date()}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    const result = await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(result).toEqual({token: 'my-token', expiresAt: expiresAt.toISOString(), sessionId: 'session-99', userId: 'user-42'})
  })

  it('should pass ipAddress and userAgent to signInSocial', async () => {
    const mockAuth = createMockAuth()
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '10.0.0.1'}}, headers: {'User-Agent': 'MediaDownloader/1.0'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(mockAuth.api.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({headers: {'user-agent': 'MediaDownloader/1.0', 'x-forwarded-for': '10.0.0.1'}})
    )
  })

  it('should handle missing sourceIp gracefully', async () => {
    const mockAuth = createMockAuth()
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(mockAuth.api.signInSocial).toHaveBeenCalledWith(expect.objectContaining({headers: expect.objectContaining({'x-forwarded-for': ''})}))
  })

  it('should propagate signInSocial errors', async () => {
    const mockAuth = createMockAuth()
    mockAuth.api.signInSocial.mockRejectedValue(new Error('Invalid ID token'))
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await expect(
      handler({
        event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
        context: {awsRequestId: 'req-1'},
        body: {idToken: 'invalid-token'}
      })
    ).rejects.toThrow('Invalid ID token')
  })
})
