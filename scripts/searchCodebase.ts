import * as lancedb from '@lancedb/lancedb'
import {generateEmbedding} from './embeddings.js'

const DB_DIR = '.lancedb'
const TABLE_NAME = 'code_chunks'

/**
 * Query expansions for conceptual searches
 * Maps common conceptual terms to technical implementation terms
 */
const QUERY_EXPANSIONS: Record<string, string[]> = {
  'error handling': ['CustomLambdaError', 'try catch', 'buildErrorResponse', 'ValidationError', 'errors.ts'],
  authentication: ['Bearer token', 'session', 'authorize', 'login', 'Better Auth', 'ApiGatewayAuthorizer'],
  'cascade deletion': ['Promise.allSettled', 'deleteUser', 'UserDelete', 'delete child first', 'relationship'],
  's3 upload': ['createS3Upload', 'PutObject', 'downloadVideoToS3', 'StartFileUpload'],
  'push notification': ['APNS', 'SNS', 'SendPushNotification', 'device token', 'notification'],
  'device registration': ['RegisterDevice', 'createDevice', 'upsertDevice', 'deviceToken'],
  'video download': ['StartFileUpload', 'yt-dlp', 'downloadVideoToS3', 'YouTube'],
  retry: ['retryWithBackoff', 'exponential backoff', 'circuit breaker', 'error classification'],
  session: ['validateSessionToken', 'sessionService', 'refreshSession', 'Better Auth'],
  'api response': ['formatResponse', 'buildErrorResponse', 'responses.ts', 'APIGatewayProxyResult']
}

/**
 * Type boost factors - higher values boost certain types for specific queries
 */
const TYPE_BOOSTS: Record<string, number> = {
  function: 1,
  class: 0.95,
  interface: 0.9,
  variable: 0.85,
  documentation: 0.8,
  'typespec-model': 0.9,
  'typespec-enum': 0.85,
  'typespec-interface': 0.9
}

interface SearchOptions {
  limit?: number
  expand?: boolean
  maxDistance?: number
}

interface SearchResult {
  filePath: string
  startLine: number
  type: string
  name: string
  text: string
  _distance: number
  adjustedDistance?: number
}

/**
 * Expand a conceptual query with related technical terms
 */
function expandQuery(query: string): string {
  const lowerQuery = query.toLowerCase()

  const expansions: string[] = []
  for (const [concept, terms] of Object.entries(QUERY_EXPANSIONS)) {
    if (lowerQuery.includes(concept)) {
      expansions.push(...terms)
    }
  }

  if (expansions.length === 0) {
    return query
  }

  return `${query}. Related: ${expansions.join(', ')}`
}

/**
 * Apply type-based boosting to results
 */
function applyTypeBoost(results: SearchResult[], query: string): SearchResult[] {
  const lowerQuery = query.toLowerCase()

  // Boost documentation for "how" or "what" queries
  const docBoost = lowerQuery.includes('how') || lowerQuery.includes('what') ? 1.1 : 0.85

  // Boost TypeSpec for API-related queries
  const typespecBoost = lowerQuery.includes('api') || lowerQuery.includes('schema') ? 1.1 : 0.9

  return results.map((r) => {
    let boost = TYPE_BOOSTS[r.type] || 1
    if (r.type === 'documentation') {
      boost = docBoost
    } else if (r.type.startsWith('typespec')) {
      boost = typespecBoost
    }
    return {...r, adjustedDistance: r._distance / boost}
  }).sort((a, b) => (a.adjustedDistance || a._distance) - (b.adjustedDistance || b._distance))
}

/**
 * Search the codebase with optional query expansion and type boosting
 */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const {limit = 5, expand = true, maxDistance = 1} = options

  const db = await lancedb.connect(DB_DIR)
  const table = await db.openTable(TABLE_NAME)

  // Optionally expand the query with related terms
  const searchQuery = expand ? expandQuery(query) : query

  const vector = await generateEmbedding(searchQuery)

  // Fetch more results to allow filtering and re-ranking
  const rawResults = await table.vectorSearch(vector).limit(limit * 2).toArray()

  // Filter by distance threshold
  const filtered = rawResults.filter((r) => r._distance < maxDistance) as SearchResult[]

  // Apply type boosting and re-rank
  const boosted = applyTypeBoost(filtered, query)

  // Return top results after boosting
  return boosted.slice(0, limit)
}

/**
 * CLI search function with formatted output
 */
async function cliSearch(query: string, limit = 5) {
  const results = await search(query, {limit, expand: true})
  console.log(`
Results for query: "${query}"
`)
  for (const result of results) {
    const distanceStr = result.adjustedDistance
      ? `${result._distance.toFixed(4)} -> ${result.adjustedDistance.toFixed(4)}`
      : result._distance.toFixed(4)
    console.log(`--- Result (Distance: ${distanceStr}) ---`)
    console.log(`File: ${result.filePath}:${result.startLine}`)
    console.log(`Type: ${result.type}, Name: ${result.name}`)
    console.log(`Preview: ${result.text.slice(0, 100).replaceAll('\n', ' ')}...`)
    console.log()
  }
}

const query = process.argv.slice(2).join(' ') || 'How is DynamoDB initialized?'
cliSearch(query).catch(console.error)
