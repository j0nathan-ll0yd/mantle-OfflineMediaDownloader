import type {ErrorClassification} from '#types/errorClassification'

/** Patterns indicating transient network/connection issues */
const AUTH_TRANSIENT_PATTERNS = ['network error', 'econnreset', 'etimedout', 'econnrefused', 'service unavailable', '503', '502', '504']

/** Patterns indicating expired tokens or sessions */
const AUTH_EXPIRED_PATTERNS = ['token expired', 'session expired', 'jwt expired', 'invalid_grant', 'token is expired', 'refresh token expired']

/** Patterns indicating invalid credentials */
const AUTH_INVALID_PATTERNS = ['invalid credentials', 'invalid password', 'user not found', 'invalid token', 'unauthorized', 'invalid signature']

/**
 * Classifies authentication-related errors to determine retry strategy.
 * Auth errors are typically not retryable as they require user action.
 *
 * @param error - The error to classify
 * @returns Classification with retry strategy
 */
export function classifyAuthError(error: Error): ErrorClassification {
  const message = error.message.toLowerCase()

  // Check for expired tokens - user needs to re-authenticate
  if (AUTH_EXPIRED_PATTERNS.some((p) => message.includes(p))) {
    return {category: 'auth_expired', retryable: false, maxRetries: 0, reason: 'Authentication token or session has expired', createIssue: false}
  }

  // Check for transient network issues
  if (AUTH_TRANSIENT_PATTERNS.some((p) => message.includes(p))) {
    return {
      category: 'transient',
      retryable: true,
      retryDelayMs: 1000,
      maxRetries: 3,
      reason: `Transient auth service error: ${message.slice(0, 100)}`,
      createIssue: false
    }
  }

  // Check for invalid credentials
  if (AUTH_INVALID_PATTERNS.some((p) => message.includes(p))) {
    return {category: 'auth_invalid', retryable: false, maxRetries: 0, reason: `Invalid authentication: ${message.slice(0, 100)}`, createIssue: false}
  }

  // Default: treat as invalid auth (user needs to take action)
  return {category: 'auth_invalid', retryable: false, maxRetries: 0, reason: `Auth failure: ${message.slice(0, 100)}`, createIssue: false}
}
