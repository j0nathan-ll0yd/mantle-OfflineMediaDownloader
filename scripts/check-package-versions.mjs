#!/usr/bin/env node
/* global console, process */
/*
 * Published-package version-drift gate (consumer-repo wrapper).
 *
 * THE FAILURE THIS PREVENTS: an agent edits source inside a published package, merges, and
 * never bumps the `version`. Nothing goes red — typecheck, tests, lint and the PR all pass,
 * and `changeset publish` SILENTLY SKIPS a version that already exists in the registry and
 * exits 0. Consumers keep resolving the old tarball forever.
 *
 * The verdict is owned by `mantle check package-versions` in @j0nathan-ll0yd/cli, which
 * compares each publishable package's PUBLISHED PAYLOAD against the payload this checkout
 * would publish. This file is a thin wrapper: it answers "is this repo in scope at all",
 * then delegates. It deliberately does NOT reimplement the comparison — three parallel
 * implementations of one algorithm diverge (that has already happened once in this estate),
 * and a consumer repo carrying its own copy would drift from the engine silently.
 *
 * ── THE ONLY THING THIS WRAPPER MAY CONCLUDE ON ITS OWN ─────────────────────────────────
 *
 * "This repo publishes nothing, so nothing can drift." That is a real, verifiable answer
 * and it exits 0.
 *
 * EVERY OTHER outcome in which the wrapper did not obtain a verdict from the engine —
 * the engine is not installed, the probe could not run, the engine crashed or was killed —
 * exits 3 (INDETERMINATE). It is NEVER exit 0.
 *
 * That rule is the whole point of this rewrite. The previous revision "skipped loudly" with
 * exit 0 while the installed CLI (1.0.0) lacked the subcommand — and in mantle-LifegamesPortal
 * that exit 0 fed the REQUIRED "CI Gate" status context. A required gate that is green for a
 * check which never ran is strictly worse than no gate at all: it manufactures the evidence of
 * safety without the safety. There is no such thing as a warning that a merge queue reads. The
 * only signal CI understands is the exit code, so "I could not tell" must be non-zero.
 *
 * The cost of that honesty is real and accepted: until @j0nathan-ll0yd/cli publishes a
 * release carrying `mantle check package-versions`, this gate is RED in any repo that
 * publishes something. That is the correct report of the true state, and it is why the PR
 * wiring this gate must not merge before the CLI release lands. BLOCKING ORDERING:
 * mantle#308 merges -> @j0nathan-ll0yd/cli publishes to GitHub Packages -> this repo bumps
 * the CLI -> this gate can merge.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────────────────
 *
 *   0  Nothing publishable in this repo, or the engine ran and reported no drift.
 *   3  INDETERMINATE — the wrapper could not obtain a verdict. Never a pass.
 *   *  Anything else is the engine's own exit status, forwarded VERBATIM. The wrapper does
 *      not translate it: the engine owns its exit-code contract and remapping here would
 *      silently rewrite the severity of a verdict whenever that contract evolves.
 *
 * Exit 3 cannot collide with a forwarded status, because the wrapper only forwards once the
 * engine has actually run to completion.
 *
 * Extra arguments are forwarded verbatim to the engine, e.g. `--json`, `--lane=pre-push`.
 *
 * Run `node scripts/check-package-versions.mjs --self-test` for the known-answer vectors.
 */

import {spawnSync} from 'node:child_process'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/** Exact registry string from the canonical discovery predicate in mantle's check-public-packages.mjs. */
const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com'

/** The `mantle check` subcommand that owns the drift verdict. */
const SUBCOMMAND = 'package-versions'

/**
 * First `@j0nathan-ll0yd/cli` release expected to carry SUBCOMMAND. DIAGNOSTIC ONLY — it is
 * printed in the failure message so the fix is self-service. It is deliberately NOT a
 * control-flow gate: a version floor used as a gate is just a skip window wearing a
 * different hat, and every skip window eventually outlives the release it was waiting for.
 */
const CLI_FLOOR_VERSION_HINT = '1.3.0'

/** INDETERMINATE. Aligned with the engine's exit class for "could not tell". */
const EXIT_INDETERMINATE = 3

// ---------------------------------------------------------------------------
// Pure functions (no fs, no spawn) — everything below is covered by --self-test.
// ---------------------------------------------------------------------------

/**
 * The canonical publishable-package predicate, applied to already-read manifests. Mirrors
 * mantle/scripts/check-public-packages.mjs: non-private AND publishConfig.registry an exact
 * match for GitHub Packages. An unreadable or unparseable manifest arrives as null and is
 * skipped, exactly as it is there.
 *
 * Deliberately does NOT filter on the package name: a candidate outside the j0nathan-ll0yd
 * scope must reach the engine so the engine's scope assertion can fail loudly, rather than
 * being silently dropped here.
 *
 * Takes entries carrying `dir` and `manifest` (the parsed manifest, or null) and returns the
 * matching directory labels, ASCII-ascending.
 */
export function selectPublishableDirs(entries) {
  return entries.filter((entry) =>
    entry.manifest != null && entry.manifest.private !== true && entry.manifest.publishConfig?.registry === GITHUB_PACKAGES_REGISTRY
  ).map((entry) => entry.dir).sort()
}

/**
 * Does a Commander `--help` listing register the named subcommand? Commander prints one
 * indented line per subcommand, for example "  package-versions [options]  ...". The match is
 * anchored to the start of an indented line so `versions` never matches `package-versions`
 * and vice versa.
 */
export function helpListsSubcommand(helpText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^[ \\t]+${escaped}(?:[ \\t]|$)`, 'm').test(String(helpText ?? ''))
}

/**
 * Classify the result of probing the engine for SUBCOMMAND.
 *
 * This exists because of a specific defect: the previous revision read only `stdout`/`stderr`
 * and discarded spawnSync's `.error`, `.status` and `.signal`. "npx is not on PATH",
 * "the registry returned 403 so the CLI was never installed", "the CLI crashed" and "the CLI
 * ran fine but has no such subcommand" all collapsed into one indistinguishable outcome —
 * and that outcome was a pass. They are four different failures with four different fixes,
 * and none of them is "everything is fine".
 *
 * Takes the raw spawnSync fields plus the combined help text. Returns an `outcome` of
 * 'available' | 'engine-unavailable' | 'subcommand-missing' and a stable `reason` slug.
 * Only 'available' ever leads to exit 0.
 */
export function classifyProbe({error, status, signal, helpText, subcommand}) {
  if (error != null) {
    return {outcome: 'engine-unavailable', reason: 'probe-spawn-failed'}
  }
  if (signal != null) {
    return {outcome: 'engine-unavailable', reason: 'probe-killed-by-signal'}
  }
  if (status !== 0) {
    return {outcome: 'engine-unavailable', reason: 'probe-nonzero-exit'}
  }
  const text = String(helpText ?? '')
  if (text.trim() === '') {
    // `mantle check --help` exiting 0 with no output is not "no subcommands"; it is a broken
    // or shimmed binary. Treating it as merely-missing would make an empty-output regression
    // in the CLI look like a routine pre-release state.
    return {outcome: 'engine-unavailable', reason: 'probe-empty-output'}
  }
  return helpListsSubcommand(text, subcommand)
    ? {outcome: 'available', reason: 'subcommand-listed'}
    : {outcome: 'subcommand-missing', reason: 'subcommand-not-listed'}
}

/**
 * Classify the result of the delegated engine run into the wrapper's own exit code.
 *
 * `status` is null whenever the child never produced an exit status — it failed to spawn, or
 * it was terminated by a signal (SIGKILL from an OOM killer, SIGTERM from a CI timeout).
 * `status ?? 1` would have called an OOM-killed engine "drift found"; `status ?? 0` would
 * have called it clean. Both are lies. It is INDETERMINATE.
 *
 * Returns `{exitCode, reason}`. `reason` is 'engine-verdict' exactly when the engine's own
 * status is being forwarded.
 */
export function classifyDelegatedRun({error, status, signal}) {
  if (error != null) {
    return {exitCode: EXIT_INDETERMINATE, reason: 'engine-spawn-failed'}
  }
  if (signal != null) {
    return {exitCode: EXIT_INDETERMINATE, reason: 'engine-killed-by-signal'}
  }
  if (typeof status !== 'number') {
    return {exitCode: EXIT_INDETERMINATE, reason: 'engine-no-exit-status'}
  }
  return {exitCode: status, reason: 'engine-verdict'}
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Every manifest that could plausibly be published from this repo: the ROOT manifest plus one
 * level under packages/.
 *
 * The root is included because omitting it is a silent-pass hole — a repo whose root manifest
 * is non-private and points at GitHub Packages publishes on every release, and a packages/-only
 * scan would report "this repo publishes no packages" and exit 0 forever.
 *
 * A `pnpm list -r --depth -1 --json` enumeration was evaluated and REJECTED, and the
 * measurement is worth recording because it contradicts the obvious assumption. Measured in
 * mantle-LifegamesPortal, which carries the sibling copy of this file: packages/portal-contract
 * is NOT a pnpm workspace member. Its pnpm-workspace.yaml carries no `packages:` key (it is a
 * settings-only file — "this repo is a single-package project"), so that same command returns
 * the root alone, and `pnpm --filter` on the contract package prints
 * "No projects matched the filters" AND EXITS 0. Discovering through pnpm would
 * therefore have reported that repo as publishing nothing — reintroducing, through a more
 * sophisticated mechanism, the exact silent pass this rewrite exists to remove.
 */
function readCandidateEntries(root) {
  const entries = [{dir: '<root>', manifest: readManifest(join(root, 'package.json'))}]
  const packagesDir = join(root, 'packages')
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        entries.push({dir: `packages/${entry.name}`, manifest: readManifest(join(packagesDir, entry.name, 'package.json'))})
      }
    }
  }
  return entries
}

/** Installed CLI version, or null when it cannot be read. Diagnostics only. */
function readInstalledCliVersion(root) {
  return readManifest(join(root, 'node_modules', '@j0nathan-ll0yd', 'cli', 'package.json'))?.version ?? null
}

// ---------------------------------------------------------------------------
// Self-test (A2b: every check ships a known-answer self-test)
// ---------------------------------------------------------------------------

async function selfTest() {
  const {default: assert} = await import('node:assert/strict')

  let checks = 0
  const eq = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message)
    checks++
  }

  const publishableManifest = {name: '@j0nathan-ll0yd/sample-package', version: '1.0.0', private: false, publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}

  // Discovery.
  eq(selectPublishableDirs([]), [], 'a repo with no manifests at all yields no candidates')
  eq(selectPublishableDirs([{dir: 'packages/sample', manifest: publishableManifest}]), ['packages/sample'])
  eq(selectPublishableDirs([{dir: '<root>', manifest: publishableManifest}]), ['<root>'],
    'a publishable ROOT manifest is a candidate: a packages/-only scan would silently pass such a repo forever')
  eq(selectPublishableDirs([{dir: 'packages/internal', manifest: {name: 'internal', private: true, publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}}]),
    [], 'private packages are not candidates')
  eq(selectPublishableDirs([{dir: 'packages/public-npm', manifest: {name: 'x', publishConfig: {registry: 'https://registry.npmjs.org'}}}]), [],
    'non-GitHub-Packages registries are not candidates')
  eq(selectPublishableDirs([{dir: 'packages/none', manifest: {name: 'x'}}]), [], 'a manifest without publishConfig.registry is not a candidate')
  eq(selectPublishableDirs([{dir: 'packages/broken', manifest: null}]), [], 'an unparseable manifest is skipped')
  // An out-of-scope name is still a candidate: the engine must see it and fail loudly on the scope assertion.
  eq(selectPublishableDirs([{dir: 'packages/rogue', manifest: {name: 'rogue', publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}}]), ['packages/rogue'])
  eq(selectPublishableDirs([{dir: 'packages/b', manifest: publishableManifest}, {dir: 'packages/a', manifest: publishableManifest}]), [
    'packages/a',
    'packages/b'
  ], 'output is ASCII-sorted')

  // Subcommand probe against a realistic Commander listing.
  const help = [
    'Usage: mantle check [options] [command]',
    '',
    'Commands:',
    '  deps                         Check dependency architecture rules',
    '  versions [options]           Compare instance dependency versions',
    '  openspec [options]           OpenSpec drift tether'
  ].join('\n')
  const helpWithSubcommand = `${help}\n  package-versions [options]   Detect published-package version drift`
  eq(helpListsSubcommand(help, SUBCOMMAND), false, 'the bare `versions` entry must NOT satisfy the package-versions probe')
  eq(helpListsSubcommand(helpWithSubcommand, SUBCOMMAND), true)
  eq(helpListsSubcommand(`${help}\n  package-versions`, SUBCOMMAND), true, 'a subcommand printed with no trailing description still matches')
  eq(helpListsSubcommand('', SUBCOMMAND), false)
  eq(helpListsSubcommand(help, 'versions'), true, 'the probe finds a subcommand that IS present')

  // Probe classification. These are the vectors the previous revision had no way to express,
  // because it read only the probe's text and threw away .error/.status/.signal.
  const probe = (overrides) => classifyProbe({error: null, status: 0, signal: null, helpText: help, subcommand: SUBCOMMAND, ...overrides})
  eq(probe({helpText: helpWithSubcommand}), {outcome: 'available', reason: 'subcommand-listed'})
  eq(probe({}), {outcome: 'subcommand-missing', reason: 'subcommand-not-listed'},
    'the engine ran but has no such subcommand — a real, distinct, NON-PASSING state')
  eq(probe({error: Object.assign(new Error('spawn npx ENOENT'), {code: 'ENOENT'})}), {outcome: 'engine-unavailable', reason: 'probe-spawn-failed'},
    'npx missing from PATH must not read as "subcommand not yet released"')
  eq(probe({status: 127, helpText: 'command not found: npx'}), {outcome: 'engine-unavailable', reason: 'probe-nonzero-exit'},
    'a non-zero probe exit is engine-unavailable, not subcommand-missing')
  eq(probe({status: 1, helpText: 'ERR_PNPM_FETCH_403  GET https://npm.pkg.github.com/@j0nathan-ll0yd%2Fcli: Forbidden'}), {
    outcome: 'engine-unavailable',
    reason: 'probe-nonzero-exit'
  }, 'a 403 that prevented the CLI from installing is engine-unavailable')
  eq(probe({status: null, signal: 'SIGKILL'}), {outcome: 'engine-unavailable', reason: 'probe-killed-by-signal'})
  eq(probe({helpText: ''}), {outcome: 'engine-unavailable', reason: 'probe-empty-output'},
    'a probe that exits 0 printing nothing is a broken binary, not a missing subcommand')
  eq(probe({helpText: '   \n  '}), {outcome: 'engine-unavailable', reason: 'probe-empty-output'})

  // Delegated-run classification.
  const run = (overrides) => classifyDelegatedRun({error: null, status: 0, signal: null, ...overrides})
  eq(run({}), {exitCode: 0, reason: 'engine-verdict'})
  eq(run({status: 2}), {exitCode: 2, reason: 'engine-verdict'}, 'the engine exit status is forwarded verbatim, never remapped')
  eq(run({status: 4}), {exitCode: 4, reason: 'engine-verdict'}, 'an exit class this wrapper has never heard of still forwards intact')
  eq(run({error: Object.assign(new Error('spawn npx ENOENT'), {code: 'ENOENT'})}), {exitCode: EXIT_INDETERMINATE, reason: 'engine-spawn-failed'})
  eq(run({status: null, signal: 'SIGKILL'}), {exitCode: EXIT_INDETERMINATE, reason: 'engine-killed-by-signal'},
    'an OOM-killed engine is INDETERMINATE — `status ?? 1` would have called it drift, `status ?? 0` would have called it clean')
  eq(run({status: null}), {exitCode: EXIT_INDETERMINATE, reason: 'engine-no-exit-status'})

  // THE INVARIANT. Enumerated over every failure shape rather than asserted per case, so a
  // future edit that reintroduces a silent pass fails here even if it also updates the case
  // above it. This is the assertion that would have caught the defect being fixed.
  const failureShapes = [
    {error: new Error('ENOENT')},
    {status: 1},
    {status: 127},
    {status: null, signal: 'SIGKILL'},
    {status: null, signal: 'SIGTERM'},
    {status: null},
    {status: undefined},
    {helpText: ''},
    {helpText: help} // engine present, subcommand absent — the live state of this repo today
  ]
  for (const shape of failureShapes) {
    const label = JSON.stringify(shape, (_key, value) => (value instanceof Error ? 'Error' : value))
    assert.notEqual(probe(shape).outcome, 'available', `probe must not report 'available' for ${label}`)
    checks++
    if (!('helpText' in shape)) {
      assert.notEqual(classifyDelegatedRun({error: null, status: 0, signal: null, ...shape}).exitCode, 0,
        `a delegated run that produced no verdict must not exit 0 for ${label}`)
      checks++
    }
  }

  console.log(`check-package-versions self-test: ${checks} known-answer assertions passed.`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function failIndeterminate(headline, detail) {
  // `::error::` surfaces the reason as an annotation on the PR itself rather than burying it
  // in a log fold; outside Actions the prefix would just be noise.
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''
  console.error('')
  console.error(`${prefix}INDETERMINATE: ${headline}`)
  for (const line of detail) {
    console.error(`  ${line}`)
  }
  console.error('  This is NOT a pass. The published-package drift gate did not run, so nothing here')
  console.error('  says the payload matches the registry. Exiting 3.')
  process.exit(EXIT_INDETERMINATE)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    await selfTest()
    return
  }

  const publishableDirs = selectPublishableDirs(readCandidateEntries(repoRoot))
  if (publishableDirs.length === 0) {
    console.log('check-package-versions: this repo publishes no packages (neither the root manifest nor any entry')
    console.log(`  under packages/ is both non-private and targeted at ${GITHUB_PACKAGES_REGISTRY}).`)
    console.log('  Nothing can drift, so nothing to check. The gate engages automatically as soon as such a')
    console.log('  package is added — no edit to this script needed.')
    process.exit(0)
  }

  console.log(`check-package-versions: ${publishableDirs.length} publishable package(s): ${publishableDirs.join(', ')}`)

  const help = spawnSync('npx', ['mantle', 'check', '--help'], {cwd: repoRoot, encoding: 'utf8'})
  const probe = classifyProbe({
    error: help.error,
    status: help.status,
    signal: help.signal,
    helpText: `${help.stdout ?? ''}${help.stderr ?? ''}`,
    subcommand: SUBCOMMAND
  })
  const installed = readInstalledCliVersion(repoRoot) ?? 'unreadable'

  if (probe.outcome === 'engine-unavailable') {
    failIndeterminate(`could not probe \`mantle check\` for the ${SUBCOMMAND} subcommand (${probe.reason}).`, [
      `Installed @j0nathan-ll0yd/cli: ${installed}.`,
      help.error === undefined ? `Probe exit status: ${help.status}, signal: ${help.signal}.` : `Probe spawn error: ${help.error.message}.`,
      'The engine itself could not be reached — this is an environment failure (npx missing, dependencies',
      'not installed, GitHub Packages returning 401/403), NOT a statement about package drift.',
      'Fix: `pnpm install --frozen-lockfile` with a token that can read npm.pkg.github.com, then re-run.'
    ])
  }

  if (probe.outcome === 'subcommand-missing') {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` does not exist in the installed CLI (${installed}).`, [
      `The drift engine ships in @j0nathan-ll0yd/cli >= ${CLI_FLOOR_VERSION_HINT}.`,
      'Fix: bump @j0nathan-ll0yd/cli in this repo to a release that carries the subcommand.',
      'ORDERING (this is a hard dependency, not a preference): mantle#308 must MERGE and the',
      '  @j0nathan-ll0yd/cli release must PUBLISH to GitHub Packages before that bump is possible.',
      'If the subcommand shipped under a different name, correct SUBCOMMAND in this script.',
      'Deliberately not skippable: this wrapper previously exited 0 here, and in mantle-LifegamesPortal',
      '  that exit 0 fed the REQUIRED "CI Gate" context — a green required gate for a check that never ran.'
    ])
  }

  const forwarded = argv.filter((arg) => arg !== '--self-test')
  const result = spawnSync('npx', ['mantle', 'check', SUBCOMMAND, ...forwarded], {cwd: repoRoot, stdio: 'inherit'})
  const delegated = classifyDelegatedRun({error: result.error, status: result.status, signal: result.signal})

  if (delegated.reason !== 'engine-verdict') {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` did not produce a verdict (${delegated.reason}).`, [
      result.error === undefined ? `Exit status: ${result.status}, signal: ${result.signal}.` : `Spawn error: ${result.error.message}.`,
      'A run that was killed or never started says nothing about whether the payload drifted.'
    ])
  }

  process.exit(delegated.exitCode)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
