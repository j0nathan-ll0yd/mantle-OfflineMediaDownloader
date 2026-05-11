/**
 * S3ObjectCreated Lambda
 *
 * Handles S3 object creation events when videos are uploaded.
 * Updates file records and queues push notifications for users.
 *
 * Trigger: S3 Event (s3:ObjectCreated)
 * Input: S3Event with object creation records
 * Output: void (processes all records, logs errors)
 */
import {sendMessage} from '@mantleframework/aws'
import {defineLambda, defineS3Handler} from '@mantleframework/core'
import {SqsQueueUrl} from '@mantleframework/core'
import {getRequiredEnv} from '@mantleframework/env'
import {NotFoundError} from '@mantleframework/errors'
import {addAnnotation, addMetadata, endSpan, logDebug, logError, logInfo, metrics, MetricUnit, startSpan} from '@mantleframework/observability'
defineLambda({deadLetterQueue: true, bind: {SNS_QUEUE_URL: 'SendPushNotification'}})
import {getFilesByKey, getUserFilesByFileId} from '#entities/queries'
import {createDownloadReadyNotification} from '#services/notification/transformers'
import type {File} from '#types/domainModels'

/** Get file by S3 object key */
async function getFileByFilename(fileName: string): Promise<File> {
  logDebug('query file by key <=', {fileName})
  const files = await getFilesByKey(fileName)
  logDebug('query file by key =>', {count: files.length})
  if (files.length > 0) {
    return files[0] as File
  } else {
    throw new NotFoundError('Unable to locate file')
  }
}

/** Get user IDs who have requested a given file */
async function getUsersOfFile(file: File): Promise<string[]> {
  logDebug('query users by fileId <=', {fileId: file.fileId})
  const userFiles = await getUserFilesByFileId(file.fileId)
  logDebug('query users by fileId =>', {count: userFiles.length})
  return userFiles.map((userFile) => userFile.userId)
}

/** Dispatches DownloadReadyNotification to a user via SQS */
function dispatchFileNotificationToUser(file: File, userId: string) {
  const {messageBody, messageAttributes} = createDownloadReadyNotification(file, userId)
  const sendMessageParams = {MessageBody: messageBody, MessageAttributes: messageAttributes, QueueUrl: SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))}
  logDebug('sendMessage <=', sendMessageParams)
  return sendMessage(sendMessageParams)
}

/** Log results of notification dispatch and emit metrics */
function logDispatchResults(results: PromiseSettledResult<unknown>[], userIds: string[], fileId: string): {succeeded: number; failed: number} {
  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failedResults = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

  if (failedResults.length > 0) {
    failedResults.forEach((failure) => {
      const userId = userIds[results.indexOf(failure)]
      logError('Failed to dispatch notification', {fileId, userId, error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason)})
    })
    logInfo('S3ObjectCreated completed with partial failures', {fileId, totalUsers: userIds.length, succeeded, failed: failedResults.length})
  } else {
    logInfo('All notifications dispatched successfully', {fileId, userCount: userIds.length})
  }

  return {succeeded, failed: failedResults.length}
}

const s3 = defineS3Handler({operationName: 'S3ObjectCreated', trigger: 'direct', bucket: 'files'})

export const handler = s3(async (record) => {
  const fileName = record.key
  const span = startSpan('s3-event-process')
  addAnnotation(span, 's3Key', fileName)

  try {
    const file = await getFileByFilename(fileName)
    addAnnotation(span, 'fileId', file.fileId)
    const userIds = await getUsersOfFile(file)
    addMetadata(span, 'userCount', userIds.length)

    if (userIds.length === 0) {
      logInfo('No users to notify for file', {fileId: file.fileId, fileName})
      endSpan(span)
      return
    }

    const results = await Promise.allSettled(userIds.map((userId) => dispatchFileNotificationToUser(file, userId)))
    const {succeeded, failed} = logDispatchResults(results, userIds, file.fileId)

    metrics.addMetric('NotificationsSent', MetricUnit.Count, succeeded)
    addMetadata(span, 'notificationsSent', succeeded)
    addMetadata(span, 'notificationsFailed', failed)

    if (failed > 0) {
      metrics.addMetric('NotificationsFailed', MetricUnit.Count, failed)
    }
    endSpan(span)
  } catch (error) {
    endSpan(span, error as Error)
    throw error
  }
})
