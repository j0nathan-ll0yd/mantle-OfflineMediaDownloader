/**
 * Unit tests for RegisterDevice Lambda (POST /device/register)
 *
 * Tests platform endpoint creation, user device registration, subscription management.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/aws', () => ({createPlatformEndpoint: vi.fn(), listSubscriptionsByTopic: vi.fn()}))

vi.mock('@mantleframework/core',
  () => ({
    buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data})),
    UserStatus: {Authenticated: 'Authenticated', Anonymous: 'Anonymous'}
  }))

vi.mock('@mantleframework/env', () => ({getRequiredEnv: vi.fn(() => 'arn:aws:sns:us-west-2:123456789012:app/APNS/MediaDownloader')}))

vi.mock('@mantleframework/errors', () => {
  class ServiceUnavailableError extends Error {
    statusCode = 503
    constructor(message: string) {
      super(message)
      this.name = 'ServiceUnavailableError'
    }
  }
  class UnexpectedError extends Error {
    statusCode = 500
    constructor(message: string) {
      super(message)
      this.name = 'UnexpectedError'
    }
  }
  return {ServiceUnavailableError, UnexpectedError}
})

vi.mock('@mantleframework/observability', () => ({logDebug: vi.fn()}))

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({optional: vi.fn(() => ({}))}))}
  }))

vi.mock('#entities/queries', () => ({upsertDevice: vi.fn(), upsertUserDevice: vi.fn()}))

vi.mock('#errors/custom-errors', () => ({providerFailureErrorMessage: 'AWS request failed'}))

vi.mock('#services/device/deviceService', () => ({getUserDevices: vi.fn(), subscribeEndpointToTopic: vi.fn(), unsubscribeEndpointToTopic: vi.fn()}))

vi.mock('#types/api-schema', () => ({deviceRegistrationResponseSchema: {}}))

vi.mock('#utils/platform-config', () => ({verifyPlatformConfiguration: vi.fn()}))

const {handler} = (await import('#lambdas/api/device/register.post.js')) as any
import {createPlatformEndpoint, listSubscriptionsByTopic} from '@mantleframework/aws'
import {upsertDevice, upsertUserDevice} from '#entities/queries'
import {getUserDevices, subscribeEndpointToTopic, unsubscribeEndpointToTopic} from '#services/device/deviceService'
import {verifyPlatformConfiguration} from '#utils/platform-config'

describe('RegisterDevice Lambda', () => {
  const baseBody = {deviceId: 'dev-1', token: 'apns-token', name: 'iPhone', systemVersion: '17.0', systemName: 'iOS'}

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createPlatformEndpoint).mockResolvedValue({EndpointArn: 'arn:aws:sns:endpoint/dev-1', $metadata: {}})
    vi.mocked(upsertDevice).mockResolvedValue(undefined as never)
    vi.mocked(upsertUserDevice).mockResolvedValue(undefined as never)
  })

  it('should call verifyPlatformConfiguration', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])

    await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})

    expect(verifyPlatformConfiguration).toHaveBeenCalled()
  })

  it('should throw ServiceUnavailableError when createPlatformEndpoint returns null', async () => {
    vi.mocked(createPlatformEndpoint).mockResolvedValue(null as never)

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})).rejects.toThrow(
      'AWS failed to respond'
    )
  })

  it('should return 200 for first device of authenticated user', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([{userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()}])

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})

    expect(result.statusCode).toBe(200)
    expect(result.endpointArn).toBe('arn:aws:sns:endpoint/dev-1')
    expect(upsertUserDevice).toHaveBeenCalled()
  })

  it('should unsubscribe and return 201 for subsequent devices of authenticated user', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(listSubscriptionsByTopic).mockResolvedValue({
      Subscriptions: [{
        Endpoint: 'arn:aws:sns:endpoint/dev-1',
        SubscriptionArn: 'arn:aws:sns:sub/1',
        Protocol: 'application',
        Owner: '123',
        TopicArn: 'arn:aws:sns:topic'
      }],
      $metadata: {}
    })
    vi.mocked(unsubscribeEndpointToTopic).mockResolvedValue(undefined as never)

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})

    expect(result.statusCode).toBe(201)
    expect(unsubscribeEndpointToTopic).toHaveBeenCalled()
  })

  it('should subscribe anonymous user to push notification topic', async () => {
    vi.mocked(subscribeEndpointToTopic).mockResolvedValue({} as never)

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: undefined, userStatus: 'Anonymous', body: baseBody})

    expect(subscribeEndpointToTopic).toHaveBeenCalledWith('arn:aws:sns:endpoint/dev-1', expect.any(String))
    expect(result.statusCode).toBe(200)
  })

  it('should throw ServiceUnavailableError when listSubscriptionsByTopic has no subscriptions', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(listSubscriptionsByTopic).mockResolvedValue({Subscriptions: undefined, $metadata: {}})

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})).rejects.toThrow(
      'AWS request failed'
    )
  })

  it('should throw UnexpectedError when no matching subscription found for endpoint', async () => {
    vi.mocked(getUserDevices).mockResolvedValue([
      {userId: 'user-1', deviceId: 'dev-1', createdAt: new Date()},
      {userId: 'user-1', deviceId: 'dev-2', createdAt: new Date()}
    ])
    vi.mocked(listSubscriptionsByTopic).mockResolvedValue({
      Subscriptions: [{
        Endpoint: 'arn:aws:sns:endpoint/OTHER',
        SubscriptionArn: 'arn:aws:sns:sub/99',
        Protocol: 'application',
        Owner: '123',
        TopicArn: 'arn:aws:sns:topic'
      }],
      $metadata: {}
    })

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', userStatus: 'Authenticated', body: baseBody})).rejects.toThrow(
      'Invalid subscription response'
    )
  })

  it('should always upsert device regardless of user status', async () => {
    vi.mocked(subscribeEndpointToTopic).mockResolvedValue({} as never)

    await handler({context: {awsRequestId: 'req-1'}, userId: undefined, userStatus: 'Anonymous', body: baseBody})

    expect(upsertDevice).toHaveBeenCalled()
  })
})
