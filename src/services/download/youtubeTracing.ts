/**
 * YouTube Tracing Service
 *
 * Wraps YouTube/yt-dlp operations with OpenTelemetry tracing and
 * circuit breaker protection against cascading failures.
 */
import {isOk, S3BucketName} from '@j0nathan-ll0yd/core'
import {addAnnotation, addMetadata, endSpan, startSpan} from '@j0nathan-ll0yd/observability'
import {downloadVideoToS3, fetchVideoInfo} from '#services/youtube/youtube'
import type {FetchVideoInfoResult} from '#types/video'
import {CircuitBreaker} from '@j0nathan-ll0yd/resilience'

const youtubeCircuitBreaker = new CircuitBreaker({name: 'youtube'})

/**
 * Fetch video info with OpenTelemetry tracing and circuit breaker protection.
 * Wraps fetchVideoInfo with circuit breaker to prevent cascading failures
 * when YouTube/yt-dlp is degraded.
 *
 * @param fileUrl - The video URL to fetch info for
 * @param fileId - The file ID for annotation
 * @returns The video info result
 * @throws CircuitBreakerOpenError if circuit is open
 */
export async function fetchVideoInfoTraced(fileUrl: string, fileId: string): Promise<FetchVideoInfoResult> {
  const span = startSpan('yt-dlp-fetch-info')

  const result = await youtubeCircuitBreaker.execute(() => fetchVideoInfo(fileUrl)) as FetchVideoInfoResult

  addAnnotation(span, 'videoId', fileId)
  addMetadata(span, 'videoUrl', fileUrl)
  addMetadata(span, 'success', isOk(result))
  endSpan(span)

  return result
}

/**
 * Download video to S3 with OpenTelemetry tracing and circuit breaker protection.
 * Wraps downloadVideoToS3 with circuit breaker to prevent cascading failures
 * when YouTube/yt-dlp is degraded.
 *
 * @param fileUrl - The video URL to download
 * @param bucket - The S3 bucket to upload to
 * @param fileName - The S3 object key
 * @returns Object with fileSize, s3Url, and duration
 * @throws CircuitBreakerOpenError if circuit is open
 */
export async function downloadVideoToS3Traced(
  fileUrl: string,
  bucket: S3BucketName,
  fileName: string,
  onProgress?: (percent: number) => void
): Promise<{fileSize: number; s3Url: string; duration: number}> {
  const span = startSpan('yt-dlp-download-to-s3')
  try {
    const result = await youtubeCircuitBreaker.execute(() => downloadVideoToS3(fileUrl, bucket, fileName, {onProgress})) as {
      fileSize: number
      s3Url: string
      duration: number
    }
    addAnnotation(span, 's3Bucket', bucket)
    addAnnotation(span, 's3Key', fileName)
    addMetadata(span, 'fileSize', result.fileSize)
    addMetadata(span, 'duration', result.duration)
    endSpan(span)
    return result
  } catch (error) {
    endSpan(span, error as Error)
    throw error
  }
}
