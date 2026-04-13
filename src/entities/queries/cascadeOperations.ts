/**
 * Cascade Operations - Transaction-wrapped multi-entity operations.
 * All operations are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 *
 * These operations ensure atomicity when modifying related entities.
 * Aurora DSQL doesn't enforce foreign keys, so we must delete children
 * before parents to maintain referential integrity.
 *
 * Cascade order (children before parents):
 * 1. UserFiles, UserDevices (junction tables)
 * 2. Sessions, Accounts (auth tables)
 * 3. Users (parent)
 *
 * @see docs/wiki/TypeScript/Entity-Query-Patterns.md for usage examples
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@mantleframework/database'
import {and, eq} from '@mantleframework/database/orm'
import {defineQuery} from '#db/defineQuery'
import {accounts, fileDownloads, files, sessions, userDevices, userFiles, users} from '#db/schema'

/**
 * Deletes a user and ALL related records atomically.
 * Children are deleted before parent to maintain referential integrity.
 *
 * Note: This does NOT delete Devices - devices may be shared across users.
 * Use deleteUserWithDevices() if you need to delete orphaned devices.
 *
 * @param userId - The user's unique identifier
 */
export const deleteUserCascade = defineQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Delete]},
    {table: userDevices, operations: [DatabaseOperation.Delete]},
    {table: sessions, operations: [DatabaseOperation.Delete]},
    {table: accounts, operations: [DatabaseOperation.Delete]},
    {table: users, operations: [DatabaseOperation.Delete]}
  ],
  transaction: true
}, async function deleteUserCascade(tx, userId: string): Promise<void> {
  // 1. Delete junction tables first (children)
  await tx.delete(userFiles).where(eq(userFiles.userId, userId))
  await tx.delete(userDevices).where(eq(userDevices.userId, userId))
  // 2. Delete auth tables
  await tx.delete(sessions).where(eq(sessions.userId, userId))
  await tx.delete(accounts).where(eq(accounts.userId, userId))
  // 3. Delete user last (parent)
  await tx.delete(users).where(eq(users.id, userId))
})

/**
 * Deletes all relationships for a user atomically.
 * Use this for partial cleanup (e.g., before re-associating).
 *
 * @param userId - The user's unique identifier
 */
export const deleteUserRelationships = defineQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Delete]},
    {table: userDevices, operations: [DatabaseOperation.Delete]}
  ],
  transaction: true
}, async function deleteUserRelationships(tx, userId: string): Promise<void> {
  await tx.delete(userFiles).where(eq(userFiles.userId, userId))
  await tx.delete(userDevices).where(eq(userDevices.userId, userId))
})

/**
 * Deletes all auth records for a user atomically.
 * Use this for session invalidation (e.g., logout all devices).
 *
 * @param userId - The user's unique identifier
 */
export const deleteUserAuthRecords = defineQuery({
  tables: [
    {table: sessions, operations: [DatabaseOperation.Delete]},
    {table: accounts, operations: [DatabaseOperation.Delete]}
  ],
  transaction: true
}, async function deleteUserAuthRecords(tx, userId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId))
  await tx.delete(accounts).where(eq(accounts.userId, userId))
})

/**
 * Deletes a user's link to a file, and if no other users are linked,
 * removes the file and download records atomically.
 *
 * S3 cleanup happens outside this transaction (caller's responsibility).
 *
 * @param userId - The user's unique identifier
 * @param fileId - The file's unique identifier
 * @returns Object indicating if the user-file link existed and if the file was orphaned
 */
export const deleteFileCascade = defineQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]},
    {table: files, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]},
    {table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}
  ],
  transaction: true
}, async function deleteFileCascade(tx, userId: string, fileId: string): Promise<{existed: boolean; fileRemoved: boolean}> {
  // 1. Check if the user-file link exists
  const [existing] = await tx.select().from(userFiles).where(and(eq(userFiles.userId, userId), eq(userFiles.fileId, fileId))).limit(1)
  if (!existing) {
    return {existed: false, fileRemoved: false}
  }

  // 2. Delete the user-file link
  await tx.delete(userFiles).where(and(eq(userFiles.userId, userId), eq(userFiles.fileId, fileId)))

  // 3. Count remaining links
  const remaining = await tx.select().from(userFiles).where(eq(userFiles.fileId, fileId))
  if (remaining.length > 0) {
    return {existed: true, fileRemoved: false}
  }

  // 4. No remaining links — orphaned file, clean up DB records
  await tx.delete(fileDownloads).where(eq(fileDownloads.fileId, fileId))
  await tx.delete(files).where(eq(files.fileId, fileId))

  return {existed: true, fileRemoved: true}
})
