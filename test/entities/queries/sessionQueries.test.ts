/**
 * Unit tests for Session Queries
 *
 * Tests mutable logic: null coalescing (result[0] ?? null)
 * and non-null assertions on returning().
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockAccount, createMockSession, createMockVerification} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema',
  () => ({
    sessions: {id: 'id', token: 'token', userId: 'userId', expiresAt: 'expiresAt'},
    accounts: {id: 'id', userId: 'userId'},
    verification: {id: 'id', identifier: 'identifier', expiresAt: 'expiresAt'}
  }))
vi.mock('#db/zodSchemas',
  () => ({
    sessionInsertSchema: {parse: vi.fn((v: unknown) => v)},
    sessionUpdateSchema: {partial: vi.fn(() => ({parse: vi.fn((v: unknown) => v)}))},
    accountInsertSchema: {parse: vi.fn((v: unknown) => v)},
    verificationInsertSchema: {parse: vi.fn((v: unknown) => v)}
  }))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm',
  () => ({eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition'), lt: vi.fn((_col: unknown, _val: unknown) => 'lt-condition')}))

const {
  getSession,
  getSessionByToken,
  getSessionsByUserId,
  createSession,
  updateSession,
  deleteSession,
  deleteSessionsByUserId,
  deleteExpiredSessions,
  getAccount,
  getAccountsByUserId,
  createAccount,
  deleteAccount,
  deleteAccountsByUserId,
  getVerificationByIdentifier,
  createVerification,
  deleteVerification,
  deleteExpiredVerifications
} = await import('#entities/queries/sessionQueries')

describe('Session Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Session Operations

  describe('getSession', () => {
    it('should return session when found', async () => {
      const mockSession = createMockSession()
      mockDb._setSelectResult([mockSession])

      const result = await getSession('session-1')

      expect(result).toEqual(mockSession)
    })

    it('should return null when session not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getSession('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getSessionByToken', () => {
    it('should return session when found by token', async () => {
      const mockSession = createMockSession()
      mockDb._setSelectResult([mockSession])

      const result = await getSessionByToken('valid-token')

      expect(result).toEqual(mockSession)
    })

    it('should return null when token not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getSessionByToken('invalid-token')

      expect(result).toBeNull()
    })
  })

  describe('getSessionsByUserId', () => {
    it('should return sessions for user', async () => {
      const sessions = [createMockSession(), createMockSession({id: 'session-2'})]
      mockDb._setSelectResult(sessions)

      const result = await getSessionsByUserId('user-1')

      expect(result).toEqual(sessions)
    })

    it('should return empty array when user has no sessions', async () => {
      mockDb._setSelectResult([])

      const result = await getSessionsByUserId('user-1')

      expect(result).toEqual([])
    })
  })

  describe('createSession', () => {
    it('should return the created session', async () => {
      const mockSession = createMockSession()
      mockDb._setInsertResult([mockSession])

      const result = await createSession({userId: 'user-1', token: 'token-1', expiresAt: new Date()})

      expect(result).toEqual(mockSession)
    })
  })

  describe('updateSession', () => {
    it('should return the updated session', async () => {
      const mockSession = createMockSession()
      mockDb._setUpdateResult([mockSession])

      const result = await updateSession('session-1', {token: 'new-token'})

      expect(result).toEqual(mockSession)
    })
  })

  describe('deleteSession', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteSession('session-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteSessionsByUserId', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteSessionsByUserId('user-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteExpiredSessions', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteExpiredSessions()).resolves.toBeUndefined()
    })
  })

  // Account Operations

  describe('getAccount', () => {
    it('should return account when found', async () => {
      const mockAccount = createMockAccount()
      mockDb._setSelectResult([mockAccount])

      const result = await getAccount('account-1')

      expect(result).toEqual(mockAccount)
    })

    it('should return null when account not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getAccount('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getAccountsByUserId', () => {
    it('should return accounts for user', async () => {
      const accounts = [createMockAccount()]
      mockDb._setSelectResult(accounts)

      const result = await getAccountsByUserId('user-1')

      expect(result).toEqual(accounts)
    })
  })

  describe('createAccount', () => {
    it('should return the created account', async () => {
      const mockAccount = createMockAccount()
      mockDb._setInsertResult([mockAccount])

      const result = await createAccount({userId: 'user-1', accountId: 'apple-1', providerId: 'apple'})

      expect(result).toEqual(mockAccount)
    })
  })

  describe('deleteAccount', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteAccount('account-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteAccountsByUserId', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteAccountsByUserId('user-1')).resolves.toBeUndefined()
    })
  })

  // Verification Operations

  describe('getVerificationByIdentifier', () => {
    it('should return verification when found', async () => {
      const mockVerification = createMockVerification()
      mockDb._setSelectResult([mockVerification])

      const result = await getVerificationByIdentifier('test@example.com')

      expect(result).toEqual(mockVerification)
    })

    it('should return null when verification not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getVerificationByIdentifier('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('createVerification', () => {
    it('should return the created verification', async () => {
      const mockVerification = createMockVerification()
      mockDb._setInsertResult([mockVerification])

      const result = await createVerification({identifier: 'test@example.com', value: 'token-abc', expiresAt: new Date()})

      expect(result).toEqual(mockVerification)
    })
  })

  describe('deleteVerification', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteVerification('verification-1')).resolves.toBeUndefined()
    })
  })

  describe('deleteExpiredVerifications', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])
      await expect(deleteExpiredVerifications()).resolves.toBeUndefined()
    })
  })
})
