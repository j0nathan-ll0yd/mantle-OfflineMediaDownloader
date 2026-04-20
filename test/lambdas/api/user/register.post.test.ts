/**
 * Unit tests for RegisterUser Lambda (POST /user/register)
 *
 * Tests sign-in flow, session validation, new user name update, and error paths.
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

vi.mock('@mantleframework/observability', () => ({logInfo: vi.fn(), metrics: {addMetric: vi.fn()}, MetricUnit: {Count: 'Count'}}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({optional: vi.fn(() => ({}))}))}
  }))

vi.mock('#db/client', () => ({getDrizzleClient: vi.fn()}))

vi.mock('#db/schema', () => ({accounts: {}, sessions: {}, users: {}, verification: {}}))

vi.mock('#entities/queries', () => ({updateUser: vi.fn()}))

vi.mock('#types/api-schema', () => ({userRegistrationResponseSchema: {}}))

const {handler} = (await import('#lambdas/api/user/register.post.js')) as any
import {getAuth} from '@mantleframework/auth'
import {updateUser} from '#entities/queries'
import {metrics} from '@mantleframework/observability'

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

describe('RegisterUser Lambda', () => {
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

  it('should throw when session is missing from result', async () => {
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

  it('should update user name for new users with firstName and lastName', async () => {
    const now = new Date()
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'test-token',
        user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)
    vi.mocked(updateUser).mockResolvedValue(undefined as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token', firstName: 'John', lastName: 'Doe'}
    })

    expect(updateUser).toHaveBeenCalledWith('user-1', {name: 'John Doe', firstName: 'John', lastName: 'Doe'})
  })

  it('should not update user name when no name fields provided for new user', async () => {
    const now = new Date()
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'test-token',
        user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(updateUser).not.toHaveBeenCalled()
  })

  it('should not update user name for existing users', async () => {
    const oldDate = new Date(Date.now() - 60000) // 60 seconds ago
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'test-token',
        user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: oldDate, updatedAt: oldDate}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token', firstName: 'John', lastName: 'Doe'}
    })

    expect(updateUser).not.toHaveBeenCalled()
  })

  it('should emit NewUserRegistration metric for new users', async () => {
    const now = new Date()
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'test-token',
        user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(metrics.addMetric).toHaveBeenCalledWith('NewUserRegistration', 'Count', 1)
  })

  it('should return token, expiresAt, sessionId, and userId', async () => {
    const expiresAt = new Date(Date.now() + 86400000)
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'my-token',
        user: {id: 'user-42', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: new Date(Date.now() - 60000), updatedAt: new Date()}
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

  it('should handle firstName only (no lastName)', async () => {
    const now = new Date()
    const mockAuth = createMockAuth({
      signInSocialResult: {
        redirect: false,
        token: 'test-token',
        user: {id: 'user-1', email: 'test@example.com', emailVerified: true, name: 'Test', createdAt: now, updatedAt: now}
      }
    })
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)
    vi.mocked(updateUser).mockResolvedValue(undefined as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {'User-Agent': 'test'}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token', firstName: 'John'}
    })

    expect(updateUser).toHaveBeenCalledWith('user-1', {name: 'John', firstName: 'John', lastName: ''})
  })

  it('should use empty string for User-Agent when missing', async () => {
    const mockAuth = createMockAuth()
    vi.mocked(getAuth).mockResolvedValue(mockAuth as never)

    await handler({
      event: {requestContext: {identity: {sourceIp: '1.2.3.4'}}, headers: {}},
      context: {awsRequestId: 'req-1'},
      body: {idToken: 'test-id-token'}
    })

    expect(mockAuth.api.signInSocial).toHaveBeenCalledWith(expect.objectContaining({headers: expect.objectContaining({'user-agent': ''})}))
  })
})
