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
import {defineLambda, defineScheduledHandler} from '@j0nathan-ll0yd/core'
import {getOptionalEnv, getRequiredEnv} from '@j0nathan-ll0yd/env'
import {UnexpectedError} from '@j0nathan-ll0yd/errors'
import {addMetadata, endSpan, logDebug, logError, logInfo, logWarn, metrics, MetricUnit, startSpan} from '@j0nathan-ll0yd/observability'
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

/**
 * Reserved synthetic device seeded by `bin/test-registerDevice.sh` for remote smoke tests. Its token
 * is an all-zeros placeholder that APNS permanently rejects (400 BadDeviceToken), so it is excluded
 * from health checks — otherwise every run would prune it and the smoke-test fixture would vanish.
 */
const RESERVED_TEST_DEVICE_ID = '00000000-0000-0000-0000-000000000001'

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
    // A structured APNS rejection (has a `reason`) is an expected outcome of a health check — the
    // whole point of this job is to surface dead tokens. Log it at WARN, not ERROR, so it does not
    // trip alerting; the caller decides whether the reason is permanent (prune) or transient (skip).
    if (err && typeof err === 'object' && 'reason' in err) {
      const apnsError = err as Apns2Error
      logWarn('apnProvider.send => APNS rejection', {statusCode: apnsError.statusCode, reason: apnsError.reason})
      return {statusCode: Number(apnsError.statusCode), reason: apnsError.reason}
    }
    // No reason means an unexpected transport/library failure, not a token verdict — this is a real error.
    logError('apnProvider.send => unexpected failure', {error: err instanceof Error ? err.message : String(err)})
    throw new UnexpectedError('Unexpected result from APNS')
  }
}

/**
 * APNS `reason` values that indicate the token is permanently invalid and can never receive a push.
 * `Unregistered` (410) — app uninstalled. `BadDeviceToken` / `DeviceTokenNotForTopic` (400) — token
 * malformed or registered against a different environment/topic. All three warrant pruning; every
 * other reason (e.g. `TooManyRequests`, `InternalServerError`, `ServiceUnavailable`) is transient.
 * @see https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 */
const PERMANENT_APNS_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'])

/**
 * Health-check a device token and decide whether it is permanently invalid (safe to prune).
 * Returns false for both healthy tokens and transient failures — a transient failure logs a warning
 * and leaves the device in place so it is re-checked on the next run rather than deleted in error.
 */
async function isDeviceTokenPermanentlyInvalid(token: string): Promise<boolean> {
  const apnsResponse = await dispatchHealthCheckNotificationToDeviceToken(token)
  if (apnsResponse.statusCode === 200) {
    return false
  }
  if (apnsResponse.reason && PERMANENT_APNS_REASONS.has(apnsResponse.reason)) {
    return true
  }
  // Non-200 without a permanent reason: transient (rate limit, APNS outage). Keep the device, retry next run.
  logWarn('Transient APNS failure; leaving device in place', {statusCode: apnsResponse.statusCode, reason: apnsResponse.reason})
  return false
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

    // The reserved smoke-test device carries an intentionally-invalid token; never health-check or prune it.
    if (deviceId === RESERVED_TEST_DEVICE_ID) {
      logDebug('Skipping reserved smoke-test device', {deviceId})
      continue
    }

    logInfo('Verifying device', {deviceId})

    let shouldPrune = false
    let pruneReason = ''

    if (await isDeviceTokenPermanentlyInvalid(device.token)) {
      shouldPrune = true
      pruneReason = 'APNS token permanently invalid'
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
