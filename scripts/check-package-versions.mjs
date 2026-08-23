#!/usr/bin/env node
/**
 * Delegates package-version policy to the shared Mantle engine. The repository-owned git scan
 * remains independent so tracked or new package.json files omitted by workspace discovery are
 * still caught. Missing or incompatible shared engines are indeterminate (exit 3), never clean.
 *
 * See Atlas decision 0044 and the referenced invariant and conformance tests.
 */

import {spawnSync} from 'node:child_process'
import {readFileSync, realpathSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/** Exact registry string from the canonical discovery predicate in mantle's check-public-packages.mjs. */
const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com'

/**
 * Package-name scope that marks a manifest as ours. Mirrors `PACKAGE_SCOPE` in the engine
 * (mantle packages/cli/src/commands/check/package-versions/pipeline.ts). See
 * `selectPublishablePackages` for why the wrapper has to honour the NAME as well as the registry.
 */
const PACKAGE_SCOPE = '@j0nathan-ll0yd/'

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
 * Mirrors the shared engine's publishable-package predicate: a package needs a name and must
 * not be private unless it explicitly declares a registry. Keeping this filter aligned prevents
 * the independent coverage scan from hiding packages the engine would publish.
 *
 * `registryOverride` is a test hook for the registry path.
 */
export function selectPublishablePackages(entries) {
  return entries.filter((entry) => {
    if (entry.manifest == null || entry.manifest.private === true) {
      return false
    }
    const name = typeof entry.manifest.name === 'string' ? entry.manifest.name : ''
    return name.startsWith(PACKAGE_SCOPE) || entry.manifest.publishConfig?.registry === GITHUB_PACKAGES_REGISTRY
  }).map((entry) => ({dir: entry.dir, name: typeof entry.manifest.name === 'string' ? entry.manifest.name : null})).sort((left, right) =>
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
 * Uses git rather than the workspace graph so tracked and newly added package.json files at the
 * supported depth remain visible, including nested leaf packages omitted from pnpm-workspace.
 * Discovery failure is indeterminate because an empty candidate set could be a false clean.
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
  eq(selectPublishablePackages([{dir: 'packages/none', manifest: {name: 'x'}}]), [],
    'an out-of-scope manifest with no publishConfig.registry is not a candidate')
  eq(selectPublishablePackages([{dir: 'packages/broken', manifest: null}]), [], 'an unparseable manifest is skipped')

  // D10 — THE ENGINE-ALIGNMENT VECTORS. Each of these is a manifest the ENGINE calls publishable
  // (name in scope) that the old registry-only predicate called invisible. The wrapper is the
  // engine's independent second opinion on coverage, so a package the wrapper cannot see is a
  // package the coverage audit never asks about; if the engine's enumeration also misses it, both
  // sides agree on a pass having examined nothing. These are the vectors that diverged.
  eq(selectPublishablePackages([{dir: 'packages/scoped', manifest: {name: '@j0nathan-ll0yd/scoped-no-registry', version: '1.0.0'}}]), [{
    dir: 'packages/scoped',
    name: '@j0nathan-ll0yd/scoped-no-registry'
  }], 'IN-SCOPE NAME WITH NO publishConfig.registry: the engine calls this publishable, so the wrapper must too')
  eq(
    selectPublishablePackages([{
      dir: 'packages/scoped-npmjs',
      manifest: {name: '@j0nathan-ll0yd/scoped-elsewhere', publishConfig: {registry: 'https://registry.npmjs.org'}}
    }]),
    [{dir: 'packages/scoped-npmjs', name: '@j0nathan-ll0yd/scoped-elsewhere'}],
    'the engine treats the in-scope NAME as sufficient on its own, so a different declared registry does not remove the package from coverage'
  )
  eq(selectPublishablePackages([{dir: 'packages/scoped-private', manifest: {name: '@j0nathan-ll0yd/scoped-private', private: true}}]), [],
    'private still wins over the scope signal, exactly as `isPrivate` short-circuits `inScope` in the engine')
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

/**
 * Record the INDETERMINATE verdict and print why.
 *
 * SETS `process.exitCode` AND RETURNS — it does NOT call `process.exit()`, and every caller must
 * therefore `return` immediately after calling it. See the note on `main` for the measurement
 * behind that rule.
 */
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
  process.exitCode = EXIT_INDETERMINATE
}

/**
 * Never call `process.exit()` here. CI writes through a pipe, so forced exit can truncate the
 * actionable drift row; a measured 1,801-row run stopped at 65,507 bytes. Set `process.exitCode`
 * and return so Node flushes output. Callers must return immediately after `failIndeterminate()`.
 */
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
    return
  }

  const discovered = selectPublishablePackages(entries)
  if (discovered.length === 0) {
    console.log(`check-package-versions: this repo publishes no packages (none of the ${String(entries.length)} package.json file(s) tracked by git is`)
    console.log(`  non-private and either named ${PACKAGE_SCOPE}* or targeted at ${GITHUB_PACKAGES_REGISTRY}).`)
    console.log('  Nothing can drift, so nothing to check. The gate engages automatically as soon as such a')
    console.log('  package is added — no edit to this script needed.')
    return
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
    return
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
    return
  }

  // `--json` is not optional for the wrapper: the coverage audit needs the machine-readable
  // report. stdout is captured for that; stderr is inherited so the engine's own diagnostics
  // reach the log unbuffered.
  const forwarded = argv.filter((arg) => arg !== '--self-test')
  const passthroughJson = forwarded.includes('--json')
  const engineArgs = passthroughJson ? forwarded : [...forwarded, '--json']
  //
  // `maxBuffer` is set explicitly and generously. spawnSync defaults to 1MB, and exceeding it
  // kills the child with ENOBUFS — which this wrapper correctly classifies as INDETERMINATE, but
  // for a reason that has nothing to do with package drift. That ceiling is reachable in normal
  // operation: the report carries a row per workspace package (21 in this estate today) and the
  // header note above records a sibling gate that prefixes ~33KB of build output to stdout. A
  // gate that turns red because its own capture buffer was too small trains readers to ignore it.
  const result = spawnSync('npx', ['mantle', 'check', SUBCOMMAND, ...engineArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024
  })
  const delegated = classifyDelegatedRun({error: result.error, status: result.status, signal: result.signal})

  if (delegated.reason !== 'engine-verdict') {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` did not produce a verdict (${delegated.reason}).`, [
      result.error === undefined ? `Exit status: ${result.status}, signal: ${result.signal}.` : `Spawn error: ${result.error.message}.`,
      'A run that was killed or never started says nothing about whether the payload drifted.'
    ])
    return
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
    process.exitCode = delegated.exitCode
    return
  }

  // From here the engine says "nothing wrong". That claim is only worth as much as its coverage.
  if (report === null) {
    failIndeterminate(`\`mantle check ${SUBCOMMAND}\` exited 0 but produced no machine-readable report (${reason}).`, [
      'The wrapper cannot confirm the engine examined the package(s) this repo publishes:',
      ...discovered.map((pkg) => `  - ${pkg.name} (${pkg.dir})`),
      'An exit 0 the wrapper cannot corroborate is indistinguishable from an exit 0 for work never done.'
    ])
    return
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
    return
  }
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
