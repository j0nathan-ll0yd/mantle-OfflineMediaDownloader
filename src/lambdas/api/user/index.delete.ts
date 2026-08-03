/**
 * UserDelete Lambda
 *
 * Deletes a user and all associated data (files, devices, subscriptions).
 * Implements cascade deletion with proper ordering to maintain referential integrity.
 *
 * Trigger: API Gateway DELETE /user
 * Input: Authenticated user context (userId from authorizer)
 * Output: APIGatewayProxyResult confirming deletion
 */
import {buildValidatedResponse, defineLambda} from '@j0nathan-ll0yd/core'
import {UnexpectedError} from '@j0nathan-ll0yd/errors'
import {logDebug, logError} from '@j0nathan-ll0yd/observability'
import {defineApiHandler, z} from '@j0nathan-ll0yd/validation'
import {deleteUser as deleteUserRecord, deleteUserDevicesByUserId, deleteUserFilesByUserId, getDevicesBatch} from '#entities/queries'
import {providerFailureErrorMessage} from '#errors/custom-errors'
import {createFailedUserDeletionIssue} from '#integrations/github/issueService'
import {deleteDevice, getUserDevices} from '#services/device/deviceService'
import type {Device} from '#types/domainModels'

const PartialDeletionResponseSchema = z.object({message: z.string(), failedOperations: z.number()})

defineLambda({secrets: {GITHUB_PERSONAL_TOKEN: 'github.issue.token'}})

/** Delete all user-file relationships */
async function deleteUserFiles(userId: string): Promise<void> {
  logDebug('deleteUserFiles', {userId})
  await deleteUserFilesByUserId(userId)
  logDebug('deleteUserFiles completed')
}

/** Delete all user-device relationships */
async function deleteUserDevicesRelations(userId: string): Promise<void> {
  logDebug('deleteUserDevices', {userId})
  await deleteUserDevicesByUserId(userId)
  logDebug('deleteUserDevices completed')
}

/** Delete user record */
async function deleteUser(userId: string): Promise<void> {
  logDebug('deleteUser', {userId})
  await deleteUserRecord(userId)
  logDebug('deleteUser completed')
}

const api = defineApiHandler({auth: 'authorizer', operationName: 'UserDelete'})
export const handler = api(async ({context, userId}) => {
  const deletableDevices: Device[] = []

  const userDevices = await getUserDevices(userId)
  logDebug('Found userDevices', {count: userDevices.length})
  if (userDevices.length > 0) {
    const deviceIds = userDevices.map((userDevice: {deviceId: string}) => userDevice.deviceId)
    const devices = await getDevicesBatch(deviceIds)
    logDebug('Found devices', {count: devices.length})
    if (devices.length === 0) {
      throw new UnexpectedError(providerFailureErrorMessage)
    }
    deletableDevices.push(...(devices as Device[]))
  }

  // Delete children FIRST (correct cascade order), then parent LAST
  const relationResults = await Promise.allSettled([deleteUserFiles(userId), deleteUserDevicesRelations(userId)])
  logDebug('Promise.allSettled relations', {count: relationResults.length})

  const relationFailures = relationResults.filter((r) => r.status === 'rejected')
  if (relationFailures.length > 0) {
    logError('Cascade deletion partial failure (relations)', {failedCount: relationFailures.length})
    return buildValidatedResponse(context, 207, {
      message: 'Partial deletion - some child records could not be removed',
      failedOperations: relationFailures.length
    }, PartialDeletionResponseSchema)
  }

  const deviceResults = await Promise.allSettled(deletableDevices.map((device) => deleteDevice(device)))
  logDebug('Promise.allSettled devices', {count: deviceResults.length})

  const deviceFailures = deviceResults.filter((r) => r.status === 'rejected')
  if (deviceFailures.length > 0) {
    logError('Cascade deletion partial failure (devices)', {failedCount: deviceFailures.length})
    return buildValidatedResponse(context, 207, {message: 'Partial deletion - some devices could not be removed', failedOperations: deviceFailures.length},
      PartialDeletionResponseSchema)
  }

  // Delete parent LAST - only if all children succeeded
  try {
    await deleteUser(userId)
    logDebug('deleteUser completed')
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logError('Failed to properly remove user', {userId, error: err.message})
    await createFailedUserDeletionIssue(userId, deletableDevices, err, context.awsRequestId)
    throw new UnexpectedError('Operation failed unexpectedly; but logged for resolution')
  }

  return buildValidatedResponse(context, 204)
})
