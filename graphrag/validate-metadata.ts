#!/usr/bin/env node
/**
 * Validate metadata.json completeness
 *
 * Ensures all Lambdas discovered in src/lambdas/ have entries in metadata.json.
 * Run as part of CI to catch drift between codebase and semantic metadata.
 *
 * Usage:
 *   pnpm run graphrag:validate
 *   node --import tsx graphrag/validate-metadata.ts
 */

import fs from 'fs/promises'
import path from 'path'
import {fileURLToPath} from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

interface LambdaMetadata {
  trigger: string
  purpose: string
}

interface Metadata {
  lambdas: Record<string, LambdaMetadata>
  // Other fields exist but we only validate lambdas
}

interface ValidationResult {
  valid: boolean
  missingLambdas: string[]
  extraLambdas: string[]
  incompleteMetadata: Array<{lambda: string; issues: string[]}>
}

/**
 * Discover Lambda names from src/lambdas/ directory
 *
 * Supports two Lambda layout conventions:
 * - File-based routing (Mantle): `api/user/login.post.ts` -\> `api/user/login`
 * - Directory-based: `sqs/SendPushNotification/index.ts` -\> `sqs/SendPushNotification`
 */
async function discoverLambdas(): Promise<string[]> {
  const lambdasDir = path.join(projectRoot, 'src', 'lambdas')
  const lambdas: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, {withFileTypes: true})
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        // File-based routing: event.post.ts, index.get.ts, webhook.post.ts
        const routeMatch = entry.name.match(/^(.+)\.(post|get|delete|put|patch)\.ts$/)
        if (routeMatch) {
          const rel = path.relative(lambdasDir, path.join(dir, routeMatch[1]))
          lambdas.push(rel)
          continue
        }
        // Directory-based: index.ts inside a named folder
        if (entry.name === 'index.ts') {
          const rel = path.relative(lambdasDir, dir)
          lambdas.push(rel)
        }
      }
    }
  }

  await walk(lambdasDir)
  return lambdas.sort()
}

/**
 * Load metadata from graphrag/metadata.json
 */
async function loadMetadata(): Promise<Metadata> {
  const metadataPath = path.join(__dirname, 'metadata.json')
  const content = await fs.readFile(metadataPath, 'utf-8')
  return JSON.parse(content)
}

/**
 * Validate metadata completeness
 */
async function validateMetadata(): Promise<ValidationResult> {
  const [lambdas, metadata] = await Promise.all([discoverLambdas(), loadMetadata()])

  const metadataLambdas = Object.keys(metadata.lambdas)

  // Find Lambdas missing from metadata
  const missingLambdas = lambdas.filter((l) => !metadataLambdas.includes(l))

  // Find Lambdas in metadata but not in codebase
  const extraLambdas = metadataLambdas.filter((l) => !lambdas.includes(l))

  // Check for incomplete metadata entries
  const incompleteMetadata: Array<{lambda: string; issues: string[]}> = []
  for (const [lambda, meta] of Object.entries(metadata.lambdas)) {
    const issues: string[] = []
    if (!meta.trigger || meta.trigger === 'Unknown') {
      issues.push('missing trigger')
    }
    if (!meta.purpose || meta.purpose === 'Unknown') {
      issues.push('missing purpose')
    }
    if (issues.length > 0) {
      incompleteMetadata.push({lambda, issues})
    }
  }

  return {
    valid: missingLambdas.length === 0 && extraLambdas.length === 0 && incompleteMetadata.length === 0,
    missingLambdas,
    extraLambdas,
    incompleteMetadata
  }
}

/**
 * Print validation results
 */
function printResults(result: ValidationResult): void {
  if (result.valid) {
    console.log('✓ metadata.json is complete and valid')
    return
  }

  console.log('✗ metadata.json validation failed\n')

  if (result.missingLambdas.length > 0) {
    console.log('Missing Lambda entries in metadata.json:')
    for (const lambda of result.missingLambdas) {
      console.log(`  - ${lambda}`)
    }
    console.log('')
  }

  if (result.extraLambdas.length > 0) {
    console.log('Stale Lambda entries (not in codebase):')
    for (const lambda of result.extraLambdas) {
      console.log(`  - ${lambda}`)
    }
    console.log('')
  }

  if (result.incompleteMetadata.length > 0) {
    console.log('Incomplete metadata entries:')
    for (const {lambda, issues} of result.incompleteMetadata) {
      console.log(`  - ${lambda}: ${issues.join(', ')}`)
    }
    console.log('')
  }

  console.log('To fix:')
  console.log('  1. Edit graphrag/metadata.json')
  console.log('  2. Add missing Lambda entries with trigger and purpose')
  console.log('  3. Remove stale entries')
  console.log('  4. Run: pnpm run graphrag:extract')
}

// Main execution
async function main() {
  try {
    const result = await validateMetadata()
    printResults(result)

    if (!result.valid) {
      process.exit(1)
    }
  } catch (error) {
    console.error('Error validating metadata:', error)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${__filename}`) {
  main()
}

export { validateMetadata, ValidationResult }
