#!/usr/bin/env node

/**
 * Version-asserting, arg-forwarding wrapper for TypeScript 7 (the `@typescript/native` alias,
 * which is `npm:typescript@^7.0.2` — the Go-based native compiler).
 *
 * WHY THIS EXISTS: installing the alias silently flips `node_modules/.bin/tsc` AND `pnpm exec tsc`
 * to TypeScript 7 (verified 2026-07-14 — zero pnpm warnings, deterministic across reinstalls).
 * While TypeScript 6 and 7 are both installed, bare `tsc` is ambiguous and BANNED repo-wide; every
 * typecheck/emit invocation goes through tsc6.mjs (TS6) or this wrapper (TS7) so the compiler is
 * explicit, version-asserted, and announced. See .omc/plans/typescript-7-upgrade.md.
 *
 * Usage: `node bin/tsc7.mjs <tsc args...>`
 */

import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const LABEL = 'tsc7'
const PACKAGE = '@typescript/native'
const EXPECTED_MAJOR = '7'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(repoRoot, 'node_modules', PACKAGE)

// Cheap version assert — read the resolved package.json `version` field (NOT a `tsc --version` spawn).
let version
try {
  version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
} catch (error) {
  console.error(`[${LABEL}] FATAL: cannot read ${PACKAGE}/package.json at ${packageDir}: ${error.message}`)
  process.exit(1)
}

if (version.split('.')[0] !== EXPECTED_MAJOR) {
  console.error(
    `[${LABEL}] FATAL: expected ${PACKAGE}@${EXPECTED_MAJOR}.x but resolved ${version} at ${packageDir} — aborting (compiler-identity guard; see .omc/plans/typescript-7-upgrade.md)`
  )
  process.exit(1)
}

const tscPath = join(packageDir, 'bin', 'tsc')
const args = process.argv.slice(2)

// Banner on EVERY run: makes an ad-hoc bare-`tsc` slip visible (the grep gate cannot catch
// interactive-shell usage) and makes the forwarded argv auditable (the arg-forwarding gate).
console.error(`[${LABEL}] ${PACKAGE}@${version} → ${tscPath} ${args.join(' ')}`)

// Forward argv verbatim; propagate the child exit code (re-raise signals) so callers/CI see the truth.
const child = spawn(process.execPath, [tscPath, ...args], {stdio: 'inherit'})
child.on('error', (error) => {
  console.error(`[${LABEL}] FATAL: failed to spawn compiler: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 1)
  }
})
