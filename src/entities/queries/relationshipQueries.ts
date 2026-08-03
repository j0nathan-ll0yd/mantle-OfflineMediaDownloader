/**
 * Relationship Queries - Drizzle ORM queries for user-file and user-device relationships.
 * All queries are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 *
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@j0nathan-ll0yd/database'
import {and, eq, inArray, or} from '@j0nathan-ll0yd/database/orm'
import type {InferInsertModel, InferSelectModel} from '@j0nathan-ll0yd/database/orm'
import {defineQuery} from '#db/defineQuery'
import {assertDeviceExists, assertFileExists, assertUserExists} from '#db/fkEnforcement'
import {devices, files, userDevices, userFiles, users} from '#db/schema'
import {userDeviceInsertSchema, userFileInsertSchema} from '#db/zodSchemas'
import type {DeviceRow} from './deviceQueries'
import type {FileRow} from './fileQueries'

export type UserFileRow = InferSelectModel<typeof userFiles>
export type UserDeviceRow = InferSelectModel<typeof userDevices>

export type CreateUserFileInput = Omit<InferInsertModel<typeof userFiles>, 'createdAt'>
export type CreateUserDeviceInput = Omit<InferInsertModel<typeof userDevices>, 'createdAt'>

// UserFile Operations

/**
 * Gets a user-file relationship.
 * @param userId - The user's unique identifier
 * @param fileId - The file's unique identifier
 * @returns The user-file row or null if not found
 */
export const getUserFile = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select]}]},
  async function getUserFile(db, userId: string, fileId: string): Promise<UserFileRow | null> {
    const result = await db.select().from(userFiles).where(and(eq(userFiles.userId, userId), eq(userFiles.fileId, fileId))).limit(1)
    return result[0] ?? null
  })

/**
 * Gets all file relationships for a user.
 * @param userId - The user's unique identifier
 * @returns Array of user-file rows
 */
export const getUserFilesByUserId = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select]}]},
  async function getUserFilesByUserId(db, userId: string): Promise<UserFileRow[]> {
    return await db.select().from(userFiles).where(eq(userFiles.userId, userId))
  })

/**
 * Gets file IDs for a user (optimized - fetches only IDs).
 * Use when caller only needs file IDs, not full relationship data.
 * @param userId - The user's unique identifier
 * @returns Array of file IDs
 */
export const getUserFileIdsByUserId = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select]}]},
  async function getUserFileIdsByUserId(db, userId: string): Promise<string[]> {
    const result = await db.select({fileId: userFiles.fileId}).from(userFiles).where(eq(userFiles.userId, userId))
    return result.map((r) => r.fileId)
  })

/**
 * Gets all user relationships for a file.
 * @param fileId - The file's unique identifier
 * @returns Array of user-file rows
 */
export const getUserFilesByFileId = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select]}]},
  async function getUserFilesByFileId(db, fileId: string): Promise<UserFileRow[]> {
    return await db.select().from(userFiles).where(eq(userFiles.fileId, fileId))
  })

/**
 * Gets all files for a user with full file data (JOIN query).
 * @param userId - The user's unique identifier
 * @returns Array of file rows
 */
export const getFilesForUser = defineQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Select]},
    {table: files, operations: [DatabaseOperation.Select]}
  ]
}, async function getFilesForUser(db, userId: string): Promise<FileRow[]> {
  const result = await db.select({file: files}).from(userFiles).innerJoin(files, eq(userFiles.fileId, files.fileId)).where(eq(userFiles.userId, userId))
  return result.map((r) => r.file)
})

/**
 * Creates a user-file relationship.
 * Validates that both user and file exist before creating (application-level FK enforcement).
 * @param input - The user-file data to create
 * @returns The created user-file row
 * @throws ForeignKeyViolationError if user or file does not exist
 */
export const createUserFile = defineQuery({
  tables: [
    {table: users, operations: [DatabaseOperation.Select]},
    {table: files, operations: [DatabaseOperation.Select]},
    {table: userFiles, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}
  ],
  transaction: true
}, async function createUserFile(db, input: CreateUserFileInput): Promise<UserFileRow> {
  const validatedInput = userFileInsertSchema.parse(input)
  // Validate FK references exist (Aurora DSQL doesn't enforce FKs)
  await assertUserExists(validatedInput.userId)
  await assertFileExists(validatedInput.fileId)
  const [userFile] = await db.insert(userFiles).values(validatedInput).returning()
  return userFile!
})

/**
 * Upserts a user-file relationship (create if not exists).
 * Uses atomic ON CONFLICT DO NOTHING to avoid race conditions.
 *
 * Note: Unlike createUserFile(), this does NOT validate FK references.
 * Upserts are typically used in contexts where parent entities have already been created.
 *
 * @param input - The user-file data to upsert
 * @returns The existing or created user-file row
 */
export const upsertUserFile = defineQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Insert, DatabaseOperation.Select]}
  ]
}, async function upsertUserFile(db, input: CreateUserFileInput): Promise<UserFileRow> {
  const validatedInput = userFileInsertSchema.parse(input)
  // Try to insert, do nothing on conflict (junction table has no updatable fields)
  const result = await db.insert(userFiles).values(validatedInput).onConflictDoNothing({target: [userFiles.userId, userFiles.fileId]}).returning()
  // If conflict occurred (no rows returned), fetch existing record
  if (result.length === 0) {
    const [existing] = await db.select().from(userFiles).where(and(eq(userFiles.userId, input.userId), eq(userFiles.fileId, input.fileId))).limit(1)
    return existing!
  }
  return result[0]!
})

/**
 * Deletes a user-file relationship.
 * @param userId - The user's unique identifier
 * @param fileId - The file's unique identifier
 */
export const deleteUserFile = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserFile(db, userId: string, fileId: string): Promise<void> {
    await db.delete(userFiles).where(and(eq(userFiles.userId, userId), eq(userFiles.fileId, fileId)))
  })

/**
 * Deletes all file relationships for a user.
 * @param userId - The user's unique identifier
 */
export const deleteUserFilesByUserId = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserFilesByUserId(db, userId: string): Promise<void> {
    await db.delete(userFiles).where(eq(userFiles.userId, userId))
  })

/**
 * Deletes multiple user-file relationships (batch operation).
 * Uses single query with OR conditions instead of N separate queries.
 * @param keys - Array of userId/fileId pairs to delete
 */
export const deleteUserFilesBatch = defineQuery({tables: [{table: userFiles, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserFilesBatch(db, keys: Array<{userId: string; fileId: string}>): Promise<void> {
    if (keys.length === 0) {
      return
    }

    // Build OR conditions for composite key matching
    const conditions = keys.map((k) => and(eq(userFiles.userId, k.userId), eq(userFiles.fileId, k.fileId)))

    await db.delete(userFiles).where(or(...conditions))
  })

// UserDevice Operations

/**
 * Gets a user-device relationship.
 * @param userId - The user's unique identifier
 * @param deviceId - The device's unique identifier
 * @returns The user-device row or null if not found
 */
export const getUserDevice = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select]}]},
  async function getUserDevice(db, userId: string, deviceId: string): Promise<UserDeviceRow | null> {
    const result = await db.select().from(userDevices).where(and(eq(userDevices.userId, userId), eq(userDevices.deviceId, deviceId))).limit(1)
    return result[0] ?? null
  })

/**
 * Gets all device relationships for a user.
 * @param userId - The user's unique identifier
 * @returns Array of user-device rows
 */
export const getUserDevicesByUserId = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select]}]},
  async function getUserDevicesByUserId(db, userId: string): Promise<UserDeviceRow[]> {
    return await db.select().from(userDevices).where(eq(userDevices.userId, userId))
  })

/**
 * Gets device IDs for a user (optimized - fetches only IDs).
 * Use when caller only needs device IDs, not full relationship data.
 * @param userId - The user's unique identifier
 * @returns Array of device IDs
 */
export const getUserDeviceIdsByUserId = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select]}]},
  async function getUserDeviceIdsByUserId(db, userId: string): Promise<string[]> {
    const result = await db.select({deviceId: userDevices.deviceId}).from(userDevices).where(eq(userDevices.userId, userId))
    return result.map((r) => r.deviceId)
  })

/**
 * Gets all user relationships for a device.
 * @param deviceId - The device's unique identifier
 * @returns Array of user-device rows
 */
export const getUserDevicesByDeviceId = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select]}]},
  async function getUserDevicesByDeviceId(db, deviceId: string): Promise<UserDeviceRow[]> {
    return await db.select().from(userDevices).where(eq(userDevices.deviceId, deviceId))
  })

/**
 * Gets all devices for a user with full device data (JOIN query).
 * @param userId - The user's unique identifier
 * @returns Array of device rows
 */
export const getDevicesForUser = defineQuery({
  tables: [
    {table: userDevices, operations: [DatabaseOperation.Select]},
    {table: devices, operations: [DatabaseOperation.Select]}
  ]
}, async function getDevicesForUser(db, userId: string): Promise<DeviceRow[]> {
  const result = await db.select({device: devices}).from(userDevices).innerJoin(devices, eq(userDevices.deviceId, devices.deviceId)).where(
    eq(userDevices.userId, userId)
  )
  return result.map((r) => r.device)
})

/**
 * Gets device IDs for multiple users (batch operation for push notifications).
 * @param userIds - Array of user IDs
 * @returns Array of device IDs
 */
export const getDeviceIdsForUsers = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select]}]},
  async function getDeviceIdsForUsers(db, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) {
      return []
    }
    const result = await db.select({deviceId: userDevices.deviceId}).from(userDevices).where(inArray(userDevices.userId, userIds))
    return result.map((r) => r.deviceId)
  })

/**
 * Creates a user-device relationship.
 * Validates that both user and device exist before creating (application-level FK enforcement).
 * @param input - The user-device data to create
 * @returns The created user-device row
 * @throws ForeignKeyViolationError if user or device does not exist
 */
export const createUserDevice = defineQuery({
  tables: [
    {table: users, operations: [DatabaseOperation.Select]},
    {table: devices, operations: [DatabaseOperation.Select]},
    {table: userDevices, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}
  ],
  transaction: true
}, async function createUserDevice(db, input: CreateUserDeviceInput): Promise<UserDeviceRow> {
  const validatedInput = userDeviceInsertSchema.parse(input)
  // Validate FK references exist (Aurora DSQL doesn't enforce FKs)
  await assertUserExists(validatedInput.userId)
  await assertDeviceExists(validatedInput.deviceId)
  const [userDevice] = await db.insert(userDevices).values(validatedInput).returning()
  return userDevice!
})

/**
 * Upserts a user-device relationship (create if not exists).
 * Uses atomic ON CONFLICT DO NOTHING to avoid race conditions.
 *
 * Note: Unlike createUserDevice(), this does NOT validate FK references.
 * Upserts are typically used in contexts where parent entities have already been created.
 *
 * @param input - The user-device data to upsert
 * @returns The existing or created user-device row
 */
export const upsertUserDevice = defineQuery({
  tables: [
    {table: userDevices, operations: [DatabaseOperation.Insert, DatabaseOperation.Select]}
  ]
}, async function upsertUserDevice(db, input: CreateUserDeviceInput): Promise<UserDeviceRow> {
  const validatedInput = userDeviceInsertSchema.parse(input)
  // Try to insert, do nothing on conflict (junction table has no updatable fields)
  const result = await db.insert(userDevices).values(validatedInput).onConflictDoNothing({target: [userDevices.userId, userDevices.deviceId]}).returning()
  // If conflict occurred (no rows returned), fetch existing record
  if (result.length === 0) {
    const [existing] = await db.select().from(userDevices).where(and(eq(userDevices.userId, input.userId), eq(userDevices.deviceId, input.deviceId))).limit(
      1
    )
    return existing!
  }
  return result[0]!
})

/**
 * Deletes a user-device relationship.
 * @param userId - The user's unique identifier
 * @param deviceId - The device's unique identifier
 */
export const deleteUserDevice = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserDevice(db, userId: string, deviceId: string): Promise<void> {
    await db.delete(userDevices).where(and(eq(userDevices.userId, userId), eq(userDevices.deviceId, deviceId)))
  })

/**
 * Deletes all device relationships for a user.
 * @param userId - The user's unique identifier
 */
export const deleteUserDevicesByUserId = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserDevicesByUserId(db, userId: string): Promise<void> {
    await db.delete(userDevices).where(eq(userDevices.userId, userId))
  })

/**
 * Deletes all user relationships for a device.
 * @param deviceId - The device's unique identifier
 */
export const deleteUserDevicesByDeviceId = defineQuery({tables: [{table: userDevices, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUserDevicesByDeviceId(db, deviceId: string): Promise<void> {
    await db.delete(userDevices).where(eq(userDevices.deviceId, deviceId))
  })
