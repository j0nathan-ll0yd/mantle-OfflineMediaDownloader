/*
 * PROCESS-BOUNDARY tests for scripts/check-package-versions.mjs.
 *
 * WHY THIS FILE EXISTS. The wrapper's `--self-test` calls its pure functions directly, so it
 * proves `classifyDelegatedRun({status: 1})` returns 1 — and proves NOTHING about whether the
 * process actually exits 1. Every assertion in the gate could be green while a one-line edit at
 * the exit-status site made the binary exit 0 on real drift. CI reads exactly one thing from this
 * gate, the exit status of a real process, and that was the one thing untested.
 *
 * So: these tests SPAWN the shipped file, byte-for-byte, as a child process, and assert
 * `child.status`. The file under test is copied from its real path rather than re-created here,
 * so there is no way for the test to drift into exercising a different implementation.
 *
 * They also assert what the process PRINTS, not just what it returns. An exit code with no
 * explanation is a gate nobody can act on — see the D7 tests near the bottom, and the note on
 * `runSlowReader` for why observing that requires a reader that is deliberately slow.
 *
 * The engine is stubbed (a fake `npx` earlier on PATH) because these tests are about the
 * WRAPPER's exit contract, and must run offline, deterministically, in a repo whose installed
 * CLI does not yet carry the subcommand. The engine's own correctness is covered by
 * `mantle check package-versions --self-test` in the CLI package.
 *
 * PROVEN ABLE TO FAIL: replacing the wrapper's final `process.exitCode = delegated.exitCode` with
 * `0` turns 'forwards a DRIFT verdict as a non-zero exit status' red while `--self-test` stays
 * fully green. Reintroducing `process.exit()` anywhere in the wrapper reds all three D7 rungs, on
 * both darwin/arm64 and the linux/arm64 CI arch, on every run. Command output is in the PR
 * description.
 */

import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrapperSource = join(scriptsDir, 'check-package-versions.mjs')
const registry = 'https://npm.pkg.github.com'

const created = []
after(() => {
  for (const dir of created) {
    rmSync(dir, {recursive: true, force: true})
  }
})

const publishableManifest = (name) => ({name, version: '1.0.0', private: false, publishConfig: {registry}})

function reportWith({specVersion = 3, rows}) {
  return {specVersion, lane: 'branch', registry, rows}
}

const cleanRow = {
  name: '@j0nathan-ll0yd/thing',
  path: 'packages/thing',
  declared: '1.0.0',
  referenceVersion: '1.0.0',
  verdict: 'CLEAN',
  exitClass: 0,
  differingFiles: [],
  leakedPaths: [],
  detail: null
}

const driftRow = {...cleanRow, verdict: 'DRIFT', exitClass: 1, differingFiles: ['dist/index.js'], detail: 'payload differs from the published 1.0.0'}

/**
 * Row count for the D7 output-completeness fixtures, and the floor those tests assert against.
 *
 * These numbers are MEASURED, not guessed, and the margin is the point. Pausing the reader does
 * not stop delivery instantly — libuv has already satisfied one read request and the OS pipe holds
 * another 64KB — so a fixture only slightly larger than the pipe buffer still arrives intact even
 * when the defect is present. At 1800 rows (~103KB of table) a wrapper with `process.exit()`
 * reintroduced delivered ALL 103027 bytes and the test passed: a regression test that could not
 * fail. Raising the fixture until the queued tail dwarfs everything in flight separates the two
 * cases decisively.
 *
 * Measured on this fixture, slow reader, node 24:
 *
 *                            darwin/arm64                linux/arm64 (the CI runner arch)
 *   with `process.exit()`    131147 bytes, no DRIFT row  0 bytes, NOTHING AT ALL
 *   with `process.exitCode`  1160430 bytes, DRIFT row    1160430 bytes, DRIFT row
 *
 * The CI platform is the WORSE of the two: the defective wrapper exits 1, correctly blocking the
 * merge, having printed literally nothing. The floor below sits an order of magnitude above the
 * truncated case and well below the healthy one, so it separates them on both platforms.
 */
const OUTPUT_FIXTURE_ROWS = 20000
const OUTPUT_FLOOR_BYTES = 500000

const fillerRows = () =>
  Array.from({length: OUTPUT_FIXTURE_ROWS}, (_unused, index) => ({...cleanRow, name: `@j0nathan-ll0yd/filler-${index}`, path: `packages/filler-${index}`}))

/**
 * Build a throwaway repo containing the REAL wrapper plus a stub engine, and return a `run`
 * function that spawns the wrapper in it.
 *
 * `manifests` maps a directory ('.' for the root) to a manifest object. `engine` describes the
 * stub: `helpListsSubcommand`, what it writes to stdout, and how it terminates.
 */
function makeRepo({manifests, engine}) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-drift-spawn-'))
  created.push(dir)

  for (const [relative, manifest] of Object.entries(manifests)) {
    const target = relative === '.' ? dir : join(dir, relative)
    mkdirSync(target, {recursive: true})
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  // The wrapper enumerates manifests with `git ls-files`, so the fixture has to be a git repo.
  // `--others --exclude-standard` covers untracked files, so nothing needs staging or committing
  // (which would also require a git identity this test has no business assuming).
  const git = spawnSync('git', ['init', '--quiet'], {cwd: dir, encoding: 'utf8'})
  assert.equal(git.status, 0, `git init failed in the fixture: ${git.stderr}`)

  mkdirSync(join(dir, 'scripts'), {recursive: true})
  cpSync(wrapperSource, join(dir, 'scripts', 'check-package-versions.mjs'))

  const stubDir = join(dir, 'stub-bin')
  mkdirSync(stubDir, {recursive: true})
  const config = join(dir, 'stub-engine.json')
  writeFileSync(config, JSON.stringify(engine, null, 2))

  // A fake `npx` placed first on PATH. It records every invocation so a test can assert the
  // engine was never consulted, and reproduces the two behaviours the wrapper depends on:
  // the `mantle check --help` subcommand listing, and the `--json` report.
  //
  // THE STUB ITSELF MUST NOT CALL `process.exit()`, for exactly the reason the wrapper must not:
  // its stdout is a pipe (the wrapper captures it), so `process.exit()` discards whatever is still
  // buffered. An earlier revision of this stub did, and it truncated its own multi-hundred-KB JSON
  // report mid-document — the wrapper then reported `engine-report-unparseable` and the D7
  // truncation tests failed for a reason that had nothing to do with the code under test. A test
  // harness carrying the bug it is testing for silently measures the wrong thing.
  writeFileSync(join(stubDir, 'npx'), [
    '#!/usr/bin/env node',
    "import {appendFileSync, readFileSync} from 'node:fs'",
    `const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'))`,
    `appendFileSync(${JSON.stringify(join(dir, 'engine-invocations.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
    "if (process.argv.includes('--help')) {",
    '  process.stdout.write(config.help)',
    '  process.exitCode = 0',
    '} else {',
    '  if (config.terminateWithSignal !== undefined) { process.kill(process.pid, config.terminateWithSignal) }',
    '  process.stdout.write(config.stdout)',
    '  process.exitCode = config.exitCode',
    '}'
  ].join('\n'))
  chmodSync(join(stubDir, 'npx'), 0o755)

  const env = {...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, GITHUB_ACTIONS: 'false'}

  return {
    dir,
    engineInvocations: () => (existsSync(join(dir, 'engine-invocations.log')) ? readFileSync(join(dir, 'engine-invocations.log'), 'utf8') : ''),
    run: (args = []) => spawnSync(process.execPath, [join(dir, 'scripts', 'check-package-versions.mjs'), ...args], {cwd: dir, encoding: 'utf8', env}),
    /**
     * Spawn the wrapper against a DELIBERATELY SLOW pipe reader and resolve with everything the
     * reader eventually received.
     *
     * `spawnSync` cannot express this: it drains the child's pipes as fast as the OS delivers
     * them, so the child's writes never sit queued at exit time and the truncation under test does
     * not reproduce. A real CI log collector is not that prompt.
     *
     * THE READER MUST NOT TOUCH THE STREAM UNTIL THE STALL EXPIRES. Two earlier revisions of this
     * helper were racy and both produced a test that could not reliably fail:
     *
     *   1. pause() immediately after spawn, resume on a timer — the wrapper spends ~300ms shelling
     *      out to the engine before printing, so the timer had already fired and there was never
     *      any backpressure.
     *   2. attach a 'data' handler, then pause() on the first chunk — attaching the handler puts
     *      the stream in FLOWING mode, so libuv starts reading before the pause lands. Against an
     *      unchanged mutant this delivered 131147 bytes (truncated) on one run and all 1160430 on
     *      the next. A flaky gate is worse than no gate: it reds healthy work at random and greens
     *      defective work at random.
     *
     * Leaving the stream in its default PAUSED, non-flowing state — no listener at all — means
     * libuv never reads, so the OS pipe fills and stays full. The child's writes then queue in its
     * own memory, which is precisely the state `process.exit()` discards. Listeners are attached
     * only after `pauseMs`, and everything still buffered is drained normally from there.
     *
     * This cannot deadlock. If a platform ever makes stdout-to-pipe writes synchronous, the child
     * simply blocks until the reader attaches, and the run completes either way.
     */
    runSlowReader: (args = [], {pauseMs = 400} = {}) =>
      new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [join(dir, 'scripts', 'check-package-versions.mjs'), ...args], {
          cwd: dir,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        let closeStatus
        let draining = false
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const settle = () => {
          if (draining && closeStatus !== undefined && child.stdout.readableEnded && child.stderr.readableEnded) {
            resolvePromise({status: closeStatus, stdout, stderr})
          }
        }

        setTimeout(() => {
          draining = true
          child.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.stdout.on('end', settle)
          child.stderr.on('end', settle)
          settle()
        }, pauseMs)

        child.on('error', reject)
        child.on('close', (status) => {
          closeStatus = status
          settle()
        })
      })
  }
}

const helpWithSubcommand = [
  'Usage: mantle check [options] [command]',
  '',
  'Commands:',
  '  deps                         Check dependency architecture rules',
  '  versions [options]           Compare instance dependency versions',
  '  package-versions [options]   Publish-payload drift gate'
].join('\n')

const helpWithoutSubcommand = helpWithSubcommand.split('\n').filter((line) => !line.includes('package-versions')).join('\n')

const oneRepoPublishesOne = {'.': {name: 'consumer-repo', private: true}, 'packages/thing': publishableManifest('@j0nathan-ll0yd/thing')}

test('forwards a DRIFT verdict as a non-zero exit status', () => {
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: [driftRow]}), null, 2), exitCode: 1}
  })
  const result = repo.run()
  assert.equal(result.status, 1, `expected the wrapper process to exit 1 on drift, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /DRIFT/)
})

test('exits 0 when the engine covered every published package and found nothing', () => {
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: [cleanRow]}), null, 2), exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 0, `expected exit 0 for a covered clean repo, got ${result.status}\n${result.stdout}${result.stderr}`)
})

test('X1: exits 3 when the engine exits 0 having examined nothing this repo publishes', () => {
  // The MEASURED shape. `pnpm list -r` returns the private root alone in this repo, so the
  // engine reports "1 workspace package(s): 1 SKIPPED" and exits 0 while the published package
  // is never looked at. Before the coverage audit, the wrapper forwarded that 0 into a REQUIRED
  // status context.
  const rootOnly = {
    name: 'consumer-repo',
    path: '.',
    declared: '0.0.1',
    verdict: 'SKIPPED',
    exitClass: 0,
    differingFiles: [],
    leakedPaths: [],
    detail: 'private: true'
  }
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: [rootOnly]}), null, 2), exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 3, `an engine that examined nothing must not pass, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /@j0nathan-ll0yd\/thing.*NO ROW/s)
})

test('exits 3 when the engine reports SKIPPED for a package this repo demonstrably publishes', () => {
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {
      help: helpWithSubcommand,
      stdout: JSON.stringify(reportWith({rows: [{...cleanRow, verdict: 'SKIPPED', detail: 'private: true'}]}), null, 2),
      exitCode: 0
    }
  })
  const result = repo.run()
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /SKIPPED/)
})

test('exits 3 when the engine measured under a different digest spec version', () => {
  // Not pedantry: measured on @j0nathan-ll0yd/portal-contract@1.0.0, the spec-2 rule reports
  // DRIFT on a package the canonical spec-3 rule reports CLEAN. A wrong rule is a confident
  // wrong answer, and the "fix" for a gate that cries wolf is always to delete the gate.
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({specVersion: 2, rows: [cleanRow]}), null, 2), exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /spec v2/)
})

test('exits 3 when the engine exits 0 with an unparseable report', () => {
  const repo = makeRepo({manifests: oneRepoPublishesOne, engine: {help: helpWithSubcommand, stdout: 'turbo: 3 packages built\n', exitCode: 0}})
  const result = repo.run()
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
})

test('recovers the report when build output precedes it on stdout, and still passes a covered clean run', () => {
  // X8 in a sibling implementation: ~33KB of turbo output ahead of the JSON document. This
  // asserts the recovery path end-to-end rather than only in the pure parser.
  const noise = `${'turbo: building @j0nathan-ll0yd/thing\n'.repeat(400)}`
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: `${noise}${JSON.stringify(reportWith({rows: [cleanRow]}), null, 2)}`, exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`)
})

test('exits 3 when the installed CLI has no package-versions subcommand', () => {
  const repo = makeRepo({manifests: oneRepoPublishesOne, engine: {help: helpWithoutSubcommand, stdout: '', exitCode: 0}})
  const result = repo.run()
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
})

test('exits 3 when the engine is killed by a signal instead of returning a verdict', () => {
  const repo = makeRepo({manifests: oneRepoPublishesOne, engine: {help: helpWithSubcommand, stdout: '', exitCode: 0, terminateWithSignal: 'SIGKILL'}})
  const result = repo.run()
  assert.equal(result.status, 3, `a killed engine is INDETERMINATE, got ${result.status}\n${result.stdout}${result.stderr}`)
})

test('exits 0 WITHOUT consulting the engine when the repo publishes nothing', () => {
  // The OfflineMediaDownloader shape today, and the one conclusion the wrapper is allowed to
  // reach on its own. It must stay a legitimate 0 — a gate that fails in repos with nothing to
  // check gets disabled everywhere, including where it matters.
  const repo = makeRepo({
    manifests: {'.': {name: 'consumer-repo', private: true}, 'packages/internal': {name: 'internal', private: true, publishConfig: {registry}}},
    engine: {help: helpWithoutSubcommand, stdout: '', exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.equal(repo.engineInvocations(), '', 'the engine must not be invoked at all when there is nothing to check')
})

test('a publishable manifest outside packages/ is still discovered, so it cannot be silently passed', () => {
  const repo = makeRepo({
    manifests: {'.': {name: 'consumer-repo', private: true}, 'tools/contract': publishableManifest('@j0nathan-ll0yd/thing')},
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: []}), null, 2), exitCode: 0}
  })
  const result = repo.run()
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /tools\/contract/)
})

/**
 * D7, the DETERMINISTIC rung. The behavioural tests below depend on winning a race against the
 * OS pipe buffer, so on a fast enough machine they could pass while the defect is present. This
 * one cannot: it reads the shipped file and asserts the defective CALL does not appear in it.
 *
 * `process.exit()` is banned outright rather than audited case by case, because every one of its
 * uses here was a truncation waiting to happen and the correct spelling — assign `process.exitCode`
 * and return — is available at every site.
 */
test('D7: the shipped wrapper contains no process.exit() call', () => {
  const source = readFileSync(wrapperSource, 'utf8')
  const offenders = source.split('\n').map((line, index) => ({line, number: index + 1})) // Comments discuss `process.exit()` deliberately and at length; only real calls matter.
    .filter(({line}) => !/^\s*(?:\*|\/\/)/.test(line)).filter(({line}) => /process\.exit\s*\(/.test(line))

  assert.deepEqual(offenders.map(({number, line}) => `${number}: ${line.trim()}`), [],
    'process.exit() discards buffered stdout, and stdout is a pipe in CI. Use `process.exitCode = ...` followed by `return`.')
})

/**
 * D7. The gate blocked correctly and PRINTED NOTHING USEFUL.
 *
 * `process.exit()` does not drain buffered stdout. On POSIX a pipe destination makes stdout writes
 * asynchronous, and in CI stdout is ALWAYS a pipe, so everything still queued at exit time is
 * discarded. Measured against the pre-fix wrapper with this exact fixture: the wrapper exited 2
 * (correct) while the reader received 65507 bytes — one pipe buffer — and the DRIFT row never
 * arrived. The single actionable line is the likeliest one to be lost, because the engine prints
 * it after the rows it already cleared.
 *
 * The sentinel row is deliberately LAST. A truncation test that asserts on early output passes
 * while the interesting content is still being dropped.
 */
test('D7: the DRIFT row survives a slow pipe reader instead of being truncated by process exit', async () => {
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: [...fillerRows(), driftRow]}), null, 2), exitCode: 1}
  })

  const result = await repo.runSlowReader()

  assert.equal(result.status, 1, `expected the wrapper to still exit 1 on drift, got ${result.status}`)
  assert.match(result.stdout, /DRIFT/, 'the DRIFT verdict — the entire reason CI is red — must reach the log')
  assert.match(result.stdout, /@j0nathan-ll0yd\/thing/, 'the drifting package must be NAMED in the surviving output')
  assert.match(result.stdout, /dist\/index\.js/, 'the differing file must survive too, or the failure is not actionable')
  assert.ok(result.stdout.length > OUTPUT_FLOOR_BYTES,
    `stdout stopped at ${result.stdout.length} bytes; a complete run of this fixture is ~1.1MB, so the tail is being discarded at exit`)
})

/**
 * D7, the INDETERMINATE half: the same truncation applies to the exit-3 explanation, which is
 * printed to stderr AFTER a potentially large table has been queued to stdout.
 */
test('D7: the INDETERMINATE explanation survives a slow pipe reader', async () => {
  const repo = makeRepo({
    manifests: oneRepoPublishesOne,
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: fillerRows()}), null, 2), exitCode: 0}
  })

  const result = await repo.runSlowReader()

  assert.equal(result.status, 3, `expected exit 3 for an uncovered package, got ${result.status}`)
  assert.match(result.stderr, /INDETERMINATE/, 'the verdict headline must reach the log')
  assert.match(result.stderr, /NO ROW/, 'the specific coverage defect must reach the log')
  assert.match(result.stderr, /Exiting 3/, 'the closing line proves stderr was drained rather than cut off')
})

/**
 * D10. The wrapper is the engine's INDEPENDENT SECOND OPINION on coverage, so its publishable
 * predicate must be at least as wide as the engine's. The engine (pipeline.ts) treats an in-scope
 * NAME and a GitHub Packages `publishConfig.registry` as two independent sufficient signals; this
 * wrapper used to require the registry one alone.
 *
 * The divergence is not academic: a manifest named `@j0nathan-ll0yd/*` that inherits its registry
 * from `.npmrc` — how much of this estate is written — was invisible to the wrapper while the
 * engine considered it publishable. If the engine's enumeration then missed it too, the report
 * carried no row, the audit had nothing to compare, and BOTH sides agreed on a pass having
 * examined nothing. That is the exact silent pass this wrapper exists to catch, assembled from two
 * blind spots instead of one.
 */
test('D10: a scoped package with no publishConfig.registry is still audited for coverage', async () => {
  const repo = makeRepo({
    manifests: {
      '.': {name: 'consumer-repo', private: true},
      // No publishConfig at all — the registry would come from .npmrc. The ENGINE calls this
      // publishable because the name is in scope.
      'packages/inherits-registry': {name: '@j0nathan-ll0yd/inherits-registry', version: '1.0.0'}
    },
    // The engine exits 0 reporting nothing — the X1 enumeration defect. Under the old predicate
    // the wrapper discovered nothing either, found no coverage problem, and forwarded that 0.
    engine: {help: helpWithSubcommand, stdout: JSON.stringify(reportWith({rows: []}), null, 2), exitCode: 0}
  })

  const result = repo.run()

  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /@j0nathan-ll0yd\/inherits-registry/, 'the wrapper must discover the package the engine considers publishable')
  assert.match(result.stderr, /NO ROW/, 'and must report the engine never examined it')
})

test('--self-test exits 0 as its own process', () => {
  const repo = makeRepo({manifests: oneRepoPublishesOne, engine: {help: helpWithSubcommand, stdout: '', exitCode: 0}})
  const result = repo.run(['--self-test'])
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /known-answer assertions passed/)
})
