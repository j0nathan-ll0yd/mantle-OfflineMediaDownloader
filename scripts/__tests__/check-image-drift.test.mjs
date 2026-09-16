/**
 * Known-answer tests for the staging image-drift measurer.
 *
 * The evaluator is exercised through an INJECTED fetcher, so every verdict — match, drift, and
 * each distinct flavour of unmeasured — is reachable offline with no AWS call. The final block
 * spawns the shipped file against this repo's real pin, infra, and tfvars with a stubbed `aws` on
 * PATH: pure functions returning the right value says nothing about whether the process exits with
 * it, and the exit code is the only thing this check communicates to a caller.
 */

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {delimiter, dirname, join, resolve} from 'node:path'
import {after, describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  declaresPin,
  evaluateTarget,
  evaluateTargets,
  exitCodeFor,
  extractContainerFunctionName,
  extractDigest,
  extractStagePrefix,
  formatRow,
  parsePinDigest,
  redactAccountIds,
  summaryLines
} from '../check-image-drift.mjs'

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(scriptsDir, '..')
const script = join(scriptsDir, 'check-image-drift.mjs')

const PINNED = 'sha256:2c8bf906e3febc5c1a5e889d53ca26a1c6b5508b09d475cec95fd4ef7bf419aa'
const OTHER = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'

const pinText = (digest) => JSON.stringify({digest, bundleHash: OTHER, tag: 'sha-3db71539'})
const target = (overrides) => ({pinPath: 'docker/start-file-upload.pin.json', pinText: pinText(PINNED), functionName: 'staging-StartFileUpload', ...overrides})
const fetcherReturning = (value) => async () => value

const created = []
after(() => {
  for (const dir of created) {
    rmSync(dir, {recursive: true, force: true})
  }
})

describe('redactAccountIds', () => {
  test('replaces a 12-digit account id inside an ARN', () => {
    assert.equal(
      redactAccountIds('User: arn:aws:iam::123456789012:role/reader is not authorized'),
      'User: arn:aws:iam::<account>:role/reader is not authorized'
    )
  })

  test('replaces the account label in an ECR host', () => {
    assert.equal(redactAccountIds('123456789012.dkr.ecr.us-west-2.amazonaws.com/staging/x'), '<account>.dkr.ecr.us-west-2.amazonaws.com/staging/x')
  })

  test('leaves a sha256 digest intact — it is not account-identifying and the reader needs it', () => {
    assert.equal(redactAccountIds(PINNED), PINNED)
  })
})

describe('extractDigest', () => {
  test('reads the digest out of a digest-pinned image reference', () => {
    assert.equal(extractDigest(`123456789012.dkr.ecr.us-west-2.amazonaws.com/staging/start-file-upload@${PINNED}`), PINNED)
  })

  test('accepts a bare digest', () => {
    assert.equal(extractDigest(PINNED), PINNED)
  })

  test('returns null for a TAG-only reference: a tag cannot identify the running image', () => {
    assert.equal(extractDigest('123456789012.dkr.ecr.us-west-2.amazonaws.com/staging/start-file-upload:sha-3db71539'), null)
  })

  test('returns null for a short or non-hex digest rather than accepting it', () => {
    assert.equal(extractDigest('sha256:2c8bf906'), null)
    assert.equal(extractDigest('sha256:zzzz'), null)
  })

  test('returns null for absent input', () => {
    assert.equal(extractDigest(), null)
    assert.equal(extractDigest(null), null)
    assert.equal(extractDigest(''), null)
  })
})

describe('parsePinDigest', () => {
  test('reads a well-formed pin record', () => {
    assert.deepEqual(parsePinDigest(pinText(PINNED)), {digest: PINNED})
  })

  test('malformed JSON is a problem, never an empty pass', () => {
    assert.match(parsePinDigest('{not json').problem, /not valid JSON/)
  })

  test('a JSON array or scalar is not a pin record', () => {
    assert.match(parsePinDigest('[]').problem, /not a JSON object/)
    assert.match(parsePinDigest('"sha256:x"').problem, /not a JSON object/)
  })

  test('a pin record with no digest field is a problem', () => {
    assert.match(parsePinDigest(JSON.stringify({tag: 'sha-3db71539'})).problem, /no string `digest` field/)
  })

  test('a tag in the digest field is a problem, not a comparable value', () => {
    assert.match(parsePinDigest(JSON.stringify({digest: 'sha-3db71539'})).problem, /not a sha256 manifest digest/)
  })
})

describe('extractStagePrefix', () => {
  test('reads `environment` from tfvars, which IS module.core.name_prefix', () => {
    assert.equal(extractStagePrefix('# comment\nenvironment        = "staging"\nlog_level = "INFO"\n'), 'staging')
  })

  test('returns null when the key is absent so the caller reports UNMEASURED', () => {
    assert.equal(extractStagePrefix('log_level = "INFO"\n'), null)
    assert.equal(extractStagePrefix(), null)
  })

  test('a commented-out environment line is not a prefix', () => {
    assert.equal(extractStagePrefix('# environment = "prod"\n'), null)
  })
})

describe('declaresPin', () => {
  const source = "defineLambda({\n  packageType: 'container',\n  imageDigestFile: 'docker/start-file-upload.pin.json',\n})"

  test('finds the declaring Lambda', () => {
    assert.equal(declaresPin(source, 'docker/start-file-upload.pin.json'), true)
  })

  test('does not match a different pin path', () => {
    assert.equal(declaresPin(source, 'docker/other.pin.json'), false)
  })

  test('accepts double and backtick quoting', () => {
    assert.equal(declaresPin('imageDigestFile: "docker/a.pin.json"', 'docker/a.pin.json'), true)
    assert.equal(declaresPin('imageDigestFile: `docker/a.pin.json`', 'docker/a.pin.json'), true)
  })

  test('a file with no imageDigestFile option does not match', () => {
    assert.equal(declaresPin('defineLambda({timeout: 900})', 'docker/a.pin.json'), false)
  })
})

describe('extractContainerFunctionName', () => {
  const block = [
    'module "lambda_start_file_upload" {',
    '  source = "../node_modules/@j0nathan-ll0yd/cli/modules/lambda"',
    '',
    '  function_name = "StartFileUpload"',
    '  package_type  = "Image"',
    '  image_uri     = var.image_uri_start_file_upload',
    '  source_dir    = "${path.module}/../build/lambdas/StartFileUpload"',
    '}'
  ].join('\n')

  test('joins a lambda directory to its Terraform function_name', () => {
    assert.deepEqual(extractContainerFunctionName(block, 'StartFileUpload'), {functionName: 'StartFileUpload'})
  })

  test('a block with no image_uri reports a problem: the pin is no longer measurable', () => {
    assert.match(extractContainerFunctionName(block.replace(/^\s*image_uri.*$/m, ''), 'StartFileUpload').problem, /no longer a container-image Lambda/)
  })

  test('a block with no function_name reports a problem', () => {
    assert.match(extractContainerFunctionName(block.replace(/^\s*function_name.*$/m, ''), 'StartFileUpload').problem, /declares no function_name/)
  })

  test('no matching module is a problem, not a silent skip', () => {
    assert.match(extractContainerFunctionName(block, 'SomeOtherLambda').problem, /no generated infra module builds from/)
  })

  test('the source_dir join is exact, so a prefix of another lambda name does not match', () => {
    assert.match(extractContainerFunctionName(block, 'StartFile').problem, /no generated infra module builds from/)
  })
})

describe('evaluateTarget with an injected fetcher', () => {
  test('MATCH when the deployed digest equals the committed pin', async () => {
    const row = await evaluateTarget(target(), fetcherReturning({digest: PINNED}))
    assert.equal(row.verdict, 'MATCH')
    assert.equal(row.pinDigest, PINNED)
    assert.equal(row.deployedDigest, PINNED)
  })

  test('DRIFT when the deployed digest differs, carrying both digests', async () => {
    const row = await evaluateTarget(target(), fetcherReturning({digest: OTHER}))
    assert.equal(row.verdict, 'DRIFT')
    assert.equal(row.pinDigest, PINNED)
    assert.equal(row.deployedDigest, OTHER)
  })

  test('UNMEASURED when the fetcher reports a problem (no credentials, API error)', async () => {
    const row = await evaluateTarget(target(), fetcherReturning({problem: 'aws lambda get-function exited 255: Unable to locate credentials'}))
    assert.equal(row.verdict, 'UNMEASURED')
    assert.match(row.detail, /Unable to locate credentials/)
    assert.equal(row.deployedDigest, null)
  })

  test('UNMEASURED when the fetcher returns neither a digest nor a problem', async () => {
    const row = await evaluateTarget(target(), fetcherReturning({}))
    assert.equal(row.verdict, 'UNMEASURED')
    assert.match(row.detail, /returned no digest/)
  })

  test('UNMEASURED on a malformed pin, and the fetcher is never consulted', async () => {
    let calls = 0
    const row = await evaluateTarget(target({pinText: '{not json'}), async () => {
      calls++
      return {digest: PINNED}
    })
    assert.equal(row.verdict, 'UNMEASURED')
    assert.match(row.detail, /not valid JSON/)
    assert.equal(calls, 0, 'an unreadable pin has nothing to compare, so the AWS call must not be made')
  })

  test('UNMEASURED when resolution already failed, with the function name left null', async () => {
    const row = await evaluateTarget({pinPath: 'docker/orphan.pin.json', problem: 'no src/lambdas declares this pin'}, fetcherReturning({digest: PINNED}))
    assert.equal(row.verdict, 'UNMEASURED')
    assert.equal(row.functionName, null)
    assert.match(row.detail, /no src\/lambdas declares this pin/)
  })

  test('THE INVARIANT: no fetcher outcome other than the pinned digest may produce MATCH', async () => {
    const outcomes = [
      {problem: 'Unable to locate credentials'},
      {problem: 'ResourceNotFoundException'},
      {},
      {digest: null},
      {digest: OTHER},
      {digest: 'sha-3db71539'},
      null,
      undefined
    ]
    for (const outcome of outcomes) {
      const row = await evaluateTarget(target(), fetcherReturning(outcome))
      assert.notEqual(row.verdict, 'MATCH', `MATCH must be unreachable for ${JSON.stringify(outcome)}`)
    }
  })
})

describe('evaluateTargets', () => {
  test('produces exactly one row per pin, in input order', async () => {
    const rows = await evaluateTargets(
      [target({pinPath: 'docker/a.pin.json'}), target({pinPath: 'docker/b.pin.json', pinText: pinText(OTHER)})],
      fetcherReturning({digest: PINNED})
    )
    assert.deepEqual(rows.map((row) => [row.pinPath, row.verdict]), [['docker/a.pin.json', 'MATCH'], ['docker/b.pin.json', 'DRIFT']])
  })
})

describe('exitCodeFor', () => {
  const row = (verdict) => ({verdict})

  test('all match is 0', () => {
    assert.equal(exitCodeFor([row('MATCH'), row('MATCH')]), 0)
  })

  test('any drift is 1', () => {
    assert.equal(exitCodeFor([row('MATCH'), row('DRIFT')]), 1)
  })

  test('drift outranks unmeasured: the actionable row must not be hidden behind 3', () => {
    assert.equal(exitCodeFor([row('UNMEASURED'), row('DRIFT')]), 1)
  })

  test('unmeasured with no drift is 3', () => {
    assert.equal(exitCodeFor([row('MATCH'), row('UNMEASURED')]), 3)
  })

  test('zero rows is 3, not a pass: a run that compared nothing verified nothing', () => {
    assert.equal(exitCodeFor([]), 3)
  })
})

describe('formatRow', () => {
  test('DRIFT carries both digests and its own remediation', () => {
    const line = formatRow({verdict: 'DRIFT', pinPath: 'docker/a.pin.json', functionName: 'staging-StartFileUpload', pinDigest: PINNED, deployedDigest: OTHER})
    assert.match(line, /^DRIFT docker\/a\.pin\.json staging-StartFileUpload/)
    assert.match(line, new RegExp(`pin ${PINNED} deployed ${OTHER}`))
    assert.match(line, /npx mantle deploy --stage staging/)
  })

  test('MATCH names the digest it verified', () => {
    assert.equal(
      formatRow({verdict: 'MATCH', pinPath: 'docker/a.pin.json', functionName: 'staging-StartFileUpload', pinDigest: PINNED, deployedDigest: PINNED}),
      `MATCH docker/a.pin.json staging-StartFileUpload — ${PINNED}`
    )
  })

  test('UNMEASURED states the reason with account ids redacted', () => {
    const line = formatRow({
      verdict: 'UNMEASURED',
      pinPath: 'docker/a.pin.json',
      functionName: 'staging-StartFileUpload',
      detail: 'arn:aws:iam::123456789012:role/reader is not authorized'
    })
    assert.match(line, /^UNMEASURED /)
    assert.match(line, /<account>/)
    assert.doesNotMatch(line, /123456789012/)
  })

  test('an unresolved function name is labelled rather than printed as undefined', () => {
    assert.match(formatRow({verdict: 'UNMEASURED', pinPath: 'docker/a.pin.json', functionName: null, detail: 'x'}), /\(function unresolved\)/)
  })
})

describe('summaryLines', () => {
  test('exit 1 is stated as advisory, with the deploy command', () => {
    const text = summaryLines([{verdict: 'DRIFT'}], 1).join('\n')
    assert.match(text, /ADVISORY/)
    assert.match(text, /npx mantle deploy --stage staging/)
    assert.match(text, /not a broken build/)
  })

  test('exit 3 is stated as NOT a pass', () => {
    assert.match(summaryLines([{verdict: 'UNMEASURED'}], 3).join('\n'), /NOT a pass/)
  })

  test('counts every verdict', () => {
    assert.match(summaryLines([{verdict: 'MATCH'}, {verdict: 'DRIFT'}, {verdict: 'UNMEASURED'}], 1)[0], /3 pin\(s\): 1 match, 1 drift, 1 unmeasured\./)
  })
})

/**
 * Process boundary. These run the shipped file against THIS repo's real docker/*.pin.json,
 * infra/*.tf and infra/environments/staging.tfvars, with a stub `aws` first on PATH. They are the
 * only coverage of resolveTargets — the pin-to-function-name derivation — and they would catch a
 * rename that made the measurer look up a function that does not exist.
 */
describe('spawned against the real repo with a stubbed aws CLI', () => {
  function runWith({digest, exitStatus = 0}) {
    const dir = mkdtempSync(join(tmpdir(), 'image-drift-'))
    created.push(dir)
    const shim = join(dir, 'aws')
    const payload = JSON.stringify({
      Configuration: {PackageType: 'Image'},
      Code: {ImageUri: `123456789012.dkr.ecr.us-west-2.amazonaws.com/staging/start-file-upload@${digest}`, ResolvedImageUri: `x@${digest}`}
    })
    const lines = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "configure" ]; then printf %s "us-west-2"; exit 0; fi',
      `if [ ${String(exitStatus)} -ne 0 ]; then printf %s "Unable to locate credentials" >&2; exit ${String(exitStatus)}; fi`,
      `printf %s ${JSON.stringify(payload)}`,
      ''
    ]
    writeFileSync(shim, lines.join('\n'))
    chmodSync(shim, 0o755)
    return spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, AWS_REGION: 'us-west-2'}
    })
  }

  test('exits 0 and reports MATCH for staging-StartFileUpload when the stub returns the committed digest', () => {
    const result = runWith({digest: PINNED})
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^MATCH docker\/start-file-upload\.pin\.json staging-StartFileUpload/m)
    assert.match(result.stdout, /Exit 0: every committed pin is the image the stage is running\./)
  })

  test('exits 1 and reports DRIFT with the remediation when the stub returns a different digest', () => {
    const result = runWith({digest: OTHER})
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /^DRIFT docker\/start-file-upload\.pin\.json staging-StartFileUpload/m)
    assert.match(result.stdout, /npx mantle deploy --stage staging/)
  })

  test('exits 3 and reports UNMEASURED when the CLI fails, never 0', () => {
    const result = runWith({digest: PINNED, exitStatus: 255})
    assert.equal(result.status, 3, result.stdout + result.stderr)
    assert.match(result.stdout, /^UNMEASURED docker\/start-file-upload\.pin\.json staging-StartFileUpload/m)
    assert.match(result.stdout, /Unable to locate credentials/)
    assert.match(result.stdout, /NOT a pass/)
  })
})
