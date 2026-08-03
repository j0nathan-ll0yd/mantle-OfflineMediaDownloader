/**
 * RegisterDevice Lambda
 *
 * Registers iOS devices for push notifications via APNS.
 * Creates platform endpoint and subscribes to notification topics.
 *
 * Trigger: API Gateway POST /device/register
 * Input: DeviceRegistrationRequest with device token
 * Output: APIGatewayProxyResult with device registration
 */
import {createPlatformEndpoint, listSubscriptionsByTopic} from '@j0nathan-ll0yd/aws'
import {buildValidatedResponse, UserStatus} from '@j0nathan-ll0yd/core'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {ServiceUnavailableError, UnexpectedError} from '@j0nathan-ll0yd/errors'
import {logDebug} from '@j0nathan-ll0yd/observability'
import {defineApiHandler, z} from '@j0nathan-ll0yd/validation'
import {upsertDevice as upsertDeviceRecord, upsertUserDevice} from '#entities/queries'
import {providerFailureErrorMessage} from '#errors/custom-errors'
import {getUserDevices, subscribeEndpointToTopic, unsubscribeEndpointToTopic} from '#services/device/deviceService'
import {deviceRegistrationResponseSchema} from '#types/api-schema'
import type {Device} from '#types/domainModels'
import {verifyPlatformConfiguration} from '#utils/platform-config'

/** Creates platform endpoint from device token */
async function createPlatformEndpointFromToken(token: string) {
  const platformApplicationArn = getRequiredEnv('PLATFORM_APPLICATION_ARN')
  logDebug('createPlatformEndpoint', {platformApplicationArn, token})
  const response = await createPlatformEndpoint(platformApplicationArn, token)
  if (!response) {
    throw new ServiceUnavailableError('AWS failed to respond')
  }
  logDebug('createPlatformEndpoint response', {endpointArn: response.EndpointArn})
  return response
}

/** Store user-device relationship */
async function upsertUserDevices(userId: string, deviceId: string) {
  logDebug('upsertUserDevices', {userId, deviceId})
  const response = await upsertUserDevice({userId, deviceId})
  logDebug('upsertUserDevices completed')
  return response
}

/** Store device details */
async function upsertDevice(device: Device) {
  logDebug('upsertDevice', {deviceId: device.deviceId})
  const response = await upsertDeviceRecord({
    deviceId: device.deviceId,
    endpointArn: device.endpointArn,
    token: device.token,
    name: device.name,
    systemVersion: device.systemVersion,
    systemName: device.systemName
  })
  logDebug('upsertDevice completed')
  return response
}

/** Gets subscription ARN for an endpoint */
async function getSubscriptionArnFromEndpointAndTopic(endpointArn: string, topicArn: string): Promise<string> {
  logDebug('getSubscriptionArnFromEndpointAndTopic', {endpointArn, topicArn})
  const listResponse = await listSubscriptionsByTopic(topicArn)
  logDebug('getSubscriptionArnFromEndpointAndTopic response', {subscriptionCount: listResponse?.Subscriptions?.length ?? 0})
  if (!listResponse?.Subscriptions) {
    throw new ServiceUnavailableError(providerFailureErrorMessage)
  }
  const result = listResponse.Subscriptions.filter((subscription) => {
    return subscription.Endpoint === endpointArn
  })
  if (!result || result.length === 0 || !result[0]?.SubscriptionArn) {
    throw new UnexpectedError('Invalid subscription response')
  }
  return result[0].SubscriptionArn
}

const DeviceRegistrationRequestSchema = z.object({
  deviceId: z.string(),
  token: z.string(),
  name: z.string().optional(),
  systemVersion: z.string().optional(),
  systemName: z.string().optional()
})

const api = defineApiHandler({auth: 'authorizer-optional', schema: DeviceRegistrationRequestSchema, operationName: 'RegisterDevice'})
export const handler = api(async ({context, userId, userStatus, body}) => {
  verifyPlatformConfiguration()

  const platformEndpoint = await createPlatformEndpointFromToken(body.token)
  const pushNotificationTopicArn = getRequiredEnv('PUSH_NOTIFICATION_TOPIC_ARN')
  const device = {...body, endpointArn: platformEndpoint.EndpointArn} as Device
  await upsertDevice(device)

  /* c8 ignore else */
  if (userStatus === UserStatus.Authenticated && userId) {
    await upsertUserDevices(userId, body.deviceId)
    const userDevices = await getUserDevices(userId)
    if (userDevices.length === 1) {
      return buildValidatedResponse(context, 200, {endpointArn: device.endpointArn}, deviceRegistrationResponseSchema)
    }
    const subscriptionArn = await getSubscriptionArnFromEndpointAndTopic(device.endpointArn, pushNotificationTopicArn)
    await unsubscribeEndpointToTopic(subscriptionArn)
    return buildValidatedResponse(context, 201, {endpointArn: platformEndpoint.EndpointArn}, deviceRegistrationResponseSchema)
  }
  if (userStatus === UserStatus.Anonymous) {
    await subscribeEndpointToTopic(device.endpointArn, pushNotificationTopicArn)
  }

  return buildValidatedResponse(context, 200, {endpointArn: device.endpointArn}, deviceRegistrationResponseSchema)
})
