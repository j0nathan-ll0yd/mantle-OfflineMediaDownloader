#!/usr/bin/env node
/*
 * .mcp.json entry-point gate.
 *
 * THE FAILURE THIS PREVENTS: an MCP server is wired up by FILESYSTEM PATH into a
 * dependency's internals, that dependency reorganises its `dist/`, and the MCP server stops
 * starting. Nothing goes red. Typecheck, lint, tests and the PR all pass — an MCP server that
 * fails to spawn is a degraded editor session, not a failing build, and the only symptom is
 * that an agent quietly loses its tools.
 *
 * This is not hypothetical. `.mcp.json` used to invoke:
 *
 *     node node_modules/@j0nathan-ll0yd/cli/dist/mcp/mcp-entry.mjs
 *
 * @j0nathan-ll0yd/cli 2.0.0 RETRACTED the `./mcp` subpath from its `exports` map. That
 * retraction did not break this repo, but only by luck: a path handed to `node` never
 * consults `exports`, and the file happened to keep shipping (2.0.1 and 2.1.0 ship it
 * byte-identical, sha256 89b44acf…). The day a release drops or renames that file, the server
 * breaks silently. `dist/**` is package internals — nothing about it is covered by semver.
 *
 * The config now uses the SUPPORTED entry point instead: the `mantle` bin (a declared,
 * semver-protected `bin` field) with its `mcp-server` subcommand, which serves the identical
 * tool set. This check exists so that entry point cannot rot silently either.
 *
 * WHAT IS CHECKED: every stdio server in .mcp.json (those with a `command`; `type: "http"`
 * servers have no local entry point to verify) must have a command that actually resolves on
 * disk, plus any script-file argument it names. That is a filesystem fact, checkable in
 * milliseconds with no network and no spawning.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: that the server speaks MCP correctly. Spawning each
 * server and completing an `initialize` handshake would be a better assertion, but it costs
 * seconds per server on every pre-push and would make the gate flaky on a cold cache. The
 * silent failure mode being closed here is "the entry point vanished", which existence
 * catches completely.
 *
 * Like the other gates in this repo: any outcome where a verdict could NOT be reached is a
 * non-zero exit, never a pass. A gate that exits 0 because it could not read its own input is
 * the failure it is meant to prevent.
 */
import {accessSync, constants, readFileSync, realpathSync, statSync} from 'node:fs'
import {dirname, isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = resolve(PROJECT_ROOT, '.mcp.json')

/** Argument shapes that name a script file we can verify on disk. */
const SCRIPT_ARG = /\.(mjs|cjs|js)$/

/** A command is a path (rather than a PATH lookup like `node`) when it contains a separator. */
function isPathCommand(command) {
  return command.includes('/')
}

function fail(message) {
  console.error(`✗ check-mcp-entry: ${message}`)
  process.exit(1)
}

function checkExecutable(label, path) {
  let stats
  try {
    stats = statSync(path)
  } catch {
    return `${label} does not exist: ${path}`
  }
  if (!stats.isFile()) {
    return `${label} is not a file: ${path}`
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return `${label} is not executable: ${path}`
  }
  return null
}

function checkReadable(label, path) {
  try {
    statSync(path)
  } catch {
    return `${label} does not exist: ${path}`
  }
  return null
}

async function main() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (error) {
    fail(`could not read ${CONFIG_PATH}: ${error.message}`)
  }

  let config
  try {
    config = JSON.parse(raw)
  } catch (error) {
    fail(`.mcp.json is not valid JSON: ${error.message}`)
  }

  const servers = config?.mcpServers
  if (servers === undefined || servers === null || typeof servers !== 'object') {
    fail('.mcp.json has no "mcpServers" object')
  }

  const problems = []
  let checked = 0

  for (const [name, server] of Object.entries(servers)) {
    const command = server?.command
    if (typeof command !== 'string' || command.length === 0) {
      // Remote transports (type: "http"/"sse") have no local entry point.
      if (typeof server?.url === 'string') {
        continue
      }
      problems.push(`server "${name}" has neither a "command" nor a "url"`)
      continue
    }

    checked += 1

    if (isPathCommand(command)) {
      const resolved = isAbsolute(command) ? command : resolve(PROJECT_ROOT, command)
      const problem = checkExecutable(`server "${name}" command`, resolved)
      if (problem !== null) {
        problems.push(problem)
      }
    }

    for (const arg of Array.isArray(server.args) ? server.args : []) {
      if (typeof arg === 'string' && SCRIPT_ARG.test(arg)) {
        const resolved = isAbsolute(arg) ? arg : resolve(PROJECT_ROOT, arg)
        const problem = checkReadable(`server "${name}" arg`, resolved)
        if (problem !== null) {
          problems.push(problem)
        }
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ check-mcp-entry: ${problem}`)
    }
    console.error('')
    console.error('  An MCP server whose entry point does not resolve fails SILENTLY at runtime:')
    console.error('  the editor loses its tools and nothing else goes red. Prefer a package bin')
    console.error('  (e.g. ./node_modules/.bin/mantle mcp-server) over a path into dist/.')
    process.exit(1)
  }

  if (checked === 0) {
    fail('no stdio MCP servers found to verify — refusing to report a pass on an empty check')
  }

  console.log(`✓ check-mcp-entry: ${checked} stdio MCP server entry point(s) resolve`)
}

/*
 * Guard against the "module compared to itself by a different path" trap documented in
 * check-package-versions.mjs: if either path cannot be resolved, RUN rather than silently
 * skipping. A gate that no-ops is worse than no gate.
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
