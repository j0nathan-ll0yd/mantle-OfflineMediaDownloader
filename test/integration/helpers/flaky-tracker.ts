/**
 * Flaky Test Tracker
 *
 * Utilities for tracking and logging flaky tests that required retries.
 * Used to identify tests that need investigation even when they eventually pass.
 *
 * In CI, this logs warnings when tests pass only after retry, helping identify
 * tests that should be fixed rather than just masked by retry mechanisms.
 */

/** Store for tracking retried tests in the current run */
const retriedTests: Array<{testName: string; attempt: number; duration: number}> = []

/**
 * Log when a test required a retry to pass.
 * Call this from test setup/teardown hooks when retry is detected.
 *
 * @param testName - Full name of the test (suite + test name)
 * @param attempt - The attempt number that succeeded (2 = first retry, 3 = second retry)
 * @param durationMs - How long the successful attempt took
 */
export function logFlakyTest(testName: string, attempt: number, durationMs = 0): void {
  if (!(attempt > 1)) {
    return
  }

  retriedTests.push({testName, attempt, duration: durationMs})

  // Always log flaky tests as warnings
  console.warn(`[FLAKY] Test "${testName}" passed on attempt ${attempt}${durationMs ? ` (${durationMs}ms)` : ''}`)
}

/**
 * Get all tests that required retries in this run.
 * Useful for generating summary reports.
 */
export function getFlakyTestsReport(): Array<{testName: string; attempt: number; duration: number}> {
  return [...retriedTests]
}

/**
 * Clear the flaky test tracker.
 * Call this in globalTeardown if needed.
 */
export function clearFlakyTests(): void {
  retriedTests.length = 0
}

/**
 * Generate a summary string of all flaky tests.
 * Returns empty string if no tests were flaky.
 */
export function generateFlakySummary(): string {
  if (retriedTests.length === 0) {
    return ''
  }

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    `⚠️  FLAKY TESTS DETECTED: ${retriedTests.length} test(s) required retries`,
    '═══════════════════════════════════════════════════════════════════════════════',
    ''
  ]

  for (const test of retriedTests) {
    lines.push(`  • ${test.testName}`)
    lines.push(`    └─ Passed on attempt ${test.attempt}${test.duration ? ` (${test.duration}ms)` : ''}`)
  }

  lines.push('')
  lines.push('These tests should be investigated to fix the root cause of flakiness.')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('')

  return lines.join('\n')
}

/**
 * Print the flaky test summary to console if there were any flaky tests.
 * Call this at the end of the test run (e.g., in globalTeardown).
 */
export function printFlakySummary(): void {
  const summary = generateFlakySummary()
  if (summary) {
    console.log(summary)
  }
}

/**
 * Check if any tests were flaky in this run.
 */
export function hadFlakyTests(): boolean {
  return retriedTests.length > 0
}

/**
 * Get the count of flaky tests.
 */
export function getFlakyTestCount(): number {
  return retriedTests.length
}

/**
 * Export metrics data for CI integration.
 * Returns data compatible with ci-metrics.ts.
 */
export function exportMetricsData(): {flakyTests: number; retriedTests: string[]} {
  return {flakyTests: retriedTests.length, retriedTests: retriedTests.map((t) => `${t.testName} (attempt ${t.attempt})`)}
}
