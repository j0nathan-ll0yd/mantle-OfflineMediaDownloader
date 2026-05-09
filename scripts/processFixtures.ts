#!/usr/bin/env tsx
/**
 * Process raw CloudWatch fixtures into clean test fixtures
 * - Deduplicates similar payloads
 * - Separates incoming/outgoing fixtures
 * - Formats for test consumption
 *
 * Usage: pnpm run process-fixtures [--input <dir>] [--output <dir>]
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_INPUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'raw')
const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'api-contracts')

/**
 * Represents a raw fixture with marker and data
 */
interface RawFixture {
  __FIXTURE_MARKER__: 'INCOMING' | 'OUTGOING'
  data: FixtureData
}

/**
 * Fixture data can be any JSON-serializable object
 */
type FixtureData = Record<string, unknown>

/**
 * Calculate structural similarity between two objects
 * Returns 0-1 score (1 = identical structure)
 */
function calculateSimilarity(obj1: FixtureData | null | undefined, obj2: FixtureData | null | undefined): number {
  const keys1 = new Set(Object.keys(obj1 ?? {}))
  const keys2 = new Set(Object.keys(obj2 ?? {}))

  const intersection = new Set([...keys1].filter((k) => keys2.has(k)))
  const union = new Set([...keys1, ...keys2])

  if (union.size === 0) {
    return 1
  }

  const keySimilarity = intersection.size / union.size

  let valueSimilarity = 0
  let comparableValues = 0

  for (const key of intersection) {
    comparableValues++
    const val1 = obj1?.[key]
    const val2 = obj2?.[key]

    if (typeof val1 === typeof val2) {
      if (typeof val1 === 'object' && val1 !== null && val2 !== null) {
        valueSimilarity += calculateSimilarity(val1 as FixtureData, val2 as FixtureData)
      } else {
        valueSimilarity += 1
      }
    }
  }

  const avgValueSimilarity = comparableValues > 0 ? valueSimilarity / comparableValues : 0

  return (keySimilarity + avgValueSimilarity) / 2
}

/**
 * Deduplicate fixtures by structural similarity
 * Keeps most recent fixture for each unique structure
 */
function deduplicateFixtures(fixtures: RawFixture[], similarityThreshold = 0.9): RawFixture[] {
  const unique: RawFixture[] = []
  for (const fixture of fixtures) {
    const isDuplicate = unique.some((existing) => calculateSimilarity(fixture.data, existing.data) >= similarityThreshold)
    if (!isDuplicate) {
      unique.push(fixture)
    }
  }
  return unique
}

/**
 * Process a raw fixture file
 */
async function processFixtureFile(inputPath: string, outputDir: string): Promise<void> {
  const filename = path.basename(inputPath)
  // Extract Lambda/service name (handles both regular Lambdas and BetterAuth)
  const lambdaName = filename.split('-')[0]

  console.log(`Processing ${filename}...`)

  const rawContent = await fs.readFile(inputPath, 'utf-8')
  const lines = rawContent.trim().split('\n').filter(Boolean)

  if (lines.length === 0) {
    console.log(`  Info: No fixtures found in ${filename}`)
    return
  }

  const fixtures: RawFixture[] = lines.map((line) => JSON.parse(line) as RawFixture)

  const incoming = fixtures.filter((f) => f.__FIXTURE_MARKER__ === 'INCOMING')
  const outgoing = fixtures.filter((f) => f.__FIXTURE_MARKER__ === 'OUTGOING')

  console.log(`  Incoming: ${incoming.length}, Outgoing: ${outgoing.length}`)

  const uniqueIncoming = deduplicateFixtures(incoming)
  const uniqueOutgoing = deduplicateFixtures(outgoing)

  console.log(`  Deduplicated to ${uniqueIncoming.length} incoming, ${uniqueOutgoing.length} outgoing`)

  const lambdaOutputDir = path.join(outputDir, lambdaName)
  await fs.mkdir(lambdaOutputDir, {recursive: true})

  if (uniqueIncoming.length > 0) {
    const incomingPath = path.join(lambdaOutputDir, 'incoming.json')
    await fs.writeFile(incomingPath, JSON.stringify(uniqueIncoming.map((f) => f.data), null, 2))
    console.log(`  Wrote ${incomingPath}`)
  }

  if (uniqueOutgoing.length > 0) {
    const outgoingPath = path.join(lambdaOutputDir, 'outgoing.json')
    await fs.writeFile(outgoingPath, JSON.stringify(uniqueOutgoing.map((f) => f.data), null, 2))
    console.log(`  Wrote ${outgoingPath}`)
  }
}

/**
 * Main processing function
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let inputDir = DEFAULT_INPUT_DIR
  let outputDir = DEFAULT_OUTPUT_DIR

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputDir = args[i + 1]
      i++
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1]
      i++
    }
  }

  console.log('Processing fixtures...')
  console.log(`Input: ${inputDir}`)
  console.log(`Output: ${outputDir}`)
  console.log('')

  try {
    await fs.mkdir(outputDir, {recursive: true})

    const files = await fs.readdir(inputDir)
    const jsonFiles = files.filter((f) => f.endsWith('.json'))

    if (jsonFiles.length === 0) {
      console.log('No fixture files found. Run bin/extract-fixtures.sh first.')
      process.exit(0)
    }

    for (const file of jsonFiles) {
      await processFixtureFile(path.join(inputDir, file), outputDir)
    }

    console.log('')
    console.log('Processing complete!')
    console.log(`Fixtures saved to: ${outputDir}`)
  } catch (error) {
    console.error('Error processing fixtures:', error)
    process.exit(1)
  }
}

main()
