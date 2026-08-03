/**
 * Application-Layer Foreign Key Enforcement for Aurora DSQL
 *
 * Aurora DSQL accepts foreign key syntax but does NOT enforce it.
 * This module provides utilities to check referential integrity at the application layer.
 *
 * Usage pattern:
 * 1. Call assertXxxExists() before inserting child records
 * 2. Wrap in transactions for atomicity
 *
 * @see https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html
 */
import {eq} from '@j0nathan-ll0yd/database/orm'
import {ForeignKeyViolationError} from '@j0nathan-ll0yd/errors'
import {getDrizzleClient} from './client.js'
import {devices, files, users} from './schema.js'

export { ForeignKeyViolationError }

/**
 * Asserts that a user exists in the database.
 * Call this before inserting records that reference userId.
 *
 * @param userId - The user ID to check
 * @throws ForeignKeyViolationError if user does not exist
 */
export async function assertUserExists(userId: string): Promise<void> {
  const db = await getDrizzleClient()
  const result = await db.select({id: users.id}).from(users).where(eq(users.id, userId)).limit(1)
  if (result.length === 0) {
    throw new ForeignKeyViolationError('users', 'id', userId)
  }
}

/**
 * Asserts that a file exists in the database.
 * Call this before inserting records that reference fileId.
 *
 * @param fileId - The file ID to check
 * @throws ForeignKeyViolationError if file does not exist
 */
export async function assertFileExists(fileId: string): Promise<void> {
  const db = await getDrizzleClient()
  const result = await db.select({fileId: files.fileId}).from(files).where(eq(files.fileId, fileId)).limit(1)
  if (result.length === 0) {
    throw new ForeignKeyViolationError('files', 'fileId', fileId)
  }
}

/**
 * Asserts that a device exists in the database.
 * Call this before inserting records that reference deviceId.
 *
 * @param deviceId - The device ID to check
 * @throws ForeignKeyViolationError if device does not exist
 */
export async function assertDeviceExists(deviceId: string): Promise<void> {
  const db = await getDrizzleClient()
  const result = await db.select({deviceId: devices.deviceId}).from(devices).where(eq(devices.deviceId, deviceId)).limit(1)
  if (result.length === 0) {
    throw new ForeignKeyViolationError('devices', 'deviceId', deviceId)
  }
}

/**
 * Asserts that multiple users exist in the database.
 * More efficient than calling assertUserExists in a loop.
 *
 * @param userIds - Array of user IDs to check
 * @throws ForeignKeyViolationError if any user does not exist
 */
export async function assertUsersExist(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return
  }

  const db = await getDrizzleClient()
  const {inArray} = await import('@j0nathan-ll0yd/database/orm')
  const result = await db.select({id: users.id}).from(users).where(inArray(users.id, userIds))

  const foundIds = new Set(result.map((r) => r.id))
  for (const userId of userIds) {
    if (!foundIds.has(userId)) {
      throw new ForeignKeyViolationError('users', 'id', userId)
    }
  }
}

/**
 * Asserts that multiple files exist in the database.
 * More efficient than calling assertFileExists in a loop.
 *
 * @param fileIds - Array of file IDs to check
 * @throws ForeignKeyViolationError if any file does not exist
 */
export async function assertFilesExist(fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) {
    return
  }

  const db = await getDrizzleClient()
  const {inArray} = await import('@j0nathan-ll0yd/database/orm')
  const result = await db.select({fileId: files.fileId}).from(files).where(inArray(files.fileId, fileIds))

  const foundIds = new Set(result.map((r) => r.fileId))
  for (const fileId of fileIds) {
    if (!foundIds.has(fileId)) {
      throw new ForeignKeyViolationError('files', 'fileId', fileId)
    }
  }
}
