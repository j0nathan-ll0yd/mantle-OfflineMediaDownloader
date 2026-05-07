/**
 * CloudWatch Logs Test Vendor Wrapper
 *
 * Encapsulates AWS SDK CloudWatch Logs operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */
import {
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DeleteLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  PutLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs'
import type {InputLogEvent, OutputLogEvent} from '@aws-sdk/client-cloudwatch-logs'
import {CloudWatchLogsClient} from '@aws-sdk/client-cloudwatch-logs'

const USE_LOCALSTACK = process.env.USE_LOCALSTACK === 'true'
const LOCALSTACK_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566'

function createCloudWatchLogsClient(): CloudWatchLogsClient {
  return new CloudWatchLogsClient(USE_LOCALSTACK ? {endpoint: LOCALSTACK_ENDPOINT, region: 'us-east-1'} : {})
}

const logsClient = createCloudWatchLogsClient()

/**
 * Destroys the CloudWatch Logs client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  logsClient.destroy()
}

/**
 * Creates a CloudWatch log group
 * @param logGroupName - Name of the log group to create
 */
export async function createLogGroup(logGroupName: string): Promise<void> {
  await logsClient.send(new CreateLogGroupCommand({logGroupName}))
}

/**
 * Deletes a CloudWatch log group
 * @param logGroupName - Name of the log group to delete
 */
export async function deleteLogGroup(logGroupName: string): Promise<void> {
  await logsClient.send(new DeleteLogGroupCommand({logGroupName}))
}

/**
 * Creates a log stream within a log group
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream to create
 */
export async function createLogStream(logGroupName: string, logStreamName: string): Promise<void> {
  await logsClient.send(new CreateLogStreamCommand({logGroupName, logStreamName}))
}

/**
 * Puts log events to a log stream
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param events - Log events to put
 * @param sequenceToken - Optional sequence token for subsequent puts
 * @returns The next sequence token
 */
export async function putLogEvents(
  logGroupName: string,
  logStreamName: string,
  events: InputLogEvent[],
  sequenceToken?: string
): Promise<string | undefined> {
  const result = await logsClient.send(new PutLogEventsCommand({logGroupName, logStreamName, logEvents: events, sequenceToken}))
  return result.nextSequenceToken
}

/**
 * Gets log events from a log stream
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param limit - Maximum number of events to retrieve
 * @returns Array of log events
 */
export async function getLogEvents(logGroupName: string, logStreamName: string, limit = 100): Promise<OutputLogEvent[]> {
  const result = await logsClient.send(new GetLogEventsCommand({logGroupName, logStreamName, limit, startFromHead: true}))
  return result.events || []
}

/**
 * Gets the sequence token for a log stream
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @returns Sequence token or undefined if stream is new
 */
export async function getLogStreamSequenceToken(logGroupName: string, logStreamName: string): Promise<string | undefined> {
  const result = await logsClient.send(new DescribeLogStreamsCommand({logGroupName, logStreamNamePrefix: logStreamName, limit: 1}))
  const stream = result.logStreams?.find((s) => s.logStreamName === logStreamName)
  return stream?.uploadSequenceToken
}
