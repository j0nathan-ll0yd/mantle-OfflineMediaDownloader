/**
 * File Queries - Drizzle ORM queries for file operations.
 * All queries are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 *
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@j0nathan-ll0yd/database'
import {and, eq, inArray, lt} from '@j0nathan-ll0yd/database/orm'
import type {InferInsertModel, InferSelectModel} from '@j0nathan-ll0yd/database/orm'
import {defineQuery} from '#db/defineQuery'
import {fileDownloads, files} from '#db/schema'
import {fileDownloadInsertSchema, fileDownloadUpdateSchema, fileInsertSchema, fileUpdateSchema} from '#db/zodSchemas'

export type FileRow = InferSelectModel<typeof files>
export type FileDownloadRow = InferSelectModel<typeof fileDownloads>

export type CreateFileInput = Omit<InferInsertModel<typeof files>, 'size'> & {size?: number}
export type UpdateFileInput = Partial<Omit<InferInsertModel<typeof files>, 'fileId'>>

export type CreateFileDownloadInput = Omit<InferInsertModel<typeof fileDownloads>, 'createdAt' | 'updatedAt'>
export type UpdateFileDownloadInput = Partial<Omit<InferInsertModel<typeof fileDownloads>, 'fileId' | 'createdAt'>>

// File Operations

/**
 * Gets a file by ID.
 * @param fileId - The file's unique identifier
 * @returns The file row or null if not found
 */
export const getFile = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select]}]},
  async function getFile(db, fileId: string): Promise<FileRow | null> {
    const result = await db.select().from(files).where(eq(files.fileId, fileId)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets only the status of a file (optimized - fetches single column).
 * Use when caller only needs to check file status.
 * @param fileId - The file's unique identifier
 * @returns The file status or null if not found
 */
export const getFileStatus = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select]}]},
  async function getFileStatus(db, fileId: string): Promise<string | null> {
    const result = await db.select({status: files.status}).from(files).where(eq(files.fileId, fileId)).limit(1)
    return result[0]?.status ?? null
  })

/**
 * Gets multiple files by IDs (batch operation).
 * @param fileIds - Array of file IDs to retrieve
 * @returns Array of file rows
 */
export const getFilesBatch = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select]}]},
  async function getFilesBatch(db, fileIds: string[]): Promise<FileRow[]> {
    if (fileIds.length === 0) {
      return []
    }
    return await db.select().from(files).where(inArray(files.fileId, fileIds))
  })

/**
 * Finds files by S3 object key.
 * @param key - The S3 object key to search for
 * @returns Array of files matching the key
 */
export const getFilesByKey = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select]}]},
  async function getFilesByKey(db, key: string): Promise<FileRow[]> {
    return await db.select().from(files).where(eq(files.key, key))
  })

/**
 * Creates a new file.
 * @param input - The file data to create
 * @returns The created file row
 */
export const createFile = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createFile(db, input: CreateFileInput): Promise<FileRow> {
    // Validate file input against schema
    const validatedInput = fileInsertSchema.parse({...input, size: input.size ?? 0})
    const [file] = await db.insert(files).values(validatedInput).returning()
    return file!
  })

/**
 * Upserts a file (create if not exists, update if exists).
 * Uses atomic ON CONFLICT DO UPDATE to avoid race conditions.
 * @param input - The file data to upsert
 * @returns The created or updated file row
 */
export const upsertFile = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select, DatabaseOperation.Insert, DatabaseOperation.Update]}]},
  async function upsertFile(db, input: CreateFileInput): Promise<FileRow> {
    // Validate file input against schema
    const validatedInput = fileInsertSchema.parse({...input, size: input.size ?? 0})
    const [result] = await db.insert(files).values(validatedInput).onConflictDoUpdate({
      target: files.fileId,
      set: {
        size: input.size ?? 0,
        authorName: input.authorName,
        authorUser: input.authorUser,
        publishDate: input.publishDate,
        description: input.description,
        key: input.key,
        url: input.url,
        contentType: input.contentType,
        title: input.title,
        status: input.status,
        // Rich metadata fields (Issue #151)
        duration: input.duration,
        uploadDate: input.uploadDate,
        viewCount: input.viewCount,
        thumbnailUrl: input.thumbnailUrl
      }
    }).returning()
    return result!
  })

/**
 * Updates a file by ID.
 * @param fileId - The file's unique identifier
 * @param data - The fields to update
 * @returns The updated file row
 */
export const updateFile = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select, DatabaseOperation.Update]}]},
  async function updateFile(db, fileId: string, data: UpdateFileInput): Promise<FileRow> {
    // Validate partial update data against schema
    const validatedData = fileUpdateSchema.partial().parse(data)
    const [updated] = await db.update(files).set(validatedData).where(eq(files.fileId, fileId)).returning()
    return updated!
  })

/**
 * Deletes a file by ID.
 * @param fileId - The file's unique identifier
 */
export const deleteFile = defineQuery({tables: [{table: files, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteFile(db, fileId: string): Promise<void> {
    await db.delete(files).where(eq(files.fileId, fileId))
  })

// FileDownload Operations

/**
 * Gets a file download record by file ID.
 * @param fileId - The file's unique identifier
 * @returns The file download row or null if not found
 */
export const getFileDownload = defineQuery({tables: [{table: fileDownloads, operations: [DatabaseOperation.Select]}]},
  async function getFileDownload(db, fileId: string): Promise<FileDownloadRow | null> {
    const result = await db.select().from(fileDownloads).where(eq(fileDownloads.fileId, fileId)).limit(1)
    return result[0] ?? null
  })

/**
 * Creates a new file download record.
 * @param input - The file download data to create
 * @returns The created file download row
 */
export const createFileDownload = defineQuery({tables: [{table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createFileDownload(db, input: CreateFileDownloadInput): Promise<FileDownloadRow> {
    // Validate file download input against schema
    const validatedInput = fileDownloadInsertSchema.parse(input)
    const [download] = await db.insert(fileDownloads).values(validatedInput).returning()
    return download!
  })

/**
 * Upserts a file download record (create if not exists, update if exists).
 * Uses atomic ON CONFLICT DO UPDATE to avoid race conditions.
 * @param input - The file download data to upsert
 * @returns The created or updated file download row
 */
export const upsertFileDownload = defineQuery({
  tables: [{table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Insert, DatabaseOperation.Update]}]
}, async function upsertFileDownload(db, input: CreateFileDownloadInput): Promise<FileDownloadRow> {
  // Validate file download input against schema
  const validatedInput = fileDownloadInsertSchema.parse(input)
  const [result] = await db.insert(fileDownloads).values(validatedInput).onConflictDoUpdate({
    target: fileDownloads.fileId,
    set: {
      status: input.status,
      retryCount: input.retryCount,
      maxRetries: input.maxRetries,
      retryAfter: input.retryAfter,
      errorCategory: input.errorCategory,
      lastError: input.lastError,
      scheduledReleaseTime: input.scheduledReleaseTime,
      sourceUrl: input.sourceUrl,
      correlationId: input.correlationId,
      updatedAt: new Date()
    }
  }).returning()
  return result!
})

/**
 * Updates a file download record by file ID.
 * @param fileId - The file's unique identifier
 * @param data - The fields to update
 * @returns The updated file download row
 */
export const updateFileDownload = defineQuery({tables: [{table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Update]}]},
  async function updateFileDownload(db, fileId: string, data: UpdateFileDownloadInput): Promise<FileDownloadRow> {
    // Validate partial update data against schema
    const validatedData = fileDownloadUpdateSchema.partial().parse(data)
    const [updated] = await db.update(fileDownloads).set({...validatedData, updatedAt: new Date()}).where(eq(fileDownloads.fileId, fileId)).returning()
    return updated!
  })

/**
 * Deletes a file download record by file ID.
 * @param fileId - The file's unique identifier
 */
export const deleteFileDownload = defineQuery({tables: [{table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteFileDownload(db, fileId: string): Promise<void> {
    await db.delete(fileDownloads).where(eq(fileDownloads.fileId, fileId))
  })

/**
 * Deletes file download records in a terminal state that are older than the cutoff.
 * Used by the scheduled cleanup Lambda to reclaim rows that finished before the retention window.
 * @param cutoffTime - Records updated before this time are eligible for deletion
 * @param statuses - Terminal statuses that make a record eligible (e.g. Completed, Failed)
 * @returns Count of deleted records
 */
export const deleteExpiredFileDownloads = defineQuery({tables: [{table: fileDownloads, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteExpiredFileDownloads(db, cutoffTime: Date, statuses: string[]): Promise<number> {
    const result = await db.delete(fileDownloads).where(and(inArray(fileDownloads.status, statuses), lt(fileDownloads.updatedAt, cutoffTime))).returning({
      fileId: fileDownloads.fileId
    })
    return result.length
  })
