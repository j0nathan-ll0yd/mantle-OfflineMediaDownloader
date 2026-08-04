#!/usr/bin/env node
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
 * would publish. This file is a thin wrapper: it answers "what does this repo publish", then
 * delegates the verdict and AUDITS THE REPORT IT GETS BACK. It deliberately does NOT
 * reimplement the payload comparison — parallel implementations of that algorithm have
 * already diverged three ways in this estate, and a consumer repo carrying its own copy would
 * drift from the engine silently.
 *
 * ── THE TWO THINGS THIS WRAPPER CONCLUDES ON ITS OWN ────────────────────────────────────
 *
 * 1. "This repo publishes nothing, so nothing can drift." A real, verifiable answer; exit 0.
 *
 * 2. "The engine's report does not cover what this repo publishes, so its 0 means nothing."
 *    Exit 3. This is the load-bearing half, and it exists because of a MEASURED defect:
 *
 *      $ node .../packages/cli/dist/index.mjs check package-versions --cwd .   # in mantle-LifegamesPortal
 *      Package                  Declared   Reference  Verdict
 *      mantle-lifegames-portal  0.0.1      -          SKIPPED
 *      1 workspace package(s): 1 SKIPPED
 *      EXIT=0
 *
 *    The engine enumerates the workspace with `pnpm list -r --depth -1 --json`. That repo's
 *    pnpm-workspace.yaml carries no `packages:` key, so that returns the ROOT ALONE — the root
 *    is private, so zero publishable packages are found and the engine exits 0 having examined
 *    NOTHING. Meanwhile packages/portal-contract is non-private, targets GitHub Packages, and
 *    is published on every release. "I found nothing" rendered as "all clean", into a REQUIRED
 *    status context. The wrapper's own manifest scan does not go through pnpm, so it sees
 *    portal-contract; comparing the two is what turns that silent pass into a loud failure.
 *
 * EVERY OTHER outcome in which the wrapper did not obtain a TRUSTWORTHY verdict from the
 * engine — the engine is not installed, the probe could not run, the engine crashed or was
 * killed, the engine exited 0 with a report that does not cover this repo — exits 3
 * (INDETERMINATE). It is NEVER exit 0.
 *
 * There is no such thing as a warning that a merge queue reads. The only signal CI understands
 * is the exit code, so "I could not tell" must be non-zero.
 *
 * ── WHY THE DIGEST SPEC VERSION IS ASSERTED, NOT LOGGED ─────────────────────────────────
 *
 * The engine reports the `specVersion` of the payload-normalization rule it applied. This
 * wrapper requires REQUIRED_SPEC_VERSION and treats any other value as INDETERMINATE, because
 * a wrong rule produces a CONFIDENT WRONG ANSWER rather than an error. Measured on
 * @j0nathan-ll0yd/portal-contract@1.0.0 (the one package mantle-LifegamesPortal publishes), whose
 * published tarball and
 * `pnpm pack` of the unmodified source differ in the manifest alone:
 *
 *   spec 2 rule (strip `version` only)      registry ec9ff0b96a1b41b7  head 15b6c82ec57ef5d7  -> DRIFT
 *   spec 3 rule (canonical, +6 scripts)     registry 6044cfd8672bf781  head 6044cfd8672bf781  -> CLEAN
 *
 * The package is CLEAN. Spec 2 calls it DRIFT because the registry copy was uploaded by
 * `npm publish` (which strips no scripts) while the gate measures HEAD with `pnpm pack` (which
 * strips exactly six publish-only scripts, here `prepublishOnly`). An engine on the wrong spec
 * would red every PR in this repo over a package nobody touched — and the fix for THAT is
 * always "make the gate stop complaining", which is how a gate gets deleted. Pinning the spec
 * makes the mismatch report itself as a mismatch.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────────────────
 *
 *   0  Nothing publishable in this repo, or the engine ran, covered everything this repo
 *      publishes, and reported no drift.
 *   3  INDETERMINATE — the wrapper could not obtain a verdict it can trust. Never a pass.
 *   *  Anything else is the engine's own exit status, forwarded VERBATIM. The wrapper does
 *      not translate it: the engine owns its exit-code contract and remapping here would
 *      silently rewrite the severity of a verdict whenever that contract evolves.
 *
 * The coverage audit only ever UPGRADES a zero to a 3. A non-zero engine status is already
 * failing loudly and is forwarded intact, with any coverage problems printed as context.
 *
 * Extra arguments are forwarded verbatim to the engine, e.g. `--lane=pre-push`. `--json` is
 * always passed (the wrapper needs the machine-readable report to audit coverage); pass
 * `--json` yourself to get the engine's document on stdout instead of the rendered table.
 *
 * Run `node scripts/check-package-versions.mjs --self-test` for the known-answer vectors, and
 * `node --test scripts/__tests__/check-package-versions.spawn.test.mjs` for the tests that
 * spawn this file as a real process and assert its real exit code.
 */

import {spawnSync} from 'node:child_process'
import {readFileSync, realpathSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/** Exact registry string from the canonical discovery predicate in mantle's check-public-packages.mjs. */
const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com'

/** The `mantle check` subcommand that owns the drift verdict. */
const SUBCOMMAND = 'package-versions'

/**
 * The payload-normalization rule this repo's packages must be measured under. Canonical
 * definition and the measurements behind it: atlas `contracts/package-digest/`. See the
 * spec-version note in the header for why this is a hard assertion rather than a log line.
 */
const REQUIRED_SPEC_VERSION = 3

/**
 * First `@j0nathan-ll0yd/cli` release expected to carry SUBCOMMAND. DIAGNOSTIC ONLY — it is
 * printed in the failure message so the fix is self-service. It is deliberately NOT a
 * control-flow gate: a version floor used as a gate is just a skip window wearing a
 * different hat, and every skip window eventually outlives the release it was waiting for.
 */
const CLI_FLOOR_VERSION_HINT = '1.3.0'

/** INDETERMINATE. Aligned with the engine's exit class for "could not tell". */
const EXIT_INDETERMINATE = 3

/** The verdict that means "the engine chose not to examine this package". */
const SKIPPED = 'SKIPPED'

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
 * Takes entries carrying `dir` and `manifest` (the parsed manifest, or null) and returns
 * `{dir, name}` for the matches, ASCII-ascending by dir. `name` is carried because it is how
 * the coverage audit joins against the engine's report — package names are unique and
 * authoritative, whereas the two sides could spell a path differently.
 */
export function selectPublishablePackages(entries) {
  return entries.filter((entry) =>
    entry.manifest != null && entry.manifest.private !== true && entry.manifest.publishConfig?.registry === GITHUB_PACKAGES_REGISTRY
  ).map((entry) => ({dir: entry.dir, name: typeof entry.manifest.name === 'string' ? entry.manifest.name : null})).sort((left, right) =>
    left.dir < right.dir ? -1 : (left.dir > right.dir ? 1 : 0)
  )
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
 * This exists because of a specific defect: an earlier revision read only `stdout`/`stderr`
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

/**
 * Recover the engine's JSON report from its captured stdout.
 *
 * Tolerant of leading noise on purpose. A sibling implementation of this gate in another repo
 * streams ~33KB of workspace-build output to stdout ahead of its JSON document, so
 * `JSON.parse(stdout)` throws on a perfectly healthy run. Rather than assume this engine never
 * acquires that habit, the parser retries from every line that is exactly `{` — the shape
 * `JSON.stringify(value, null, 2)` always starts with.
 *
 * Returns `{report, reason}`; exactly one is non-null. A report without a `rows` array is
 * rejected rather than treated as an empty report, because "zero rows" is precisely the shape
 * of the silent pass this wrapper exists to catch.
 */
export function parseEngineReport(stdout) {
  const text = String(stdout ?? '')
  if (text.trim() === '') {
    return {report: null, reason: 'engine-report-absent'}
  }
  const candidates = [text.trim()]
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '{') {
      candidates.push(text.slice(offset))
    }
    offset += line.length + 1
  }
  let sawObject = false
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue
    }
    sawObject = true
    if (Array.isArray(parsed.rows)) {
      return {report: parsed, reason: null}
    }
  }
  return {report: null, reason: sawObject ? 'engine-report-has-no-rows' : 'engine-report-unparseable'}
}

/**
 * THE COVERAGE AUDIT. Compare what this repo publishes (discovered here, without pnpm) against
 * what the engine says it examined, and return a human-readable problem per mismatch.
 *
 * An empty return value is the ONLY thing that lets an engine exit 0 through this wrapper.
 *
 * Two distinct mismatches, both of which have to be failures:
 *   - no row at all — the engine's enumeration never saw the package (the measured X1 defect);
 *   - a SKIPPED row — the engine saw it and declined to examine it, while this wrapper
 *     independently determined it is non-private and targeted at GitHub Packages. One of the
 *     two is wrong, and neither answer is "clean".
 *
 * The spec-version assertion is folded in here because it is the same class of problem: a
 * report that cannot be trusted to mean what it says.
 */
export function auditCoverage({discovered, report, requiredSpecVersion}) {
  const problems = []
  const rows = Array.isArray(report?.rows) ? report.rows : []
  if (report?.specVersion !== requiredSpecVersion) {
    problems.push(
      `the engine measured under digest spec v${String(report?.specVersion ?? 'unknown')}, but this repo requires v${String(requiredSpecVersion)}. ` +
        'A different normalization rule does not produce an error, it produces a confident wrong answer.'
    )
  }
  for (const pkg of discovered) {
    const row = rows.find((candidate) => candidate?.name != null && candidate.name === pkg.name) ?? rows.find((candidate) => candidate?.path === pkg.dir)
    const label = `${pkg.name ?? '(unnamed)'} (${pkg.dir})`
    if (row === undefined) {
      problems.push(`${label} is published from this repo, but the engine's report has NO ROW for it — it was never examined.`)
    } else if (row.verdict === SKIPPED) {
      problems.push(`${label} is published from this repo, but the engine reported ${SKIPPED}: ${String(row.detail ?? 'no reason given')}.`)
    }
  }
  return problems
}

/**
 * Render the engine's rows as a table. The wrapper always asks the engine for `--json` (it
 * needs the machine-readable report to audit coverage), which means the engine's own pretty
 * printer never runs — so the wrapper reproduces a compact equivalent rather than leaving CI
 * logs with nothing but a JSON blob.
 */
export function formatReportTable(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : []
  const pad = (value, width) => String(value ?? '-').padEnd(width)
  const nameWidth = Math.max(20, ...rows.map((row) => String(row?.name ?? '-').length))
  const declaredWidth = Math.max(9, ...rows.map((row) => String(row?.declared ?? '-').length))
  const referenceWidth = Math.max(9, ...rows.map((row) => String(row?.referenceVersion ?? '-').length))
  const lines = [
    `Published-payload drift vs ${String(report?.registry ?? 'unknown registry')} (lane=${String(report?.lane ?? '?')}, spec v${
      String(report?.specVersion ?? '?')
    })`,
    '',
    [pad('Package', nameWidth), pad('Declared', declaredWidth), pad('Reference', referenceWidth), 'Verdict'].join('  '),
    ['-'.repeat(nameWidth), '-'.repeat(declaredWidth), '-'.repeat(referenceWidth), '-'.repeat(18)].join('  ')
  ]
  for (const row of rows) {
    lines.push(
      [pad(row?.name, nameWidth), pad(row?.declared, declaredWidth), pad(row?.referenceVersion, referenceWidth), String(row?.verdict ?? '?')].join('  ')
    )
    if (row?.detail != null && row.verdict !== 'CLEAN') {
      lines.push(`    ${String(row.detail)}`)
    }
    for (const path of Array.isArray(row?.differingFiles) ? row.differingFiles : []) {
      lines.push(`    differs  ${String(path)}`)
    }
    for (const path of Array.isArray(row?.leakedPaths) ? row.leakedPaths : []) {
      lines.push(`    leaked   ${String(path)}`)
    }
  }
  return lines
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
 * Every manifest in the repo, from git rather than from a package manager or a hand-rolled
 * directory walk.
 *
 * `git ls-files --cached --others --exclude-standard` is the enumeration that matches what a
 * reviewer would call "the files in this repo": it includes tracked files AND new untracked
 * ones (so a package added in the working tree is covered on the very first run), and it
 * excludes everything .gitignore excludes (so node_modules, dist and coverage never appear).
 * Git's pathspec `*` crosses directory separators (unlike a shell glob), so the second pathspec
 * passed below reaches a manifest at any depth, not just one level under the root.
 *
 * A `pnpm list -r --depth -1 --json` enumeration was evaluated and REJECTED, and the
 * measurement is worth recording because it contradicts the obvious assumption. Measured in
 * mantle-LifegamesPortal: packages/portal-contract is NOT a pnpm workspace member there. pnpm-workspace.yaml
 * carries no `packages:` key (it is a settings-only file — "this repo is a single-package
 * project") and portal-contract carries its OWN pnpm-workspace.yaml and pnpm-lock.yaml, i.e.
 * it is a self-contained nested project by design. So `pnpm list -r` returns the root alone,
 * and `pnpm --filter` on the contract package prints "No projects matched the filters" AND
 * EXITS 0. Discovering through pnpm reports that repo as publishing nothing — which is exactly
 * the defect the coverage audit above catches in the engine.
 *
 * A `packages/*` scan was also rejected: it answers correctly here by luck of layout, and a
 * publishable package one directory elsewhere would be silently invisible. Since "this repo
 * publishes nothing" is the ONE conclusion this wrapper is allowed to reach on its own, its
 * enumeration has to be exhaustive rather than conventional.
 *
 * Returns null when git could not answer, which the caller treats as INDETERMINATE. It never
 * degrades to a partial scan: a partial scan's failure mode is a silent pass.
 */
function readCandidateEntries(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'package.json', '*/package.json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error != null || result.status !== 0) {
    return null
  }
  const entries = []
  for (const path of result.stdout.split('\0')) {
    if (path === '' || path.split('/').includes('node_modules')) {
      continue
    }
    entries.push({dir: path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length), manifest: readManifest(join(root, path))})
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
  eq(selectPublishablePackages([]), [], 'a repo with no manifests at all yields no candidates')
  eq(selectPublishablePackages([{dir: 'packages/sample', manifest: publishableManifest}]), [{
    dir: 'packages/sample',
    name: '@j0nathan-ll0yd/sample-package'
  }])
  eq(selectPublishablePackages([{dir: '.', manifest: publishableManifest}]), [{dir: '.', name: '@j0nathan-ll0yd/sample-package'}],
    'a publishable ROOT manifest is a candidate: skipping it would silently pass such a repo forever')
  eq(
    selectPublishablePackages([{
      dir: 'packages/internal',
      manifest: {name: 'internal', private: true, publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}
    }]),
    [],
    'private packages are not candidates'
  )
  eq(selectPublishablePackages([{dir: 'packages/public-npm', manifest: {name: 'x', publishConfig: {registry: 'https://registry.npmjs.org'}}}]), [],
    'non-GitHub-Packages registries are not candidates')
  eq(selectPublishablePackages([{dir: 'packages/none', manifest: {name: 'x'}}]), [], 'a manifest without publishConfig.registry is not a candidate')
  eq(selectPublishablePackages([{dir: 'packages/broken', manifest: null}]), [], 'an unparseable manifest is skipped')
  // An out-of-scope name is still a candidate: the engine must see it and fail loudly on the scope assertion.
  eq(selectPublishablePackages([{dir: 'packages/rogue', manifest: {name: 'rogue', publishConfig: {registry: GITHUB_PACKAGES_REGISTRY}}}]), [{
    dir: 'packages/rogue',
    name: 'rogue'
  }])
  eq(
    selectPublishablePackages([{dir: 'packages/b', manifest: publishableManifest}, {dir: 'packages/a', manifest: publishableManifest}]).map((pkg) =>
      pkg.dir
    ),
    [
      'packages/a',
      'packages/b'
    ],
    'output is ASCII-sorted'
  )

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

  // Probe classification. These are the vectors an earlier revision had no way to express,
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

  // Report recovery.
  const cleanReport = {
    specVersion: REQUIRED_SPEC_VERSION,
    lane: 'branch',
    registry: GITHUB_PACKAGES_REGISTRY,
    rows: [{name: '@j0nathan-ll0yd/sample-package', path: 'packages/sample', declared: '1.0.0', verdict: 'CLEAN', detail: null}]
  }
  eq(parseEngineReport(JSON.stringify(cleanReport, null, 2)), {report: cleanReport, reason: null})
  eq(parseEngineReport(`turbo build noise\nmore noise\n${JSON.stringify(cleanReport, null, 2)}`), {report: cleanReport, reason: null},
    'a build-output preamble on stdout must not defeat the parser — a sibling implementation of this gate emits ~33KB of it')
  eq(parseEngineReport(''), {report: null, reason: 'engine-report-absent'})
  eq(parseEngineReport('not json at all'), {report: null, reason: 'engine-report-unparseable'})
  eq(parseEngineReport('{"specVersion":3}'), {report: null, reason: 'engine-report-has-no-rows'},
    'a report without a rows array is rejected: "zero rows" is the exact shape of the silent pass')
  eq(parseEngineReport('[]'), {report: null, reason: 'engine-report-unparseable'})

  // THE COVERAGE AUDIT — the reason this wrapper exists in its current form.
  const discovered = [{dir: 'packages/sample', name: '@j0nathan-ll0yd/sample-package'}]
  const audit = (report) => auditCoverage({discovered, report, requiredSpecVersion: REQUIRED_SPEC_VERSION})
  eq(audit(cleanReport), [], 'a report that covers every published package with a real verdict is the only thing that passes')
  assert.equal(audit({...cleanReport, rows: []}).length, 1, 'a report with no row for a published package is a coverage failure')
  checks++
  assert.match(audit({...cleanReport, rows: []})[0], /NO ROW/, 'the message must name the defect, not just fail')
  checks++
  // The measured X1 shape: the engine enumerated only the private root and exited 0.
  const x1Report = {...cleanReport, rows: [{name: 'mantle-lifegames-portal', path: '.', declared: '0.0.1', verdict: SKIPPED, detail: 'private: true'}]}
  assert.equal(audit(x1Report).length, 1, 'the real X1 report shape (root-only, 1 SKIPPED, exit 0) must be a coverage failure')
  checks++
  const skippedRow = {...cleanReport.rows[0], verdict: SKIPPED, detail: 'private: true'}
  assert.match(audit({...cleanReport, rows: [skippedRow]})[0], /SKIPPED/,
    'a package this wrapper independently proved publishable, reported SKIPPED, is a contradiction — not a pass')
  checks++
  eq(audit({...cleanReport, rows: [{...cleanReport.rows[0], name: undefined}]}), [], 'the row join falls back to path when the engine omits a name')
  assert.equal(audit({...cleanReport, specVersion: 2}).length, 1, 'a spec-2 engine is INDETERMINATE: measured, it calls a known-clean estate package DRIFT')
  checks++
  assert.equal(audit({...cleanReport, specVersion: undefined}).length, 1, 'an engine that reports no spec version cannot be trusted either')
  checks++
  eq(auditCoverage({discovered: [], report: {...cleanReport, rows: []}, requiredSpecVersion: REQUIRED_SPEC_VERSION}), [],
    'a repo that genuinely publishes nothing is covered by an empty report')

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

  // The same enumeration for the coverage audit: no untrustworthy report shape may audit clean.
  const untrustworthyReports = [
    {...cleanReport, rows: []},
    x1Report,
    {...cleanReport, rows: [skippedRow]},
    {...cleanReport, specVersion: 1},
    {...cleanReport, specVersion: 2},
    {...cleanReport, specVersion: 4},
    {...cleanReport, specVersion: '3'},
    {...cleanReport, rows: [{name: 'some-other-package', path: 'packages/other', declared: '1.0.0', verdict: 'CLEAN', detail: null}]}
  ]
  for (const report of untrustworthyReports) {
    assert.notEqual(audit(report).length, 0, `an untrustworthy report must never audit clean: ${JSON.stringify(report)}`)
    checks++
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
  console.error('  This is NOT a pass. The published-package drift gate did not produce a verdict this repo can')
  console.error('  trust, so nothing here says the payload matches the registry. Exiting 3.')
  process.exit(EXIT_INDETERMINATE)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    await selfTest()
    return
  }

  const entries = readCandidateEntries(repoRoot)
  if (entries === null) {
    failIndeterminate("could not enumerate this repository's package manifests.", [
      '`git ls-files` failed, so the wrapper does not know what this repo publishes.',
      'It deliberately does NOT fall back to a partial directory scan: a partial scan that misses a',
      '  published package reports "this repo publishes nothing" and exits 0 — a silent pass.'
    ])
  }

  const discovered = selectPublishablePackages(entries)
  if (discovered.length === 0) {
    console.log(`check-package-versions: this repo publishes no packages (none of the ${String(entries.length)} package.json file(s) tracked by git is`)
    console.log(`  both non-private and targeted at ${GITHUB_PACKAGES_REGISTRY}).`)
    console.log('  Nothing can drift, so nothing to check. The gate engages automatically as soon as such a')
    console.log('  package is added — no edit to this script needed.')
    process.exit(0)
  }

  console.log(
    `check-package-versions: ${String(discovered.length)} publishable package(s): ${discovered.map((pkg) => `${pkg.name} (${pkg.dir})`).join(', ')}`
  )

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
      'Deliberately not skippable: an earlier revision exited 0 here, and in mantle-LifegamesPortal that',
      '  exit 0 fed the REQUIRED "CI Gate" context — a green required gate for a check that never ran.'
    ])
  }

  // `--json` is not optional for the wrapper: the coverage audit needs the machine-readable
  // report. stdout is captured for that; stderr is inherited so the engine's own diagnostics
  // reach the log unbuffered.
  const forwarded = argv.filter((arg) => arg !== '--self-test')
  const passthroughJson = forwarded.includes('--json')
  const engineArgs = passthroughJson ? forwarded : [...forwarded, '--json']
  const result = spawnSync('npx', ['mantle', 'check', SUBCOMMAND, ...engineArgs], {cwd: repoRoot, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit']})
  const delegated = classifyDelegatedRun({error: result.error, status: result.status, signal: result.signal})

  if (delegated.reason !== 'engine-verdict') {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` did not produce a verdict (${delegated.reason}).`, [
      result.error === undefined ? `Exit status: ${result.status}, signal: ${result.signal}.` : `Spawn error: ${result.error.message}.`,
      'A run that was killed or never started says nothing about whether the payload drifted.'
    ])
  }

  const {report, reason} = parseEngineReport(result.stdout)
  if (passthroughJson) {
    process.stdout.write(String(result.stdout ?? ''))
  } else if (report === null) {
    process.stdout.write(String(result.stdout ?? ''))
  } else {
    console.log('')
    for (const line of formatReportTable(report)) {
      console.log(line)
    }
    console.log('')
  }

  const problems = report === null ? [] : auditCoverage({discovered, report, requiredSpecVersion: REQUIRED_SPEC_VERSION})

  if (delegated.exitCode !== 0) {
    // The engine is already failing loudly and owns its exit-code contract, so its status is
    // forwarded intact rather than being flattened into 3. Coverage problems are still printed:
    // they change what the failure MEANS, and a reader chasing a DRIFT row needs to know the
    // report was also incomplete.
    for (const problem of problems) {
      console.error(`coverage problem (in addition to the engine's own non-zero verdict): ${problem}`)
    }
    process.exit(delegated.exitCode)
  }

  // From here the engine says "nothing wrong". That claim is only worth as much as its coverage.
  if (report === null) {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` exited 0 but produced no machine-readable report (${reason}).`, [
      'The wrapper cannot confirm the engine examined the package(s) this repo publishes:',
      ...discovered.map((pkg) => `  - ${pkg.name} (${pkg.dir})`),
      'An exit 0 the wrapper cannot corroborate is indistinguishable from an exit 0 for work never done.'
    ])
  }

  if (problems.length > 0) {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` exited 0, but its report does not cover what this repo publishes.`, [
      ...problems,
      '',
      'The engine enumerates the workspace with `pnpm list -r`. A repo whose pnpm-workspace.yaml carries no',
      '  `packages:` key enumerates as the root alone, so the engine exits 0 having examined nothing. That is',
      '  measured, not hypothetical: it is the live state of mantle-LifegamesPortal.',
      "Fix: land the engine's package-manager-independent discovery (mantle#308, X1) and bump",
      `  @j0nathan-ll0yd/cli here. Do NOT "fix" this by deleting the audit — an exit 0 from a check that`,
      '  inspected nothing is the failure this gate was built to prevent.'
    ])
  }

  process.exit(0)
}

/**
 * Run main() when this file was invoked as a script, rather than imported.
 *
 * The obvious spelling — comparing import.meta.url to a file:// URL built by concatenating
 * process.argv[1] — is a SILENT-PASS BUG, and the spawn tests caught it. import.meta.url is
 * fully resolved while
 * `process.argv[1]` is whatever the caller typed, so the two disagree whenever any path segment
 * is a symlink — on macOS `mkdtemp` alone is enough, since `/var` is a symlink to `/private/var`.
 * When they disagree, main() never runs, nothing is printed, and node exits 0: a gate that
 * passes because it did not execute. Compare resolved paths, and if either cannot be resolved,
 * RUN — for a check whose whole contract is "never exit 0 without an answer", the safe default
 * on an ambiguous invocation is to do the work.
 */
function invokedAsScript() {
  const entry = process.argv[1]
  if (entry === undefined) {
    return false
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return true
  }
}

if (invokedAsScript()) {
  await main()
}
