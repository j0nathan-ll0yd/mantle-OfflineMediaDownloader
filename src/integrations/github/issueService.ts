import {Octokit} from '@octokit/rest'
import {logDebug, logError, logInfo} from '@j0nathan-ll0yd/observability'
import type {Device} from '#types/domainModels'
import type {IssueResult} from '#types/errorFingerprint'
import {renderGithubIssueTemplate} from '#integrations/github/templates'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {extractFingerprintFromError, generateErrorFingerprint} from './errorFingerprint.js'

export type { IssueResult } from '#types/errorFingerprint'

const owner = 'j0nathan-ll0yd'
const repo = 'mantle-OfflineMediaDownloader'

async function getOctokitInstance() {
  // Constrained to only reading/writing issues
  return new Octokit({
    auth: getRequiredEnv('GITHUB_PERSONAL_TOKEN'),
    baseUrl: 'https://api.github.com',
    userAgent: `${repo}-production`,
    timeZone: 'America/Los_Angeles',
    log: {
      debug: (message) => {
        logDebug(message, {})
      },
      info: (message) => {
        logInfo(message, {})
      },
      warn: (message) => {
        logDebug(message, {})
      },
      error: (message) => {
        /* c8 ignore next */
        logError(message, {})
      }
    }
  })
}

/**
 * Finds an existing open issue with the given fingerprint label.
 * Returns the issue number if found, undefined otherwise.
 */
async function findExistingIssueByFingerprint(octokit: Octokit, fingerprint: string): Promise<number | undefined> {
  try {
    const response = await octokit.rest.issues.listForRepo({owner, repo, state: 'open', labels: fingerprint, per_page: 1})

    if (response.data.length > 0) {
      logInfo('Found existing issue with fingerprint', {fingerprint, issueNumber: response.data[0]!.number})
      return response.data[0]!.number
    }
    return undefined
  } catch (error) {
    logError('Failed to search for existing issue', {error: error instanceof Error ? error.message : String(error)})
    return undefined
  }
}

/**
 * Adds a comment to an existing issue noting a duplicate occurrence.
 */
async function addCommentToExistingIssue(octokit: Octokit, issueNumber: number, context: string): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `## Duplicate Occurrence\n\n**Timestamp:** ${new Date().toISOString()}\n\n${context}`
    })
    logInfo('Added comment to existing issue', {issueNumber})
  } catch (error) {
    logError('Failed to add comment to issue', {error: error instanceof Error ? error.message : String(error)})
  }
}

/** Creates GitHub issue when user deletion fails (with deduplication). */
export async function createFailedUserDeletionIssue(userId: string, devices: Device[], error: Error, requestId: string): Promise<IssueResult | null> {
  // Generate fingerprint for deduplication
  const fpInput = extractFingerprintFromError(error, 'UserDelete')
  const {fingerprint, summary} = generateErrorFingerprint(fpInput)

  const title = `User Deletion Failed: ${userId}`
  const timestamp = new Date().toISOString()
  // Pre-compute all values for safe template interpolation
  const deviceCount = devices.length
  const hasDevices = deviceCount > 0
  const devicesJson = devices.length > 0 ? JSON.stringify(devices, null, 2) : ''
  const body = renderGithubIssueTemplate('user-deletion-failure', {
    userId,
    requestId,
    deviceCount,
    hasDevices,
    devicesJson,
    errorMessage: error.message,
    errorName: error.constructor.name,
    errorStack: error.stack ?? 'No stack trace available',
    timestamp,
    fingerprint,
    fingerprintSummary: summary
  })

  try {
    const octokit = await getOctokitInstance()

    // Check for existing issue with same fingerprint
    const existingIssue = await findExistingIssueByFingerprint(octokit, fingerprint)
    if (existingIssue) {
      const commentContext = `User ID: ${userId}\nRequest ID: ${requestId}\nError: ${error.message}`
      await addCommentToExistingIssue(octokit, existingIssue, commentContext)
      const issueUrl = `https://github.com/${owner}/${repo}/issues/${existingIssue}`
      return {issueNumber: existingIssue, issueUrl, isDuplicate: true}
    }

    // Create new issue with fingerprint label
    const params = {owner, repo, title, body, labels: ['bug', 'user-management', 'automated', 'requires-manual-fix', fingerprint]}
    logDebug('createFailedUserDeletionIssue <=', params as unknown as Record<string, unknown>)
    const response = await octokit.rest.issues.create(params)
    logDebug('createFailedUserDeletionIssue =>', {issueNumber: response.data.number})
    return {issueNumber: response.data.number, issueUrl: response.data.html_url, isDuplicate: false}
  } catch (githubError) {
    // Don't fail the Lambda if GitHub issue creation fails
    logError('Failed to create GitHub issue for user deletion failure', {error: githubError instanceof Error ? githubError.message : String(githubError)})
    return null
  }
}

/** Creates GitHub issue when video download fails permanently (with deduplication). */
export async function createVideoDownloadFailureIssue(fileId: string, fileUrl: string, error: Error, errorDetails?: string): Promise<IssueResult | null> {
  // Generate fingerprint for deduplication
  const fpInput = extractFingerprintFromError(error, 'StartFileUpload', `video:${fileId}`)
  const {fingerprint, summary} = generateErrorFingerprint(fpInput)

  const title = `Video Download Failed: ${fileId}`
  const timestamp = new Date().toISOString()
  // Pre-compute all values for safe template interpolation
  const body = renderGithubIssueTemplate('video-download-failure', {
    fileId,
    fileUrl,
    errorMessage: error.message,
    errorName: error.constructor.name,
    errorStack: error.stack ?? 'No stack trace available',
    errorDetails: errorDetails ?? '',
    hasErrorDetails: !!errorDetails,
    timestamp,
    fingerprint,
    fingerprintSummary: summary
  })

  try {
    const octokit = await getOctokitInstance()

    // Check for existing issue with same fingerprint
    const existingIssue = await findExistingIssueByFingerprint(octokit, fingerprint)
    if (existingIssue) {
      const commentContext = `File ID: ${fileId}\nFile URL: ${fileUrl}\nError: ${error.message}`
      await addCommentToExistingIssue(octokit, existingIssue, commentContext)
      const issueUrl = `https://github.com/${owner}/${repo}/issues/${existingIssue}`
      return {issueNumber: existingIssue, issueUrl, isDuplicate: true}
    }

    // Create new issue with fingerprint label
    const params = {owner, repo, title, body, labels: ['bug', 'video-download', 'automated', fingerprint]}
    logDebug('createVideoDownloadFailureIssue <=', params as unknown as Record<string, unknown>)
    const response = await octokit.rest.issues.create(params)
    logDebug('createVideoDownloadFailureIssue =>', {issueNumber: response.data.number})
    return {issueNumber: response.data.number, issueUrl: response.data.html_url, isDuplicate: false}
  } catch (githubError) {
    // Don't fail the Lambda if GitHub issue creation fails
    logError('Failed to create GitHub issue for video download failure', {error: githubError instanceof Error ? githubError.message : String(githubError)})
    return null
  }
}

/** Creates priority GitHub issue when YouTube cookies expire (with deduplication). */
export async function createCookieExpirationIssue(fileId: string, fileUrl: string, error: Error): Promise<IssueResult | null> {
  // Use static fingerprint for cookie expiration (always same issue)
  const {fingerprint, summary} = generateErrorFingerprint({errorType: 'CookieExpiration', context: 'youtube-cookies'})

  const title = '🍪 YouTube Cookie Expiration Detected'
  const timestamp = new Date().toISOString()
  // Pre-compute all values for safe template interpolation
  const body = renderGithubIssueTemplate('cookie-expiration', {
    fileId,
    fileUrl,
    errorMessage: error.message,
    errorName: error.constructor.name,
    errorStack: error.stack ?? 'No stack trace available',
    timestamp,
    fingerprint,
    fingerprintSummary: summary
  })

  try {
    const octokit = await getOctokitInstance()

    // Check for existing issue (cookie issues should always dedupe)
    const existingIssue = await findExistingIssueByFingerprint(octokit, fingerprint)
    if (existingIssue) {
      const commentContext = `File ID: ${fileId}\nFile URL: ${fileUrl}\nError: ${error.message}`
      await addCommentToExistingIssue(octokit, existingIssue, commentContext)
      const issueUrl = `https://github.com/${owner}/${repo}/issues/${existingIssue}`
      logInfo('Added occurrence to existing cookie issue', {issueNumber: existingIssue})
      return {issueNumber: existingIssue, issueUrl, isDuplicate: true}
    }

    // Create new issue with fingerprint label
    const params = {owner, repo, title, body, labels: ['cookie-expiration', 'requires-manual-fix', 'automated', 'priority', fingerprint]}
    logDebug('createCookieExpirationIssue <=', params as unknown as Record<string, unknown>)
    const response = await octokit.rest.issues.create(params)
    logInfo('Created GitHub issue for cookie expiration', {issueNumber: response.data.number, issueUrl: response.data.html_url})
    return {issueNumber: response.data.number, issueUrl: response.data.html_url, isDuplicate: false}
  } catch (githubError) {
    // Don't fail the Lambda if GitHub issue creation fails
    logError('Failed to create GitHub issue for cookie expiration', {error: githubError instanceof Error ? githubError.message : String(githubError)})
    return null
  }
}

/**
 * Auto-close cookie expiration issue when YouTube authentication recovers.
 * Called after a successful video download to close any open cookie issues.
 * This implements self-healing by closing issues when the problem is resolved.
 */
export async function closeCookieExpirationIssueIfResolved(): Promise<void> {
  // Use same fingerprint as createCookieExpirationIssue for consistency
  const {fingerprint} = generateErrorFingerprint({errorType: 'CookieExpiration', context: 'youtube-cookies'})
  try {
    const octokit = await getOctokitInstance()
    const existingIssue = await findExistingIssueByFingerprint(octokit, fingerprint)

    if (existingIssue) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: existingIssue,
        body: `## Automatically Resolved

YouTube authentication succeeded. Closing this issue.

**Timestamp:** ${new Date().toISOString()}
**Resolution:** Cookies + PO tokens working`
      })

      await octokit.rest.issues.update({owner, repo, issue_number: existingIssue, state: 'closed'})

      logInfo('Closed resolved cookie expiration issue', {issueNumber: existingIssue})
    }
  } catch (error) {
    // Don't fail Lambda if GitHub API fails - this is best-effort
    logError('Failed to close cookie expiration issue', {error: error instanceof Error ? error.message : String(error)})
  }
}
