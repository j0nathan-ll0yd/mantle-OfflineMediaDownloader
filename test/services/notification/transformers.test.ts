import {describe, expect, test, vi} from 'vitest'
import type {File} from '#types/domainModels'
import type {YtDlpVideoInfo} from '#types/youtube'
import {FileStatus} from '#types/enums'

// Mock SQS stringAttribute
vi.mock('@j0nathan-ll0yd/aws', () => ({stringAttribute: vi.fn((value: string) => ({DataType: 'String', StringValue: value}))}))

const {
  truncateDescription,
  createMetadataNotification,
  createDownloadStartedNotification,
  createDownloadReadyNotification,
  createFailureNotification,
  transformToAPNSNotification,
  transformToAPNSAlertNotification
} = await import('#services/notification/transformers.js')

describe('Notification Transformers', () => {
  describe('truncateDescription', () => {
    test('should return empty string for null/undefined input', () => {
      expect(truncateDescription(null as unknown as string)).toEqual('')
      expect(truncateDescription(undefined as unknown as string)).toEqual('')
      expect(truncateDescription('')).toEqual('')
    })

    test('should return original string if under MAX_DESCRIPTION_LENGTH', () => {
      const shortDescription = 'This is a short description'
      expect(truncateDescription(shortDescription)).toEqual(shortDescription)
    })

    test('should truncate long descriptions to MAX_DESCRIPTION_LENGTH with ellipsis', () => {
      const longDescription = 'A'.repeat(600) // 600 characters
      const result = truncateDescription(longDescription)
      expect(result.length).toEqual(500)
      expect(result.endsWith('...')).toBe(true)
    })

    test('should handle description exactly at MAX_DESCRIPTION_LENGTH', () => {
      const exactDescription = 'A'.repeat(500)
      expect(truncateDescription(exactDescription)).toEqual(exactDescription)
    })
  })

  describe('createMetadataNotification', () => {
    const mockVideoInfo: YtDlpVideoInfo = {
      id: 'test-video-id',
      title: 'Test Video Title',
      uploader: 'Test Uploader',
      description: 'Test description',
      upload_date: '20231201',
      thumbnail: 'https://example.com/thumb.jpg',
      duration: 300,
      formats: []
    }

    test('should create metadata notification with correct structure', () => {
      const result = createMetadataNotification('test-video-id', mockVideoInfo, 'user-123')
      const body = JSON.parse(result.messageBody)

      expect(body.notificationType).toEqual('MetadataNotification')
      expect(body.file.fileId).toEqual('test-video-id')
      expect(body.file.key).toEqual('test-video-id.mp4')
      expect(body.file.title).toEqual('Test Video Title')
      expect(body.file.authorName).toEqual('Test Uploader')
      expect(body.file.description).toEqual('Test description')
      expect(body.file.contentType).toEqual('video/mp4')
      expect(body.file.status).toEqual('pending')
    })

    test('should normalize authorUser to lowercase with underscores', () => {
      const videoInfo = {...mockVideoInfo, uploader: 'Philip DeFranco'}
      const result = createMetadataNotification('vid-1', videoInfo, 'user-1')
      const body = JSON.parse(result.messageBody)
      expect(body.file.authorUser).toEqual('philip_defranco')
    })

    test('should handle missing optional fields gracefully', () => {
      const minimalVideoInfo: YtDlpVideoInfo = {id: 'test-id', title: '', formats: [], duration: 0, thumbnail: ''}
      const result = createMetadataNotification('test-id', minimalVideoInfo, 'user-1')
      const body = JSON.parse(result.messageBody)

      expect(body.file.title).toEqual('')
      expect(body.file.authorName).toEqual('Unknown')
      expect(body.file.authorUser).toEqual('unknown')
      expect(body.file.description).toEqual('')
    })

    test('should set correct message attributes', () => {
      const result = createMetadataNotification('vid-1', mockVideoInfo, 'user-123')
      expect(result.messageAttributes.userId).toEqual({DataType: 'String', StringValue: 'user-123'})
      expect(result.messageAttributes.notificationType).toEqual({DataType: 'String', StringValue: 'MetadataNotification'})
    })
  })

  describe('createDownloadReadyNotification', () => {
    const mockFile: File = {
      fileId: 'file-123',
      key: 'file-123.mp4',
      size: 50000000,
      url: 'https://cdn.example.com/file-123.mp4',
      status: FileStatus.Downloaded,
      title: 'Test File',
      authorName: 'Test Author',
      authorUser: 'test_author',
      publishDate: '2023-12-01',
      description: 'Test description',
      contentType: 'video/mp4'
    }

    test('should create download ready notification with correct structure', () => {
      const result = createDownloadReadyNotification(mockFile, 'user-456')
      const body = JSON.parse(result.messageBody)

      expect(body.notificationType).toEqual('DownloadReadyNotification')
      expect(body.file.fileId).toEqual('file-123')
      expect(body.file.key).toEqual('file-123.mp4')
      expect(body.file.size).toEqual(50000000)
      expect(body.file.url).toEqual('https://cdn.example.com/file-123.mp4')
    })

    test('should set correct message attributes', () => {
      const result = createDownloadReadyNotification(mockFile, 'user-456')
      expect(result.messageAttributes.userId).toEqual({DataType: 'String', StringValue: 'user-456'})
      expect(result.messageAttributes.notificationType).toEqual({DataType: 'String', StringValue: 'DownloadReadyNotification'})
    })
  })

  describe('transformToAPNSNotification', () => {
    test('should transform SQS message to APNS format', () => {
      const sqsMessageBody = JSON.stringify({file: {fileId: 'file-1', key: 'file-1.mp4'}, notificationType: 'DownloadReadyNotification'})
      const targetArn = 'arn:aws:sns:us-west-2:123456789:endpoint/APNS_SANDBOX/app/device-token'

      const result = transformToAPNSNotification(sqsMessageBody, targetArn)

      expect(result.TargetArn).toEqual(targetArn)
      expect(result.MessageStructure).toEqual('json')

      // Verify APNS message structure
      const message = JSON.parse(result.Message!)
      const apnsPayload = JSON.parse(message.APNS_SANDBOX)
      expect(apnsPayload.aps['content-available']).toEqual(1)
      expect(apnsPayload.notificationType).toEqual('DownloadReadyNotification')
      expect(apnsPayload.file.fileId).toEqual('file-1')
    })

    test('should set correct APNS message attributes for background push', () => {
      const sqsMessageBody = JSON.stringify({file: {}, notificationType: 'MetadataNotification'})

      const result = transformToAPNSNotification(sqsMessageBody, 'arn:test')

      expect(result.MessageAttributes).toEqual({
        'AWS.SNS.MOBILE.APNS.PRIORITY': {DataType: 'String', StringValue: '5'},
        'AWS.SNS.MOBILE.APNS.PUSH_TYPE': {DataType: 'String', StringValue: 'background'}
      })
    })

    test('should include default message for non-APNS platforms', () => {
      const sqsMessageBody = JSON.stringify({file: {}, notificationType: 'Test'})

      const result = transformToAPNSNotification(sqsMessageBody, 'arn:test')

      const message = JSON.parse(result.Message!)
      expect(message.default).toEqual('Default message')
    })
  })

  describe('createDownloadStartedNotification', () => {
    const mockVideoInfo: YtDlpVideoInfo = {
      id: 'start-vid',
      title: 'Starting Download',
      uploader: 'Test Channel',
      description: 'Test',
      upload_date: '20240101',
      thumbnail: 'https://example.com/thumb.jpg',
      duration: 120,
      formats: []
    }

    test('should create download started notification with correct structure', () => {
      const result = createDownloadStartedNotification('start-vid', mockVideoInfo, 'user-1')
      const body = JSON.parse(result.messageBody)

      expect(body.notificationType).toEqual('DownloadStartedNotification')
      expect(body.file.fileId).toEqual('start-vid')
      expect(body.file.title).toEqual('Starting Download')
      expect(body.file.thumbnailUrl).toEqual('https://example.com/thumb.jpg')
    })

    test('should handle missing title gracefully', () => {
      const videoInfo: YtDlpVideoInfo = {id: 'vid-2', title: '', formats: [], duration: 0, thumbnail: ''}
      const result = createDownloadStartedNotification('vid-2', videoInfo, 'user-1')
      const body = JSON.parse(result.messageBody)

      expect(body.file.title).toEqual('')
    })

    test('should set correct message attributes', () => {
      const result = createDownloadStartedNotification('start-vid', mockVideoInfo, 'user-99')

      expect(result.messageAttributes.userId).toEqual({DataType: 'String', StringValue: 'user-99'})
      expect(result.messageAttributes.notificationType).toEqual({DataType: 'String', StringValue: 'DownloadStartedNotification'})
    })
  })

  describe('createFailureNotification', () => {
    test('should create failure notification with all fields', () => {
      const result = createFailureNotification('fail-1', 'permanent', 'Video unavailable', true, 'user-1', 'My Video')
      const body = JSON.parse(result.messageBody)

      expect(body.notificationType).toEqual('FailureNotification')
      expect(body.file.fileId).toEqual('fail-1')
      expect(body.file.title).toEqual('My Video')
      expect(body.file.errorCategory).toEqual('permanent')
      expect(body.file.errorMessage).toEqual('Video unavailable')
      expect(body.file.retryExhausted).toBe(true)
    })

    test('should handle missing title', () => {
      const result = createFailureNotification('fail-2', 'cookie_expired', 'Auth failed', false, 'user-1')
      const body = JSON.parse(result.messageBody)

      expect(body.file.title).toBeUndefined()
      expect(body.file.retryExhausted).toBe(false)
    })

    test('should set correct message attributes', () => {
      const result = createFailureNotification('fail-3', 'rate_limited', 'Too many requests', false, 'user-42')

      expect(result.messageAttributes.userId).toEqual({DataType: 'String', StringValue: 'user-42'})
      expect(result.messageAttributes.notificationType).toEqual({DataType: 'String', StringValue: 'FailureNotification'})
    })
  })

  describe('transformToAPNSAlertNotification', () => {
    test('should transform failure to APNS alert format', () => {
      const sqsMessageBody = JSON.stringify({
        file: {fileId: 'vid-1', title: 'Test Video', errorCategory: 'permanent', errorMessage: 'Video removed', retryExhausted: true},
        notificationType: 'FailureNotification'
      })
      const targetArn = 'arn:aws:sns:us-west-2:123456789:endpoint/APNS_SANDBOX/app/token'

      const result = transformToAPNSAlertNotification(sqsMessageBody, targetArn)

      expect(result.TargetArn).toEqual(targetArn)
      expect(result.MessageStructure).toEqual('json')

      const message = JSON.parse(result.Message)
      const apnsPayload = JSON.parse(message.APNS_SANDBOX)
      expect(apnsPayload.aps.alert.title).toEqual('Download Failed')
      expect(apnsPayload.aps.alert.subtitle).toEqual('Test Video')
      expect(apnsPayload.aps.alert.body).toContain('Failed after multiple attempts')
      expect(apnsPayload.aps.sound).toEqual('default')
    })

    test('should use fileId as subtitle when title is missing', () => {
      const sqsMessageBody = JSON.stringify({
        file: {fileId: 'vid-2', errorCategory: 'cookie_expired', errorMessage: 'Auth failed', retryExhausted: false},
        notificationType: 'FailureNotification'
      })

      const result = transformToAPNSAlertNotification(sqsMessageBody, 'arn:test')

      const message = JSON.parse(result.Message)
      const apnsPayload = JSON.parse(message.APNS_SANDBOX)
      expect(apnsPayload.aps.alert.subtitle).toEqual('vid-2')
    })

    test('should show different message when retry not exhausted', () => {
      const sqsMessageBody = JSON.stringify({
        file: {fileId: 'vid-3', title: 'Some Video', errorCategory: 'rate_limited', errorMessage: 'Too many requests', retryExhausted: false},
        notificationType: 'FailureNotification'
      })

      const result = transformToAPNSAlertNotification(sqsMessageBody, 'arn:test')

      const message = JSON.parse(result.Message)
      const apnsPayload = JSON.parse(message.APNS_SANDBOX)
      expect(apnsPayload.aps.alert.body).toContain('Unable to download')
      expect(apnsPayload.aps.alert.body).not.toContain('Failed after multiple attempts')
    })

    test('should set priority 10 and alert push type', () => {
      const sqsMessageBody = JSON.stringify({file: {fileId: 'vid-4', errorMessage: 'Error', retryExhausted: false}, notificationType: 'FailureNotification'})

      const result = transformToAPNSAlertNotification(sqsMessageBody, 'arn:test')

      expect(result.MessageAttributes).toEqual({
        'AWS.SNS.MOBILE.APNS.PRIORITY': {DataType: 'String', StringValue: '10'},
        'AWS.SNS.MOBILE.APNS.PUSH_TYPE': {DataType: 'String', StringValue: 'alert'}
      })
    })

    test('should include file payload in APNS message', () => {
      const file = {fileId: 'vid-5', title: 'A Video', errorCategory: 'permanent', errorMessage: 'Gone', retryExhausted: true}
      const sqsMessageBody = JSON.stringify({file, notificationType: 'FailureNotification'})

      const result = transformToAPNSAlertNotification(sqsMessageBody, 'arn:test')

      const message = JSON.parse(result.Message)
      const apnsPayload = JSON.parse(message.APNS_SANDBOX)
      expect(apnsPayload.file).toEqual(file)
      expect(apnsPayload.notificationType).toEqual('FailureNotification')
    })
  })
})
