import {execSync, spawn} from 'child_process'
import {createReadStream, existsSync, readdirSync, statSync} from 'fs'
import {copyFile, readdir, stat, unlink} from 'fs/promises'
import type {YtDlpVideoInfo} from '#types/youtube'
import {metrics, MetricUnit} from '@mantleframework/observability'
import {logDebug, logError} from '@mantleframework/observability'
import {CookieExpirationError} from '#errors/custom-errors'
import {UnexpectedError} from '@mantleframework/errors'
import {createUpload} from '@mantleframework/aws'
import {getOptionalEnv, getRequiredEnv} from '@mantleframework/env'
import {err, ok} from '@mantleframework/core'
import type {S3BucketName} from '@mantleframework/core'

/**
 * One-time diagnostic check for Lambda layer environment.
 * Logs layer file presence, permissions, and yt-dlp version on cold start.
 */
let diagnosticsRun = false
function runLayerDiagnostics(binaryPath: string): void {
  if (diagnosticsRun) {
    return
  }
  diagnosticsRun = true

  const checks: Record<string, unknown> = {}

  // Check key files exist
  const paths = [
    binaryPath,
    '/opt/bin/bgutil',
    '/opt/bin/deno',
    '/opt/bin/ffmpeg',
    '/opt/cookies/youtube-cookies.txt',
    '/opt/python'
  ]
  for (const p of paths) {
    try {
      const exists = existsSync(p)
      if (exists) {
        const s = statSync(p)
        checks[p] = {exists: true, size: s.size, mode: s.mode.toString(8), isDir: s.isDirectory()}
      } else {
        checks[p] = {exists: false}
      }
    } catch (e) {
      checks[p] = {error: String(e)}
    }
  }

  // List /opt/bin contents
  try {
    checks['/opt/bin/*'] = readdirSync('/opt/bin')
  } catch {
    checks['/opt/bin/*'] = 'not readable'
  }

  // Check yt-dlp version
  try {
    checks['yt-dlp-version'] = execSync(`${binaryPath} --version`, {timeout: 5000}).toString().trim()
  } catch (e) {
    checks['yt-dlp-version'] = `error: ${String(e).substring(0, 200)}`
  }

  // Check if deno is executable
  try {
    checks['deno-version'] = execSync('/opt/bin/deno --version', {timeout: 5000}).toString().split('\n')[0]?.trim()
  } catch (e) {
    checks['deno-version'] = `error: ${String(e).substring(0, 200)}`
  }

  // Check PATH
  checks['PATH'] = getOptionalEnv('PATH', '').substring(0, 300)

  logDebug('Layer diagnostics', checks)
}

/**
 * yt-dlp static configuration constants (values known at deploy time)
 */
const YTDLP_STATIC_CONFIG = {
  /** Cookies source path (read-only in Lambda layer) */
  COOKIES_SOURCE: '/opt/cookies/youtube-cookies.txt',
  /** Cookies destination path (writable in Lambda) */
  COOKIES_DEST: '/tmp/youtube-cookies.txt',
  /** Output container format */
  MERGE_FORMAT: 'mp4',
  /** Number of concurrent fragment downloads for speed */
  CONCURRENT_FRAGMENTS: '4',
  /** bgutil plugin path in Lambda layer (set via PYTHONPATH env var) */
  PLUGIN_PATH: '/opt/python',
  /** Explicit deno path for yt-dlp JS challenge solving (PyInstaller binary can't discover via PATH) */
  JS_RUNTIME: 'deno:/opt/bin/deno',
  /** Explicit ffmpeg location (PyInstaller binary can't discover via PATH) */
  FFMPEG_LOCATION: '/opt/bin'
} as const

/** Runtime yt-dlp config — env vars read at call time, not import time */
function getYtdlpConfig() {
  return {
    ...YTDLP_STATIC_CONFIG,
    /** Sleep between requests during data extraction (seconds) - helps avoid rate limiting */
    SLEEP_REQUESTS: getOptionalEnv('YTDLP_SLEEP_REQUESTS', '1'),
    /** Minimum sleep between downloads (seconds) */
    SLEEP_INTERVAL: getOptionalEnv('YTDLP_SLEEP_INTERVAL', '2'),
    /** Maximum sleep between downloads (seconds) - random delay between min and max */
    MAX_SLEEP_INTERVAL: getOptionalEnv('YTDLP_MAX_SLEEP_INTERVAL', '5')
  }
}

/** Video file extensions that yt-dlp may leave in /tmp (intermediates + output) */
const VIDEO_FILE_EXTENSIONS = ['.mp4', '.m4a', '.webm', '.mkv', '.part', '.ytdl']

/**
 * Remove stale video files from /tmp left by previous invocations.
 * Lambda containers are reused — crashed/timed-out downloads leave
 * intermediate files (.f137.mp4, .f140.m4a, .part) that accumulate.
 * Preserves the cookies file.
 */
async function cleanupStaleTempFiles(): Promise<void> {
  try {
    const files = await readdir('/tmp')
    const staleFiles = files.filter((f) => VIDEO_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)))
    if (staleFiles.length > 0) {
      logDebug('Cleaning up stale temp files', {count: staleFiles.length, files: staleFiles})
      await Promise.all(staleFiles.map((f) => unlink(`/tmp/${f}`).catch(() => {})))
    }
  } catch {
    // /tmp may not be listable in some environments
  }
}

/**
 * Prepare cookies for yt-dlp usage.
 * Copies static cookies from Lambda layer to writable /tmp directory.
 *
 * @returns Path to the writable cookie file
 * @throws Error if copy fails
 */
async function prepareCookies(): Promise<string> {
  logDebug('Copying cookies from Lambda layer')
  await copyFile(YTDLP_STATIC_CONFIG.COOKIES_SOURCE, YTDLP_STATIC_CONFIG.COOKIES_DEST)
  return YTDLP_STATIC_CONFIG.COOKIES_DEST
}

/**
 * Format selectors in order of preference (SABR fallback strategy).
 * When YouTube enforces SABR streaming, separate streams (video+audio) return 403.
 * Combined formats bypass SABR restrictions.
 * @see https://github.com/yt-dlp/yt-dlp/issues/12482
 */
const FORMAT_SELECTORS = [
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', // Primary: separate streams (best quality)
  'best[ext=mp4]/best', // Fallback 1: combined format (bypasses SABR)
  'bestvideo+bestaudio/best' // Fallback 2: any format
] as const

/**
 * Cookie error patterns categorized by severity.
 * - bot_detection: YouTube has detected automated access, requires PO tokens or fresh cookies
 * - cookie_expired: Session cookies have expired, needs cookie refresh
 * - rate_limited: Too many requests, may need to slow down or wait
 */
const COOKIE_ERROR_PATTERNS = {
  bot_detection: [
    "Sign in to confirm you're not a bot",
    'This helps protect our community',
    'bot detection',
    'confirm your human',
    'confirm you are human'
  ],
  cookie_expired: [
    'HTTP Error 403',
    'Forbidden',
    'cookies have expired',
    'session expired',
    'login required'
  ],
  rate_limited: ['HTTP Error 429', 'Too many requests', 'rate limit', 'temporarily blocked']
} as const

/**
 * SABR (Server-side Ad Blocking Response) streaming error patterns.
 * When YouTube enforces SABR, separate video/audio streams fail with 403.
 * Solution: Use combined format selectors instead of separate streams.
 * @see https://github.com/yt-dlp/yt-dlp/issues/12482
 */
const SABR_ERROR_PATTERNS = [
  'SABR streaming',
  'missing a url',
  'formats have been skipped',
  'YouTube is forcing SABR'
] as const

/**
 * Check if an error indicates SABR streaming enforcement
 * @param errorMessage - Error message from yt-dlp
 * @returns true if error is SABR-related
 */
export function isSabrError(errorMessage: string): boolean {
  const lowerMessage = errorMessage.toLowerCase()
  return SABR_ERROR_PATTERNS.some((p) => lowerMessage.includes(p.toLowerCase()))
}

/** Cookie error severity type */
export type CookieErrorSeverity = 'bot_detection' | 'cookie_expired' | 'rate_limited' | null

/**
 * Classify a cookie-related error by severity
 * @param errorMessage - Error message from yt-dlp
 * @returns The error severity category, or null if not a cookie error
 */
export function classifyCookieError(errorMessage: string): CookieErrorSeverity {
  const lowerMessage = errorMessage.toLowerCase()
  for (const [severity, patterns] of Object.entries(COOKIE_ERROR_PATTERNS)) {
    if (patterns.some((p) => lowerMessage.includes(p.toLowerCase()))) {
      return severity as CookieErrorSeverity
    }
  }
  return null
}

/**
 * Check if an error message indicates cookie expiration or bot detection
 * @param errorMessage - Error message from yt-dlp
 * @returns true if error is related to cookie expiration
 */
export function isCookieExpirationError(errorMessage: string): boolean {
  return classifyCookieError(errorMessage) !== null
}

import type {FetchVideoInfoResult} from '#types/video'

/**
 * Execute yt-dlp --dump-json to get video metadata.
 * Direct replacement for yt-dlp-wrap's getVideoInfo method.
 *
 * @param binaryPath - Path to yt-dlp binary
 * @param args - Command line arguments (URL should be last)
 * @returns Parsed video info JSON
 */
function getVideoInfo(binaryPath: string, args: string[]): Promise<YtDlpVideoInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, ['-J', '--skip-download', '--no-check-formats', '--verbose', ...args])
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    proc.on('error', (error) => {
      reject(error)
    })

    proc.on('close', (code) => {
      // Always log stderr for debugging yt-dlp client/format behavior
      if (stderr) {
        logDebug('yt-dlp stderr', {stderr: stderr.substring(0, 8000)})
      }
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(new Error(`Failed to parse yt-dlp JSON output: ${parseError}`))
        }
      } else {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`))
      }
    })
  })
}

/**
 * Safely fetch video metadata using yt-dlp.
 *
 * This function is designed to be "safe" - it never throws, instead returning
 * a result object with success/failure status and optional error details.
 * This enables callers to handle errors gracefully (e.g., scheduling retries).
 *
 * Uses yt-dlp's default player client set which queries all clients and merges
 * their format lists for best coverage.
 *
 * @param uri - YouTube video URL
 * @returns Result object with video info (if successful) or error details
 */
export async function fetchVideoInfo(uri: string): Promise<FetchVideoInfoResult> {
  const ytdlpBinaryPath = getRequiredEnv('YTDLP_BINARY_PATH')
  logDebug('fetchVideoInfo =>', {uri, binaryPath: ytdlpBinaryPath})

  // Prepare cookies from Lambda layer
  try {
    await prepareCookies()
  } catch (cookieError) {
    logError('Failed to prepare cookies', {error: cookieError instanceof Error ? cookieError.message : String(cookieError)})
    return err({error: cookieError instanceof Error ? cookieError : new Error(String(cookieError)), isCookieError: false})
  }

  // Run one-time diagnostics on cold start
  runLayerDiagnostics(ytdlpBinaryPath)

  // Let yt-dlp use its default player client set (android_vr, ios_downgraded, web, web_safari).
  // Default mode queries ALL clients and merges their format lists. Individual clients may return
  // limited formats (android_vr erratic since Mar 2026, mweb needs PO token), but merged results
  // provide enough for format selection. Uses -J --skip-download (set in getVideoInfo).
  try {
    const ytdlpConfig = getYtdlpConfig()
    const ytdlpFlags = [
      '--no-warnings',
      '--no-check-formats',
      '--js-runtimes',
      ytdlpConfig.JS_RUNTIME,
      '--ffmpeg-location',
      ytdlpConfig.FFMPEG_LOCATION,
      '--plugin-dirs',
      ytdlpConfig.PLUGIN_PATH,
      '--cookies',
      ytdlpConfig.COOKIES_DEST,
      '--sleep-requests',
      ytdlpConfig.SLEEP_REQUESTS,
      '--ignore-errors',
      uri
    ]

    const info = await getVideoInfo(ytdlpBinaryPath, ytdlpFlags)

    logDebug('fetchVideoInfo <=', {
      id: info?.id,
      title: info?.title,
      formatCount: info?.formats?.length || 0,
      release_timestamp: info?.release_timestamp,
      live_status: info?.live_status
    })

    metrics.addMetric('YouTubeClientSuccess', MetricUnit.Count, 1)
    return ok(info)
  } catch (error) {
    const caughtError = error instanceof Error ? error : new Error(String(error))
    logError('fetchVideoInfo failed', {uri, error: caughtError.message})

    // Detect cookie errors for upstream handling
    const cookieError = isCookieExpirationError(caughtError.message)
    if (cookieError) {
      logError('Cookie expiration detected', {message: caughtError.message})
      const errorSeverity = classifyCookieError(caughtError.message)
      metrics.addDimension('ErrorType', errorSeverity || 'unknown')
      metrics.addMetric('YouTubeAuthFailure', MetricUnit.Count, 1)
      return err({error: caughtError, isCookieError: true})
    }

    metrics.addMetric('YouTubeClientFailure', MetricUnit.Count, 1)
    return err({error: caughtError, isCookieError: false})
  }
}

/**
 * Extract video ID from YouTube URL
 * @param url - YouTube video URL
 * @returns Video ID
 */
export function getVideoID(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) {
      return match[1]!
    }
  }
  throw new UnexpectedError('Invalid YouTube URL format')
}

/**
 * Parse yt-dlp progress line and extract useful info.
 * Progress lines look like: "[download]  45.2% of ~151.23MiB at 2.50MiB/s ETA 00:35"
 */
function parseProgressLine(line: string): {percent?: number; size?: string; speed?: string; eta?: string} | null {
  // Match download progress line
  const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/)
  if (progressMatch) {
    return {percent: parseFloat(progressMatch[1]!), size: progressMatch[2], speed: progressMatch[3], eta: progressMatch[4]}
  }

  // Match merger line
  if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
    return {percent: 100} // Merging means download is complete
  }

  return null
}

/**
 * Execute yt-dlp command and wait for completion.
 * Logs progress periodically during download.
 * @param ytdlpBinaryPath - Path to yt-dlp binary
 * @param args - Command line arguments
 * @returns Promise that resolves on success, rejects with error details on failure
 */
function execYtDlp(ytdlpBinaryPath: string, args: string[], onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn(ytdlpBinaryPath, args, {cwd: '/tmp'})

    let stderr = ''
    let lastLoggedPercent = -25 // Log every 25% progress
    let lastLogTime = Date.now()
    const LOG_INTERVAL_MS = 60000 // Also log at least every 60 seconds
    let lastDispatchedMilestone = 0 // Track onProgress milestones independently

    ytdlp.stderr.on('data', (chunk) => {
      const data = chunk.toString()
      stderr += data

      // Parse and log progress
      const lines = data.split('\n')
      for (const line of lines) {
        const progress = parseProgressLine(line)
        if (progress) {
          const now = Date.now()
          const timeSinceLastLog = now - lastLogTime

          // Log if: 25% progress milestone, 60s elapsed, or download complete
          const shouldLog = (progress.percent !== undefined && progress.percent >= lastLoggedPercent + 25) ||
            timeSinceLastLog >= LOG_INTERVAL_MS ||
            (progress.percent === 100)

          if (shouldLog && progress.percent !== undefined) {
            logDebug('yt-dlp progress', {percent: `${progress.percent.toFixed(1)}%`, size: progress.size, speed: progress.speed, eta: progress.eta})
            lastLoggedPercent = Math.floor(progress.percent / 25) * 25
            lastLogTime = now
          }

          // Invoke onProgress at 25% milestones only (exclude 100% — DownloadReadyNotification handles completion)
          if (onProgress && progress.percent !== undefined && progress.percent < 100) {
            const milestone = Math.floor(progress.percent / 25) * 25
            if (milestone > 0 && milestone > lastDispatchedMilestone) {
              lastDispatchedMilestone = milestone
              onProgress(milestone)
            }
          }
        }
      }
    })

    // Also capture stdout for progress and informational output
    // yt-dlp 2026.03.17+ with --progress --newline sends progress to stdout
    ytdlp.stdout.on('data', (chunk) => {
      const data = chunk.toString()
      const lines = data.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }

        const progress = parseProgressLine(trimmed)
        if (progress?.percent !== undefined) {
          // Invoke onProgress at 25% milestones (exclude 100%)
          if (onProgress && progress.percent < 100) {
            const milestone = Math.floor(progress.percent / 25) * 25
            if (milestone > 0 && milestone > lastDispatchedMilestone) {
              lastDispatchedMilestone = milestone
              onProgress(milestone)
            }
          }
        } else {
          logDebug('yt-dlp stdout', trimmed)
        }
      }
    })

    ytdlp.on('error', (error) => {
      reject(error)
    })

    ytdlp.on('exit', (code) => {
      if (code !== 0) {
        logError('yt-dlp stderr output', {stderr})

        if (isCookieExpirationError(stderr)) {
          reject(new CookieExpirationError(`YouTube cookie expiration or bot detection: ${stderr}`))
        } else {
          reject(new UnexpectedError(`yt-dlp exited with code ${code}: ${stderr}`))
        }
      } else {
        resolve()
      }
    })
  })
}

/**
 * Download video to temp file then stream to S3 with format fallback.
 *
 * Two-phase approach:
 * 1. yt-dlp downloads to /tmp with proper video+audio merging (uses ffmpeg internally)
 * 2. Stream completed file to S3
 *
 * Implements SABR fallback: tries separate streams first (best quality), then falls
 * back to combined formats if YouTube enforces SABR streaming restrictions.
 *
 * @param uri - YouTube video URL
 * @param bucket - Target S3 bucket name
 * @param key - Target S3 object key (e.g., "dQw4w9WgXcQ.mp4")
 * @returns Upload results including file size, S3 URL, and duration
 */
export async function downloadVideoToS3(
  uri: string,
  bucket: S3BucketName,
  key: string,
  options?: {onProgress?: (percent: number) => void}
): Promise<{fileSize: number; s3Url: string; duration: number}> {
  const ytdlpBinaryPath = getRequiredEnv('YTDLP_BINARY_PATH')
  const tempFile = `/tmp/${key}`

  logDebug('downloadVideoToS3 =>', {uri, bucket, key, tempFile})

  const startTime = Date.now()

  try {
    // Clean up stale files from previous invocations (container reuse)
    await cleanupStaleTempFiles()

    // Prepare cookies from Lambda layer
    await prepareCookies()

    // Try each format selector in order (SABR fallback strategy)
    let downloadError: Error | undefined
    let usedFormat: string | undefined

    for (const formatSelector of FORMAT_SELECTORS) {
      try {
        logDebug('Trying format selector', {formatSelector})

        // Phase 1: Download to temp file with proper merging (yt-dlp uses ffmpeg internally)
        const ytdlpConfig = getYtdlpConfig()
        const ytdlpArgs = [
          '-f',
          formatSelector,
          '--merge-output-format',
          ytdlpConfig.MERGE_FORMAT,
          '--js-runtimes',
          ytdlpConfig.JS_RUNTIME,
          '--ffmpeg-location',
          ytdlpConfig.FFMPEG_LOCATION,
          '--cookies',
          ytdlpConfig.COOKIES_DEST,
          '--plugin-dirs',
          ytdlpConfig.PLUGIN_PATH,
          '--no-warnings',
          '--concurrent-fragments',
          ytdlpConfig.CONCURRENT_FRAGMENTS,
          '--sleep-interval',
          ytdlpConfig.SLEEP_INTERVAL,
          '--max-sleep-interval',
          ytdlpConfig.MAX_SLEEP_INTERVAL,
          '--progress',
          '--newline',
          '-o',
          tempFile,
          uri
        ]

        logDebug('Phase 1: Downloading to temp file', {args: ytdlpArgs, formatSelector})
        await execYtDlp(ytdlpBinaryPath, ytdlpArgs, options?.onProgress)
        logDebug('Phase 1 complete: Download finished', {formatSelector})

        // Track which format succeeded
        usedFormat = formatSelector
        const successMetric = metrics.singleMetric()
        successMetric.addDimension('FormatSelector', formatSelector === FORMAT_SELECTORS[0] ? 'primary' : 'fallback')
        successMetric.addMetric('YouTubeFormatSuccess', MetricUnit.Count, 1)

        break // Success, exit the loop
      } catch (error) {
        downloadError = error instanceof Error ? error : new Error(String(error))
        const errorMessage = downloadError.message

        // Track format failure
        const failureMetric = metrics.singleMetric()
        failureMetric.addDimension('FormatSelector', formatSelector === FORMAT_SELECTORS[0] ? 'primary' : 'fallback')
        failureMetric.addMetric('YouTubeFormatFailure', MetricUnit.Count, 1)

        // If it's a SABR error, 403, or ffmpeg postprocessing failure, try next format
        // Postprocessing failures indicate ffmpeg couldn't merge separate streams — combined formats bypass this
        if (
          isSabrError(errorMessage) || (errorMessage.includes('403') && !isCookieExpirationError(errorMessage)) ||
          errorMessage.includes('Postprocessing: Conversion failed')
        ) {
          logDebug('Format failed, trying next format', {formatSelector, error: errorMessage})
          // Clean up partial temp file before retry
          try {
            await unlink(tempFile)
          } catch {
            // File may not exist
          }
          continue
        }

        // For other errors (cookie, auth, etc.), don't try other formats
        throw error
      }
    }

    // If all formats failed, throw the last error
    if (!usedFormat) {
      throw downloadError || new Error('All format selectors failed')
    }

    // Phase 2: Stream file to S3
    logDebug('Phase 2: Streaming to S3', {bucket, key})
    const fileStream = createReadStream(tempFile)
    const upload = createUpload(bucket, key, fileStream, {
      contentType: 'video/mp4',
      queueSize: 4,
      partSize: 10 * 1024 * 1024 // 10MB parts for larger files
    })

    await upload.done()
    logDebug('Phase 2 complete: S3 upload finished')

    // Get file size before cleanup
    const stats = await stat(tempFile)
    const fileSize = stats.size

    // Cleanup temp file
    await unlink(tempFile)
    logDebug('Cleanup complete: Temp file deleted')

    const duration = Math.floor((Date.now() - startTime) / 1000)
    const s3Url = `s3://${bucket}/${key}`

    logDebug('downloadVideoToS3 <=', {fileSize, s3Url, duration})

    // Publish CloudWatch metrics (flushed by Powertools middleware in calling Lambda)
    const throughputMBps = fileSize > 0 && duration > 0 ? fileSize / 1024 / 1024 / duration : 0

    metrics.addMetric('VideoDownloadSuccess', MetricUnit.Count, 1)
    metrics.addMetric('VideoDownloadDuration', MetricUnit.Seconds, duration)
    metrics.addMetric('VideoDownloadSize', MetricUnit.Bytes, fileSize)
    metrics.addMetric('VideoThroughput', MetricUnit.Count, throughputMBps)

    return {fileSize, s3Url, duration}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('downloadVideoToS3 error', {error: message})

    // Always try to clean up temp file
    try {
      await unlink(tempFile)
    } catch {
      // File may not exist if download failed early
    }

    // Publish failure metric (flushed by Powertools middleware in calling Lambda)
    metrics.addMetric('VideoDownloadFailure', MetricUnit.Count, 1)

    // Classify cookie/auth errors and rethrow with metrics
    if (isCookieExpirationError(message)) {
      const errorSeverity = classifyCookieError(message)
      metrics.addDimension('ErrorType', errorSeverity || 'unknown')
      metrics.addMetric('YouTubeAuthFailure', MetricUnit.Count, 1)
      throw error instanceof CookieExpirationError
        ? error
        : new CookieExpirationError(`YouTube cookie expiration or bot detection: ${message}`)
    }

    throw new UnexpectedError(`Failed to download video to S3: ${message}`)
  }
}
