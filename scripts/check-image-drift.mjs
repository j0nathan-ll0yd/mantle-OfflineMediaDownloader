#!/usr/bin/env node
/**
 * Advisory measurer: does the container image DEPLOYED to a stage still match the image pin
 * COMMITTED to this repo?
 *
 * The seam it watches is the gap between a pin commit and a deploy. Nothing in this repo deploys
 * automatically (`ci.deploy: false`, `pnpm run deploy:staging` is run by a human), while the
 * scheduled ffmpeg and yt-dlp lanes push new `docker/*.pin.json` commits to main on their own
 * cadence. Between those two facts, main and the live stack drift apart silently: a pin can sit
 * merged and undeployed for days, and the only thing that ever compares the two is
 * `mantle deploy`'s own post-deploy verification — which by definition runs only at deploy time,
 * when the answer is already yes.
 *
 * ADVISORY BY DESIGN. Exit 1 means "there is a deploy to run", not "the build is broken". Do NOT
 * wire this into a required CI context: main legitimately runs ahead of staging between manual
 * deploys, so a blocking version of this check would go red for doing its job. Exit 3 is the
 * verdict that matters for trust — no credentials, no such function, an API error, a malformed
 * pin: anything that means "could not tell" is reported as UNMEASURED and never as a pass.
 *
 * Read-only. The single AWS call is `lambda:GetFunction`.
 *
 * Usage:
 *   node scripts/check-image-drift.mjs [--stage staging]
 */

import {spawnSync} from 'node:child_process'
import {readdirSync, readFileSync, realpathSync, statSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/** Directory holding the committed pin records, relative to the repo root. */
const PIN_DIR = 'docker'

/** Suffix that marks a file in PIN_DIR as a container-image pin record. */
const PIN_SUFFIX = '.pin.json'

/** Only stage this repo can deploy (`allowedStages: ['staging']` in mantle.config.ts). */
const DEFAULT_STAGE = 'staging'

/** Region fallback. Mirrors the pin in bin/aws-audit.sh and `backend.s3.region` in mantle.config.ts. */
const FALLBACK_REGION = 'us-west-2'

/** Verdicts. UNMEASURED is a first-class outcome, not an error path — see the header. */
const MATCH = 'MATCH'
const DRIFT = 'DRIFT'
const UNMEASURED = 'UNMEASURED'

/** Exit classes. 1 is "deploy pending", NOT "broken"; 3 is "no verdict". */
const EXIT_MATCH = 0
const EXIT_DRIFT = 1
const EXIT_UNMEASURED = 3

/** The one-line fix for a DRIFT row. Deploys stay manual and human-run on purpose. */
const REMEDIATION = 'npx mantle deploy --stage staging'

// ---------------------------------------------------------------------------
// Pure functions (no fs, no spawn) — everything below is covered by the unit tests
// in scripts/__tests__/check-image-drift.test.mjs.
// ---------------------------------------------------------------------------

/**
 * Strip account-identifying material out of text that came from the AWS CLI before it reaches
 * stdout. AWS error messages routinely quote the calling principal's full ARN, which carries the
 * 12-digit account ID, and an ECR image URI leads with that same ID as a hostname label. Neither
 * is needed to act on the row, and this output is pasted into PR bodies.
 */
export function redactAccountIds(text) {
  return String(text ?? '').replaceAll(/\b\d{12}\b/g, '<account>')
}

/**
 * Pull the manifest digest out of an ECR image reference.
 *
 * Accepts the registry/repository form Lambda reports, where the digest follows an at-sign, and a
 * bare digest. Returns null for a TAG-only reference: a tag says nothing about which image is
 * running, and answering "match" from one would be the exact silent pass this check prevents.
 */
export function extractDigest(reference) {
  const match = /(^|@)(sha256:[0-9a-f]{64})$/.exec(String(reference ?? '').trim())
  return match === null ? null : match[2]
}

/**
 * Read the pinned digest out of a `docker/*.pin.json` payload.
 *
 * Returns `{digest}` or `{problem}`. A pin whose `digest` is absent, malformed, or a tag is a
 * problem rather than a skip: the pin record is the authority this check measures against, so an
 * unreadable one leaves the deployed image unverified.
 */
export function parsePinDigest(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return {problem: 'pin record is not valid JSON'}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {problem: 'pin record is not a JSON object'}
  }
  if (typeof parsed.digest !== 'string') {
    return {problem: 'pin record has no string `digest` field'}
  }
  const digest = extractDigest(parsed.digest)
  return digest === null ? {problem: `pin record digest is not a sha256 manifest digest: ${parsed.digest}`} : {digest}
}

/**
 * Read the stack's name prefix out of a tfvars file.
 *
 * `module.core.name_prefix` IS `var.environment` — see `modules/core/main.tf` in the installed CLI
 * package. bin/aws-audit.sh already resolves the prefix this way rather than assuming it equals the
 * stage name, so a rename surfaces here instead of silently filtering everything out.
 */
export function extractStagePrefix(tfvarsText) {
  const match = /^[ \t]*environment[ \t]*=[ \t]*"([^"]+)"/m.exec(String(tfvarsText ?? ''))
  return match === null ? null : match[1]
}

/**
 * Does this Lambda source file declare the given pin as its image source?
 *
 * The `imageDigestFile` option in `defineLambda()` is the authoritative link between a pin record
 * and the function that deploys it, which is why the mapping is discovered rather than listed in
 * a table here: a table would have to be edited by whoever adds the second container Lambda, and
 * it would not be.
 */
export function declaresPin(sourceText, pinRelPath) {
  const escaped = pinRelPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`imageDigestFile\\s*:\\s*['"\`]${escaped}['"\`]`).test(String(sourceText ?? ''))
}

/**
 * Read the unprefixed Terraform `function_name` for a Lambda whose build output is
 * `build/lambdas/<lambdaDirName>`, from generated infra.
 *
 * Returns `{functionName}` or `{problem}`. Going through the generated `.tf` rather than assuming
 * the directory name buys a real check: the block must also carry `image_uri`, so a pin left
 * behind after its Lambda stopped being a container image reports a problem offline instead of
 * being compared against a Zip function's nonexistent digest.
 */
export function extractContainerFunctionName(tfText, lambdaDirName) {
  const blocks = String(tfText ?? '').split(/^module\s+"/m).slice(1)
  for (const block of blocks) {
    if (!new RegExp(`source_dir\\s*=\\s*"[^"]*build/lambdas/${lambdaDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(block)) {
      continue
    }
    const name = /^\s*function_name\s*=\s*"([^"]+)"/m.exec(block)
    if (name === null) {
      return {problem: `generated infra for ${lambdaDirName} declares no function_name`}
    }
    if (!/^\s*image_uri\s*=/m.test(block)) {
      return {problem: `generated infra for ${lambdaDirName} is no longer a container-image Lambda (no image_uri), so its pin cannot be measured`}
    }
    return {functionName: name[1]}
  }
  return {problem: `no generated infra module builds from build/lambdas/${lambdaDirName}`}
}

/**
 * Turn one resolved target into a verdict row, asking `fetchDeployed` for the live digest.
 *
 * `target.problem` carries a resolution failure from the I/O layer; it short-circuits to
 * UNMEASURED so every pin still produces exactly one row. `fetchDeployed` resolves to
 * `{digest}` or `{problem}` and is injected, which is what makes the whole evaluator testable
 * without AWS.
 */
export async function evaluateTarget(target, fetchDeployed) {
  const row = {pinPath: target.pinPath, functionName: target.functionName ?? null, pinDigest: null, deployedDigest: null, detail: null}
  if (target.problem != null) {
    return {...row, verdict: UNMEASURED, detail: target.problem}
  }
  const pin = parsePinDigest(target.pinText)
  if (pin.problem != null) {
    return {...row, verdict: UNMEASURED, detail: pin.problem}
  }
  const fetched = await fetchDeployed({functionName: target.functionName})
  if (fetched?.problem != null || typeof fetched?.digest !== 'string') {
    return {...row, verdict: UNMEASURED, pinDigest: pin.digest, detail: fetched?.problem ?? 'deployed-digest lookup returned no digest'}
  }
  const verdict = fetched.digest === pin.digest ? MATCH : DRIFT
  return {...row, verdict, pinDigest: pin.digest, deployedDigest: fetched.digest}
}

/** Evaluate every target in order. Order is stable so the output diffs cleanly between runs. */
export async function evaluateTargets(targets, fetchDeployed) {
  const rows = []
  for (const target of targets) {
    rows.push(await evaluateTarget(target, fetchDeployed))
  }
  return rows
}

/** One line per pin. DRIFT carries its own remediation so a reader never has to look it up. */
export function formatRow(row) {
  const fn = row.functionName ?? '(function unresolved)'
  if (row.verdict === UNMEASURED) {
    return `${UNMEASURED} ${row.pinPath} ${fn} — ${redactAccountIds(row.detail ?? 'no reason recorded')}`
  }
  if (row.verdict === DRIFT) {
    return `${DRIFT} ${row.pinPath} ${fn} — pin ${row.pinDigest} deployed ${row.deployedDigest} — deploy it: ${REMEDIATION}`
  }
  return `${MATCH} ${row.pinPath} ${fn} — ${row.pinDigest}`
}

/**
 * DRIFT outranks UNMEASURED: a measured drift is actionable now, and flattening it into 3 would
 * hide the one row a reader has to act on. Zero rows is EXIT_UNMEASURED, not a pass — a run that
 * found no pins to compare has verified nothing, and "the enumeration broke" and "there are
 * genuinely no container Lambdas" look identical from the outside.
 */
export function exitCodeFor(rows) {
  if (rows.length === 0) {
    return EXIT_UNMEASURED
  }
  if (rows.some((row) => row.verdict === DRIFT)) {
    return EXIT_DRIFT
  }
  return rows.some((row) => row.verdict === UNMEASURED) ? EXIT_UNMEASURED : EXIT_MATCH
}

/** Trailer that states what the exit code means, printed with every run. */
export function summaryLines(rows, exitCode) {
  const count = (verdict) => rows.filter((row) => row.verdict === verdict).length
  const lines = [`${String(rows.length)} pin(s): ${String(count(MATCH))} match, ${String(count(DRIFT))} drift, ${String(count(UNMEASURED))} unmeasured.`]
  if (exitCode === EXIT_DRIFT) {
    lines.push(`Exit 1 is ADVISORY: it means a committed pin has not been deployed yet. Run \`${REMEDIATION}\`.`)
    lines.push('It is not a broken build — deploys are manual in this repo, so main legitimately leads staging between them.')
  } else if (exitCode === EXIT_UNMEASURED) {
    lines.push('Exit 3 is UNMEASURED, NOT a pass: nothing here says the deployed image matches the committed pin.')
    lines.push('Usual cause: no AWS credentials in the environment. Re-run with credentials for the staging account.')
  } else {
    lines.push('Exit 0: every committed pin is the image the stage is running.')
  }
  return lines
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Sorted list of repo-relative pin paths. Returns null when the directory cannot be read. */
function listPinPaths(root) {
  try {
    return readdirSync(join(root, PIN_DIR)).filter((entry) => entry.endsWith(PIN_SUFFIX)).sort().map((entry) => `${PIN_DIR}/${entry}`)
  } catch {
    return null
  }
}

/** Every `src/lambdas/**\/index.ts` in the repo, sorted. */
function listLambdaEntryPoints(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'index.ts') {
        found.push(full)
      }
    }
  }
  walk(join(root, 'src', 'lambdas'))
  return found
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Concatenated generated infra. The pin-to-function join does not care which file a module is in. */
function readInfraText(root) {
  const dir = join(root, 'infra')
  let entries
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith('.tf')).sort()
  } catch {
    return null
  }
  const parts = []
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      if (!statSync(path).isFile()) {
        continue
      }
    } catch {
      continue
    }
    const text = readTextOrNull(path)
    if (text !== null) {
      parts.push(text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * Resolve each pin to the deployed function name it should be compared against, recording a
 * `problem` instead of throwing so an unresolvable pin still yields an UNMEASURED row.
 */
function resolveTargets({root, stage}) {
  const pinPaths = listPinPaths(root)
  if (pinPaths === null) {
    return null
  }
  const tfvarsPath = join(root, 'infra', 'environments', `${stage}.tfvars`)
  const prefix = extractStagePrefix(readTextOrNull(tfvarsPath))
  const infraText = readInfraText(root)
  const entryPoints = listLambdaEntryPoints(root).map((path) => ({path, text: readTextOrNull(path)}))

  return pinPaths.map((pinPath) => {
    const pinText = readTextOrNull(join(root, pinPath))
    const base = {pinPath, pinText}
    if (pinText === null) {
      return {...base, problem: `could not read ${pinPath}`}
    }
    const declaring = entryPoints.filter((entry) => declaresPin(entry.text, pinPath))
    if (declaring.length === 0) {
      return {...base, problem: `no src/lambdas/**/index.ts declares imageDigestFile: '${pinPath}', so the function to measure is unknown`}
    }
    if (declaring.length > 1) {
      return {...base, problem: `${String(declaring.length)} Lambdas declare imageDigestFile: '${pinPath}'; the pin-to-function mapping is ambiguous`}
    }
    const lambdaDirName = basename(dirname(declaring[0].path))
    if (infraText === null) {
      return {...base, problem: 'could not read generated infra under infra/*.tf'}
    }
    const resolved = extractContainerFunctionName(infraText, lambdaDirName)
    if (resolved.problem != null) {
      return {...base, problem: resolved.problem}
    }
    if (prefix === null) {
      return {...base, problem: `could not read 'environment' from infra/environments/${stage}.tfvars, so the deployed function name is unknown`}
    }
    return {...base, functionName: `${prefix}-${resolved.functionName}`}
  })
}

/** Region resolution, mirroring bin/aws-audit.sh so both tools read the same stack. */
function resolveRegion() {
  const fromEnv = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION
  if (fromEnv != null && fromEnv !== '') {
    return fromEnv
  }
  const configured = spawnSync('aws', ['configure', 'get', 'region'], {encoding: 'utf8'})
  const value = String(configured.stdout ?? '').trim()
  return value === '' ? FALLBACK_REGION : value
}

/**
 * The real fetcher: one read-only `lambda:GetFunction` per pin.
 *
 * Prefers `Code.ResolvedImageUri` — the digest Lambda actually resolved and is running — over the
 * configured `Code.ImageUri`, which may be a tag. Every failure shape returns a `problem` string,
 * never a digest and never a throw, because the caller's contract is that "could not tell" is an
 * UNMEASURED row rather than a crash or a pass.
 */
function createAwsFetcher(region) {
  return async ({functionName}) => {
    const result = spawnSync('aws', ['lambda', 'get-function', '--function-name', functionName, '--region', region, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    if (result.error != null) {
      return {problem: `could not run the aws CLI (${result.error.message})`}
    }
    if (result.signal != null) {
      return {problem: `the aws CLI was killed by ${result.signal}`}
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? 'no stderr'
      return {problem: `aws lambda get-function ${functionName} exited ${String(result.status)}: ${stderr.slice(0, 300)}`}
    }
    let parsed
    try {
      parsed = JSON.parse(String(result.stdout ?? ''))
    } catch {
      return {problem: `aws lambda get-function ${functionName} returned output that is not JSON`}
    }
    const packageType = parsed?.Configuration?.PackageType
    if (packageType !== 'Image') {
      return {problem: `${functionName} is deployed as PackageType=${String(packageType)}, not Image, so it has no image digest to compare`}
    }
    const digest = extractDigest(parsed?.Code?.ResolvedImageUri) ?? extractDigest(parsed?.Code?.ImageUri)
    return digest === null ? {problem: `${functionName} reports no sha256 image digest (only a tag), so the running image cannot be identified`} : {digest}
  }
}

function parseStage(argv) {
  const index = argv.indexOf('--stage')
  return index === -1 ? DEFAULT_STAGE : (argv[index + 1] ?? DEFAULT_STAGE)
}

/**
 * Never call `process.exit()` here. This writes through a pipe in CI and in `direnv exec`, and a
 * forced exit does not drain buffered stdout — the sibling gate in scripts/check-package-versions.mjs
 * measured a run losing its entire output that way. Set `process.exitCode` and return.
 */
async function main() {
  const stage = parseStage(process.argv.slice(2))
  const targets = resolveTargets({root: repoRoot, stage})
  if (targets === null) {
    console.error(`UNMEASURED: could not enumerate ${PIN_DIR}/*${PIN_SUFFIX} — nothing was compared, so nothing is verified.`)
    process.exitCode = EXIT_UNMEASURED
    return
  }

  console.log(`check-image-drift: stage=${stage}, comparing ${String(targets.length)} committed pin(s) against the deployed Lambda image digest(s).`)
  console.log('')

  const rows = await evaluateTargets(targets, createAwsFetcher(resolveRegion()))
  for (const row of rows) {
    console.log(formatRow(row))
  }

  const exitCode = exitCodeFor(rows)
  console.log('')
  for (const line of summaryLines(rows, exitCode)) {
    console.log(line)
  }
  process.exitCode = exitCode
}

/**
 * Run main() only when this file was invoked as a script, so the unit tests can import the pure
 * functions. Resolved-path comparison (not string equality against `process.argv[1]`) because the
 * two disagree whenever any path segment is a symlink — on macOS `/var` alone is enough — and a
 * mismatch would make the script exit 0 having done nothing.
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
