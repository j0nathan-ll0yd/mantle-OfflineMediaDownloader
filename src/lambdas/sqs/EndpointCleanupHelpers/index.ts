import {defineSqsHandler} from '@mantleframework/core'
import {logError, logInfo, metrics, MetricUnit} from '@mantleframework/observability'
import {z} from '@mantleframework/validation'
import {getDeviceByEndpointArn} from '#entities/queries'
import {cleanupDisabledEndpoint} from '../SendPushNotification/endpointCleanupHelpers.js'

const snsWrapperSchema = z.object({Message: z.string().optional()})

const snsEndpointEventSchema = z.object({
  EventType: z.string(),
  EndpointArn: z.string(),
  Resource: z.string(),
  Service: z.string().optional(),
  Time: z.string().optional()
})

const sqs = defineSqsHandler<string>({operationName: 'EndpointCleanupHelpers', parseBody: false, queue: 'EndpointEvents'})

export const handler = sqs(async (record) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(record.body)
  } catch {
    logError('Failed to parse SQS record body as JSON', {messageId: record.messageId})
    return
  }

  const wrapperResult = snsWrapperSchema.safeParse(parsed)
  if (!wrapperResult.success) {
    logError('SQS record body failed schema validation', {messageId: record.messageId, error: wrapperResult.error.message})
    return
  }

  let messagePayload: unknown
  try {
    messagePayload = JSON.parse(wrapperResult.data.Message ?? '')
  } catch {
    logError('Failed to parse SNS message as JSON', {messageId: record.messageId})
    return
  }

  const eventResult = snsEndpointEventSchema.safeParse(messagePayload)
  if (!eventResult.success) {
    logError('SNS message failed schema validation', {messageId: record.messageId, error: eventResult.error.message})
    return
  }

  const event = eventResult.data

  if (event.EventType !== 'EndpointDisabled') {
    logInfo('Ignoring non-EndpointDisabled event', {eventType: event.EventType})
    return
  }

  const endpointArn = event.EndpointArn
  logInfo('Processing EndpointDisabled event', {endpointArn})
  metrics.addMetric('EndpointDisabledEvent', MetricUnit.Count, 1)

  const device = await getDeviceByEndpointArn(endpointArn)
  if (!device) {
    logInfo('No device found for disabled endpoint', {endpointArn})
    return
  }

  await cleanupDisabledEndpoint(device.deviceId, endpointArn)
})
