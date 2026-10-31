/**
 * Lambda Invocation Integration Tests
 *
 * Tests Lambda invocation patterns via LocalStack including
 * function invocation, payload handling, and error responses.
 *
 * Note: Tests will skip gracefully if Lambda function deployment
 * is not available or fails in LocalStack.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'

import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {
  createTestFunction,
  deleteTestFunction,
  invokeFunction,
  isLambdaAvailable,
  LAMBDA_NOT_ENABLED,
  LambdaContainerUnavailableError,
  listFunctions
} from '../helpers/lambda-invocation-helpers'

describe('Lambda Invocation Integration Tests', () => {
  let lambdaAvailable = false
  const testFunctionName = `test-function-${Date.now()}`
  let functionCreated = false
  // Set when the emulator cannot start the function container; invoke tests skip with this reason
  let containerUnavailableReason: string | undefined

  beforeAll(async () => {
    lambdaAvailable = await isLambdaAvailable()
    if (!lambdaAvailable) {
      console.log(`Lambda tests will be skipped: ${LAMBDA_NOT_ENABLED}`)
      return
    }

    try {
      await createTestFunction(testFunctionName)
      functionCreated = true
    } catch (error) {
      if (!(error instanceof LambdaContainerUnavailableError)) {
        throw error
      }
      containerUnavailableReason = error.message
      console.log(`Skipping invoke tests: ${containerUnavailableReason}`)
    }
  })

  afterAll(async () => {
    if (lambdaAvailable) {
      await deleteTestFunction(testFunctionName)
    }
  })

  /**
   * Invokes the test function, or skips the test with the emulator's reason when it cannot start the function container.
   * A FunctionError raised by the function's own code propagates and fails the test.
   */
  async function invokeTestFunctionOrSkip(skip: (note?: string) => never, payload: unknown) {
    if (!lambdaAvailable) {
      skip(LAMBDA_NOT_ENABLED)
    }
    if (containerUnavailableReason) {
      skip(containerUnavailableReason)
    }
    try {
      return await invokeFunction(testFunctionName, payload)
    } catch (error) {
      if (error instanceof LambdaContainerUnavailableError) {
        console.log(`Skipping invoke test: ${error.message}`)
        skip(error.message)
      }
      throw error
    }
  }

  /**
   * Parses the echo function's JSON body, failing the test with a clear message when the body is missing.
   */
  function parseEchoBody(payload: unknown): {echo: unknown; timestamp: unknown} {
    const body = (payload as {body?: unknown} | undefined)?.body
    expect(typeof body).toBe('string')
    return JSON.parse(body as string)
  }

  test('should verify LocalStack Lambda service is available', async () => {
    const available = await isLambdaAvailable()
    expect(typeof available).toBe('boolean')
    console.log(`Lambda service available: ${available}`)
  })

  test('should list Lambda functions', async ({skip}) => {
    if (!lambdaAvailable) {
      skip(LAMBDA_NOT_ENABLED)
      return
    }

    const functions = await listFunctions()
    expect(Array.isArray(functions)).toBe(true)
    console.log(`Found ${functions.length} Lambda functions`)

    if (functionCreated) {
      expect(functions).toContain(testFunctionName)
    }
  })

  test('should invoke Lambda function with payload', async ({skip}) => {
    const payload = {message: 'Hello', data: {value: 42}}
    const result = await invokeTestFunctionOrSkip(skip, payload)

    expect(result.statusCode).toBe(200)

    // The echo function returns the input in the body
    const parsed = parseEchoBody(result.payload)
    expect(parsed.echo).toEqual(payload)
    expect(parsed.timestamp).toBeDefined()
  })

  test('should handle empty payload', async ({skip}) => {
    const result = await invokeTestFunctionOrSkip(skip, {})

    expect(result.statusCode).toBe(200)
    expect(parseEchoBody(result.payload).echo).toEqual({})
  })

  test('should handle complex payload', async ({skip}) => {
    const complexPayload = {array: [1, 2, 3], nested: {deep: {value: 'test'}}, nullValue: null, number: 123.456, boolean: true}

    const result = await invokeTestFunctionOrSkip(skip, complexPayload)

    expect(result.statusCode).toBe(200)
    expect(parseEchoBody(result.payload).echo).toEqual(complexPayload)
  })

  test('should handle invocation of non-existent function', async ({skip}) => {
    if (!lambdaAvailable) {
      skip(LAMBDA_NOT_ENABLED)
      return
    }

    await expect(invokeFunction('non-existent-function-xyz-123', {test: true})).rejects.toMatchObject({name: 'ResourceNotFoundException'})
  })
})
