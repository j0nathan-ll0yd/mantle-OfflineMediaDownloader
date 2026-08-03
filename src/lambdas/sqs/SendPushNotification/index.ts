/**
 * SendPushNotification Lambda
 *
 * Sends APNS push notifications to user devices via SQS queue processing.
 *
 * Trigger: SQS Queue (from S3ObjectCreated)
 */
import {defineSqsHandler, isErr} from '@j0nathan-ll0yd/core'
import {addAnnotation, addMetadata, endSpan, logError, logInfo, metrics, MetricUnit, startSpan} from '@j0nathan-ll0yd/observability'
import type {FileNotificationType} from '#types/notificationTypes'
import {pushNotificationAttributesSchema} from '#types/schemas'
import {validateSchema} from '@j0nathan-ll0yd/validation'
import {cleanupDisabledEndpoints} from './endpointCleanupHelpers.js'
import {getDevice, getDeviceIdsForUser, mapSettledToDeviceResults, processNotificationResults, sendNotificationToDevice} from './pushHelpers.js'

const sqs = defineSqsHandler<string>({operationName: 'SendPushNotification', parseBody: false, queue: 'SendPushNotification'})

export const handler = sqs(async (record) => {
  const rawAttributes = {notificationType: record.messageAttributes.notificationType?.stringValue, userId: record.messageAttributes.userId?.stringValue}
  const validationResult = validateSchema(pushNotificationAttributesSchema, rawAttributes)
  if (!validationResult.success) {
    logError('Invalid SQS message attributes - discarding', {messageId: record.messageId, errors: validationResult.errors})
    return
  }

  const validatedAttrs = validationResult.data as {notificationType: string; userId: string}
  const notificationType = validatedAttrs.notificationType as FileNotificationType
  const userId = validatedAttrs.userId
  const span = startSpan('send-push')
  addAnnotation(span, 'userId', userId)
  addAnnotation(span, 'notificationType', notificationType)

  try {
    const deviceIds = await getDeviceIdsForUser(userId)
    addMetadata(span, 'deviceCount', deviceIds.length)
    if (deviceIds.length === 0) {
      logInfo('No devices registered for user', {userId})
      endSpan(span)
      return
    }

    logInfo('Sending notifications to devices', {userId, deviceCount: deviceIds.length})
    const results = await Promise.allSettled(deviceIds.map(async (deviceId) => {
      const device = await getDevice(deviceId)
      return sendNotificationToDevice(device, record.body, notificationType)
    }))

    const deviceResults = mapSettledToDeviceResults(results, deviceIds)
    const {succeeded, failed, disabledEndpoints} = processNotificationResults(deviceResults, deviceIds, userId)

    metrics.addMetric('PushNotificationsSent', MetricUnit.Count, succeeded.length)
    addMetadata(span, 'notificationsSent', succeeded.length)
    addMetadata(span, 'notificationsFailed', failed.length)
    addMetadata(span, 'disabledEndpoints', disabledEndpoints.length)

    if (failed.length > 0) {
      metrics.addMetric('PushNotificationsFailed', MetricUnit.Count, failed.length)
    }
    if (disabledEndpoints.length > 0) {
      metrics.addMetric('DisabledEndpointsDetected', MetricUnit.Count, disabledEndpoints.length)
      const disabledDeviceIds = disabledEndpoints.flatMap((r) => isErr(r) ? [r.error.deviceId] : [])
      logInfo('Cleaning up disabled endpoints', {userId, deviceIds: disabledDeviceIds})
      void cleanupDisabledEndpoints(disabledDeviceIds).catch((err: unknown) => {
        logError('Async endpoint cleanup failed', {error: err instanceof Error ? err.message : String(err)})
      })
    }

    if (succeeded.length === 0 && failed.length > 0) {
      const error = new Error(`All ${failed.length} device notifications failed`)
      endSpan(span, error)
      throw error
    }
    endSpan(span)
  } catch (error) {
    endSpan(span, error as Error)
    throw error
  }
})
