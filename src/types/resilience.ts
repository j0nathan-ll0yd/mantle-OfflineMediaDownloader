/**
 * Resilience Pattern Types
 *
 * Type definitions for resilience patterns used throughout the application,
 * including circuit breakers, retry configurations, and failure handling.
 *
 * @see src/lib/system/circuitBreaker.ts for circuit breaker implementation
 * @see src/lib/system/retry.ts for retry utilities
 */
import type {Result} from '@j0nathan-ll0yd/core'

/**
 * Circuit breaker states
 *
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failures exceeded threshold, requests rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/**
 * Configuration options for the circuit breaker
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number
  /** Time in ms to wait before attempting recovery (default: 60000) */
  resetTimeout: number
  /** Number of successful calls in HALF_OPEN to close circuit (default: 2) */
  successThreshold: number
  /** Name for logging and metrics */
  name: string
}

/**
 * Success payload when an APNS endpoint is cleaned up
 */
export interface EndpointCleaned {
  /** The device ID that was cleaned up */
  deviceId: string
  /** The SNS endpoint ARN that was cleaned up */
  endpointArn: string
}

/**
 * Error payload when an APNS endpoint cleanup fails
 */
export interface EndpointCleanupError {
  /** The device ID that failed cleanup */
  deviceId: string
  /** The SNS endpoint ARN that failed cleanup */
  endpointArn: string
  /** Error message describing the failure */
  error: string
}

/**
 * Result of cleaning up a disabled APNS endpoint
 */
export type EndpointCleanupResult = Result<EndpointCleaned, EndpointCleanupError>
