/*
 * PROCESS-BOUNDARY tests for scripts/check-package-versions.mjs.
 *
 * WHY THIS FILE EXISTS. The wrapper's `--self-test` calls its pure functions directly, so it
 * proves `classifyDelegatedRun({status: 1})` returns 1 — and proves NOTHING about whether the
 * process actually exits 1. Every assertion in the gate could be green while a one-line edit at
 * the `process.exit(...)` site made the binary exit 0 on real drift. CI reads exactly one thing
 * from this gate, the exit status of a real process, and that was the one thing untested.
 *
 * So: these tests SPAWN the shipped file, byte-for-byte, as a child process, and assert
 * `child.status`. The file under test is copied from its real path rather than re-created here,
 * so there is no way for the test to drift into exercising a different implementation.
 *
 * The engine is stubbed (a fake `npx` earlier on PATH) because these tests are about the
 * WRAPPER's exit contract, and must run offline, deterministically, in a repo whose installed
 * CLI does not yet carry the subcommand. The engine's own correctness is covered by
 * `mantle check package-versions --self-test` in the CLI package.
 *
 * PROVEN ABLE TO FAIL: replacing the wrapper's final `process.exit(delegated.exitCode)` with
 * `process.exit(0)` turns 'forwards a DRIFT verdict as a non-zero exit status' red while
 * `--self-test` stays fully green. Command output is in the PR description.
 */

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
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
  writeFileSync(join(stubDir, 'npx'), [
    '#!/usr/bin/env node',
    "import {appendFileSync, readFileSync, writeFileSync} from 'node:fs'",
    `const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'))`,
    `appendFileSync(${JSON.stringify(join(dir, 'engine-invocations.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
    "if (process.argv.includes('--help')) {",
    '  process.stdout.write(config.help)',
    '  process.exit(0)',
    '}',
    'if (config.terminateWithSignal !== undefined) { process.kill(process.pid, config.terminateWithSignal) }',
    'process.stdout.write(config.stdout)',
    'process.exit(config.exitCode)'
  ].join('\n'))
  chmodSync(join(stubDir, 'npx'), 0o755)

  return {
    dir,
    engineInvocations: () => (existsSync(join(dir, 'engine-invocations.log')) ? readFileSync(join(dir, 'engine-invocations.log'), 'utf8') : ''),
    run: (args = []) =>
      spawnSync(process.execPath, [join(dir, 'scripts', 'check-package-versions.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: {...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, GITHUB_ACTIONS: 'false'}
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

test('--self-test exits 0 as its own process', () => {
  const repo = makeRepo({manifests: oneRepoPublishesOne, engine: {help: helpWithSubcommand, stdout: '', exitCode: 0}})
  const result = repo.run(['--self-test'])
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /known-answer assertions passed/)
})
