import type {ErrorClassification} from '#types/errorClassification'

/** Patterns indicating rate limiting - retry with longer delay */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'throttl', 'quota exceeded', 'request limit']

/** Patterns indicating transient server errors - retry with backoff */
const TRANSIENT_PATTERNS = [
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'econnreset',
  'etimedout',
  'econnrefused',
  'network error',
  'socket hang up'
]

/** Patterns indicating permanent client errors - no retry */
const PERMANENT_PATTERNS = ['400', '401', '403', '404', 'not found', 'unauthorized', 'forbidden', 'bad request', 'invalid']

/**
 * Classifies external API errors to determine retry strategy.
 * Rate limits get longer delays; server errors are retried; client errors are not.
 *
 * @param error - The error to classify
 * @param serviceName - Name of the external service for context
 * @returns Classification with retry strategy
 */
export function classifyExternalApiError(error: Error, serviceName: string): ErrorClassification {
  const message = error.message.toLowerCase()

  // Check rate limiting first - needs special handling with longer delay
  if (RATE_LIMIT_PATTERNS.some((p) => message.includes(p))) {
    return {
      category: 'rate_limited',
      retryable: true,
      retryDelayMs: 60000, // 1 minute for rate limits
      maxRetries: 3,
      reason: `${serviceName} rate limit: ${message.slice(0, 100)}`,
      createIssue: false
    }
  }

  // Check transient server errors - these are retryable
  if (TRANSIENT_PATTERNS.some((p) => message.includes(p))) {
    return {
      category: 'transient',
      retryable: true,
      retryDelayMs: 5000,
      maxRetries: 3,
      reason: `${serviceName} transient error: ${message.slice(0, 100)}`,
      createIssue: false
    }
  }

  // Check permanent client errors - these are not retryable
  if (PERMANENT_PATTERNS.some((p) => message.includes(p))) {
    return {
      category: 'permanent',
      retryable: false,
      maxRetries: 0,
      reason: `${serviceName} client error: ${message.slice(0, 100)}`,
      createIssue: true,
      issuePriority: 'normal'
    }
  }

  // Default: treat unknown errors as permanent (safer to not retry blindly)
  return {
    category: 'permanent',
    retryable: false,
    maxRetries: 0,
    reason: `${serviceName} error: ${message.slice(0, 100)}`,
    createIssue: true,
    issuePriority: 'normal'
  }
}
