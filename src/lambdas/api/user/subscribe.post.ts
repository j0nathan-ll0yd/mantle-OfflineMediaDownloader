/**
 * UserSubscribe Lambda
 *
 * Subscribes user's device endpoint to an SNS topic for push notifications.
 * Requires authenticated user with valid device registration.
 *
 * Trigger: API Gateway POST /user/subscribe
 * Input: UserSubscriptionRequest with endpointArn and topicArn
 * Output: APIGatewayProxyResult with subscription confirmation
 */
import {buildValidatedResponse} from '@j0nathan-ll0yd/core'
import {defineApiHandler, z} from '@j0nathan-ll0yd/validation'
import {subscribeEndpointToTopic} from '#services/device/deviceService'
import {verifyPlatformConfiguration} from '#utils/platform-config'

const SubscriptionRequestSchema = z.object({endpointArn: z.string(), topicArn: z.string()})

const SubscriptionResponseSchema = z.object({subscriptionArn: z.string().optional()})

const api = defineApiHandler({auth: 'authorizer', schema: SubscriptionRequestSchema, operationName: 'UserSubscribe'})
export const handler = api(async ({context, body}) => {
  verifyPlatformConfiguration()

  const subscribeResponse = await subscribeEndpointToTopic(body.endpointArn, body.topicArn)

  return buildValidatedResponse(context, 201, {subscriptionArn: subscribeResponse.SubscriptionArn}, SubscriptionResponseSchema)
})
