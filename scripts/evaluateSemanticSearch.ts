import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {search} from './searchCodebase.js'

interface SearchResult {
  filePath: string
  name: string
  type: string
  startLine: number
  _distance: number
  adjustedDistance?: number
}

interface QueryEvaluation {
  query: string
  expectedFiles: string[]
  results: Array<{file: string; name: string; type: string; distance: number; relevant: boolean}>
  metrics: {
    precisionAt5: number
    firstRelevantRank: number
    coverage: number
    avgDistanceRelevant: number
    avgDistanceIrrelevant: number
    distanceGap: number
  }
}

interface EvaluationReport {
  timestamp: string
  totalQueries: number
  averagePrecisionAt5: number
  averageFirstRelevantRank: number
  averageCoverage: number
  queries: QueryEvaluation[]
}

/**
 * Test queries with expected relevant file patterns
 */
const TEST_QUERIES: Array<{query: string; expectedPatterns: string[]}> = [
  {
    query: 'error handling patterns',
    expectedPatterns: [
      'src/lib/system/errors.ts',
      'src/lib/lambda/responses.ts',
      'src/lib/lambda/middleware/api.ts',
      'errorClassifier.ts'
    ]
  },
  {
    query: 'authentication flow',
    expectedPatterns: [
      'ApiGatewayAuthorizer',
      'sessionService.ts',
      'LoginUser',
      'RegisterUser',
      'RefreshToken',
      'BetterAuth'
    ]
  },
  {
    query: 'S3 upload logic',
    expectedPatterns: [
      'StartFileUpload',
      'src/lib/vendor/AWS/S3.ts',
      'YouTube.ts',
      'S3ObjectCreated'
    ]
  },
  {
    query: 'device registration',
    expectedPatterns: [
      'RegisterDevice',
      'device-queries.ts',
      'deviceService.ts',
      'Device'
    ]
  },
  {
    query: 'cascade deletion',
    expectedPatterns: [
      'UserDelete',
      'relationship-queries.ts',
      'Promise.allSettled',
      'deleteUser'
    ]
  },
  {
    query: 'push notification',
    expectedPatterns: [
      'SendPushNotification',
      'deviceService.ts',
      'APNS',
      'notification'
    ]
  },
  {
    query: 'video download retry',
    expectedPatterns: [
      'StartFileUpload',
      'errorClassifier.ts',
      'retry.ts',
      'VideoError'
    ]
  },
  {
    query: 'API response format',
    expectedPatterns: [
      'src/lib/lambda/responses.ts',
      'src/lib/lambda/middleware/api.ts',
      'formatResponse',
      'buildResponse'
    ]
  },
  {
    query: 'user session management',
    expectedPatterns: [
      'sessionService.ts',
      'session-queries.ts',
      'Session',
      'validateSessionToken'
    ]
  },
  {
    query: 'file entity queries',
    expectedPatterns: [
      'file-queries.ts',
      'relationship-queries.ts',
      'getFile',
      'UserFiles'
    ]
  }
]

/**
 * Check if a file path matches any of the expected patterns
 */
function isRelevant(filePath: string, name: string, expectedPatterns: string[]): boolean {
  const fullPath = `${filePath}:${name}`
  return expectedPatterns.some((pattern) => fullPath.toLowerCase().includes(pattern.toLowerCase()))
}

/**
 * Calculate evaluation metrics for a query
 */
function calculateMetrics(results: QueryEvaluation['results'], expectedPatterns: string[]): QueryEvaluation['metrics'] {
  const relevantResults = results.filter((r) => r.relevant)
  const irrelevantResults = results.filter((r) => !r.relevant)

  // Precision@5: proportion of relevant results in top 5
  const precisionAt5 = relevantResults.length / Math.min(results.length, 5)

  // First relevant rank (1-indexed, 0 if none found)
  const firstRelevantIndex = results.findIndex((r) => r.relevant)
  const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : 0

  // Coverage: how many expected patterns were found
  const foundPatterns = expectedPatterns.filter((pattern) => results.some((r) => `${r.file}:${r.name}`.toLowerCase().includes(pattern.toLowerCase())))
  const coverage = foundPatterns.length / expectedPatterns.length

  // Average distances
  const avgDistanceRelevant = relevantResults.length > 0
    ? relevantResults.reduce((sum, r) => sum + r.distance, 0) / relevantResults.length
    : 0

  const avgDistanceIrrelevant = irrelevantResults.length > 0
    ? irrelevantResults.reduce((sum, r) => sum + r.distance, 0) / irrelevantResults.length
    : 0

  // Distance gap between relevant and irrelevant (higher is better)
  const distanceGap = avgDistanceIrrelevant - avgDistanceRelevant

  return {precisionAt5, firstRelevantRank, coverage, avgDistanceRelevant, avgDistanceIrrelevant, distanceGap}
}

/**
 * Run semantic search using the improved search function
 */
async function runSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const results = await search(query, {limit, expand: true})
  return results.map((r) => ({
    filePath: r.filePath,
    name: r.name,
    type: r.type,
    startLine: r.startLine,
    _distance: r._distance,
    adjustedDistance: r.adjustedDistance
  }))
}

/**
 * Evaluate a single query
 */
async function evaluateQuery(query: string, expectedPatterns: string[], limit = 5): Promise<QueryEvaluation> {
  const searchResults = await runSearch(query, limit)

  const results = searchResults.map((r) => ({
    file: r.filePath,
    name: r.name,
    type: r.type,
    distance: r._distance,
    relevant: isRelevant(r.filePath, r.name, expectedPatterns)
  }))

  const metrics = calculateMetrics(results, expectedPatterns)

  return {query, expectedFiles: expectedPatterns, results, metrics}
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(report: EvaluationReport): string {
  let md = `# Semantic Search Quality Evaluation

**Generated**: ${report.timestamp}
**Queries Evaluated**: ${report.totalQueries}

## Summary Metrics

| Metric | Value |
|--------|-------|
| Average Precision@5 | ${(report.averagePrecisionAt5 * 100).toFixed(1)}% |
| Average First Relevant Rank | ${report.averageFirstRelevantRank.toFixed(2)} |
| Average Coverage | ${(report.averageCoverage * 100).toFixed(1)}% |

## Query-by-Query Analysis

`

  for (const q of report.queries) {
    md += `### "${q.query}"

**Metrics:**
- Precision@5: ${(q.metrics.precisionAt5 * 100).toFixed(0)}%
- First Relevant Rank: ${q.metrics.firstRelevantRank || 'N/A'}
- Coverage: ${(q.metrics.coverage * 100).toFixed(0)}%
- Avg Distance (Relevant): ${q.metrics.avgDistanceRelevant.toFixed(4)}
- Avg Distance (Irrelevant): ${q.metrics.avgDistanceIrrelevant.toFixed(4)}
- Distance Gap: ${q.metrics.distanceGap.toFixed(4)}

**Expected Patterns:** ${q.expectedFiles.join(', ')}

**Results:**
| Rank | File | Name | Type | Distance | Relevant |
|------|------|------|------|----------|----------|
`
    q.results.forEach((r, i) => {
      md += `| ${i + 1} | ${r.file} | ${r.name} | ${r.type} | ${r.distance.toFixed(4)} | ${r.relevant ? 'Yes' : 'No'} |\n`
    })

    md += '\n'
  }

  md += `## Recommendations

Based on this evaluation:

1. **Low Precision Queries**: ${report.queries.filter((q) => q.metrics.precisionAt5 < 0.4).map((q) => `"${q.query}"`).join(', ') || 'None'}
2. **Missing First Rank**: ${report.queries.filter((q) => q.metrics.firstRelevantRank > 1).map((q) => `"${q.query}"`).join(', ') || 'None'}
3. **Low Coverage**: ${report.queries.filter((q) => q.metrics.coverage < 0.5).map((q) => `"${q.query}"`).join(', ') || 'None'}
`

  return md
}

/**
 * Main evaluation function
 */
export async function runEvaluation(): Promise<EvaluationReport> {
  console.log('Running semantic search evaluation...\n')

  const evaluations: QueryEvaluation[] = []

  for (const {query, expectedPatterns} of TEST_QUERIES) {
    console.log(`Evaluating: "${query}"`)
    const evaluation = await evaluateQuery(query, expectedPatterns)
    evaluations.push(evaluation)
    console.log(`  Precision@5: ${(evaluation.metrics.precisionAt5 * 100).toFixed(0)}%`)
    console.log(`  First Relevant: ${evaluation.metrics.firstRelevantRank}`)
    console.log(`  Coverage: ${(evaluation.metrics.coverage * 100).toFixed(0)}%`)
    console.log()
  }

  const report: EvaluationReport = {
    timestamp: new Date().toISOString(),
    totalQueries: evaluations.length,
    averagePrecisionAt5: evaluations.reduce((sum, e) => sum + e.metrics.precisionAt5, 0) / evaluations.length,
    averageFirstRelevantRank: evaluations.reduce((sum, e) => sum + (e.metrics.firstRelevantRank || 6), 0) / evaluations.length,
    averageCoverage: evaluations.reduce((sum, e) => sum + e.metrics.coverage, 0) / evaluations.length,
    queries: evaluations
  }

  console.log('=== Summary ===')
  console.log(`Average Precision@5: ${(report.averagePrecisionAt5 * 100).toFixed(1)}%`)
  console.log(`Average First Relevant Rank: ${report.averageFirstRelevantRank.toFixed(2)}`)
  console.log(`Average Coverage: ${(report.averageCoverage * 100).toFixed(1)}%`)

  // Write markdown report
  const markdown = generateMarkdownReport(report)
  const reportPath = path.join(process.cwd(), 'docs', 'wiki', 'Meta', 'Semantic-Search-Evaluation.md')
  await fs.writeFile(reportPath, markdown, 'utf-8')
  console.log(`\nReport written to: ${reportPath}`)

  return report
}

// Run when executed directly
runEvaluation().catch(console.error)
