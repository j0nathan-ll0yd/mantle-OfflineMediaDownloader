import {defineSqsHandler} from '@mantleframework/core'
import {logError, logInfo, metrics, MetricUnit} from '@mantleframework/observability'
import {getDeviceByEndpointArn} from '#entities/queries'
import {cleanupDisabledEndpoint} from '../SendPushNotification/endpointCleanupHelpers.js'

interface SnsEndpointEvent {
  EventType: string
  Resource: string
}

const sqs = defineSqsHandler<string>({operationName: 'EndpointCleanupHelpers', parseBody: false, queue: 'EndpointEvents'})

export const handler = sqs(async (record) => {
  let snsWrapper: {Message?: string}
  try {
    snsWrapper = JSON.parse(record.body)
  } catch {
    logError('Failed to parse SQS record body', {messageId: record.messageId})
    return
  }

  let event: SnsEndpointEvent
  try {
    event = JSON.parse(snsWrapper.Message ?? '')
  } catch {
    logError('Failed to parse SNS message', {messageId: record.messageId})
    return
  }

  if (event.EventType !== 'EndpointDisabled') {
    logInfo('Ignoring non-EndpointDisabled event', {eventType: event.EventType})
    return
  }

  const endpointArn = event.Resource
  logInfo('Processing EndpointDisabled event', {endpointArn})
  metrics.addMetric('EndpointDisabledEvent', MetricUnit.Count, 1)

  const device = await getDeviceByEndpointArn(endpointArn)
  if (!device) {
    logInfo('No device found for disabled endpoint', {endpointArn})
    return
  }

  await cleanupDisabledEndpoint(device.deviceId, endpointArn)
})
