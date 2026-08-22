#!/usr/bin/env node
/**
 * OpenSpec covers-tether ratchet.
 *
 * Runs `mantle check openspec --json`, extracts uncovered requirements, and
 * compares them with `openspec/covers-baseline.json`. Existing uncovered
 * requirements are grandfathered. A requirement that becomes newly uncovered
 * fails the process, so coverage debt can shrink but cannot grow.
 *
 * Modes:
 *   (default)             Fail on newly uncovered requirements.
 *   --update-baseline     Replace the baseline with the current uncovered set.
 *                         Refuses to increase the grandfathered count.
 *   --reconcile-renames   Report added and removed ids without applying the gate.
 *
 * A requirement rename changes its baseline id. Reconcile the old and new ids
 * in the same change with `--update-baseline` after reviewing the diff.
 */

import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const UNCOVERED_TYPE = 'uncovered-requirement'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(REPO_ROOT, 'openspec', 'covers-baseline.json')
const BASELINE_REL = 'openspec/covers-baseline.json'

function abortRed(message) {
  console.error(`\n[covers-ratchet] ABORT RED - ${message}`)
  process.exit(1)
}

function parseFindings(stdout) {
  const trimmed = stdout.trim()
  const attempts = [trimmed]
  const first = trimmed.indexOf('[')
  const last = trimmed.lastIndexOf(']')
  if (first !== -1 && last > first) {
    attempts.push(trimmed.slice(first, last + 1))
  }

  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate)
      if (Array.isArray(value)) {
        return value
      }
    } catch {
      // Try the next candidate. npx can print banner text around the JSON.
    }
  }
  return null
}

function collectUncoveredIds() {
  const result = spawnSync('npx', ['mantle', 'check', 'openspec', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1'},
    maxBuffer: 32 * 1024 * 1024
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const exitCode = result.status

  if (/unknown option\b.*--json|error: unknown option '--json'/i.test(stderr)) {
    abortRed(
      'the installed Mantle CLI does not support `check openspec --json`.\n' +
        '  Update @j0nathan-ll0yd/cli and the lockfile before enabling this gate.\n' +
        `  mantle stderr: ${stderr.trim().split('\n').slice(0, 3).join(' | ')}`
    )
  }

  if (result.error) {
    abortRed(`could not spawn \`npx mantle\`: ${result.error.message}`)
  }

  const parsed = parseFindings(stdout)
  if (parsed === null) {
    abortRed(
      `could not parse \`mantle check openspec --json\` output as JSON (exit ${exitCode}).\n` +
        `  stderr: ${stderr.trim().split('\n').slice(0, 3).join(' | ') || '(empty)'}\n` +
        `  stdout head: ${stdout.slice(0, 200)}`
    )
  }

  // Advisory JSON mode must exit zero. A non-zero exit means the scan did not
  // complete, even if it emitted partial findings. Never treat that as green.
  if (exitCode !== 0) {
    const findingNote = parsed.length === 0 ? 'zero findings' : `${parsed.length} possibly partial finding(s)`
    abortRed(
      `\`mantle check openspec --json\` exited ${exitCode} with ${findingNote}.\n` +
        `  stderr: ${stderr.trim().split('\n').slice(0, 3).join(' | ') || '(empty)'}`
    )
  }

  const ids = parsed
    .filter((finding) => finding && finding.type === UNCOVERED_TYPE)
    .map((finding) => `${finding.capability}#${finding.requirementName}`)

  return [...new Set(ids)].sort()
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
  } catch (error) {
    abortRed(`${BASELINE_REL} is not valid JSON - ${error instanceof Error ? error.message : String(error)}`)
  }

  const list = Array.isArray(parsed) ? parsed : parsed.uncovered
  if (!Array.isArray(list)) {
    abortRed(`${BASELINE_REL} must be an array or an object with an "uncovered" array`)
  }
  return new Set(list)
}

function writeBaseline(ids) {
  const payload = {
    description:
      'Grandfathered OpenSpec requirements without a `// covers:` test tether. ' +
      'scripts/openspec-covers-ratchet.mjs fails CI when the uncovered set grows. ' +
      'When a covering test lands, regenerate this file so the baseline shrinks.',
    generatedBy: 'node scripts/openspec-covers-ratchet.mjs --update-baseline',
    uncovered: [...ids].sort()
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
}

function main() {
  const args = new Set(process.argv.slice(2))
  const updateMode = args.has('--update-baseline')
  const reconcileMode = args.has('--reconcile-renames')
  const ids = collectUncoveredIds()
  const current = new Set(ids)

  if (updateMode) {
    const baseline = readBaseline()
    if (baseline === null) {
      abortRed(`${BASELINE_REL} is missing. Restore the committed baseline before updating it.`)
    }
    if (ids.length > baseline.size) {
      abortRed(
        `refusing to grow the grandfathered count from ${baseline.size} to ${ids.length}.\n` +
          '  Add covering tests before updating the baseline.'
      )
    }
    writeBaseline(ids)
    console.log(`[covers-ratchet] Wrote ${BASELINE_REL} with ${ids.length} grandfathered requirement(s).`)
    return
  }

  const baseline = readBaseline()
  if (baseline === null) {
    abortRed(`${BASELINE_REL} is missing. Restore the committed baseline before checking coverage.`)
  }

  const newlyUncovered = ids.filter((id) => !baseline.has(id))
  const prunable = [...baseline].filter((id) => !current.has(id)).sort()

  if (reconcileMode) {
    console.log('[covers-ratchet] Rename reconciliation (gate not applied):')
    console.log(`  ADDED - ${newlyUncovered.length}`)
    for (const id of newlyUncovered) console.log(`    + ${id}`)
    console.log(`  REMOVED - ${prunable.length}`)
    for (const id of prunable) console.log(`    - ${id}`)
    return
  }

  console.log(
    `[covers-ratchet] ${ids.length} uncovered requirement(s); ${baseline.size} grandfathered in ${BASELINE_REL}.`
  )

  if (prunable.length > 0) {
    console.log('[covers-ratchet] Baseline entries can be pruned with --update-baseline:')
    for (const id of prunable) console.log(`    - ${id}`)
  }

  if (newlyUncovered.length > 0) {
    console.error(`\n[covers-ratchet] FAIL - ${newlyUncovered.length} newly uncovered requirement(s):`)
    for (const id of newlyUncovered) console.error(`    + ${id}`)
    console.error(
      '\nAdd a covering test, or reconcile an intentional requirement rename with --update-baseline in the same change.'
    )
    process.exit(1)
  }

  console.log('[covers-ratchet] PASS - no newly uncovered requirements.')
}

main()
