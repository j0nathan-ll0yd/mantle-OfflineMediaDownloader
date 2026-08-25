/**
 * API Gateway Routing Integration Tests
 *
 * Tests API Gateway routing behavior via LocalStack.
 * Note: LocalStack's API Gateway support varies by tier.
 * These tests gracefully skip when features aren't available.
 */

// Set environment variables before imports
process.env.AWS_REGION = 'us-west-2'

import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {createTestApi, deleteTestApi, invokeApiEndpoint, isApiGatewayAvailable} from '../helpers/apigateway-helpers'
import {deleteTable} from '../lib/vendor/AWS/DynamoDB'

describe('API Gateway Routing Integration Tests', () => {
  let apiGatewayAvailable = false
  let testApiId: string | null = null
  let testEndpoint: string | null = null

  beforeAll(async () => {
    apiGatewayAvailable = await isApiGatewayAvailable()
    if (!apiGatewayAvailable) {
      console.log('LocalStack API Gateway not available - some tests will be skipped')
      return
    }

    // Try to create a test API
    const api = await createTestApi(`test-api-${Date.now()}`)
    if (api) {
      testApiId = api.apiId
      testEndpoint = api.endpoint
    }
  })

  afterAll(async () => {
    if (testApiId) {
      await deleteTestApi(testApiId)
    }
  })

  test('should verify LocalStack health includes API Gateway', async () => {
    // This test always runs to verify LocalStack is up
    const response = await fetch(`${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/_localstack/health`)
    expect(response.ok).toBe(true)

    const health = await response.json() as {services?: Record<string, string>}
    expect(health.services).toBeDefined()
    // API Gateway may or may not be available depending on LocalStack version/tier
    console.log('LocalStack services:', Object.keys(health.services || {}))

    // A2B SCRATCH MUTANT - DO NOT MERGE. Atlas gate-can-fail proof for the
    // integration-tests required check. The integration fixture creates no
    // DynamoDB tables at all (globalSetup.ts provisions PostgreSQL worker
    // schemas only), so this table name is absent on every run and the call
    // fails with ResourceNotFoundException deterministically. It sits after
    // the LocalStack health assertions above so a red run proves the sidecar
    // was reachable and the failure is the gate, not the infrastructure.
    await deleteTable('a2b-scratch-table-that-is-never-created')
  })

  test('should handle API Gateway availability check', async () => {
    const available = await isApiGatewayAvailable()
    // Just verify the check runs without throwing
    expect(typeof available).toBe('boolean')
    console.log(`API Gateway available: ${available}`)
  })

  test('should create test API if available', async () => {
    if (!apiGatewayAvailable) {
      console.log('Skipping: API Gateway not available')
      return
    }

    // If we got here and API was created, verify we have the IDs
    if (testApiId && testEndpoint) {
      expect(testApiId).toBeDefined()
      expect(testEndpoint).toContain(testApiId)
    } else {
      console.log('API creation not supported in this LocalStack configuration')
    }
  })

  test('should invoke endpoint and get response', async () => {
    if (!apiGatewayAvailable || !testEndpoint) {
      console.log('Skipping: API Gateway endpoint not available')
      return
    }

    // Invoke the test endpoint
    const response = await invokeApiEndpoint(testEndpoint, 'GET', '/')

    // LocalStack may return various status codes depending on configuration
    // We just verify we got a response
    expect(response.status).toBeDefined()
    console.log(`API Gateway response status: ${response.status}`)
  })

  test('should return 404 for unknown routes when available', async () => {
    if (!apiGatewayAvailable || !testEndpoint) {
      console.log('Skipping: API Gateway endpoint not available')
      return
    }

    // Try an unknown route
    const response = await invokeApiEndpoint(testEndpoint, 'GET', '/unknown-route-xyz')

    // LocalStack should return 404 for unconfigured routes
    // But behavior varies by version
    expect(response.status).toBeDefined()
    console.log(`Unknown route response status: ${response.status}`)
  })

  test('should handle POST requests', async () => {
    if (!apiGatewayAvailable || !testEndpoint) {
      console.log('Skipping: API Gateway endpoint not available')
      return
    }

    const response = await invokeApiEndpoint(testEndpoint, 'POST', '/', {body: JSON.stringify({test: 'data'})})

    expect(response.status).toBeDefined()
    console.log(`POST response status: ${response.status}`)
  })
})
