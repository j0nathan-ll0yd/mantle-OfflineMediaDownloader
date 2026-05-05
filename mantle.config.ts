import { defineConfig } from '@mantleframework/core'

export default defineConfig({
  name: 'media-downloader',
  database: {provider: 'aurora-dsql'},
  backend: {
    s3: {
      bucket: 'mantle-offlinemediadownloader-tfstate',
      key: 'infra.tfstate',
      region: 'us-west-2',
      encrypt: true,
      dynamodbTable: 'TerraformStateLock',
      workspaceKeyPrefix: 'env'
    }
  },
  customVariables: [
    {
      name: 'resource_prefix',
      type: 'string',
      description: 'DEPRECATED: Legacy prefix for S3 bucket names only. New resources use module.core.name_prefix. Do not replicate in new instances. See ADR 0001.',
      validation: {oneOf: ['stag', 'prod']},
      validationMessage: "Resource prefix must be 'stag' or 'prod'."
    },
    {name: 'api_throttle_burst_limit', type: 'number', description: 'API Gateway throttle burst limit', default: '100'},
    {name: 'api_throttle_rate_limit', type: 'number', description: 'API Gateway throttle rate limit', default: '50'},
    {name: 'api_quota_limit', type: 'number', description: 'API Gateway daily quota limit', default: '10000'},
    {name: 'dsql_deletion_protection', type: 'bool', description: 'Enable deletion protection for DSQL cluster', default: 'true'},

    {
      name: 'cors_allowed_origins',
      type: 'list(string)',
      description: 'Origins allowed to fetch media files via CORS (empty list disables CORS)',
      default: '[]',
      validation: {condition: 'alltrue([for o in var.cors_allowed_origins : can(regex("^https?://", o))])', errorMessage: 'Each origin must start with http:// or https://.'}
    }
  ],
  eventbridge: {
    bus: 'MediaDownloader',
    dlqAlarm: false,
    sqsTargets: [
      {
        detailType: 'DownloadRequested',
        queue: 'DownloadQueue',
        fieldMapping: {
          fileId: '$.detail.fileId',
          sourceUrl: '$.detail.sourceUrl',
          correlationId: '$.detail.correlationId',
          userId: '$.detail.userId'
        },
        staticFields: {attempt: 1}
      }
    ]
  },
  observability: {
    adot: true,
    metricsNamespace: 'MediaDownloader',
    disableMetrics: true
  },
  secrets: {
    provider: 'sops',
    filePattern: 'secrets.{env}.enc.yaml'
  },
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
        resourceName: 'apns'
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
    {name: 'DownloadQueue', visibilityTimeoutSeconds: 900},
    {name: 'SendPushNotification', envAlias: 'SNS_QUEUE_URL'}
  ],
  cloudfront: {
    apiDistribution: {
      geoRestriction: {type: 'whitelist', locations: ['US']},
      forwardedHeaders: ['X-API-Key', 'Authorization', 'User-Agent'],
      cacheTtl: {default: 0, min: 0, max: 0}
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
  },
  layers: [
    {
      name: 'yt-dlp',
      path: 'layers/yt-dlp',
      compatibleArchitectures: ['x86_64'],
      description: 'yt-dlp binary and YouTube cookies'
    },
    {
      name: 'bgutil',
      path: 'layers/bgutil/build',
      compatibleArchitectures: ['x86_64'],
      description: 'bgutil PO-token provider for yt-dlp'
    },
    {
      name: 'ffmpeg',
      path: 'layers/ffmpeg',
      compatibleArchitectures: ['x86_64'],
      description: 'ffmpeg binary for video/audio stream merging'
    }
  ]
})
