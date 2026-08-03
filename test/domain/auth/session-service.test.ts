/**
 * Unit tests for Better Auth Helper Functions
 *
 * Tests session management, validation, and token generation.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {UnauthorizedError} from '@j0nathan-ll0yd/errors'

// Mock native Drizzle query functions
vi.mock('#entities/queries', () => ({getSessionByToken: vi.fn(), updateSession: vi.fn()}))

// Import after mocking
const {validateSessionToken} = await import('#domain/auth/sessionService.js')
import {getSessionByToken, updateSession} from '#entities/queries'

/**
 * Mock session data overrides for testing
 */
interface MockSessionOverrides {
  id?: string
  userId?: string
  token?: string
  expiresAt?: Date
  ipAddress?: string
  userAgent?: string
  createdAt?: Date
  updatedAt?: Date
}

/**
 * Helper to create mock session objects with sensible defaults
 * Now uses Date objects for timestamps to match Better Auth schema.
 */
function createMockSession(overrides?: MockSessionOverrides) {
  const now = new Date()
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  return {
    id: 'session-123',
    userId: 'user-123',
    token: 'valid-token',
    expiresAt: thirtyDaysFromNow, // 30 days future
    createdAt: now,
    updatedAt: now,
    ipAddress: null as string | null,
    userAgent: null as string | null,
    ...overrides
  }
}

describe('Better Auth Helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateSession).mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof updateSession>>)
  })

  describe('validateSessionToken', () => {
    it('should validate a valid session token', async () => {
      const mockSession = createMockSession()

      // Mock getSessionByToken
      vi.mocked(getSessionByToken).mockResolvedValue(mockSession)

      const result = await validateSessionToken('valid-token')

      expect(result).toEqual({userId: 'user-123', sessionId: 'session-123', expiresAt: mockSession.expiresAt.getTime()})

      // Should update lastActiveAt
      expect(vi.mocked(updateSession)).toHaveBeenCalledWith('session-123', expect.objectContaining({updatedAt: expect.any(Date)}))
    })

    it('should throw UnauthorizedError for non-existent session', async () => {
      vi.mocked(getSessionByToken).mockResolvedValue(null)

      await expect(validateSessionToken('invalid-token')).rejects.toThrow(UnauthorizedError)
      await expect(validateSessionToken('invalid-token')).rejects.toThrow('Invalid session token')
    })

    it('should throw UnauthorizedError for expired session', async () => {
      const now = new Date()
      const mockSession = createMockSession({
        token: 'expired-token',
        expiresAt: new Date(now.getTime() - 1000), // Expired 1 second ago
        createdAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000)
      })

      vi.mocked(getSessionByToken).mockResolvedValue(mockSession)

      await expect(validateSessionToken('expired-token')).rejects.toThrow(UnauthorizedError)
      await expect(validateSessionToken('expired-token')).rejects.toThrow('Session expired')
    })
  })
})
