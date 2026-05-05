/**
 * DeviceEvent Lambda
 *
 * Receives and logs events from the iOS client for debugging and analytics.
 * Simple pass-through to CloudWatch logs for later analysis.
 *
 * Trigger: API Gateway POST /device/event
 * Input: JSON payload with device ID and event message
 * Output: 204 No Content on success
 */
import {buildValidatedResponse} from '@mantleframework/core'
import {addAnnotation, endSpan, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
import {defineApiHandler} from '@mantleframework/validation'

const api = defineApiHandler({auth: 'none', operationName: 'DeviceEvent'})
export const handler = api(async ({event, context}) => {
  metrics.addMetric('DeviceEventReceived', MetricUnit.Count, 1)

  const span = startSpan('device-event-log')
  const deviceId = event.headers['x-device-uuid']
  if (deviceId) {
    addAnnotation(span, 'deviceId', deviceId)
  }

  const message = event.body
  logInfo('Event received', {deviceId, message})
  endSpan(span)

  return buildValidatedResponse(context, 204)
})
