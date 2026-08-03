/**
 * WebhookFeedly Lambda
 *
 * Receives Feedly webhook notifications for new YouTube videos.
 * Validates the article URL, creates a file record, and queues for download.
 *
 * Trigger: API Gateway POST /feedly/webhook
 * Input: FeedlyWebhookRequest with articleURL
 * Output: APIGatewayProxyResult with file metadata
 */
import {buildValidatedResponse, defineLambda, emitEvent} from '@j0nathan-ll0yd/core'
import {addAnnotation, addMetadata, endSpan, logInfo, metrics, MetricUnit, startSpan} from '@j0nathan-ll0yd/observability'
import {createIdempotencyStore, IdempotencyConfig, makeIdempotent} from '@j0nathan-ll0yd/resilience'
import {defineApiHandler, z} from '@j0nathan-ll0yd/validation'
defineLambda({bind: {SNS_QUEUE_URL: 'SendPushNotification'}})
import {associateFileToUser} from '#domain/user/userFileService'
import {addFile, getFile, sendFileNotification} from '#services/file/fileInitService'
import {getVideoID} from '#services/youtube/youtube'
import {webhookResponseSchema} from '#types/api-schema'
import {FileStatus, ResponseStatus} from '#types/enums'
import type {DownloadRequestedDetail} from '#types/events'
import type {WebhookProcessingInput, WebhookProcessingResult} from '#types/lambda'

/**
 * Core webhook processing logic - wrapped with idempotency.
 * Idempotency ensures duplicate webhook calls return the same response.
 *
 * IMPORTANT: The file record MUST exist before associating it to the user.
 * The user_files junction table association must happen AFTER addFile() for new files,
 * otherwise the association silently fails (Promise.allSettled swallows the error)
 * and the file becomes invisible to GET /files which uses an INNER JOIN through user_files.
 */
async function processWebhookRequest(input: WebhookProcessingInput): Promise<WebhookProcessingResult> {
  const {fileId, userId, articleURL, correlationId} = input
  const span = startSpan('webhook-process')
  addAnnotation(span, 'fileId', fileId)
  addAnnotation(span, 'correlationId', correlationId)
  addMetadata(span, 'userId', userId)

  try {
    // Step 1: Check if file already exists
    const file = await getFile(fileId)

    // Step 2: Create file record if it doesn't exist yet
    if (!file) {
      await addFile(fileId, articleURL, correlationId)
      addMetadata(span, 'newFile', true)
    }

    // Step 3: Associate file to user AFTER file is guaranteed to exist
    await associateFileToUser(fileId, userId)

    // Step 4: If file is already downloaded, notify user immediately
    if (file && file.status === FileStatus.Downloaded) {
      await sendFileNotification(file, userId)
      addMetadata(span, 'action', 'dispatched')
      endSpan(span)
      return {statusCode: 200, status: ResponseStatus.Dispatched}
    }

    // Step 5: File is new or still processing — emit download event
    const eventDetail: DownloadRequestedDetail = {fileId, userId, sourceUrl: articleURL, correlationId, requestedAt: new Date().toISOString()}
    await emitEvent({detailType: 'DownloadRequested', detail: eventDetail})
    logInfo('Published DownloadRequested event', {fileId, correlationId})
    addMetadata(span, 'action', 'accepted')
    endSpan(span)
    return {statusCode: 202, status: ResponseStatus.Accepted}
  } catch (error) {
    endSpan(span, error as Error)
    throw error
  }
}

// Idempotent wrapper - lazy initialization for env var availability
let idempotentProcessor: ((input: WebhookProcessingInput) => Promise<WebhookProcessingResult>) | null = null
let idempotencyConfig: IdempotencyConfig | null = null

/** Get the idempotent processor, lazily initialized */
function getIdempotentProcessor(): {processor: (input: WebhookProcessingInput) => Promise<WebhookProcessingResult>; config: IdempotencyConfig} {
  if (!idempotentProcessor || !idempotencyConfig) {
    idempotencyConfig = new IdempotencyConfig({})
    idempotentProcessor = makeIdempotent(processWebhookRequest, {
      persistenceStore: createIdempotencyStore(),
      config: idempotencyConfig,
      dataIndexArgument: 0
    })
  }
  return {processor: idempotentProcessor, config: idempotencyConfig}
}

const FeedlyWebhookRequestSchema = z.object({articleURL: z.string()})

const api = defineApiHandler({auth: 'authorizer', schema: FeedlyWebhookRequestSchema, operationName: 'WebhookFeedly'})
export const handler = api(async ({context, userId, body, metadata}) => {
  metrics.addMetric('WebhookReceived', MetricUnit.Count, 1)
  logInfo('Processing request', {correlationId: metadata.correlationId, traceId: metadata.traceId})

  const fileId = getVideoID(body.articleURL)
  const {processor, config} = getIdempotentProcessor()
  config.registerLambdaContext(context)

  const result = await processor({fileId, userId, articleURL: body.articleURL, correlationId: metadata.correlationId})
  metrics.addMetric('WebhookProcessed', MetricUnit.Count, 1)

  return buildValidatedResponse(context, result.statusCode, {status: result.status as 'Dispatched' | 'Initiated' | 'Accepted'}, webhookResponseSchema)
})
