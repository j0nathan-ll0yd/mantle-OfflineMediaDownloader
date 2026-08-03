/**
 * SNS Test Vendor Wrapper
 *
 * Encapsulates AWS SDK SNS operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */
import {
  CreatePlatformApplicationCommand,
  CreatePlatformEndpointCommand,
  CreateTopicCommand,
  DeleteEndpointCommand,
  DeletePlatformApplicationCommand,
  DeleteTopicCommand,
  GetEndpointAttributesCommand,
  ListEndpointsByPlatformApplicationCommand,
  ListSubscriptionsByTopicCommand,
  PublishCommand,
  SubscribeCommand,
  UnsubscribeCommand
} from '@aws-sdk/client-sns'
import type {Endpoint, Subscription} from '@aws-sdk/client-sns'
import {createSNSClient} from '@j0nathan-ll0yd/aws'

const snsClient = createSNSClient()

/**
 * Destroys the SNS client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  snsClient.destroy()
}

const AWS_REGION = process.env.AWS_REGION || 'us-west-2'
const AWS_ACCOUNT_ID = '000000000000' // LocalStack default account ID

/**
 * Creates an SNS topic
 * @param topicName - Name of the topic to create
 */
export async function createTopic(topicName: string): Promise<string> {
  try {
    const result = await snsClient.send(new CreateTopicCommand({Name: topicName}))
    return result.TopicArn!
  } catch (error) {
    if (error instanceof Error && error.name === 'TopicAlreadyExists') {
      return `arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${topicName}`
    }
    throw error
  }
}

/**
 * Deletes an SNS topic and all its subscriptions
 * @param topicArn - ARN of the topic to delete
 */
export async function deleteTopic(topicArn: string): Promise<void> {
  try {
    const subscriptions = await snsClient.send(new ListSubscriptionsByTopicCommand({TopicArn: topicArn}))
    if (subscriptions.Subscriptions) {
      await Promise.all(
        subscriptions.Subscriptions.filter((sub) => sub.SubscriptionArn && sub.SubscriptionArn !== 'PendingConfirmation').map((sub) =>
          snsClient.send(new UnsubscribeCommand({SubscriptionArn: sub.SubscriptionArn!}))
        )
      )
    }
    await snsClient.send(new DeleteTopicCommand({TopicArn: topicArn}))
  } catch {
    // Topic might not exist
  }
}

/**
 * Creates a platform application for APNS
 * @param appName - Name of the platform application
 */
export async function createPlatformApplication(appName: string): Promise<string> {
  try {
    const result = await snsClient.send(
      new CreatePlatformApplicationCommand({
        Name: appName,
        Platform: 'APNS_SANDBOX',
        Attributes: {PlatformCredential: 'test-certificate', PlatformPrincipal: 'test-private-key'}
      })
    )
    return result.PlatformApplicationArn!
  } catch (error) {
    if (error instanceof Error && error.name === 'InvalidParameterException') {
      return `arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:app/APNS_SANDBOX/${appName}`
    }
    throw error
  }
}

/**
 * Deletes a platform application and all its endpoints
 * @param platformApplicationArn - ARN of the platform application
 */
export async function deletePlatformApplication(platformApplicationArn: string): Promise<void> {
  try {
    const endpoints = await snsClient.send(new ListEndpointsByPlatformApplicationCommand({PlatformApplicationArn: platformApplicationArn}))
    if (endpoints.Endpoints) {
      await Promise.all(endpoints.Endpoints.map((endpoint) => snsClient.send(new DeleteEndpointCommand({EndpointArn: endpoint.EndpointArn!}))))
    }
    await snsClient.send(new DeletePlatformApplicationCommand({PlatformApplicationArn: platformApplicationArn}))
  } catch {
    // Application might not exist
  }
}

/**
 * Creates a platform endpoint for a device
 * @param platformApplicationArn - ARN of the platform application
 * @param deviceToken - Device token
 * @param userData - Optional custom user data
 */
export async function createPlatformEndpoint(platformApplicationArn: string, deviceToken: string, userData?: string): Promise<string> {
  const result = await snsClient.send(
    new CreatePlatformEndpointCommand({PlatformApplicationArn: platformApplicationArn, Token: deviceToken, CustomUserData: userData})
  )
  return result.EndpointArn!
}

/**
 * Deletes a platform endpoint
 * @param endpointArn - ARN of the endpoint to delete
 */
export async function deleteEndpoint(endpointArn: string): Promise<void> {
  try {
    await snsClient.send(new DeleteEndpointCommand({EndpointArn: endpointArn}))
  } catch {
    // Endpoint might not exist
  }
}

/**
 * Gets endpoint attributes to check if enabled
 * @param endpointArn - ARN of the endpoint
 */
export async function getEndpointEnabled(endpointArn: string): Promise<boolean> {
  try {
    const result = await snsClient.send(new GetEndpointAttributesCommand({EndpointArn: endpointArn}))
    return result.Attributes?.Enabled === 'true'
  } catch {
    return false
  }
}

/**
 * Publishes a message to an endpoint
 * @param endpointArn - ARN of the endpoint
 * @param message - Message to publish
 */
export async function publishToEndpoint(endpointArn: string, message: string): Promise<string> {
  const result = await snsClient.send(new PublishCommand({TargetArn: endpointArn, Message: message}))
  return result.MessageId!
}

/**
 * Publishes a message to a topic
 * @param topicArn - ARN of the topic
 * @param message - Message to publish
 */
export async function publishToTopic(topicArn: string, message: string): Promise<string> {
  const result = await snsClient.send(new PublishCommand({TopicArn: topicArn, Message: message}))
  return result.MessageId!
}

/**
 * Subscribes an SQS queue to an SNS topic
 * @param topicArn - ARN of the topic
 * @param queueArn - ARN of the SQS queue
 */
export async function subscribeQueueToTopic(topicArn: string, queueArn: string): Promise<string> {
  const result = await snsClient.send(new SubscribeCommand({TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn}))
  return result.SubscriptionArn!
}

/**
 * Subscribes an endpoint to a topic
 * @param topicArn - ARN of the topic
 * @param endpointArn - ARN of the endpoint
 */
export async function subscribeEndpointToTopic(topicArn: string, endpointArn: string): Promise<string> {
  const result = await snsClient.send(new SubscribeCommand({TopicArn: topicArn, Protocol: 'application', Endpoint: endpointArn}))
  return result.SubscriptionArn!
}

/**
 * Unsubscribes from a topic
 * @param subscriptionArn - ARN of the subscription
 */
export async function unsubscribe(subscriptionArn: string): Promise<void> {
  await snsClient.send(new UnsubscribeCommand({SubscriptionArn: subscriptionArn}))
}

/**
 * Lists all endpoints for a platform application
 * @param platformApplicationArn - ARN of the platform application
 */
export async function listEndpoints(platformApplicationArn: string): Promise<Endpoint[]> {
  const result = await snsClient.send(new ListEndpointsByPlatformApplicationCommand({PlatformApplicationArn: platformApplicationArn}))
  return result.Endpoints || []
}

/**
 * Lists all subscriptions for a topic
 * @param topicArn - ARN of the topic
 */
export async function listSubscriptions(topicArn: string): Promise<Subscription[]> {
  const result = await snsClient.send(new ListSubscriptionsByTopicCommand({TopicArn: topicArn}))
  return (result.Subscriptions || []).filter((sub) => sub.SubscriptionArn !== 'PendingConfirmation')
}
