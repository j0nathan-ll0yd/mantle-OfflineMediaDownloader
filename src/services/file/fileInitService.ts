/**
 * File Initialization Service
 *
 * Creates initial file and download tracking records for new webhook requests.
 * Also provides file lookup, transformation, and notification dispatch for existing files.
 */
import {sendMessage} from '@j0nathan-ll0yd/aws'
import {logDebug} from '@j0nathan-ll0yd/observability'
import {SqsQueueUrl} from '@j0nathan-ll0yd/core'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {createFile, createFileDownload, getFile as getFileRecord, getFilesForUser} from '#entities/queries'
import {createDownloadReadyNotification} from '#services/notification/transformers'
import type {File} from '#types/domainModels'
import {DownloadStatus, FileStatus} from '#types/enums'

/**
 * Create placeholder file and download tracking records for a new video.
 * File record will be updated with real metadata on successful download.
 *
 * @param fileId - The video ID
 * @param sourceUrl - The original video URL
 * @param correlationId - Correlation ID for tracing
 */
export async function addFile(fileId: string, sourceUrl?: string, correlationId?: string): Promise<void> {
  logDebug('addFile', {fileId, sourceUrl, correlationId})

  await createFile({
    fileId,
    size: 0,
    status: FileStatus.Queued,
    authorName: '',
    authorUser: '',
    publishDate: new Date().toISOString(),
    description: '',
    key: fileId,
    contentType: '',
    title: ''
  })
  logDebug('addFile createFile completed', {fileId})

  await createFileDownload({fileId, status: DownloadStatus.Pending, sourceUrl, correlationId})
  logDebug('addFile createFileDownload completed', {fileId})
}

/**
 * Get file by ID, returning undefined if not found.
 *
 * @param fileId - The file ID to look up
 * @returns The file record or undefined
 */
export async function getFile(fileId: string): Promise<File | undefined> {
  logDebug('getFile', {fileId})
  const file = await getFileRecord(fileId)
  logDebug('getFile result', {fileId, found: !!file})
  return file as File | undefined
}

/**
 * Send a DownloadReadyNotification to a user via SQS.
 *
 * @param file - The file that is ready to download
 * @param userId - The user ID to notify
 */
export async function sendFileNotification(file: File, userId: string) {
  const {messageBody, messageAttributes} = createDownloadReadyNotification(file, userId)
  const sendMessageParams = {MessageBody: messageBody, MessageAttributes: messageAttributes, QueueUrl: SqsQueueUrl(getRequiredEnv('SNS_QUEUE_URL'))}
  logDebug('sendMessage', {queueUrl: sendMessageParams.QueueUrl})
  const sendMessageResponse = await sendMessage(sendMessageParams)
  logDebug('sendMessage completed', {messageId: sendMessageResponse?.MessageId})
  return sendMessageResponse
}

/**
 * Transform database row to domain File type.
 * Converts null values to undefined for API response compatibility.
 */
export function toFile(row: Awaited<ReturnType<typeof getFilesForUser>>[0]): File {
  return {
    fileId: row.fileId,
    size: row.size,
    authorName: row.authorName,
    authorUser: row.authorUser,
    publishDate: row.publishDate,
    description: row.description,
    key: row.key,
    contentType: row.contentType,
    title: row.title,
    status: row.status as File['status'],
    url: row.url ?? undefined,
    duration: row.duration ?? undefined,
    uploadDate: row.uploadDate ?? undefined,
    viewCount: row.viewCount ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined
  }
}

/** Get files for a user, transformed to domain model */
export async function getFilesByUser(userId: string): Promise<File[]> {
  logDebug('getFilesByUser <=', {userId})
  const rows = await getFilesForUser(userId)
  const files = rows.map(toFile)
  logDebug('getFilesByUser =>', {count: files.length})
  return files
}
