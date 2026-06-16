import {buildValidatedResponse} from '@mantleframework/core'
import {logInfo, metrics, MetricUnit} from '@mantleframework/observability'
import {defineApiHandler} from '@mantleframework/validation'
import {createDeviceEvents, getUserDevicesByDeviceId, updateDevice} from '#entities/queries'
import {clientEventBatchRequestSchema} from '#types/client-event-schemas'
import type {ClientEvent} from '#types/client-event-schemas'

function extractCorrelationId(event: ClientEvent): string | undefined {
  if ('correlationId' in event) {
    return event.correlationId
  }
  return undefined
}

const api = defineApiHandler({auth: 'authorizer-optional', schema: clientEventBatchRequestSchema, operationName: 'DeviceEvent'})
export const handler = api(async ({event, context, userId, body}) => {
  const deviceId = Object.entries(event.headers).find(([k]) => k.toLowerCase() === 'x-device-uuid')?.[1]
  if (!deviceId) {
    return buildValidatedResponse(context, 400)
  }

  if (userId) {
    const userDevices = await getUserDevicesByDeviceId(deviceId)
    if (userDevices.every((ud) => !(ud.userId === userId))) {
      return buildValidatedResponse(context, 403)
    }
  }

  const eventsToInsert = body.events.map((evt) => ({
    deviceId,
    eventType: evt.eventType,
    timestamp: new Date(evt.timestamp),
    properties: JSON.stringify(evt),
    correlationId: extractCorrelationId(evt)
  }))

  const inserted = await createDeviceEvents(eventsToInsert)

  await updateDevice(deviceId, {lastSeenAt: new Date()})

  metrics.addMetric('DeviceEventReceived', MetricUnit.Count, body.events.length)
  metrics.addMetric('DeviceEventBatchSize', MetricUnit.Count, body.events.length)
  logInfo('Device events ingested', {deviceId, received: body.events.length, inserted: inserted.length})

  return buildValidatedResponse(context, 204)
})
