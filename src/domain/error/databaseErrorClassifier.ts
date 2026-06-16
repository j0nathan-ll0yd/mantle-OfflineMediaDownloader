import type {ErrorClassification} from '#types/errorClassification'

/** Patterns indicating transient connection issues - retry with backoff */
const DB_TRANSIENT_PATTERNS = [
  'connection reset',
  'connection refused',
  'etimedout',
  'econnreset',
  'econnrefused',
  'too many connections',
  'connection pool exhausted',
  'connection terminated unexpectedly',
  'serialization failure',
  '40001' // PostgreSQL serialization failure code
]

/** Patterns indicating permanent schema/constraint errors - no retry */
const DB_PERMANENT_PATTERNS = [
  'syntax error',
  'duplicate key',
  'foreign key constraint',
  'check constraint',
  'not null violation',
  'unique constraint',
  '23505', // PostgreSQL unique violation
  '23503', // PostgreSQL foreign key violation
  '23502', // PostgreSQL not null violation
  '23514' // PostgreSQL check violation
]

/** Pattern pairs where both terms must be present (handles quoted names like 'relation "users" does not exist') */
const DB_PERMANENT_PAIRED_PATTERNS: Array<[string, string]> = [
  ['relation', 'does not exist'],
  ['column', 'does not exist']
]

/**
 * Classifies database-related errors to determine retry strategy.
 * Transient errors (connection issues) are retried; permanent errors (constraint violations) are not.
 *
 * @param error - The error to classify
 * @returns Classification with retry strategy
 */
export function classifyDatabaseError(error: Error): ErrorClassification {
  const message = error.message.toLowerCase()
  const errorName = error.name || error.constructor.name

  // Check for transient/connection issues - these are retryable
  if (DB_TRANSIENT_PATTERNS.some((p) => message.includes(p.toLowerCase()))) {
    return {
      category: 'transient',
      retryable: true,
      retryDelayMs: 500,
      maxRetries: 3,
      reason: `Transient database error: ${message.slice(0, 100)}`,
      createIssue: false
    }
  }

  // Check for permanent schema/constraint errors - these need developer attention
  const isPermanent = DB_PERMANENT_PATTERNS.some((p) => message.includes(p.toLowerCase())) ||
    DB_PERMANENT_PAIRED_PATTERNS.some(([prefix, suffix]) => message.includes(prefix) && message.includes(suffix))

  if (isPermanent) {
    return {
      category: 'permanent',
      retryable: false,
      maxRetries: 0,
      reason: `Database constraint error: ${message.slice(0, 100)}`,
      createIssue: true,
      issuePriority: 'high'
    }
  }

  // Check error name for QueryError (from our Drizzle wrapper)
  if (errorName === 'QueryError') {
    // If it's a QueryError but not matching known patterns, treat as transient
    return {
      category: 'transient',
      retryable: true,
      retryDelayMs: 1000,
      maxRetries: 2,
      reason: `Unknown database error: ${message.slice(0, 100)}`,
      createIssue: false
    }
  }

  // Default: treat unknown database errors as transient (give benefit of doubt)
  return {
    category: 'transient',
    retryable: true,
    retryDelayMs: 1000,
    maxRetries: 2,
    reason: `Unknown database error: ${message.slice(0, 100)}`,
    createIssue: false
  }
}
