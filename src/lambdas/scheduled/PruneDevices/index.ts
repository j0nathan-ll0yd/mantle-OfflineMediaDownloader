/**
 * PruneDevices Lambda
 *
 * Scheduled job to clean up inactive or invalid device registrations.
 * Removes devices with expired APNS tokens or inactive endpoints.
 *
 * Trigger: CloudWatch Schedule (daily)
 * Input: ScheduledEvent
 * Output: PruneDevicesResult with deletion counts
 */
import {defineLambda, defineScheduledHandler} from '@mantleframework/core'
import {getOptionalEnv, getRequiredEnv} from '@mantleframework/env'
import {UnexpectedError} from '@mantleframework/errors'
import {addMetadata, endSpan, logDebug, logError, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
import {deleteUserDevicesByDeviceId, getAllDevices} from '#entities/queries'
import type {Apns2Error} from '#errors/custom-errors'
import {deleteDevice} from '#services/device/deviceService'
import type {Device} from '#types/domainModels'
import type {ApplePushNotificationResponse, PruneDevicesResult} from '#types/lambda'
import {secondsAgo, TIME} from '#utils/time'

defineLambda({
  secrets: {
    APNS_SIGNING_KEY: 'apns.staging.signingKey',
    APNS_TEAM: 'apns.staging.team',
    APNS_KEY_ID: 'apns.staging.keyId',
    APNS_DEFAULT_TOPIC: 'apns.staging.defaultTopic'
  },
  staticEnvVars: {APNS_HOST: 'api.sandbox.push.apple.com'}
})

// Re-export types for external consumers
export type { PruneDevicesResult } from '#types/lambda'

/** Fetch all devices from the database */
async function getDevices(): Promise<Device[]> {
  const devices = await getAllDevices()
  logDebug('getDevices =>', {count: devices.length})
  return devices as Device[]
}

/** Send a health-check background push to a device token via APNS */
async function dispatchHealthCheckNotificationToDeviceToken(token: string): Promise<ApplePushNotificationResponse> {
  logInfo('dispatchHealthCheckNotificationToDeviceToken')
  // Dynamic import for ESM compatibility - apns2 is CJS-only
  const {ApnsClient, Notification, Priority, PushType} = await import('apns2')
  const client = new ApnsClient({
    team: getRequiredEnv('APNS_TEAM'),
    keyId: getRequiredEnv('APNS_KEY_ID'),
    signingKey: getRequiredEnv('APNS_SIGNING_KEY'),
    defaultTopic: getRequiredEnv('APNS_DEFAULT_TOPIC'),
    host: getOptionalEnv('APNS_HOST', 'api.sandbox.push.apple.com')
  })
  const healthCheckNotification = new Notification(token, {
    contentAvailable: true,
    type: PushType.background,
    priority: Priority.throttled,
    aps: {health: 'check'}
  })
  try {
    logDebug('apnProvider.send <=', healthCheckNotification as unknown as Record<string, unknown>)
    const result = await client.send(healthCheckNotification)
    logDebug('apnProvider.send =>', result as unknown as Record<string, unknown>)
    return {statusCode: 200}
  } catch (err) {
    logError('apnProvider.send =>', {error: err instanceof Error ? err.message : String(err)})
    if (err && typeof err === 'object' && 'reason' in err) {
      const apnsError = err as Apns2Error
      return {statusCode: Number(apnsError.statusCode), reason: apnsError.reason}
    }
    throw new UnexpectedError('Unexpected result from APNS')
  }
}

/** Check if a device token is disabled (APNS returns 410) */
async function isDeviceDisabled(token: string): Promise<boolean> {
  const apnsResponse = await dispatchHealthCheckNotificationToDeviceToken(token)
  return apnsResponse.statusCode === 410
}

const scheduled = defineScheduledHandler({operationName: 'PruneDevices', schedule: {expression: 'rate(1 day)'}, timeout: 300})

export const handler = scheduled(async (): Promise<PruneDevicesResult> => {
  metrics.addMetric('PruneDevicesRun', MetricUnit.Count, 1)
  const span = startSpan('prune-devices-cleanup')
  const result: PruneDevicesResult = {devicesChecked: 0, devicesPruned: 0, errors: []}

  const devices = await getDevices()
  result.devicesChecked = devices.length

  const staleThreshold = secondsAgo(30 * TIME.DAY_SEC)

  for (const device of devices) {
    const deviceId = device.deviceId
    logInfo('Verifying device', {deviceId})

    let shouldPrune = false
    let pruneReason = ''

    if (await isDeviceDisabled(device.token)) {
      shouldPrune = true
      pruneReason = 'APNS 410'
    } else if (device.lastSeenAt && device.lastSeenAt < staleThreshold) {
      shouldPrune = true
      pruneReason = 'lastSeenAt stale'
      logInfo('Device stale by lastSeenAt', {deviceId, lastSeenAt: device.lastSeenAt.toISOString()})
    }

    if (shouldPrune) {
      try {
        await deleteUserDevicesByDeviceId(deviceId)
        await deleteDevice(device)
        result.devicesPruned++
        logInfo('Pruned device', {deviceId, reason: pruneReason})
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const errorMessage = `Failed to properly remove device ${deviceId}: ${message}`
        logError(errorMessage, {deviceId})
        result.errors.push(errorMessage)
      }
    }
  }

  metrics.addMetric('DevicesPruned', MetricUnit.Count, result.devicesPruned)
  addMetadata(span, 'devicesChecked', result.devicesChecked)
  addMetadata(span, 'devicesPruned', result.devicesPruned)
  addMetadata(span, 'errors', result.errors.length)
  endSpan(span)

  logInfo('PruneDevices completed', result as unknown as Record<string, unknown>)
  return result
})
