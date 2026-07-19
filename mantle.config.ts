import {defineConfig} from '@mantleframework/core'

export default defineConfig({
  name: 'media-downloader',
  database: {provider: 'aurora-dsql'},
  backend: {
    s3: {
      bucket: 'mantle-offlinemediadownloader-tfstate',
      key: 'infra.tfstate',
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
    mantleRepo: 'j0nathan-ll0yd/mantle',
    mantleRef: 'main',
    mantleAuthSecret: 'MANTLE_DEPLOY_KEY',
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
      {name: 'typecheck-test', phase: 'validate', command: 'node bin/tsc6.mjs --noEmit -p tsconfig.test.json'}
    ]
  }
})
