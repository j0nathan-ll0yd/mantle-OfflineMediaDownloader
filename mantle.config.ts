import {defineConfig} from '@j0nathan-ll0yd/core'

export default defineConfig({
  name: 'media-downloader',
  database: {provider: 'aurora-dsql'},
  backend: {
    s3: {
      bucket: 'mantle-offlinemediadownloader-tfstate',
      key: 'infra-staging.tfstate', // stage-scoped key convention: infra-<stage>.tfstate
      region: 'us-west-2',
      encrypt: true,
      // OpenTofu-native locking (LP parity, 2026-07-19); DynamoDB table and the
      // inert workspaceKeyPrefix (mantle never selects a workspace) dropped.
      useLockfile: true
    }
  },
  // The single default-workspace state holds ONLY staging resources. A production
  // deploy would rename everything staging->prod, destroying the live stack; the
  // CLI refuses it until stage-scoped state keys land (mantle Phase 2d).
  allowedStages: ['staging'],
  // The automated ffmpeg/yt-dlp lanes can now refresh about 12 times/month. Keep roughly
  // eight months of immutable digests so a routine lifecycle pass cannot erase the rollback
  // window after only 2-3 months.
  // Drives the ECR lifecycle policy `countNumber` on the StartFileUpload container
  // repo (infra-api.ts). See .omc/plans/omd-prebuilt-container-lambda-2026-08-16.md, Q3.
  containerRegistry: {imageRetentionCount: 100},
  customVariables: [
    {
      name: 'resource_prefix',
      type: 'string',
      description:
        'DEPRECATED: Legacy prefix for S3 bucket names only. New resources use module.core.name_prefix. Do not replicate in new instances. See ADR 0001.',
      validation: {oneOf: ['stag', 'prod']},
      validationMessage: "Resource prefix must be 'stag' or 'prod'."
    },
    {name: 'api_throttle_burst_limit', type: 'number', description: 'API Gateway throttle burst limit', default: '100'},
    {name: 'api_throttle_rate_limit', type: 'number', description: 'API Gateway throttle rate limit', default: '50'},
    {name: 'api_quota_limit', type: 'number', description: 'API Gateway daily quota limit', default: '10000'},
    {name: 'dsql_deletion_protection', type: 'bool', description: 'Enable deletion protection for DSQL cluster', default: 'true'},

    {name: 'api_bearer_token', type: 'string', description: 'Bearer token for MCP DevTools authentication', sensitive: true, default: '""'},

    {
      name: 'cors_allowed_origins',
      type: 'list(string)',
      description: 'Origins allowed to fetch media files via CORS (empty list disables CORS)',
      default: '[]',
      validation: {
        condition: 'alltrue([for o in var.cors_allowed_origins : can(regex("^https?://", o))])',
        errorMessage: 'Each origin must start with http:// or https://.'
      }
    }
  ],
  eventbridge: {
    bus: 'MediaDownloader',
    dlqAlarm: false,
    sqsTargets: [
      {
        detailType: 'DownloadRequested',
        queue: 'DownloadQueue',
        fieldMapping: {fileId: '$.detail.fileId', sourceUrl: '$.detail.sourceUrl', correlationId: '$.detail.correlationId', userId: '$.detail.userId'},
        staticFields: {attempt: 1}
      }
    ]
  },
  observability: {
    adot: true,
    metricsNamespace: 'MediaDownloader',
    disableMetrics: true,
    alerts: {email: 'webmaster@lifegames.org', mode: 'cost-optimized', errorLogNotifier: true, criticalFunctions: ['UserLogin', 'FilesGet']}
  },
  secrets: {provider: 'sops', filePattern: 'secrets/secrets.{env}.enc.yaml'},
  sns: {
    topics: [
      {name: 'push-notifications'}
    ],
    platformApplications: [
      {
        name: 'media-downloader',
        platform: 'APNS_SANDBOX',
        credentialSecret: 'apns.staging.privateKey',
        principalSecret: 'apns.staging.certificate',
        resourceName: 'apns',
        successFeedbackSampleRate: 100,
        enableEndpointEvents: true
      }
    ]
  },
  dynamodb: [
    {name: 'idempotency', tableName: 'Idempotency', hashKey: 'id', attributes: [{name: 'id', type: 'S'}], ttlAttribute: 'expiration'}
  ],
  storage: [
    {name: 'files', bucketName: 'mantle-offlinemediadownloader-videos', cloudfront: true, intelligentTiering: true, assets: ['videos/default-file.mp4']}
  ],
  queues: [
    {name: 'DownloadQueue', visibilityTimeoutSeconds: 900, enableDlqAlarm: false},
    {name: 'SendPushNotification', enableDlqAlarm: false, visibilityTimeoutSeconds: 180},
    {name: 'EndpointEvents', enableDlqAlarm: false, visibilityTimeoutSeconds: 180}
  ],
  cloudfront: {
    apiDistribution: {
      geoRestriction: {type: 'whitelist', locations: ['US']},
      forwardedHeaders: ['X-API-Key', 'Authorization', 'User-Agent'],
      cacheTtl: {default: 0, min: 0, max: 0},
      functionType: 'cloudfront-function',
      functionSourcePath: 'cloudfront-functions/api-key-promotion.js'
    }
  },
  authorizer: {cacheTtl: 0},
  openapi: {
    additionalSchemas: [
      {source: '#types/notification-schemas', prefix: 'Notifications.'}
    ]
  },
  ci: {
    deploy: false,
    customSteps: [
      {
        name: 'openspec-validate',
        phase: 'validate',
        command: 'OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 npx -y @fission-ai/openspec@1.4.1 validate --all --strict'
      },
      {name: 'openspec-behavior-only', phase: 'validate', command: 'bash scripts/check-openspec-behavior-only.sh'},
      // Type-check test/** (tsconfig.test.json + the #test/* path mappings) in `mantle ci`
      // (Issue #567). Routed through the tsc6 wrapper: a bare `tsc` here would resolve to the
      // @typescript/native (TS7) alias during the hybrid window (mantle#257), silently running the
      // wrong compiler on the pre-push gate. Mirrors the `check:test:types` package.json script.
      {name: 'typecheck-test', phase: 'validate', command: 'node bin/tsc6.mjs --noEmit -p tsconfig.test.json'},
      // Published-package version drift. This repo publishes NOTHING today, so the check is a
      // sub-second no-op that exits 0 — it is wired now precisely so it is already in place the
      // day a packages/ entry appears, rather than being remembered (it would not be). The
      // failure it guards against is silent: `changeset publish` skips a version already in the
      // registry and exits 0, so a source edit without a version bump never reaches consumers
      // and nothing goes red.
      // That exit 0 is a real answer, not a skip. The wrapper exits 3 (INDETERMINATE, never 0)
      // whenever it has something to check but could not obtain a verdict — so the first
      // publishable package added here turns this step RED until @j0nathan-ll0yd/cli ships
      // `mantle check package-versions` and this repo bumps to it. See the header of
      // scripts/check-package-versions.mjs.
      {name: 'package-version-drift', phase: 'validate', command: 'node scripts/check-package-versions.mjs'},
      // .mcp.json entry-point resolution. Sub-second, no network, no spawning. Guards a
      // failure that is otherwise invisible: an MCP server wired into a dependency's dist/
      // by filesystem path stops spawning the day that dependency reorganises, and nothing
      // goes red -- an agent just quietly loses its tools. cli 2.0.0 retracted the `./mcp`
      // subpath from its exports map and this repo survived only because the file kept
      // shipping. See the header of scripts/check-mcp-entry.mjs.
      {name: 'mcp-entry-point', phase: 'validate', command: 'node scripts/check-mcp-entry.mjs'}
    ]
  }
})
