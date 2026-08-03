/**
 * Download State Manager
 *
 * Manages FileDownload entity state transitions during the download lifecycle.
 * Tracks retry attempts, error classifications, and scheduling state.
 */
import {createFileDownload, getFileDownload, updateFileDownload} from '#entities/queries'
import {logDebug} from '@j0nathan-ll0yd/observability'
import {DownloadStatus} from '#types/enums'
import type {VideoErrorClassification} from '#types/video'

/**
 * Update FileDownload entity with current download state.
 * Creates a new record if one doesn't exist, otherwise updates the existing record.
 * Cleanup handled by CleanupExpiredRecords scheduled Lambda.
 *
 * @param fileId - The file ID to update state for
 * @param status - The new download status
 * @param classification - Optional error classification with retry metadata
 * @param retryCount - Current retry count (default 0)
 */
export async function updateDownloadState(fileId: string, status: DownloadStatus, classification?: VideoErrorClassification, retryCount = 0): Promise<void> {
  const update: Record<string, unknown> = {status, retryCount}
  if (classification) {
    update.errorCategory = classification.category
    update.lastError = classification.reason
    update.maxRetries = classification.maxRetries ?? 5
    if (classification.retryAfter) {
      update.retryAfter = new Date(classification.retryAfter * 1000)
    }
  }

  const existing = await getFileDownload(fileId)

  if (existing) {
    logDebug('updateFileDownload <=', {fileId, update})
    const result = await updateFileDownload(fileId, update)
    logDebug('updateFileDownload =>', result)
  } else {
    const createData = {
      fileId,
      status,
      retryCount,
      maxRetries: classification?.maxRetries ?? 5,
      errorCategory: classification?.category,
      lastError: classification?.reason,
      retryAfter: classification?.retryAfter ? new Date(classification.retryAfter * 1000) : null,
      sourceUrl: `https://www.youtube.com/watch?v=${fileId}`
    }
    logDebug('createFileDownload <=', createData)
    const result = await createFileDownload(createData)
    logDebug('createFileDownload =>', result)
  }
}
