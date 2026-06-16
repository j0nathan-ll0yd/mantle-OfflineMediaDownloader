import {createHash} from 'crypto'
import type {FingerprintInput, FingerprintResult} from '#types/errorFingerprint'

export type { FingerprintInput, FingerprintResult } from '#types/errorFingerprint'

/**
 * Normalizes a stack frame by removing line/column numbers and file paths.
 * This ensures the same logical error location produces the same fingerprint.
 */
function normalizeStackFrame(frame: string): string {
  // Remove line:column patterns like :123:45 or :123
  let normalized = frame.replaceAll(/:\d+(?::\d+)?/g, '')

  // Remove absolute paths, keep only filename
  normalized = normalized.replace(/.*[/\\]([^/\\]+)$/, '$1')

  // Remove common noise patterns
  normalized = normalized.replace(/\s+at\s+/, '')

  return normalized.trim()
}

/**
 * Extracts the first meaningful stack frame from an error.
 * Skips internal frames (node internals, node_modules).
 */
function extractFirstStackFrame(error: Error): string | undefined {
  if (!error.stack) {
    return undefined
  }

  const lines = error.stack.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Skip the error message line
    if (!trimmed.startsWith('at ')) {
      continue
    }
    // Skip node internals
    if (trimmed.includes('node:internal')) {
      continue
    }
    // Skip node_modules
    if (trimmed.includes('node_modules')) {
      continue
    }
    // Return the first app frame
    return normalizeStackFrame(trimmed)
  }

  // Fallback: return first stack line if no app frame found
  const firstAt = lines.find((l) => l.trim().startsWith('at '))
  return firstAt ? normalizeStackFrame(firstAt) : undefined
}

/**
 * Generates a stable fingerprint from error characteristics.
 * Same logical error will produce the same fingerprint regardless of:
 * - Line number changes (from code refactoring)
 * - Timestamp differences
 * - Request-specific data
 */
export function generateErrorFingerprint(input: FingerprintInput): FingerprintResult {
  const components: string[] = []

  // Always include error type
  components.push(`type:${input.errorType}`)

  // Include error code if present
  if (input.errorCode) {
    components.push(`code:${input.errorCode}`)
  }

  // Include normalized stack frame if present
  if (input.stackFrame) {
    components.push(`frame:${input.stackFrame}`)
  }

  // Include lambda name if present
  if (input.lambdaName) {
    components.push(`lambda:${input.lambdaName}`)
  }

  // Include additional context if present
  if (input.context) {
    components.push(`ctx:${input.context}`)
  }

  const hashInput = components.join('|')
  const hash = createHash('sha256').update(hashInput).digest('hex')

  return {fingerprint: `error-fp-${hash.slice(0, 12)}`, summary: components.join(', ')}
}

/**
 * Extracts fingerprint input from an error object.
 * Handles both standard Error and custom errors with codes.
 */
export function extractFingerprintFromError(error: Error, lambdaName?: string, context?: string): FingerprintInput {
  const errorType = error.name || error.constructor.name || 'Error'

  // Try to extract error code from various sources
  let errorCode: string | undefined
  if ('code' in error && typeof error.code === 'string') {
    errorCode = error.code
  } else if ('statusCode' in error && typeof error.statusCode === 'number') {
    errorCode = String(error.statusCode)
  }

  // Extract and normalize the first meaningful stack frame
  const stackFrame = extractFirstStackFrame(error)

  return {errorType, errorCode, stackFrame, lambdaName, context}
}
