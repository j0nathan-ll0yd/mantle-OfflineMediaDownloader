/**
 * Push Notification Service
 *
 * Sends APNS push notifications to individual devices via SNS.
 * Routes to alert or background delivery based on notification type.
 *
 * @see {@link file://./transformers.ts} for APNS payload construction
 */
import {getDevice as getDeviceRecord, getUserDevicesByUserId} from '#entities/queries'
import {publish} from '@mantleframework/aws'
import {err, isErr, isOk, ok} from '@mantleframework/core'
import {logDebug, logError, logInfo} from '@mantleframework/observability'
import type {Device} from '#types/domainModels'
import type {DeviceNotificationResult, FileNotificationType} from '#types/notificationTypes'
import {UnexpectedError} from '@mantleframework/errors'
import {providerFailureErrorMessage} from '#errors/custom-errors'
import {transformToAPNSAlertNotification, transformToAPNSNotification} from '#services/notification/transformers'

/**
 * Get device IDs for a user.
 *
 * @param userId - The user ID to look up devices for
 * @returns Array of device IDs
 */
export async function getDeviceIdsForUser(userId: string): Promise<string[]> {
  logDebug('getDeviceIdsForUser <=', {userId})
  const userDevices = await getUserDevicesByUserId(userId)
  logDebug('getDeviceIdsForUser =>', {count: userDevices.length})
  return userDevices.map((ud) => ud.deviceId)
}

/**
 * Get device by ID.
 *
 * @param deviceId - The device ID to look up
 * @returns The device record
 * @throws UnexpectedError if device not found
 */
export async function getDevice(deviceId: string): Promise<Device> {
  logDebug('getDevice <=', {deviceId})
  const device = await getDeviceRecord(deviceId)
  logDebug('getDevice =>', (device as unknown as Record<string, unknown>) ?? {found: false})
  if (device) {
    return device as Device
  } else {
    throw new UnexpectedError(providerFailureErrorMessage)
  }
}

/**
 * Send notification to a single device with error handling.
 * Routes to alert or background notification based on type.
 * Returns result object instead of throwing.
 *
 * @param device - The device to send the notification to
 * @param messageBody - The raw SQS message body (JSON)
 * @param notificationType - The notification type for routing
 * @returns Result with device ID on success, or error details on failure
 */
export async function sendNotificationToDevice(
  device: Device,
  messageBody: string,
  notificationType: FileNotificationType
): Promise<DeviceNotificationResult> {
  const targetArn = device.endpointArn
  if (!targetArn) {
    return err({deviceId: device.deviceId, error: 'No endpoint ARN configured', endpointDisabled: false})
  }
  try {
    logInfo(`Sending ${notificationType} to device`, {deviceId: device.deviceId})

    const useAlertDelivery = notificationType === 'FailureNotification' || notificationType === 'DownloadReadyNotification'
    const publishParams = useAlertDelivery
      ? transformToAPNSAlertNotification(messageBody, targetArn)
      : transformToAPNSNotification(messageBody, targetArn)

    logDebug('publish <=', publishParams as unknown as Record<string, unknown>)
    const publishResponse = await publish(publishParams)
    logDebug('publish =>', publishResponse as unknown as Record<string, unknown>)

    return ok({deviceId: device.deviceId})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isEndpointDisabled = message.includes('EndpointDisabled') || message.includes('endpoint is disabled')
    return err({deviceId: device.deviceId, error: message, endpointDisabled: isEndpointDisabled})
  }
}

/**
 * Process notification delivery results and log summary.
 *
 * @param deviceResults - Array of per-device notification results
 * @param deviceIds - Original device ID array for cross-referencing
 * @param userId - The target user ID for logging
 * @returns Object with succeeded and failed counts
 */
export function processNotificationResults(
  deviceResults: DeviceNotificationResult[],
  deviceIds: string[],
  userId: string
): {succeeded: DeviceNotificationResult[]; failed: DeviceNotificationResult[]; disabledEndpoints: DeviceNotificationResult[]} {
  const succeeded = deviceResults.filter((r) => isOk(r))
  const failed = deviceResults.filter((r) => !isOk(r))
  const disabledEndpoints = deviceResults.filter((r) => !isOk(r) && r.error.endpointDisabled)

  if (failed.length > 0) {
    logInfo('Push notification results', {
      userId,
      total: deviceIds.length,
      succeeded: succeeded.length,
      failed: failed.length,
      disabledEndpoints: disabledEndpoints.length
    })
    failed.forEach((r) => {
      if (isErr(r)) {
        logError('Device notification failed', {deviceId: r.error.deviceId, error: r.error.error, endpointDisabled: r.error.endpointDisabled})
      }
    })
  }

  return {succeeded, failed, disabledEndpoints}
}

/**
 * Map Promise.allSettled results to DeviceNotificationResult array.
 *
 * @param results - Promise.allSettled results from sendNotificationToDevice calls
 * @param deviceIds - Corresponding device IDs for error mapping
 * @returns Array of DeviceNotificationResult
 */
export function mapSettledToDeviceResults(results: PromiseSettledResult<DeviceNotificationResult>[], deviceIds: string[]): DeviceNotificationResult[] {
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }
    return err({deviceId: deviceIds[index]!, error: result.reason instanceof Error ? result.reason.message : String(result.reason), endpointDisabled: false})
  })
}
