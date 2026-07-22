#!/usr/bin/env node
/**
 * Detects stale pnpm overrides by checking resolved versions in the lockfile.
 *
 * Override categories:
 *   - Conditional:  "pkg@<1.2.3" or "pkg@>=1.0.0 <2.0.0"  → deterministic ACTIVE/STALE
 *   - Simple:       "pkg"                                    → REVIEW (cannot auto-determine)
 *   - Scoped:       "parent>pkg"                             → REVIEW (cannot auto-determine)
 *
 * Statuses:
 *   ACTIVE — lockfile has versions in the vulnerable range; override is still needed
 *   STALE  — no resolved version matches the condition; override is a no-op (safe to remove)
 *   DEAD   — package has zero resolved versions in the lockfile (removed dependency)
 *   REVIEW — simple/scoped override; requires manual verification
 *
 * Limitation: Inline version comparison handles dotted numeric versions (X.Y.Z) only.
 * Pre-release suffixes (e.g., 1.0.0-alpha.1) are not supported and will be compared
 * lexicographically, which may produce incorrect results.
 *
 * Exit codes:
 *   0 — no STALE or DEAD overrides found
 *   1 — at least one STALE or DEAD override detected
 */

import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

const cwd = process.cwd()

// --- Read effective pnpm overrides ---
// pnpm 11 reads workspace settings from pnpm-workspace.yaml, not package.json.
// Ask pnpm for the effective configuration so this check follows either layout.
let overrides
try {
  overrides = JSON.parse(execFileSync('pnpm', ['config', 'get', 'overrides', '--json'], {cwd, encoding: 'utf-8'}))
} catch (err) {
  console.error(`Failed to read pnpm overrides: ${err.message}`)
  process.exit(1)
}

const overrideEntries = Object.entries(overrides)
if (overrideEntries.length === 0) {
  console.log('No pnpm overrides found.')
  process.exit(0)
}

// --- Read lockfile and extract resolved versions ---
const lockPath = join(cwd, 'pnpm-lock.yaml')
let lockContent
try {
  lockContent = readFileSync(lockPath, 'utf-8')
} catch (err) {
  console.error(`Failed to read pnpm-lock.yaml: ${err.message}`)
  process.exit(1)
}

/**
 * Collect all resolved versions for a package name from the lockfile.
 * Matches patterns like "  hono@4.12.9:" in the packages section.
 */
function getResolvedVersions(pkgName) {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^  ${escaped}@(\\d[\\d.]*):`, 'gm')
  const versions = new Set()
  let m
  while ((m = re.exec(lockContent)) !== null) {
    versions.add(m[1])
  }
  return [...versions]
}

// --- Version comparison utilities ---

/**
 * Compare two dotted numeric version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na < nb) {
      return -1
    }
    if (na > nb) {
      return 1
    }
  }
  return 0
}

/**
 * Check if a version satisfies a single comparator (e.g., "<4.11.4", ">=1.1.13", "<=6.2.0").
 */
function satisfiesComparator(version, comparator) {
  const match = comparator.match(/^(>=|<=|>|<)(.+)$/)
  if (!match) {
    return false
  }
  const [, op, target] = match
  const cmp = compareVersions(version, target)
  switch (op) {
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    default:
      return false
  }
}

/**
 * Check if a version satisfies a condition range (space-separated comparators).
 * E.g., ">=7.0.0 <7.18.2" means version must satisfy BOTH comparators.
 */
function satisfiesRange(version, range) {
  const comparators = range.trim().split(/\s+/)
  return comparators.every((c) => satisfiesComparator(version, c))
}

// --- Parse and classify overrides ---

/**
 * Parse an override key into its components.
 * Returns { type, pkgName, conditionRange }
 */
function parseOverrideKey(key) {
  // Scoped override: "parent>pkg"
  if (key.includes('>') && !key.includes('@')) {
    return {type: 'scoped', pkgName: key.split('>').pop(), conditionRange: null}
  }

  // Conditional: "pkg@<condition" or "pkg@>=X <Y"
  // Match the last @ that's followed by a comparator operator
  const condMatch = key.match(/^(.+?)@((?:>=|<=|>|<).+)$/)
  if (condMatch) {
    return {type: 'conditional', pkgName: condMatch[1], conditionRange: condMatch[2]}
  }

  // Simple global: "pkg"
  return {type: 'simple', pkgName: key, conditionRange: null}
}

// --- Analyze each override ---
const results = []

for (const [key, value] of overrideEntries) {
  const {type, pkgName, conditionRange} = parseOverrideKey(key)
  const resolved = getResolvedVersions(pkgName)

  let status
  if (resolved.length === 0) {
    status = 'DEAD'
  } else if (type === 'conditional' && conditionRange) {
    const anyInRange = resolved.some((v) => satisfiesRange(v, conditionRange))
    status = anyInRange ? 'ACTIVE' : 'STALE'
  } else {
    status = 'REVIEW'
  }

  results.push({key, value, pkgName, resolved, status})
}

// --- Output ---
const statusColors = {
  ACTIVE: '\x1b[32m', // green
  STALE: '\x1b[33m', // yellow
  DEAD: '\x1b[31m', // red
  REVIEW: '\x1b[2m' // dim
}
const reset = '\x1b[0m'

const colKey = Math.max(20, ...results.map((r) => `${r.key} → ${r.value}`.length))
const colResolved = Math.max(10, ...results.map((r) => r.resolved.join(', ').length || 3))

console.log('\nPnpm Override Status Check\n')
console.log(`${'Override'.padEnd(colKey)}  ${'Resolved'.padEnd(colResolved)}  Status`)
console.log(`${'-'.repeat(colKey)}  ${'-'.repeat(colResolved)}  ------`)

for (const r of results) {
  const label = `${r.key} → ${r.value}`
  const resolvedStr = r.resolved.length > 0 ? r.resolved.join(', ') : '(none)'
  const color = statusColors[r.status] ?? ''
  console.log(`${label.padEnd(colKey)}  ${resolvedStr.padEnd(colResolved)}  ${color}${r.status}${reset}`)
}

const stale = results.filter((r) => r.status === 'STALE')
const dead = results.filter((r) => r.status === 'DEAD')
const active = results.filter((r) => r.status === 'ACTIVE')
const review = results.filter((r) => r.status === 'REVIEW')

console.log()
const summary = []
if (active.length > 0) {
  summary.push(`${active.length} active`)
}
if (review.length > 0) {
  summary.push(`${review.length} review`)
}
if (stale.length > 0) {
  summary.push(`${stale.length} stale`)
}
if (dead.length > 0) {
  summary.push(`${dead.length} dead`)
}
console.log(summary.join(', '))

if (stale.length > 0 || dead.length > 0) {
  console.log('\nStale/dead overrides can be safely removed from the pnpm workspace configuration.')
  if (stale.length > 0) {
    console.log('\nStale (condition range no longer matches any resolved version):')
    for (const r of stale) {
      console.log(`  - ${r.key}`)
    }
  }
  if (dead.length > 0) {
    console.log('\nDead (package no longer in dependency tree):')
    for (const r of dead) {
      console.log(`  - ${r.key}`)
    }
  }
  process.exit(1)
}

console.log('\nAll overrides are active or require manual review. No action needed.')
process.exit(0)
