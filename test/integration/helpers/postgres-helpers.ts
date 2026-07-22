/**
 * PostgreSQL Test Helpers - Worker-Isolated Version
 *
 * Utilities for setting up and querying test data in PostgreSQL
 * for Drizzle/Aurora DSQL integration tests.
 *
 * Each Vitest worker gets its own PostgreSQL schema for complete isolation
 * during parallel test execution. Schema is determined by VITEST_POOL_ID.
 */

import {drizzle} from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {eq, sql} from 'drizzle-orm'
import {devices, files, userDevices, userFiles, users} from '#db/schema'
import type {Device, File, User} from '#types/domainModels'
import {FileStatus} from '#types/enums'
import {createMockDevice, createMockFile, createMockUser} from './test-data'

// Test database connection configuration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'

// Worker-aware connection cache (not singleton - each worker gets its own)
const workerConnections = new Map<string, {db: ReturnType<typeof drizzle>; sqlClient: ReturnType<typeof postgres>; initialized: boolean}>()

/**
 * Get schema prefix for CI isolation.
 * Uses GITHUB_RUN_ID to ensure parallel CI runs don't interfere.
 */
function getSchemaPrefix(): string {
  const runId = process.env.GITHUB_RUN_ID
  return runId ? `run_${runId}_` : ''
}

/**
 * Get the current worker's schema name.
 * Uses VITEST_POOL_ID environment variable set by Vitest for parallel workers.
 * Falls back to JEST_WORKER_ID for Jest compatibility.
 * Includes CI run prefix for isolation when parallel CI runs occur.
 *
 * Note: VITEST_POOL_ID in threads mode is 0-indexed, so we add 1 to match
 * our schema naming (worker_1, worker_2, etc.)
 */
export function getWorkerSchema(): string {
  const prefix = getSchemaPrefix()
  // Vitest uses VITEST_POOL_ID for parallel workers
  // In threads mode, it's 0-indexed, so we add 1 to get 1-indexed worker IDs
  const vitestPoolId = process.env.VITEST_POOL_ID
  if (vitestPoolId !== undefined) {
    const workerId = Number(vitestPoolId) + 1
    return `${prefix}worker_${workerId}`
  }
  // Falls back to JEST_WORKER_ID for Jest, or '1' for single-threaded
  const workerId = process.env.JEST_WORKER_ID || '1'
  return `${prefix}worker_${workerId}`
}

/**
 * Get or create the test database connection for current worker.
 * Each worker has its own connection and operates in its own schema.
 * Uses onconnect callback to set search_path on every new connection.
 */
export async function getTestDbAsync(): Promise<ReturnType<typeof drizzle>> {
  const schema = getWorkerSchema()

  if (!workerConnections.has(schema)) {
    // Create connection with search_path set on every new connection
    // postgres.js uses a connection pool, so we need to set search_path on each connection
    const sqlClient = postgres(TEST_DATABASE_URL, {
      onnotice: () => {}, // Suppress NOTICE messages
      max: 1, // Use single connection to avoid search_path issues with pool
      // Set search_path via connection string options
      transform: {undefined: null}
    })

    const db = drizzle(sqlClient)

    // Set search_path immediately on this connection
    await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

    workerConnections.set(schema, {db, sqlClient, initialized: true})
  }

  return workerConnections.get(schema)!.db
}

/**
 * Get test database synchronously.
 * WARNING: Only use after getTestDbAsync has been called at least once.
 * For new code, prefer getTestDbAsync.
 */
export function getTestDb(): ReturnType<typeof drizzle> {
  const schema = getWorkerSchema()
  const conn = workerConnections.get(schema)
  if (!conn) {
    throw new Error('getTestDb called before getTestDbAsync. Call getTestDbAsync in beforeAll first.')
  }
  return conn.db
}

/**
 * Ensure search_path is set for the current worker schema.
 * Call this before making direct Drizzle queries in tests.
 * Helper functions already call this internally.
 */
export async function ensureSearchPath(): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()
  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
}

/**
 * Close the test database connection for current worker
 */
export async function closeTestDb(): Promise<void> {
  const schema = getWorkerSchema()
  const conn = workerConnections.get(schema)

  if (conn) {
    await conn.sqlClient.end()
    workerConnections.delete(schema)
  }
}

/**
 * Create all tables in the worker's schema.
 * Run this in beforeAll() of integration tests.
 *
 * CONVENTION: Migrations are the single source of truth for SQL.
 * Tables are created by globalSetup.ts from migrations/0001_schema.sql.
 * This function ensures schema exists and sets search_path for the connection.
 *
 * DO NOT duplicate SQL table definitions here.
 * All schema definitions belong in migrations/0001_schema.sql.
 */
export async function createAllTables(): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  // Verify schema exists — globalSetup should have created it before any workers start.
  // If this fails, it indicates a real configuration error, not a timing issue.
  const schemaCheck = await db.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = '${schema}' AND table_name = 'users'
    ) as exists
  `))

  const rows = [...schemaCheck] as Array<{exists: boolean}>
  if (!rows[0]?.exists) {
    // Schema tables not found — gather diagnostics
    const allSchemas = await db.execute(
      sql.raw(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '%worker%' ORDER BY schema_name`)
    )
    const schemaNames = [...allSchemas].map((r: Record<string, unknown>) => r.schema_name)

    // Check what tables DO exist in this schema
    const tablesInSchema = await db.execute(sql.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`))
    const tableNames = [...tablesInSchema].map((r: Record<string, unknown>) => r.table_name)

    // Check current search_path and connection state
    const connCheck = await db.execute(sql.raw(`SELECT current_database(), current_user, current_schema(), current_setting('search_path') as search_path`))
    const connInfo = [...connCheck][0] as Record<string, unknown> | undefined

    throw new Error(
      `[createAllTables] Table 'users' not found in schema '${schema}'. ` +
        `Tables in schema: [${tableNames.join(', ') || 'NONE'}]. ` +
        `Worker schemas exist: [${schemaNames.join(', ')}]. ` +
        `Connection: db=${connInfo?.current_database}, user=${connInfo?.current_user}, ` +
        `schema=${connInfo?.current_schema}, search_path=${connInfo?.search_path}. ` +
        `VITEST_POOL_ID=${process.env.VITEST_POOL_ID}, GITHUB_RUN_ID=${process.env.GITHUB_RUN_ID}`
    )
  }

  // Schema exists — set search_path
  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
}

/**
 * Drop all tables from worker's schema.
 * Run this in afterAll() of integration tests.
 */
export async function dropAllTables(): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  // Drop in reverse dependency order (children first)
  await db.execute(sql.raw(`
    DROP TABLE IF EXISTS ${schema}.user_devices CASCADE;
    DROP TABLE IF EXISTS ${schema}.user_files CASCADE;
    DROP TABLE IF EXISTS ${schema}.file_downloads CASCADE;
    DROP TABLE IF EXISTS ${schema}.verification CASCADE;
    DROP TABLE IF EXISTS ${schema}.accounts CASCADE;
    DROP TABLE IF EXISTS ${schema}.sessions CASCADE;
    DROP TABLE IF EXISTS ${schema}.devices CASCADE;
    DROP TABLE IF EXISTS ${schema}.files CASCADE;
    DROP TABLE IF EXISTS ${schema}.users CASCADE;
  `))
}

/**
 * Truncate all tables (faster than drop/create for between-test cleanup)
 *
 * Uses conditional logic to handle cases where tables may not exist yet
 * (e.g., race conditions between globalSetup and test execution in CI).
 */
export async function truncateAllTables(): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  // Check if schema and tables exist before truncating
  // This handles race conditions where globalSetup hasn't finished for this worker
  const schemaExists = await db.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = '${schema}' AND table_name = 'users'
    ) as exists
  `))

  const rows = [...schemaExists] as Array<{exists: boolean}>
  if (!rows[0]?.exists) {
    // Schema/tables don't exist yet - nothing to truncate
    return
  }

  await db.execute(sql.raw(`
    TRUNCATE ${schema}.user_devices, ${schema}.user_files, ${schema}.file_downloads,
             ${schema}.verification, ${schema}.accounts, ${schema}.sessions,
             ${schema}.devices, ${schema}.files, ${schema}.users
    CASCADE;
  `))
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Insert a file record into PostgreSQL
 */
export async function insertFile(fileData: Partial<File>): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  // Set search_path for this query
  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const defaults = createMockFile(fileData.fileId!, fileData.status || FileStatus.Queued, fileData)

  await db.insert(files).values({
    fileId: defaults.fileId!,
    status: defaults.status!,
    size: defaults.size!,
    key: defaults.key!,
    title: defaults.title!,
    description: defaults.description!,
    authorName: defaults.authorName!,
    authorUser: defaults.authorUser!,
    publishDate: defaults.publishDate!,
    contentType: defaults.contentType!,
    url: defaults.url
  })
}

/**
 * Get a file record from PostgreSQL
 */
export async function getFile(fileId: string): Promise<Partial<File> | null> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  // Set search_path for this query
  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(files).where(eq(files.fileId, fileId))
  if (!result[0]) {
    return null
  }

  // Convert null to undefined for optional fields and cast status to enum
  const row = result[0]
  return {
    ...row,
    url: row.url ?? undefined,
    status: row.status as FileStatus,
    duration: row.duration ?? undefined,
    uploadDate: row.uploadDate ?? undefined,
    viewCount: row.viewCount ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined
  }
}

/**
 * Update a file record in PostgreSQL
 */
export async function updateFile(fileId: string, updates: Partial<File>): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.update(files).set(updates).where(eq(files.fileId, fileId))
}

/**
 * Delete a file record from PostgreSQL
 */
export async function deleteFile(fileId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(files).where(eq(files.fileId, fileId))
}

// ============================================================================
// User Operations
// ============================================================================

/**
 * Insert a user record into PostgreSQL
 * Accepts either 'id' (domain type) or 'userId' (legacy tests) for backwards compatibility
 */
export async function insertUser(userData: Partial<User> & {userId?: string}): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const defaults = createMockUser(userData)

  await db.insert(users).values({
    id: defaults.id!,
    email: defaults.email!,
    emailVerified: defaults.emailVerified ?? false,
    name: defaults.name,
    firstName: defaults.firstName,
    lastName: defaults.lastName
  })
}

/**
 * Get a user record from PostgreSQL
 */
export async function getUser(id: string): Promise<Partial<User> | null> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(users).where(eq(users.id, id))
  if (!result[0]) {
    return null
  }

  // Convert null to undefined for optional fields (PostgreSQL returns null, domain uses undefined)
  const row = result[0]
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    name: row.name ?? undefined,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined
  }
}

// ============================================================================
// Device Operations
// ============================================================================

/**
 * Insert a device record into PostgreSQL
 */
export async function insertDevice(deviceData: Partial<Device>): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const defaults = createMockDevice(deviceData)

  await db.insert(devices).values({
    deviceId: defaults.deviceId!,
    name: defaults.name!,
    token: defaults.token!,
    systemVersion: defaults.systemVersion!,
    systemName: defaults.systemName!,
    endpointArn: defaults.endpointArn!
  })
}

/**
 * Get a device record from PostgreSQL
 */
export async function getDevice(deviceId: string): Promise<Partial<Device> | null> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(devices).where(eq(devices.deviceId, deviceId))
  return result[0] || null
}

/**
 * Update a device record in PostgreSQL
 */
export async function updateDevice(deviceId: string, updates: Partial<Device>): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.update(devices).set(updates).where(eq(devices.deviceId, deviceId))
}

/**
 * Delete a device record from PostgreSQL
 */
export async function deleteDevice(deviceId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(devices).where(eq(devices.deviceId, deviceId))
}

/**
 * Upsert a device record in PostgreSQL (insert or update on conflict)
 */
export async function upsertDevice(deviceData: Partial<Device>): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const defaults = createMockDevice(deviceData)
  const now = new Date().toISOString()

  // Use raw SQL for upsert since Drizzle's onConflictDoUpdate needs careful setup
  await db.execute(sql`
    INSERT INTO devices (device_id, name, token, system_version, system_name, endpoint_arn, created_at, updated_at)
    VALUES (${defaults.deviceId}, ${defaults.name}, ${defaults.token}, ${defaults.systemVersion}, ${defaults.systemName}, ${defaults.endpointArn}, ${now}, ${now})
    ON CONFLICT (device_id) DO UPDATE SET
      name = EXCLUDED.name,
      token = EXCLUDED.token,
      system_version = EXCLUDED.system_version,
      system_name = EXCLUDED.system_name,
      endpoint_arn = EXCLUDED.endpoint_arn,
      updated_at = EXCLUDED.updated_at
  `)
}

/**
 * Get all devices from PostgreSQL
 */
export async function getAllDevices(): Promise<Array<Partial<Device>>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(devices)
  return result
}

/**
 * Get multiple devices by IDs (batch lookup)
 */
export async function getDevicesBatch(deviceIds: string[]): Promise<Array<Partial<Device>>> {
  if (deviceIds.length === 0) {
    return []
  }

  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  // Build IN clause for batch lookup
  const placeholders = deviceIds.map((id) => sql`${id}`).reduce((acc, curr, i) => (i === 0 ? curr : sql`${acc}, ${curr}`))
  const result = await db.execute(sql`SELECT * FROM devices WHERE device_id IN (${placeholders})`)
  const rows = [...result] as Array<
    {device_id: string; name: string; token: string; system_version: string; system_name: string; endpoint_arn: string | null}
  >

  return rows.map((row) => ({
    deviceId: row.device_id,
    name: row.name,
    token: row.token,
    systemVersion: row.system_version,
    systemName: row.system_name,
    endpointArn: row.endpoint_arn ?? undefined
  }))
}

// ============================================================================
// Junction Table Operations
// ============================================================================

/**
 * Link a user to a file
 */
export async function linkUserFile(userId: string, fileId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.insert(userFiles).values({userId, fileId})
}

/**
 * Link a user to a device
 */
export async function linkUserDevice(userId: string, deviceId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.insert(userDevices).values({userId, deviceId})
}

/**
 * Upsert a user-device link (insert or ignore on conflict)
 */
export async function upsertUserDevice(data: {userId: string; deviceId: string}): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  // Insert or ignore on conflict
  await db.execute(sql`
    INSERT INTO user_devices (user_id, device_id, created_at)
    VALUES (${data.userId}, ${data.deviceId}, ${new Date().toISOString()})
    ON CONFLICT (user_id, device_id) DO NOTHING
  `)
}

/**
 * Get user-device links by user ID
 */
export async function getUserDevicesByUserId(userId: string): Promise<Array<{userId: string; deviceId: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(userDevices).where(eq(userDevices.userId, userId))
  return result.map((row) => ({userId: row.userId, deviceId: row.deviceId}))
}

/**
 * Get user-device links by device ID
 */
export async function getUserDevicesByDeviceId(deviceId: string): Promise<Array<{userId: string; deviceId: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(userDevices).where(eq(userDevices.deviceId, deviceId))
  return result.map((row) => ({userId: row.userId, deviceId: row.deviceId}))
}

/**
 * Delete all user-device links for a user
 */
export async function deleteUserDevicesByUserId(userId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(userDevices).where(eq(userDevices.userId, userId))
}

/**
 * Delete all user-device links for a device
 */
export async function deleteUserDevicesByDeviceId(deviceId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(userDevices).where(eq(userDevices.deviceId, deviceId))
}

/**
 * Get user-file links by file ID
 */
export async function getUserFilesByFileId(fileId: string): Promise<Array<{userId: string; fileId: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(userFiles).where(eq(userFiles.fileId, fileId))
  return result.map((row) => ({userId: row.userId, fileId: row.fileId}))
}

/**
 * Get user-file links by user ID
 */
export async function getUserFilesByUserId(userId: string): Promise<Array<{userId: string; fileId: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(userFiles).where(eq(userFiles.userId, userId))
  return result.map((row) => ({userId: row.userId, fileId: row.fileId}))
}

/**
 * Insert a user-file link
 */
export async function insertUserFile(data: {userId: string; fileId: string}): Promise<void> {
  return linkUserFile(data.userId, data.fileId)
}

/**
 * Delete all user-file links for a user
 */
export async function deleteUserFilesByUserId(userId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(userFiles).where(eq(userFiles.userId, userId))
}

/**
 * Delete a user record from PostgreSQL
 */
export async function deleteUser(userId: string): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  await db.delete(users).where(eq(users.id, userId))
}

/**
 * Get files by S3 key
 */
export async function getFilesByKey(key: string): Promise<Array<Partial<File>>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const result = await db.select().from(files).where(eq(files.key, key))
  return result.map((row) => ({
    ...row,
    url: row.url ?? undefined,
    status: row.status as FileStatus,
    duration: row.duration ?? undefined,
    uploadDate: row.uploadDate ?? undefined,
    viewCount: row.viewCount ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined
  }))
}

// ============================================================================
// FileDownloads Operations
// ============================================================================

/**
 * Insert a file download record into PostgreSQL
 */
export async function insertFileDownload(
  data: {
    fileId: string
    status: string
    updatedAt?: Date
    createdAt?: Date
    retryCount?: number
    maxRetries?: number
    sourceUrl?: string
    correlationId?: string
  }
): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const now = new Date().toISOString()
  await db.execute(sql`
    INSERT INTO file_downloads (file_id, status, retry_count, max_retries, source_url, correlation_id, created_at, updated_at)
    VALUES (${data.fileId}, ${data.status}, ${data.retryCount ?? 0}, ${data.maxRetries ?? 5},
            ${data.sourceUrl ?? null}, ${data.correlationId ?? null},
            ${data.createdAt?.toISOString() ?? now}, ${data.updatedAt?.toISOString() ?? now})
  `)
}

/**
 * Get all file downloads from PostgreSQL
 */
export async function getFileDownloads(): Promise<Array<{fileId: string; status: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  const result = await db.execute(sql`SELECT file_id, status FROM file_downloads`)
  const rows = [...result] as Array<{file_id: string; status: string}>
  return rows.map((row) => ({fileId: row.file_id, status: row.status}))
}

// ============================================================================
// Sessions Operations
// ============================================================================

/**
 * Insert a session record into PostgreSQL
 */
export async function insertSession(data: {id?: string; userId: string; token: string; expiresAt: Date; createdAt?: Date; updatedAt?: Date}): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const now = new Date().toISOString()
  const id = data.id ?? crypto.randomUUID()
  await db.execute(sql`
    INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
    VALUES (${id}, ${data.userId}, ${data.token}, ${data.expiresAt.toISOString()}, ${data.createdAt?.toISOString() ?? now}, ${
    data.updatedAt?.toISOString() ?? now
  })
  `)
}

/**
 * Get all sessions from PostgreSQL
 */
export async function getSessions(): Promise<Array<{id: string; userId: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  const result = await db.execute(sql`SELECT id, user_id FROM sessions`)
  const rows = [...result] as Array<{id: string; user_id: string}>
  return rows.map((row) => ({id: row.id, userId: row.user_id}))
}

/**
 * Get a session by token from PostgreSQL
 */
export async function getSessionByToken(token: string): Promise<{id: string; userId: string; expiresAt: Date; updatedAt: Date} | null> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  const result = await db.execute(sql`SELECT id, user_id, expires_at, updated_at FROM sessions WHERE token = ${token}`)
  const rows = [...result] as Array<{id: string; user_id: string; expires_at: string; updated_at: string}>
  if (rows.length === 0) {
    return null
  }
  const row = rows[0]!
  return {id: row.id, userId: row.user_id, expiresAt: new Date(row.expires_at), updatedAt: new Date(row.updated_at)}
}

/**
 * Get a session by ID from PostgreSQL
 */
export async function getSessionById(sessionId: string): Promise<{id: string; userId: string; token: string; expiresAt: Date; updatedAt: Date} | null> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  const result = await db.execute(sql`SELECT id, user_id, token, expires_at, updated_at FROM sessions WHERE id = ${sessionId}`)
  const rows = [...result] as Array<{id: string; user_id: string; token: string; expires_at: string; updated_at: string}>
  if (rows.length === 0) {
    return null
  }
  const row = rows[0]!
  return {id: row.id, userId: row.user_id, token: row.token, expiresAt: new Date(row.expires_at), updatedAt: new Date(row.updated_at)}
}

// ============================================================================
// Verification Operations
// ============================================================================

/**
 * Insert a verification token record into PostgreSQL
 */
export async function insertVerification(
  data: {id?: string; identifier: string; value: string; expiresAt: Date; createdAt?: Date; updatedAt?: Date}
): Promise<void> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))

  const now = new Date().toISOString()
  const id = data.id ?? crypto.randomUUID()
  await db.execute(sql`
    INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
    VALUES (${id}, ${data.identifier}, ${data.value}, ${data.expiresAt.toISOString()}, ${data.createdAt?.toISOString() ?? now}, ${
    data.updatedAt?.toISOString() ?? now
  })
  `)
}

/**
 * Get all verification tokens from PostgreSQL
 */
export async function getVerificationTokens(): Promise<Array<{id: string; identifier: string}>> {
  const db = getTestDb()
  const schema = getWorkerSchema()

  await db.execute(sql.raw(`SET search_path TO ${schema}, public`))
  const result = await db.execute(sql`SELECT id, identifier FROM verification`)
  const rows = [...result] as Array<{id: string; identifier: string}>
  return rows.map((row) => ({id: row.id, identifier: row.identifier}))
}
