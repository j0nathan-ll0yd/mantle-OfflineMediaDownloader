/**
 * Unit tests for UserSubscribe Lambda (POST /user/subscribe)
 *
 * Tests subscription creation, auth validation, and platform config check.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@mantleframework/core', () => ({buildValidatedResponse: vi.fn((_ctx, code, data) => ({statusCode: code, ...data}))}))

vi.mock('@mantleframework/errors', () => {
  class UnauthorizedError extends Error {
    statusCode = 401
    constructor(message: string) {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  return {UnauthorizedError}
})

vi.mock('@mantleframework/validation',
  () => ({
    defineApiHandler: vi.fn(() => (innerHandler: (...a: unknown[]) => unknown) => innerHandler),
    z: {object: vi.fn(() => ({})), string: vi.fn(() => ({optional: vi.fn(() => ({}))}))}
  }))

vi.mock('#services/device/deviceService', () => ({subscribeEndpointToTopic: vi.fn()}))

vi.mock('#utils/platform-config', () => ({verifyPlatformConfiguration: vi.fn()}))

const {handler} = (await import('#lambdas/api/user/subscribe.post.js')) as any
import {subscribeEndpointToTopic} from '#services/device/deviceService'
import {verifyPlatformConfiguration} from '#utils/platform-config'

describe('UserSubscribe Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw UnauthorizedError when userId is missing', async () => {
    await expect(handler({context: {awsRequestId: 'req-1'}, userId: undefined, body: {endpointArn: 'arn:endpoint', topicArn: 'arn:topic'}})).rejects.toThrow(
      'Authentication required'
    )
  })

  it('should call verifyPlatformConfiguration before subscribing', async () => {
    vi.mocked(subscribeEndpointToTopic).mockResolvedValue({SubscriptionArn: 'arn:sub', $metadata: {}})

    await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', body: {endpointArn: 'arn:endpoint', topicArn: 'arn:topic'}})

    expect(verifyPlatformConfiguration).toHaveBeenCalled()
  })

  it('should return 201 with subscription ARN', async () => {
    vi.mocked(subscribeEndpointToTopic).mockResolvedValue({SubscriptionArn: 'arn:aws:sns:sub/123', $metadata: {}})

    const result = await handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', body: {endpointArn: 'arn:endpoint', topicArn: 'arn:topic'}})

    expect(result.statusCode).toBe(201)
    expect(result.subscriptionArn).toBe('arn:aws:sns:sub/123')
  })

  it('should propagate subscription errors', async () => {
    vi.mocked(subscribeEndpointToTopic).mockRejectedValue(new Error('SNS error'))

    await expect(handler({context: {awsRequestId: 'req-1'}, userId: 'user-1', body: {endpointArn: 'arn:endpoint', topicArn: 'arn:topic'}})).rejects.toThrow(
      'SNS error'
    )
  })
})
