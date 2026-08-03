/**
 * Platform Configuration Verification
 *
 * Validates required APNS platform configuration is present at Lambda cold start.
 */
import {getOptionalEnv} from '@j0nathan-ll0yd/env'
import {logDebug} from '@j0nathan-ll0yd/observability'
import {ServiceUnavailableError} from '@j0nathan-ll0yd/errors'

/**
 * Verifies required APNS platform configuration is present.
 * @throws ServiceUnavailableError if PLATFORM_APPLICATION_ARN is not set
 */
export function verifyPlatformConfiguration(): void {
  const platformApplicationArn = getOptionalEnv('PLATFORM_APPLICATION_ARN', '')
  logDebug('process.env.PLATFORM_APPLICATION_ARN <=', {platformApplicationArn})
  if (!platformApplicationArn) {
    throw new ServiceUnavailableError('requires configuration')
  }
}
