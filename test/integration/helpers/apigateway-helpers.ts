/**
 * API Gateway Test Helpers
 *
 * Utilities for testing API Gateway routing via LocalStack.
 * Note: LocalStack's API Gateway support is limited in the free tier.
 * These helpers provide graceful degradation when features aren't available.
 */

const LOCALSTACK_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'

/**
 * Check if LocalStack API Gateway is available.
 * Returns false if the service is not responding properly.
 */
export async function isApiGatewayAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`)
    if (!response.ok) {
      return false
    }
    const health = await response.json() as {services?: Record<string, string>}
    // Check if API Gateway is running
    return health.services?.apigateway === 'running' || health.services?.apigateway === 'available'
  } catch {
    return false
  }
}

/**
 * Invoke an HTTP endpoint on LocalStack API Gateway
 * @param endpoint - The API Gateway endpoint URL
 * @param method - HTTP method
 * @param path - The path to invoke
 * @param options - Additional fetch options
 * @returns Fetch Response
 */
export async function invokeApiEndpoint(
  endpoint: string,
  method: string,
  path: string,
  options?: {headers?: Record<string, string>; body?: string}
): Promise<Response> {
  const url = `${endpoint}${path}`
  return fetch(url, {method, headers: {'Content-Type': 'application/json', ...options?.headers}, body: options?.body})
}

/**
 * Create a test API via LocalStack REST API
 * Note: This is a simplified helper - full API Gateway creation is complex
 * @param name - Name for the API
 * @returns API ID and invoke URL
 */
export async function createTestApi(name: string): Promise<{apiId: string; endpoint: string} | null> {
  try {
    const response = await fetch(`${LOCALSTACK_ENDPOINT}/restapis`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, description: 'Test API'})
    })

    if (!response.ok) {
      return null
    }

    const api = await response.json() as {id: string}
    const endpoint = `${LOCALSTACK_ENDPOINT}/restapis/${api.id}/test/_user_request_`

    return {apiId: api.id, endpoint}
  } catch {
    return null
  }
}

/**
 * Delete a test API from LocalStack
 * @param apiId - The API ID to delete
 */
export async function deleteTestApi(apiId: string): Promise<void> {
  try {
    await fetch(`${LOCALSTACK_ENDPOINT}/restapis/${apiId}`, {method: 'DELETE'})
  } catch {
    // Ignore errors
  }
}

/**
 * Skip test helper for when LocalStack API Gateway is unavailable
 * @param testFn - Test function to wrap
 * @returns Wrapped test function that skips if API Gateway unavailable
 */
export function skipIfApiGatewayUnavailable(testFn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const available = await isApiGatewayAvailable()
    if (!available) {
      console.log('Skipping test: LocalStack API Gateway not available')
      return
    }
    await testFn()
  }
}
