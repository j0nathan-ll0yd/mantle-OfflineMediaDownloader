/**
 * Device Service
 *
 * Shared utilities for device management across multiple Lambda functions.
 * Handles device registration, unregistration, and SNS subscriptions.
 *
 * This is an application service that orchestrates infrastructure operations (SNS).
 * It lives outside the domain layer to maintain domain purity.
 */
import {deleteDevice as deleteDeviceQuery, deleteUserDevice as deleteUserDeviceQuery, getUserDevicesByUserId} from '#entities/queries'
import {logDebug} from '@j0nathan-ll0yd/observability'
import type {UserDevice} from '#types/persistenceTypes'
import type {Device} from '#types/domainModels'
import {deleteEndpoint, subscribe, unsubscribe} from '@j0nathan-ll0yd/aws'

/**
 * Disassociates a deviceId from a User by deleting the UserDevice record
 * @param userId - The UUID of the User
 * @param deviceId - The UUID of the Device
 */
export async function deleteUserDevice(userId: string, deviceId: string): Promise<void> {
  logDebug('deleteUserDevice <=', {userId, deviceId})
  await deleteUserDeviceQuery(userId, deviceId)
  logDebug('deleteUserDevice => done')
}

/**
 * Removes a Device from the database.
 * This includes deleting the associated endpoint from SNS.
 * @param device - The Device object from the database
 */
export async function deleteDevice(device: Device): Promise<void> {
  logDebug('deleteDevice.deleteEndpoint <=', {endpointArn: device.endpointArn})
  const removeEndpointResponse = await deleteEndpoint(device.endpointArn)
  logDebug('deleteDevice.deleteEndpoint =>', removeEndpointResponse as unknown as Record<string, unknown>)
  logDebug('deleteDevice.deleteItem <=', {deviceId: device.deviceId})
  await deleteDeviceQuery(device.deviceId)
  logDebug('deleteDevice.deleteItem => done')
}

/**
 * Queries a user's device parameters from the database
 * Returns array of UserDevice records (one per device association)
 * @param userId - The userId
 */
export async function getUserDevices(userId: string): Promise<UserDevice[]> {
  logDebug('getUserDevices <=', {userId})
  const response = await getUserDevicesByUserId(userId)
  logDebug('getUserDevices =>', {count: response.length})
  return response as UserDevice[]
}

/**
 * Subscribes an endpoint (a client device) to an SNS topic
 * @param endpointArn - The EndpointArn of a mobile app and device
 * @param topicArn - The ARN of the topic you want to subscribe to
 */
export async function subscribeEndpointToTopic(endpointArn: string, topicArn: string) {
  logDebug('subscribe <=', {endpointArn, topicArn})
  const subscribeResponse = await subscribe(topicArn, 'application', endpointArn)
  logDebug('subscribe =>', subscribeResponse as unknown as Record<string, unknown>)
  return subscribeResponse
}

/**
 * Unsubscribes an endpoint (a client device) from an SNS topic
 * @param subscriptionArn - The SubscriptionArn of an endpoint+topic
 */
export async function unsubscribeEndpointToTopic(subscriptionArn: string) {
  logDebug('unsubscribeEndpointToTopic <=', {subscriptionArn})
  const response = await unsubscribe(subscriptionArn)
  logDebug('unsubscribeEndpointToTopic =>', response as unknown as Record<string, unknown>)
  return response
}
