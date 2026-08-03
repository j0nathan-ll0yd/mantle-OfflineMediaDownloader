/**
 * Project-Specific Error Classes
 *
 * These errors are specific to the media-downloader and are not provided
 * by \@j0nathan-ll0yd/errors. They extend CustomLambdaError for consistent
 * error handling across Lambda handlers.
 */
import type {Notification} from 'apns2'
import {CustomLambdaError} from '@j0nathan-ll0yd/errors'

/**
 * Cookie expiration or bot detection error from YouTube.
 * Thrown when yt-dlp encounters auth-related failures.
 */
export class CookieExpirationError extends CustomLambdaError {
  constructor(message: string, statusCode = 403, cause?: Error) {
    super(message, {cause})
    this.name = 'CookieExpirationError'
    this.code = 'COOKIE_EXPIRED'
    this.statusCode = statusCode
  }
}

/**
 * Errors thrown by node-apns2 (when sending push health checks).
 * Not a CustomLambdaError since it wraps a third-party library's error shape.
 */
export class Apns2Error extends Error {
  notification: Notification
  reason: string
  statusCode: number
  constructor(reason: string, statusCode: number, notification: Notification) {
    super()
    this.reason = reason
    this.notification = notification
    this.statusCode = statusCode
  }
}

/**
 * Provider failure error message constant.
 */
export const providerFailureErrorMessage = 'AWS request failed'
