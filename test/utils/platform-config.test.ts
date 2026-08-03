/**
 * Unit tests for Platform Configuration Verification
 *
 * Tests APNS platform configuration validation with env var present and missing.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@j0nathan-ll0yd/env', () => ({getOptionalEnv: vi.fn()}))

vi.mock('@j0nathan-ll0yd/observability', () => ({logDebug: vi.fn()}))

vi.mock('@j0nathan-ll0yd/errors', () => ({
  ServiceUnavailableError: class ServiceUnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ServiceUnavailableError'
    }
  }
}))

const {verifyPlatformConfiguration} = await import('#utils/platform-config.js')
import {getOptionalEnv} from '@j0nathan-ll0yd/env'
import {logDebug} from '@j0nathan-ll0yd/observability'

describe('verifyPlatformConfiguration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should succeed when PLATFORM_APPLICATION_ARN is set', () => {
    const arn = 'arn:aws:sns:us-west-2:123456789012:app/APNS_SANDBOX/MediaDownloader'
    vi.mocked(getOptionalEnv).mockReturnValue(arn)

    expect(() => verifyPlatformConfiguration()).not.toThrow()

    expect(getOptionalEnv).toHaveBeenCalledWith('PLATFORM_APPLICATION_ARN', '')
    expect(logDebug).toHaveBeenCalledWith('process.env.PLATFORM_APPLICATION_ARN <=', {platformApplicationArn: arn})
  })

  it('should throw ServiceUnavailableError when PLATFORM_APPLICATION_ARN is empty', () => {
    vi.mocked(getOptionalEnv).mockReturnValue('')

    expect(() => verifyPlatformConfiguration()).toThrow('requires configuration')
  })

  it('should throw ServiceUnavailableError when env var returns default empty string', () => {
    vi.mocked(getOptionalEnv).mockReturnValue('')

    expect(() => verifyPlatformConfiguration()).toThrow(expect.objectContaining({name: 'ServiceUnavailableError'}))
  })

  it('should log the ARN value for debugging', () => {
    const arn = 'arn:aws:sns:us-east-1:111111111111:app/APNS/Prod'
    vi.mocked(getOptionalEnv).mockReturnValue(arn)

    verifyPlatformConfiguration()

    expect(logDebug).toHaveBeenCalledWith('process.env.PLATFORM_APPLICATION_ARN <=', {platformApplicationArn: arn})
  })
})
