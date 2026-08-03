/**
 * User-File Helper Functions
 *
 * Shared utilities for managing user-file relationships across multiple Lambda functions.
 * Handles file associations, ownership, and sharing operations.
 */
import {upsertUserFile} from '#entities/queries'
import {logDebug} from '@j0nathan-ll0yd/observability'

/**
 * Associates a File to a User by creating a UserFile record.
 * Idempotent - uses upsert to handle existing associations atomically.
 * @param fileId - The unique file identifier
 * @param userId - The UUID of the user
 */
export async function associateFileToUser(fileId: string, userId: string) {
  logDebug('associateFileToUser <=', {fileId, userId})
  const response = await upsertUserFile({userId, fileId})
  logDebug('associateFileToUser =>', response)
  return response
}
