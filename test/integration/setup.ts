/**
 * Integration Test Setup
 *
 * Configures the test environment for LocalStack integration tests.
 * This file runs before all integration tests via setupFiles in vitest.integration.config.mts
 */

import {beforeAll} from 'vitest'
import {getTestDbAsync, getWorkerSchema} from './helpers/postgres-helpers'
import {logIsolationConfig, validateSchemaIsolation} from './helpers/isolation-validator'
import {POLLING, TIMEOUTS} from './helpers/timeout-config'

/**
 * Ensure USE_LOCALSTACK is set
 * This triggers all vendor wrappers to use LocalStack clients instead of production AWS
 */
process.env.USE_LOCALSTACK = 'true'

/**
 * Set TEST_DATABASE_SCHEMA for \@mantleframework/database
 * This ensures getDrizzleClient() uses the same worker-isolated schema
 * as the test's getTestDbAsync() connection
 */
process.env.TEST_DATABASE_SCHEMA = getWorkerSchema()

/**
 * Set AWS region for LocalStack
 * Match production region (us-west-2) for consistency
 */
process.env.AWS_REGION = 'us-west-2'

/**
 * Suppress Powertools metrics EMF JSON output during tests
 * Without this, CloudWatch Metrics JSON is emitted even with LOG_LEVEL=SILENT
 */
process.env.POWERTOOLS_METRICS_DISABLED = 'true'

/**
 * Set LOG_LEVEL to SILENT by default for integration tests
 * This suppresses fixture markers, LocalStack health logs, and Powertools logs
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'SILENT'

/**
 * Wait for LocalStack to be ready
 * Checks LocalStack health endpoint before running tests.
 * Uses exponential backoff with environment-aware timeouts.
 */
async function waitForLocalStack(): Promise<void> {
  const localstackUrl = `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/_localstack/health`
  const startTime = Date.now()
  let delay: number = POLLING.initialDelay
  let attempt = 0

  while (Date.now() - startTime < TIMEOUTS.serviceReady) {
    attempt++
    try {
      const response = await fetch(localstackUrl)
      if (response.ok) {
        const health = await response.json()
        if (process.env.LOG_LEVEL !== 'SILENT') {
          console.log(`LocalStack ready after ${attempt} attempt(s):`, JSON.stringify(health, null, 2))
        }
        return
      }
    } catch {
      // LocalStack not ready yet, continue retrying
    }

    // Exponential backoff with jitter
    const jitter = Math.random() * POLLING.jitterFactor * delay
    const nextDelay = Math.min(delay + jitter, POLLING.maxDelay)

    if (Date.now() - startTime + nextDelay >= TIMEOUTS.serviceReady) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, nextDelay))
    delay = Math.min(delay * 2, POLLING.maxDelay)
  }

  const elapsed = Date.now() - startTime
  throw new Error(`LocalStack not responding after ${elapsed}ms (${attempt} attempts). ` + 'Ensure LocalStack is running with: pnpm run localstack:start')
}

/**
 * Run health check before tests and initialize database connection
 * - Log isolation configuration for debugging
 * - LocalStack health check (skipped in CI where service is pre-verified)
 * - Initialize database connection with correct search_path for worker isolation
 * - Validate schema isolation to catch configuration errors early
 */
beforeAll(async () => {
  // Log isolation config for debugging CI issues
  logIsolationConfig()

  if (!process.env.CI) {
    await waitForLocalStack()
  }

  // Initialize database connection with worker-specific search_path
  // This ensures all postgres-helpers operations use the correct schema
  const db = await getTestDbAsync()

  // Validate schema isolation - fail fast if misconfigured
  const schema = await validateSchemaIsolation(db)
  if (process.env.LOG_LEVEL !== 'SILENT') {
    console.log(`[setup] Schema isolation validated: ${schema}`)
  }
})
