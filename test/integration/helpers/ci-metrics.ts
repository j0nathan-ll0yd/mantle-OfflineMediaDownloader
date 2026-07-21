/**
 * CI Metrics Helper
 *
 * Exports test metrics in JSON format for CI pipeline consumption.
 * Used for tracking test stability, duration, and flaky test patterns.
 */

import {promises as fs} from 'fs'
import * as path from 'path'

/**
 * Test metrics structure for CI reporting
 */
export interface TestMetrics {
  /** Total number of tests executed */
  totalTests: number
  /** Number of tests that passed */
  passedTests: number
  /** Number of tests that failed */
  failedTests: number
  /** Number of tests that required retries to pass */
  flakyTests: number
  /** Names of tests that were retried */
  retriedTests: string[]
  /** Total test run duration in milliseconds */
  durationMs: number
  /** Timestamp when metrics were collected */
  timestamp: string
  /** CI attempt number (1 = first try, 2 = retry) */
  ciAttempt: number
  /** Environment info */
  environment: {ci: boolean; nodeVersion: string; platform: string}
}

/**
 * Write test metrics to a JSON file for CI consumption.
 * Only writes if running in CI environment.
 *
 * @param metrics - Test metrics to export
 * @param outputPath - Path to write metrics file (default: test-results/metrics.json)
 */
export async function writeMetricsFile(metrics: TestMetrics, outputPath = 'test-results/metrics.json'): Promise<void> {
  // Always write metrics in CI, optionally in local development
  const shouldWrite = process.env.CI || process.env.WRITE_TEST_METRICS

  if (!shouldWrite) {
    return
  }

  const dir = path.dirname(outputPath)
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(outputPath, JSON.stringify(metrics, null, 2))
}

/**
 * Create metrics object from test run data.
 *
 * @param data - Test run data
 * @returns Formatted test metrics
 */
export function createMetrics(
  data: {totalTests: number; passedTests: number; failedTests: number; flakyTests: number; retriedTests: string[]; durationMs: number; ciAttempt?: number}
): TestMetrics {
  return {
    totalTests: data.totalTests,
    passedTests: data.passedTests,
    failedTests: data.failedTests,
    flakyTests: data.flakyTests,
    retriedTests: data.retriedTests,
    durationMs: data.durationMs,
    timestamp: new Date().toISOString(),
    ciAttempt: data.ciAttempt ?? (process.env.CI_ATTEMPT ? Number(process.env.CI_ATTEMPT) : 1),
    environment: {ci: !!process.env.CI, nodeVersion: process.version, platform: process.platform}
  }
}

/**
 * Read metrics from a previous run.
 *
 * @param inputPath - Path to metrics file
 * @returns Metrics object or null if file doesn't exist
 */
export async function readMetricsFile(inputPath = 'test-results/metrics.json'): Promise<TestMetrics | null> {
  try {
    const content = await fs.readFile(inputPath, 'utf-8')
    return JSON.parse(content) as TestMetrics
  } catch {
    return null
  }
}

/**
 * Format metrics for GitHub Actions job summary.
 *
 * @param metrics - Test metrics
 * @returns Markdown-formatted summary
 */
export function formatMetricsForGitHub(metrics: TestMetrics): string {
  const lines = [
    '## Test Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Tests | ${metrics.totalTests} |`,
    `| Passed | ${metrics.passedTests} |`,
    `| Failed | ${metrics.failedTests} |`,
    `| Duration | ${(metrics.durationMs / 1000).toFixed(2)}s |`,
    `| CI Attempt | ${metrics.ciAttempt} |`
  ]

  if (metrics.flakyTests > 0) {
    lines.push('')
    lines.push(`### Flaky Tests (${metrics.flakyTests})`)
    lines.push('')
    for (const test of metrics.retriedTests) {
      lines.push(`- ${test}`)
    }
  }

  return lines.join('\n')
}
