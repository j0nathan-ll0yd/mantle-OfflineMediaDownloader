/**
 * APNS Endpoint Cleanup Service
 *
 * Handles cleanup of disabled APNS endpoints detected during push notification delivery.
 * This is reactive cleanup (on-demand) vs PruneDevices which is proactive (scheduled).
 *
 * When an APNS endpoint becomes disabled (token revoked, app uninstalled, etc.),
 * we need to clean up:
 * 1. UserDevices junction records (children first)
 * 2. SNS platform endpoint
 * 3. Device record
 *
 * This is an application service that orchestrates infrastructure operations (SNS).
 * It lives outside the domain layer to maintain domain purity.
 *
 * @see src/lambdas/SendPushNotification for detection
 * @see src/lambdas/PruneDevices for proactive cleanup
 */
import {deleteDevice as deleteDeviceRecord, deleteUserDevicesByDeviceId, getDevice} from '#entities/queries'
import {deleteEndpoint} from '@j0nathan-ll0yd/aws'
import {err, isOk, ok} from '@j0nathan-ll0yd/core'
import {logDebug, logError, logInfo} from '@j0nathan-ll0yd/observability'
import type {EndpointCleanupResult} from '#types/resilience'

export type { EndpointCleanupResult }

/**
 * Clean up a disabled APNS endpoint and associated device records
 *
 * Order of operations (children before parents):
 * 1. Delete UserDevices junction records
 * 2. Delete SNS platform endpoint
 * 3. Delete Device record
 *
 * This follows the project convention: Promise.allSettled for cascade deletions,
 * children deleted before parents.
 *
 * @param deviceId - The device ID to clean up
 * @param endpointArn - The SNS endpoint ARN
 * @returns Cleanup result with success/failure status
 */
export async function cleanupDisabledEndpoint(deviceId: string, endpointArn: string): Promise<EndpointCleanupResult> {
  logInfo('Cleaning up disabled endpoint', {deviceId, endpointArn})
  try {
    // Step 1: Delete UserDevices junction records first (children)
    await deleteUserDevicesByDeviceId(deviceId)
    logDebug('Deleted UserDevice records', {deviceId})

    // Step 2: Delete SNS platform endpoint
    await deleteEndpoint(endpointArn)
    logDebug('Deleted SNS endpoint', {endpointArn})

    // Step 3: Delete Device record (parent)
    await deleteDeviceRecord(deviceId)
    logDebug('Deleted Device record', {deviceId})

    logInfo('Successfully cleaned up disabled endpoint', {deviceId})

    return ok({deviceId, endpointArn})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Failed to cleanup disabled endpoint', {deviceId, endpointArn, error: message})

    return err({deviceId, endpointArn, error: message})
  }
}

/**
 * Clean up a disabled endpoint by device ID
 * Looks up the endpoint ARN from the device record
 *
 * @param deviceId - The device ID to clean up
 * @returns Cleanup result or undefined if device not found
 */
export async function cleanupDisabledEndpointByDeviceId(deviceId: string): Promise<EndpointCleanupResult | undefined> {
  const device = await getDevice(deviceId)
  if (!device) {
    logInfo('Device not found for cleanup', {deviceId})
    return undefined
  }

  if (!device.endpointArn) {
    logInfo('Device has no endpoint ARN', {deviceId})
    return undefined
  }

  return cleanupDisabledEndpoint(deviceId, device.endpointArn)
}

/**
 * Clean up multiple disabled endpoints in parallel
 * Uses Promise.allSettled to ensure all cleanup attempts are made
 *
 * @param deviceIds - Array of device IDs to clean up
 * @returns Array of cleanup results
 */
export async function cleanupDisabledEndpoints(deviceIds: string[]): Promise<EndpointCleanupResult[]> {
  if (deviceIds.length === 0) {
    return []
  }

  logInfo('Starting batch endpoint cleanup', {deviceCount: deviceIds.length})

  const results = await Promise.allSettled(deviceIds.map((deviceId) => cleanupDisabledEndpointByDeviceId(deviceId)))

  const cleanupResults: EndpointCleanupResult[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    const deviceId = deviceIds[i] ?? ''

    if (result.status === 'fulfilled' && result.value) {
      cleanupResults.push(result.value)
    } else if (result.status === 'rejected') {
      cleanupResults.push(err({deviceId, endpointArn: '', error: result.reason instanceof Error ? result.reason.message : String(result.reason)}))
    }
  }

  const succeeded = cleanupResults.filter((r) => isOk(r))
  const failed = cleanupResults.filter((r) => !isOk(r))

  logInfo('Batch endpoint cleanup complete', {total: deviceIds.length, cleaned: succeeded.length, failed: failed.length})

  return cleanupResults
}
