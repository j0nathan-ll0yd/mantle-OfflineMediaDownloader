/**
 * Video Processing Types
 *
 * Type definitions for video download, error classification, and yt-dlp integration.
 *
 * @see src/lib/domain/video/errorClassifier.ts - Error classification implementation
 * @see src/lib/vendor/YouTube.ts - YouTube/yt-dlp integration
 */

import type {Result} from '@j0nathan-ll0yd/core'
import type {BaseErrorClassification} from './errorClassification'
import type {YtDlpVideoInfo} from './youtube'

/**
 * Categories of video download errors for intelligent retry handling
 */
export type VideoErrorCategory =
  | 'scheduled' // Scheduled video, retry at release_timestamp
  | 'livestream_upcoming' // Livestream not started, retry when starts
  | 'transient' // Network/temporary error, exponential backoff
  | 'cookie_expired' // Cookie needs refresh, requires manual intervention
  | 'permanent' // Deleted, geo-blocked, private - no retry

/**
 * Result of classifying a video download error.
 * Extends BaseErrorClassification with video-specific category and timing.
 */
export interface VideoErrorClassification extends BaseErrorClassification {
  /** The category of error determining retry behavior */
  category: VideoErrorCategory
  /** Unix timestamp (seconds) for when to retry, undefined if not retryable */
  retryAfter?: number
}

/**
 * Extended video info with scheduling fields from yt-dlp
 * These fields are provided by yt-dlp for scheduled/livestream content
 */
export interface SchedulingVideoInfo {
  release_timestamp?: number
  is_live?: boolean
  live_status?: 'is_live' | 'is_upcoming' | 'was_live' | 'not_live'
  availability?: 'public' | 'unlisted' | 'private' | 'needs_auth' | 'subscriber_only'
}

/**
 * Error details for a failed video info fetch
 */
export interface VideoInfoError {
  error: Error
  isCookieError: boolean
}

/**
 * Result of fetching video info - either success with info or failure with error details
 */
export type FetchVideoInfoResult = Result<YtDlpVideoInfo, VideoInfoError>
