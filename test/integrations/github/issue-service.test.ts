// covers: media-download#cookie-expiration-issue-closed-on-success
import {beforeEach, describe, expect, test, vi} from 'vitest'
import type {Device} from '#types/domainModels'

// Use vi.hoisted() to define mocks before vi.mock hoists
const {mockIssuesCreate, mockIssuesListForRepo, mockIssuesCreateComment, mockIssuesUpdate, MockOctokit, mockRenderGithubIssueTemplate} = vi.hoisted(() => {
  const mockIssuesCreate = vi.fn<(params: object) => Promise<{status: number; data: {id: number; number: number; html_url: string}}>>()
  const mockIssuesListForRepo = vi.fn<
    (params: object) => Promise<{data: Array<{number: number; title: string; labels: Array<{name: string}>}>}>
  >()
  const mockIssuesCreateComment = vi.fn<(params: object) => Promise<{data: {id: number}}>>()
  const mockIssuesUpdate = vi.fn<(params: object) => Promise<{data: {number: number}}>>()

  class MockOctokit {
    public rest: {
      issues: {
        create: typeof mockIssuesCreate
        listForRepo: typeof mockIssuesListForRepo
        createComment: typeof mockIssuesCreateComment
        update: typeof mockIssuesUpdate
      }
    }
    constructor() {
      this.rest = {issues: {create: mockIssuesCreate, listForRepo: mockIssuesListForRepo, createComment: mockIssuesCreateComment, update: mockIssuesUpdate}}
    }
  }

  const mockRenderGithubIssueTemplate = vi.fn<(templateName: string, data: object) => string>()
  mockRenderGithubIssueTemplate.mockImplementation((templateName: string) => `Rendered template: ${templateName}`)

  return {mockIssuesCreate, mockIssuesListForRepo, mockIssuesCreateComment, mockIssuesUpdate, MockOctokit, mockRenderGithubIssueTemplate}
})

vi.mock('@octokit/rest', () => ({Octokit: MockOctokit}))
vi.mock('#integrations/github/templates.js', () => ({renderGithubIssueTemplate: mockRenderGithubIssueTemplate}))

const {createFailedUserDeletionIssue, createVideoDownloadFailureIssue, createCookieExpirationIssue, closeCookieExpirationIssueIfResolved} = await import(
  '#integrations/github/issueService.js'
)

describe('#Util:GithubHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GITHUB_PERSONAL_TOKEN = 'test-token'
    // Default: no existing issues
    mockIssuesListForRepo.mockResolvedValue({data: []})
  })

  describe('#createFailedUserDeletionIssue', () => {
    test('should create GitHub issue for user deletion failure', async () => {
      const userId = 'test-user-123'
      const device: Device = {
        deviceId: 'device-123',
        name: 'iPhone',
        systemName: 'iOS',
        systemVersion: '17.0',
        token: 'device-token',
        endpointArn: 'arn:aws:sns:us-west-2:123456789012:endpoint/APNS/test/abc123'
      }
      const error = new Error('DynamoDB deletion failed')
      const requestId = 'req-123'

      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 1234, number: 42, html_url: 'https://github.com/owner/repo/issues/42'}})

      const response = await createFailedUserDeletionIssue(userId, [device], error, requestId)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(42)
      expect(response?.issueUrl).toEqual('https://github.com/owner/repo/issues/42')
      expect(response?.isDuplicate).toBe(false)
      expect(mockIssuesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'j0nathan-ll0yd',
          repo: 'mantle-OfflineMediaDownloader',
          title: `User Deletion Failed: ${userId}`,
          body: expect.stringContaining('Rendered template: user-deletion-failure'),
          labels: expect.arrayContaining(['bug', 'user-management', 'automated', 'requires-manual-fix'])
        })
      )
    })

    test('should add comment to existing issue if duplicate', async () => {
      const userId = 'test-user-123'
      const device: Device = {
        deviceId: 'device-123',
        name: 'iPhone',
        systemName: 'iOS',
        systemVersion: '17.0',
        token: 'device-token',
        endpointArn: 'arn:aws:sns:us-west-2:123456789012:endpoint/APNS/test/abc123'
      }
      const error = new Error('DynamoDB deletion failed')
      const requestId = 'req-123'

      // Mock existing issue found
      mockIssuesListForRepo.mockResolvedValue({data: [{number: 99, title: 'Existing issue', labels: []}]})
      mockIssuesCreateComment.mockResolvedValue({data: {id: 123}})

      const response = await createFailedUserDeletionIssue(userId, [device], error, requestId)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(99)
      expect(response?.isDuplicate).toBe(true)
      expect(mockIssuesCreate).not.toHaveBeenCalled()
      expect(mockIssuesCreateComment).toHaveBeenCalled()
    })

    test('should return null when GitHub API fails', async () => {
      const userId = 'test-user-123'
      const device: Device = {
        deviceId: 'device-123',
        name: 'iPhone',
        systemName: 'iOS',
        systemVersion: '17.0',
        token: 'device-token',
        endpointArn: 'arn:aws:sns:us-west-2:123456789012:endpoint/APNS/test/abc123'
      }
      const error = new Error('DynamoDB deletion failed')
      const requestId = 'req-123'

      mockIssuesCreate.mockRejectedValue(new Error('GitHub API rate limit exceeded'))

      const response = await createFailedUserDeletionIssue(userId, [device], error, requestId)

      expect(response).toBeNull()
    })
  })

  describe('#createVideoDownloadFailureIssue', () => {
    test('should create GitHub issue for video download failure', async () => {
      const fileId = 'video-123'
      const fileUrl = 'https://www.youtube.com/watch?v=test123'
      const error = new Error('yt-dlp extraction failed')
      const errorDetails = 'Video unavailable: Removed by uploader'

      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 5678, number: 43, html_url: 'https://github.com/owner/repo/issues/43'}})

      const response = await createVideoDownloadFailureIssue(fileId, fileUrl, error, errorDetails)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(43)
      expect(response?.issueUrl).toEqual('https://github.com/owner/repo/issues/43')
      expect(response?.isDuplicate).toBe(false)
      expect(mockIssuesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'j0nathan-ll0yd',
          repo: 'mantle-OfflineMediaDownloader',
          title: `Video Download Failed: ${fileId}`,
          body: expect.stringContaining('Rendered template: video-download-failure'),
          labels: expect.arrayContaining(['bug', 'video-download', 'automated'])
        })
      )
    })

    test('should create GitHub issue without error details', async () => {
      const fileId = 'video-456'
      const fileUrl = 'https://www.youtube.com/watch?v=test456'
      const error = new Error('Network timeout')

      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 9012, number: 44, html_url: 'https://github.com/owner/repo/issues/44'}})

      const response = await createVideoDownloadFailureIssue(fileId, fileUrl, error)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(44)
      expect(response?.isDuplicate).toBe(false)
    })

    test('should add comment to existing issue if duplicate', async () => {
      const fileId = 'video-123'
      const fileUrl = 'https://www.youtube.com/watch?v=test123'
      const error = new Error('yt-dlp extraction failed')

      // Mock existing issue found
      mockIssuesListForRepo.mockResolvedValue({data: [{number: 88, title: 'Existing issue', labels: []}]})
      mockIssuesCreateComment.mockResolvedValue({data: {id: 456}})

      const response = await createVideoDownloadFailureIssue(fileId, fileUrl, error)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(88)
      expect(response?.isDuplicate).toBe(true)
      expect(mockIssuesCreate).not.toHaveBeenCalled()
    })

    test('should return null when GitHub API fails', async () => {
      const fileId = 'video-123'
      const fileUrl = 'https://www.youtube.com/watch?v=test123'
      const error = new Error('yt-dlp extraction failed')

      mockIssuesCreate.mockRejectedValue(new Error('Network error'))

      const response = await createVideoDownloadFailureIssue(fileId, fileUrl, error)

      expect(response).toBeNull()
    })
  })

  describe('#createCookieExpirationIssue', () => {
    test('should create GitHub issue for cookie expiration', async () => {
      const fileId = 'video-789'
      const fileUrl = 'https://www.youtube.com/watch?v=test789'
      const error = new Error('Sign in to confirm you are not a bot')

      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 3456, number: 45, html_url: 'https://github.com/owner/repo/issues/45'}})

      const response = await createCookieExpirationIssue(fileId, fileUrl, error)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(45)
      expect(response?.issueUrl).toEqual('https://github.com/owner/repo/issues/45')
      expect(response?.isDuplicate).toBe(false)
      expect(mockIssuesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'j0nathan-ll0yd',
          repo: 'mantle-OfflineMediaDownloader',
          title: '🍪 YouTube Cookie Expiration Detected',
          body: expect.stringContaining('Rendered template: cookie-expiration'),
          labels: expect.arrayContaining(['cookie-expiration', 'requires-manual-fix', 'automated', 'priority'])
        })
      )
    })

    test('should add comment to existing cookie issue if duplicate', async () => {
      const fileId = 'video-789'
      const fileUrl = 'https://www.youtube.com/watch?v=test789'
      const error = new Error('Sign in to confirm you are not a bot')

      // Mock existing issue found
      mockIssuesListForRepo.mockResolvedValue({data: [{number: 77, title: 'Cookie issue', labels: []}]})
      mockIssuesCreateComment.mockResolvedValue({data: {id: 789}})

      const response = await createCookieExpirationIssue(fileId, fileUrl, error)

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(77)
      expect(response?.isDuplicate).toBe(true)
      expect(mockIssuesCreate).not.toHaveBeenCalled()
    })

    test('should return null when GitHub API fails', async () => {
      const fileId = 'video-789'
      const fileUrl = 'https://www.youtube.com/watch?v=test789'
      const error = new Error('Sign in to confirm you are not a bot')

      mockIssuesCreate.mockRejectedValue(new Error('GitHub API error'))

      const response = await createCookieExpirationIssue(fileId, fileUrl, error)

      expect(response).toBeNull()
    })
  })

  describe('#closeCookieExpirationIssueIfResolved', () => {
    test('should close existing cookie issue and add comment', async () => {
      mockIssuesListForRepo.mockResolvedValue({data: [{number: 55, title: 'Cookie issue', labels: []}]})
      mockIssuesCreateComment.mockResolvedValue({data: {id: 999}})
      mockIssuesUpdate.mockResolvedValue({data: {number: 55}})

      await closeCookieExpirationIssueIfResolved()

      expect(mockIssuesCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({issue_number: 55, body: expect.stringContaining('Automatically Resolved')})
      )
      expect(mockIssuesUpdate).toHaveBeenCalledWith(expect.objectContaining({issue_number: 55, state: 'closed'}))
    })

    test('should do nothing when no existing cookie issue found', async () => {
      mockIssuesListForRepo.mockResolvedValue({data: []})

      await closeCookieExpirationIssueIfResolved()

      expect(mockIssuesCreateComment).not.toHaveBeenCalled()
      expect(mockIssuesUpdate).not.toHaveBeenCalled()
    })

    test('should not throw when GitHub API fails', async () => {
      mockIssuesListForRepo.mockRejectedValue(new Error('API down'))

      await expect(closeCookieExpirationIssueIfResolved()).resolves.toBeUndefined()
    })
  })

  describe('#createFailedUserDeletionIssue edge cases', () => {
    test('should create issue with empty devices array', async () => {
      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 1, number: 50, html_url: 'https://github.com/owner/repo/issues/50'}})

      const response = await createFailedUserDeletionIssue('user-empty', [], new Error('Cascade failed'), 'req-456')

      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(50)
      expect(response?.isDuplicate).toBe(false)
    })

    test('should handle error with no stack trace', async () => {
      const error = new Error('No stack')
      error.stack = undefined
      mockIssuesCreate.mockResolvedValue({status: 201, data: {id: 2, number: 51, html_url: 'https://github.com/owner/repo/issues/51'}})

      const response = await createFailedUserDeletionIssue('user-nostack', [], error, 'req-789')

      expect(response).not.toBeNull()
      expect(mockRenderGithubIssueTemplate).toHaveBeenCalledWith('user-deletion-failure', expect.objectContaining({errorStack: 'No stack trace available'}))
    })

    test('should handle comment failure on duplicate gracefully', async () => {
      mockIssuesListForRepo.mockResolvedValue({data: [{number: 60, title: 'Existing', labels: []}]})
      mockIssuesCreateComment.mockRejectedValue(new Error('Comment API error'))

      const response = await createFailedUserDeletionIssue('user-1', [], new Error('fail'), 'req-1')

      // Should still return the duplicate result even if comment fails
      expect(response).not.toBeNull()
      expect(response?.issueNumber).toEqual(60)
      expect(response?.isDuplicate).toBe(true)
    })
  })
})
