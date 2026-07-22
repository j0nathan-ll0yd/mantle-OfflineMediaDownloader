/**
 * StartFileUpload Lambda
 *
 * Downloads YouTube videos to S3 using yt-dlp. Processes messages from
 * the download queue, handles retries, and publishes completion events.
 *
 * Trigger: SQS DownloadQueue (via EventBridge)
 * Input: SQSEvent with DownloadQueueMessage records
 * Output: SQSBatchResponse with item failures for retry
 *
 * @see {@link file://./downloadOrchestrator.ts} for core processing logic
 */
import {defineLambda} from '@mantleframework/core'
import {defineSqsHandler} from '@mantleframework/core'
import {logError} from '@mantleframework/observability'
import {downloadQueueMessageSchema, type ValidatedDownloadQueueMessage} from '#types/schemas'
import {validateSchema} from '@mantleframework/validation'
import {processDownloadRequest} from './downloadOrchestrator.js'

defineLambda({
  packageType: 'container',
  dockerfile: 'docker/Dockerfile.download',
  architecture: 'x86_64',
  memorySize: 2048,
  ephemeralStorage: 10240,
  timeout: 900,
  reservedConcurrency: 1,
  secrets: {GITHUB_PERSONAL_TOKEN: 'github.issue.token'},
  staticEnvVars: {
    YTDLP_BINARY_PATH: '/opt/bin/yt-dlp',
    YTDLP_COOKIES_PATH: '/opt/cookies/youtube-cookies.txt',
    YTDLP_SLEEP_REQUESTS: '1',
    YTDLP_SLEEP_INTERVAL: '2',
    YTDLP_MAX_SLEEP_INTERVAL: '5',
    AWS_SDK_UA_APP_ID: 'StartFileUpload'
  },
  bind: {SNS_QUEUE_URL: 'SendPushNotification'}
})

const sqs = defineSqsHandler({operationName: 'StartFileUpload', parseBody: true, timeout: 900, memorySize: 2048, queue: 'DownloadQueue'})

export const handler = sqs(async (record) => {
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? '1')

  const validationResult = validateSchema(downloadQueueMessageSchema, record.body)
  if (!validationResult.success) {
    logError('Invalid SQS message format - discarding', {messageId: record.messageId, errors: validationResult.errors})
    return
  }

  const message = validationResult.data as ValidatedDownloadQueueMessage
  await processDownloadRequest(message, receiveCount)
})
