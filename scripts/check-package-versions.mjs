#!/usr/bin/env node
/* global console, process */
/*
 * Published-package version-drift gate (consumer-repo wrapper).
 *
 * THE FAILURE THIS PREVENTS: an agent edits source inside a published package, merges, and
 * never bumps the `version`. Nothing goes red — typecheck, tests, lint and the PR all pass,
 * and `changeset publish` SILENTLY SKIPS a version that already exists in the registry and
 * exits 0. Consumers keep resolving the old tarball forever. The verdict itself is owned by
 * `mantle check package-versions`, which compares each publishable package's payload against
 * the commit that last SET its declared version.
 *
 * WHY A WRAPPER RATHER THAN CALLING THE CLI DIRECTLY (two reasons, both load-bearing):
 *
 *   1. EMPTY SET. The estate-wide check treats "zero publishable packages" as a hard error
 *      (the A2b anti-vacuous-pass guard: the Mantle framework repo knows it has 17 packages,
 *      so discovering none means discovery broke). That guard is correct there and WRONG in a
 *      consumer app repo, where publishing nothing is the normal steady state. A gate that
 *      errors on an empty set gets deleted the first week. This wrapper therefore owns the
 *      "is this repo even in scope" question — using the canonical four-part discovery
 *      predicate, byte-for-byte — and only delegates the verdict when there is something to
 *      verify. The moment this repo adds an entry under packages/ that is non-private and
 *      publishes to npm.pkg.github.com, the gate engages with no edit needed here.
 *
 *   2. BOUNDED ROLLOUT. `mantle check package-versions` is landing in the j0nathan-ll0yd/cli
 *      package in a separate change. Until this repo's pinned CLI carries it, invoking it
 *      unconditionally would red-wall every PR on a command that does not exist. The wrapper
 *      probes for the subcommand and skips LOUDLY while it is absent — but the skip window is
 *      BOUNDED on two independent axes, because "a gate that can never fail is as dangerous
 *      as one that never runs" (A2b):
 *        a. If the installed CLI is at or past CLI_FLOOR_VERSION and the subcommand is STILL
 *           missing, that is a broken assumption (released without it, or renamed) and the
 *           check exits 1.
 *        b. On or after SKIP_WINDOW_ENDS_ON a missing subcommand is a hard failure regardless
 *           of the installed version.
 *      Bumping the CLI past the floor activates the real gate automatically; the deadline
 *      guarantees the shim cannot silently outlive the CLI release.
 *
 * Every extra argument is forwarded verbatim to the CLI, e.g. `--base origin/main`, `--json`.
 *
 * Exit 0 = nothing publishable, or no drift, or the bounded pre-release skip.
 * Exit 1 = drift found, or the skip window has closed.
 * Exit 2 = the CLI could not determine an answer (e.g. shallow history — CI must use
 *          actions/checkout with `fetch-depth: 0`).
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

/** First CLI release expected to carry SUBCOMMAND. A new subcommand is a feature, so a minor bump off 1.2.0. */
const CLI_FLOOR_VERSION = '1.3.0'

/** Hard end of the pre-release skip window (ISO date, UTC). After this, a missing subcommand fails the build. */
const SKIP_WINDOW_ENDS_ON = '2026-10-01'

// ---------------------------------------------------------------------------
// Pure functions (no fs, no spawn) — everything below is covered by --self-test.
// ---------------------------------------------------------------------------

/**
 * The canonical publishable-package predicate, applied to already-read manifests. Mirrors
 * mantle/scripts/check-public-packages.mjs lines 68-76 exactly: non-private AND
 * publishConfig.registry an exact match for GitHub Packages. An unreadable or unparseable
 * manifest arrives as null and is silently skipped, exactly as it is there.
 *
 * Deliberately does NOT filter on the package name: a candidate outside the j0nathan-ll0yd
 * scope must reach the CLI so the CLI's scope assertion can fail loudly, rather than being
 * silently dropped here.
 *
 * Takes entries carrying `dir` and `manifest` (the parsed manifest, or null) and returns the
 * matching directory names, ASCII-ascending.
 */
export function selectPublishableDirs(entries) {
  return entries.filter((entry) =>
    entry.manifest != null && entry.manifest.private !== true && entry.manifest.publishConfig?.registry === GITHUB_PACKAGES_REGISTRY
  ).map((entry) => entry.dir).sort()
}

/** Parse a semver core into a major/minor/patch triple, or null. Prerelease and build metadata are ignored. */
export function parseSemverCore(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two semver cores, returning -1, 0 or 1. Unparseable input sorts as lower. */
export function compareSemver(a, b) {
  const left = parseSemverCore(a)
  const right = parseSemverCore(b)
  if (left === null && right === null) {
    return 0
  }
  if (left === null) {
    return -1
  }
  if (right === null) {
    return 1
  }
  const [leftMajor, leftMinor, leftPatch] = left
  const [rightMajor, rightMinor, rightPatch] = right
  if (leftMajor !== rightMajor) {
    return leftMajor < rightMajor ? -1 : 1
  }
  if (leftMinor !== rightMinor) {
    return leftMinor < rightMinor ? -1 : 1
  }
  if (leftPatch !== rightPatch) {
    return leftPatch < rightPatch ? -1 : 1
  }
  return 0
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
 * What to do when the CLI does not (yet) expose the subcommand. Pure over the two bounding
 * axes of the skip window so both can be known-answer tested.
 *
 * Takes `installedCliVersion` (or null when unreadable), `floorVersion`, and the ISO dates
 * `today` and `skipWindowEndsOn` (ISO dates compare correctly as plain strings). Returns an
 * `action` of either 'skip' or 'fail' plus a stable `reason` slug.
 */
export function decideMissingSubcommandAction({installedCliVersion, floorVersion, today, skipWindowEndsOn}) {
  if (today >= skipWindowEndsOn) {
    return {action: 'fail', reason: 'skip-window-closed'}
  }
  if (installedCliVersion !== null && compareSemver(installedCliVersion, floorVersion) >= 0) {
    return {action: 'fail', reason: 'cli-at-or-past-floor-without-subcommand'}
  }
  return {action: 'skip', reason: 'cli-below-floor'}
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the manifest of every directory one level under packages/. A missing packages/ yields an empty list. */
function readPackageEntries(root) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) {
    return []
  }
  return readdirSync(packagesDir, {withFileTypes: true}).filter((entry) => entry.isDirectory()).map((entry) => {
    try {
      return {dir: entry.name, manifest: JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'))}
    } catch {
      return {dir: entry.name, manifest: null}
    }
  })
}

/** Installed CLI version, or null when it cannot be read. */
function readInstalledCliVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', '@j0nathan-ll0yd', 'cli', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function todayIsoUtc() {
  return new Date().toISOString().slice(0, 10)
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

  const publishableManifest = {
    name: '@j0nathan-ll0yd/sample-package',
    version: '1.0.0',
    private: false,
    publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}
  }

  // Discovery — the no-publishable-packages case and the one-publishable-package case.
  eq(selectPublishableDirs([]), [], 'a repo with no packages directory yields no candidates')
  eq(selectPublishableDirs([{dir: 'sample-package', manifest: publishableManifest}]), ['sample-package'])
  eq(selectPublishableDirs([{dir: 'internal', manifest: {name: 'internal', private: true, publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}}]), [],
    'private packages are not candidates')
  eq(selectPublishableDirs([{dir: 'public-npm', manifest: {name: 'x', publishConfig: {registry: 'https://registry.npmjs.org'}}}]), [],
    'non-GitHub-Packages registries are not candidates')
  eq(selectPublishableDirs([{dir: 'no-publish-config', manifest: {name: 'x'}}]), [], 'a manifest without publishConfig.registry is not a candidate')
  eq(selectPublishableDirs([{dir: 'broken', manifest: null}]), [], 'an unparseable manifest is silently skipped')
  // An out-of-scope name is still a candidate: the CLI must see it and fail loudly on the scope assertion.
  eq(selectPublishableDirs([{dir: 'rogue', manifest: {name: 'rogue', publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}}]), ['rogue'])
  eq(selectPublishableDirs([{dir: 'b', manifest: publishableManifest}, {dir: 'a', manifest: publishableManifest}]), ['a', 'b'], 'output is ASCII-sorted')

  // Semver comparison.
  eq(compareSemver('1.0.0', '1.3.0'), -1)
  eq(compareSemver('1.3.0', '1.3.0'), 0)
  eq(compareSemver('1.10.0', '1.3.0'), 1, 'minor versions compare numerically, not lexicographically')
  eq(compareSemver('2.0.0', '1.3.0'), 1)
  eq(compareSemver('1.3.0-rc.1', '1.3.0'), 0, 'prerelease metadata is ignored')
  eq(compareSemver(null, '1.3.0'), -1, 'an unreadable version sorts below the floor')

  // Subcommand probe against a realistic Commander listing.
  const help = [
    'Usage: mantle check [options] [command]',
    '',
    'Commands:',
    '  deps                         Check dependency architecture rules',
    '  versions [options]           Compare instance dependency versions',
    '  openspec [options]           OpenSpec drift tether'
  ].join('\n')
  eq(helpListsSubcommand(help, SUBCOMMAND), false, 'the bare `versions` entry must NOT satisfy the package-versions probe')
  eq(helpListsSubcommand(`${help}\n  package-versions [options]   Detect published-package version drift`, SUBCOMMAND), true)
  eq(helpListsSubcommand(`${help}\n  package-versions`, SUBCOMMAND), true, 'a subcommand printed with no trailing description still matches')
  eq(helpListsSubcommand('', SUBCOMMAND), false)
  eq(helpListsSubcommand(help, 'versions'), true, 'the probe finds a subcommand that IS present')

  // The two bounding axes of the pre-release skip window.
  const within = {floorVersion: '1.3.0', today: '2026-08-03', skipWindowEndsOn: '2026-10-01'}
  eq(decideMissingSubcommandAction({...within, installedCliVersion: '1.0.0'}), {action: 'skip', reason: 'cli-below-floor'})
  eq(decideMissingSubcommandAction({...within, installedCliVersion: null}), {action: 'skip', reason: 'cli-below-floor'})
  eq(decideMissingSubcommandAction({...within, installedCliVersion: '1.3.0'}), {action: 'fail', reason: 'cli-at-or-past-floor-without-subcommand'},
    'a CLI at the floor without the subcommand is a broken assumption, not a skip')
  eq(decideMissingSubcommandAction({...within, installedCliVersion: '2.0.0'}), {action: 'fail', reason: 'cli-at-or-past-floor-without-subcommand'})
  eq(decideMissingSubcommandAction({...within, today: '2026-10-01', installedCliVersion: '1.0.0'}), {action: 'fail', reason: 'skip-window-closed'},
    'the deadline closes the window regardless of the installed version')
  eq(decideMissingSubcommandAction({...within, today: '2027-01-01', installedCliVersion: '1.0.0'}), {action: 'fail', reason: 'skip-window-closed'})

  console.log(`check-package-versions self-test: ${checks} known-answer assertions passed.`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    await selfTest()
    return
  }

  const publishableDirs = selectPublishableDirs(readPackageEntries(repoRoot))
  if (publishableDirs.length === 0) {
    console.log('check-package-versions: this repo publishes no packages (no entry under packages/ is both non-private')
    console.log(`  and targeted at ${GITHUB_PACKAGES_REGISTRY}). Nothing can drift, so nothing to check.`)
    console.log('  The gate engages automatically as soon as such a package is added — no edit to this script needed.')
    process.exit(0)
  }

  console.log(`check-package-versions: ${publishableDirs.length} publishable package(s): ${publishableDirs.join(', ')}`)

  const help = spawnSync('npx', ['mantle', 'check', '--help'], {cwd: repoRoot, encoding: 'utf8'})
  const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`

  if (!helpListsSubcommand(helpText, SUBCOMMAND)) {
    const installedCliVersion = readInstalledCliVersion(repoRoot)
    const decision = decideMissingSubcommandAction({
      installedCliVersion,
      floorVersion: CLI_FLOOR_VERSION,
      today: todayIsoUtc(),
      skipWindowEndsOn: SKIP_WINDOW_ENDS_ON
    })
    const installed = installedCliVersion ?? 'unknown'

    if (decision.action === 'fail') {
      console.error('')
      console.error(`FAIL: \`mantle check ${SUBCOMMAND}\` is not available (installed CLI: ${installed}).`)
      console.error(decision.reason === 'skip-window-closed'
        ? `  The pre-release skip window closed on ${SKIP_WINDOW_ENDS_ON}. The published-package drift gate has not run since then.`
        : `  The installed CLI is at or past ${CLI_FLOOR_VERSION}, which was expected to carry this subcommand.`)
      console.error('  Fix: upgrade the CLI to a release that provides that subcommand, or correct SUBCOMMAND /')
      console.error('  CLI_FLOOR_VERSION in this script if it shipped under a different name.')
      process.exit(1)
    }

    // `::warning::` is a GitHub Actions annotation, so the skip is visible on the PR itself
    // rather than buried in a log; outside Actions it would just be confusing noise.
    const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'WARNING: '
    console.log('')
    console.log(`${prefix}mantle check ${SUBCOMMAND} is not in the installed CLI (${installed}) yet — published-package drift is NOT being checked.`)
    console.log(`  Skipping until the pinned CLI reaches ${CLI_FLOOR_VERSION}. This skip becomes a hard failure on ${SKIP_WINDOW_ENDS_ON}.`)
    process.exit(0)
  }

  const forwarded = argv.filter((arg) => arg !== '--self-test')
  const result = spawnSync('npx', ['mantle', 'check', SUBCOMMAND, ...forwarded], {cwd: repoRoot, stdio: 'inherit'})
  if (result.error !== undefined) {
    console.error(`FAIL: could not run \`mantle check ${SUBCOMMAND}\`: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
