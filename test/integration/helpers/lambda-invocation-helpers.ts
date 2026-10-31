/**
 * Lambda Invocation Test Helpers
 *
 * Utilities for testing Lambda invocation patterns via LocalStack.
 * Note: Lambda deployment to LocalStack requires zip packaging which
 * is complex. These helpers provide simplified testing patterns.
 */

import {CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand, InvokeCommand, ListFunctionsCommand} from '@aws-sdk/client-lambda'
import type {FunctionConfiguration} from '@aws-sdk/client-lambda'
import {createLambdaClient} from '@j0nathan-ll0yd/aws'

const lambdaClient = createLambdaClient()

/**
 * The emulator error when 'lambda' is missing from its SERVICES list. Tests skip with this note.
 */
export const LAMBDA_NOT_ENABLED = "Service 'lambda' is not enabled"

/**
 * Check if LocalStack Lambda service is available
 * @returns False only when the emulator reports that the lambda service is not enabled
 * @throws Any other error (for example, connection errors), so the suite fails instead of skipping
 */
export async function isLambdaAvailable(): Promise<boolean> {
  try {
    await lambdaClient.send(new ListFunctionsCommand({}))
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes(LAMBDA_NOT_ENABLED)) {
      return false
    }
    throw error
  }
}

/**
 * Emulator messages that mean the function container never started, so the function's own code never ran.
 * - floci: Invoke returns FunctionError with "Failed to start Lambda container: ..." when it has no Docker socket.
 * - LocalStack: the function ends in State "Failed" with StateReason "Docker not available" when it has no Docker socket.
 */
const CONTAINER_UNAVAILABLE_PATTERNS = [/^Failed to start Lambda container/, /Docker not available/]

function isContainerUnavailable(message: string): boolean {
  return CONTAINER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Thrown when the emulator cannot start the function container. Tests skip on this error with its message as the reason.
 */
export class LambdaContainerUnavailableError extends Error {
  constructor(reason: string) {
    super(`Emulator cannot start the Lambda container: ${reason}`)
    this.name = 'LambdaContainerUnavailableError'
  }
}

/**
 * Thrown when an invocation returns a FunctionError raised by the function's own code. Tests fail on this error.
 */
export class LambdaFunctionError extends Error {
  readonly functionError: string
  readonly payload: unknown

  constructor(functionName: string, functionError: string, payload: unknown) {
    super(`Lambda ${functionName} returned FunctionError ${functionError}: ${JSON.stringify(payload)}`)
    this.name = 'LambdaFunctionError'
    this.functionError = functionError
    this.payload = payload
  }
}

/**
 * Wait for a Lambda function to become Active
 * LocalStack Lambdas start in "Pending" state and transition to "Active"
 * @param functionName - Name of the function to wait for
 * @param maxAttempts - Maximum polling attempts (default 30)
 * @param delayMs - Delay between attempts in ms (default 500)
 * @throws LambdaContainerUnavailableError if the function fails because the emulator cannot start its container
 * @throws Error if the function fails for any other reason or does not become Active in time
 */
export async function waitForFunctionActive(functionName: string, maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let configuration: FunctionConfiguration | undefined
    try {
      configuration = (await lambdaClient.send(new GetFunctionCommand({FunctionName: functionName}))).Configuration
    } catch (error) {
      // Function may not exist yet; any other error is real
      if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) {
        throw error
      }
    }
    if (configuration?.State === 'Active') {
      return
    }
    if (configuration?.State === 'Failed') {
      const reason = configuration.StateReason ?? 'no StateReason'
      if (isContainerUnavailable(reason)) {
        throw new LambdaContainerUnavailableError(reason)
      }
      throw new Error(`Function ${functionName} is in Failed state: ${reason}`)
    }
    // State is Pending or other transitional state, wait and retry
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Timeout waiting for function ${functionName} to become Active`)
}

/**
 * List all Lambda functions in LocalStack
 * @returns Array of function names
 */
export async function listFunctions(): Promise<string[]> {
  const result = await lambdaClient.send(new ListFunctionsCommand({}))
  return (result.Functions || []).map((f) => f.FunctionName || '')
}

/**
 * Invoke a Lambda function
 * @param functionName - Name of the function to invoke
 * @param payload - Payload to send to the function
 * @returns Invocation result
 * @throws LambdaContainerUnavailableError if the emulator cannot start the function container
 * @throws LambdaFunctionError if the function's own code raised an error
 */
export async function invokeFunction(functionName: string, payload: unknown): Promise<{statusCode: number | undefined; payload: unknown}> {
  const result = await lambdaClient.send(new InvokeCommand({FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload))}))

  let responsePayload: unknown
  if (result.Payload) {
    const payloadStr = Buffer.from(result.Payload).toString('utf-8')
    try {
      responsePayload = JSON.parse(payloadStr)
    } catch {
      responsePayload = payloadStr
    }
  }

  if (result.FunctionError) {
    const errorMessage = (responsePayload as {errorMessage?: unknown} | undefined)?.errorMessage
    if (typeof errorMessage === 'string' && isContainerUnavailable(errorMessage)) {
      throw new LambdaContainerUnavailableError(errorMessage)
    }
    throw new LambdaFunctionError(functionName, result.FunctionError, responsePayload)
  }

  return {statusCode: result.StatusCode, payload: responsePayload}
}

/**
 * Create a minimal test Lambda function in LocalStack
 * Note: This creates a very simple function that echoes input
 * Waits for the function to become Active before returning
 *
 * @param functionName - Name for the function
 * @throws LambdaContainerUnavailableError if the emulator cannot start the function container
 * @throws Error if creation fails for any other reason
 */
export async function createTestFunction(functionName: string): Promise<void> {
  // Minimal Lambda code that echoes input
  const code = `
    exports.handler = async (event) => {
      return {
        statusCode: 200,
        body: JSON.stringify({echo: event, timestamp: Date.now()})
      };
    };
  `

  // Create a minimal zip file in memory
  // LocalStack can accept inline code for simple functions
  const {createZipBuffer} = await import('./zip-utils')
  const zipBuffer = await createZipBuffer({'index.js': code})

  await lambdaClient.send(
    new CreateFunctionCommand({
      FunctionName: functionName,
      Runtime: 'nodejs20.x',
      Role: 'arn:aws:iam::000000000000:role/lambda-role',
      Handler: 'index.handler',
      Code: {ZipFile: zipBuffer}
    })
  )
  // Wait for function to become Active before returning
  await waitForFunctionActive(functionName)
}

/**
 * Delete a Lambda function from LocalStack
 * @param functionName - Name of the function to delete
 */
export async function deleteTestFunction(functionName: string): Promise<void> {
  try {
    await lambdaClient.send(new DeleteFunctionCommand({FunctionName: functionName}))
  } catch {
    // Ignore errors
  }
}
