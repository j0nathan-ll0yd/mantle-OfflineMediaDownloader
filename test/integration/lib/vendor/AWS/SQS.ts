/**
 * SQS Test Vendor Wrapper
 *
 * Encapsulates AWS SDK SQS operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand
} from '@aws-sdk/client-sqs'
import type {Message, ReceiveMessageCommandOutput} from '@aws-sdk/client-sqs'
import {createSQSClient} from '@j0nathan-ll0yd/aws'

const sqsClient = createSQSClient()

/**
 * Destroys the SQS client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  sqsClient.destroy()
}

/**
 * Creates an SQS queue
 * @param queueName - Name of the queue to create
 */
export async function createQueue(queueName: string): Promise<string> {
  const result = await sqsClient.send(new CreateQueueCommand({QueueName: queueName}))
  return result.QueueUrl!
}

/**
 * Deletes an SQS queue
 * @param queueUrl - URL of the queue to delete
 */
export async function deleteQueue(queueUrl: string): Promise<void> {
  await sqsClient.send(new DeleteQueueCommand({QueueUrl: queueUrl}))
}

/**
 * Gets the URL of a queue by name
 * @param queueName - Name of the queue
 */
export async function getQueueUrl(queueName: string): Promise<string> {
  const result = await sqsClient.send(new GetQueueUrlCommand({QueueName: queueName}))
  return result.QueueUrl!
}

/**
 * Gets queue attributes including ARN
 * @param queueUrl - URL of the queue
 */
export async function getQueueArn(queueUrl: string): Promise<string> {
  const result = await sqsClient.send(new GetQueueAttributesCommand({QueueUrl: queueUrl, AttributeNames: ['QueueArn']}))
  return result.Attributes!.QueueArn!
}

/**
 * Sends a message to a queue
 * @param queueUrl - URL of the queue
 * @param messageBody - Message body
 * @param messageAttributes - Optional message attributes
 */
export async function sendMessage(
  queueUrl: string,
  messageBody: string,
  messageAttributes?: Record<string, {DataType: string; StringValue: string}>
): Promise<string> {
  const result = await sqsClient.send(new SendMessageCommand({QueueUrl: queueUrl, MessageBody: messageBody, MessageAttributes: messageAttributes}))
  return result.MessageId!
}

/**
 * Receives messages from a queue
 * @param queueUrl - URL of the queue
 * @param maxMessages - Maximum number of messages to receive (1-10)
 * @param waitTimeSeconds - Long polling wait time in seconds
 */
export async function receiveMessages(queueUrl: string, maxMessages = 10, waitTimeSeconds = 5): Promise<Message[]> {
  const result: ReceiveMessageCommandOutput = await sqsClient.send(
    new ReceiveMessageCommand({QueueUrl: queueUrl, MaxNumberOfMessages: maxMessages, WaitTimeSeconds: waitTimeSeconds, MessageAttributeNames: ['All']})
  )
  return result.Messages || []
}

/**
 * Deletes a message from a queue
 * @param queueUrl - URL of the queue
 * @param receiptHandle - Receipt handle of the message
 */
export async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
  await sqsClient.send(new DeleteMessageCommand({QueueUrl: queueUrl, ReceiptHandle: receiptHandle}))
}

/**
 * Purges all messages from a queue
 * @param queueUrl - URL of the queue
 */
export async function purgeQueue(queueUrl: string): Promise<void> {
  await sqsClient.send(new PurgeQueueCommand({QueueUrl: queueUrl}))
}
