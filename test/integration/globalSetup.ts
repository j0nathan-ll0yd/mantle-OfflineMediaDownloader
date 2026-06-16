/**
 * Vitest Global Setup for PostgreSQL Integration Tests
 *
 * Creates worker-specific schemas AND tables before any tests run.
 * Each Vitest worker gets its own schema (worker_1, worker_2, etc.)
 * for complete isolation during parallel test execution.
 *
 * Tables are created by reading from the canonical migration files
 * and adapting them for test schemas.
 *
 * Runs ONCE before all test files, not per-worker.
 */
import * as fs from 'fs'
import * as path from 'path'
import postgres from 'postgres'

// Create 2x the CI maxWorkers (4) to handle edge cases where Vitest
// assigns pool IDs beyond maxWorkers. In forks mode, VITEST_POOL_ID
// is 0-indexed from 0 to maxWorkers-1, but we add safety margin.
// Must match MAX_WORKERS in globalTeardown.ts (currently 8).
const MAX_WORKERS = 8

/**
 * Get schema prefix for CI isolation.
 * Uses GITHUB_RUN_ID to ensure parallel CI runs don't interfere.
 */
function getSchemaPrefix(): string {
  const runId = process.env.GITHUB_RUN_ID
  return runId ? `run_${runId}_` : ''
}

/**
 * Read and adapt migration SQL for a specific schema.
 *
 * CONVENTION: Migrations are the single source of truth for SQL.
 * This function only applies minimal transformations needed for test environment:
 * - Schema prefix for worker isolation (parallel test execution)
 * - Aurora DSQL → PostgreSQL syntax (CREATE INDEX ASYNC → CREATE INDEX)
 * - UUID → TEXT for test simplicity with regular PostgreSQL
 *
 * DO NOT add DEFAULT NULL or other schema modifications here.
 * All schema definitions belong in migrations/*.sql files.
 */
function adaptMigrationForSchema(migrationSql: string, schema: string): string {
  let adapted = migrationSql

  // List of tables to prefix with schema
  const tables = [
    'schema_migrations',
    'users',
    'sessions',
    'accounts',
    'verification',
    'files',
    'file_downloads',
    'devices',
    'user_files',
    'user_devices'
  ]

  // Add schema prefix to table references (for worker isolation)
  for (const table of tables) {
    // Match table name in CREATE TABLE, ALTER TABLE, CREATE INDEX, UPDATE, ON, DELETE,
    // INSERT, FROM, JOIN clauses. Use word boundaries to avoid partial matches.
    const createTablePattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'g')
    const alterTablePattern = new RegExp(`ALTER TABLE ${table} `, 'g')
    const updateTablePattern = new RegExp(`UPDATE ${table} `, 'g')
    const onParenPattern = new RegExp(`ON ${table}\\(`, 'g')
    const onSpacePattern = new RegExp(`ON ${table} `, 'g')
    const deletePattern = new RegExp(`DELETE FROM ${table}\\b`, 'g')
    const insertPattern = new RegExp(`INSERT INTO ${table}\\b`, 'g')
    const fromPattern = new RegExp(`FROM ${table}\\b`, 'g')
    const joinPattern = new RegExp(`JOIN ${table}\\b`, 'g')

    adapted = adapted.replace(createTablePattern, `CREATE TABLE IF NOT EXISTS ${schema}.${table}`)
    adapted = adapted.replace(alterTablePattern, `ALTER TABLE ${schema}.${table} `)
    adapted = adapted.replace(updateTablePattern, `UPDATE ${schema}.${table} `)
    adapted = adapted.replace(onParenPattern, `ON ${schema}.${table}(`)
    adapted = adapted.replace(onSpacePattern, `ON ${schema}.${table} `)
    adapted = adapted.replace(deletePattern, `DELETE FROM ${schema}.${table}`)
    adapted = adapted.replace(insertPattern, `INSERT INTO ${schema}.${table}`)
    adapted = adapted.replace(fromPattern, `FROM ${schema}.${table}`)
    adapted = adapted.replace(joinPattern, `JOIN ${schema}.${table}`)
  }

  // Convert Aurora DSQL specific syntax for regular PostgreSQL:
  // - CREATE INDEX ASYNC → CREATE INDEX (Aurora DSQL uses async index creation)
  adapted = adapted.replaceAll('CREATE INDEX ASYNC', 'CREATE INDEX')

  // Convert UUID to TEXT for test simplicity with regular PostgreSQL
  // Better Auth uses `generateId: false` which sends DEFAULT for id columns
  adapted = adapted.replaceAll('UUID PRIMARY KEY DEFAULT gen_random_uuid()', 'TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text')
  adapted = adapted.replaceAll('UUID NOT NULL', 'TEXT NOT NULL')

  return adapted
}

/**
 * Validate that Aurora DSQL-specific syntax has been properly adapted.
 * Throws an error if unadapted features are detected.
 *
 * @param adapted - The adapted SQL string
 * @throws Error if unadapted Aurora DSQL features are found
 */
function validateAdaptations(adapted: string): void {
  const issues: string[] = []

  // Check for unadapted Aurora DSQL features
  if (adapted.includes('CREATE INDEX ASYNC')) {
    issues.push('CREATE INDEX ASYNC not converted to CREATE INDEX')
  }

  if (adapted.includes('TIMESTAMP WITHOUT TIME ZONE')) {
    issues.push('TIMESTAMP WITHOUT TIME ZONE found - may cause timezone issues')
  }

  // Warn (but don't fail) for UUID columns that might need attention
  // Note: Some UUIDs are intentionally kept for specific use cases
  if (adapted.match(/UUID\s+(NOT NULL|REFERENCES)/)) {
    log('[globalSetup] INFO: UUID columns found in adapted schema - ensure test compatibility')
  }

  if (issues.length > 0) {
    throw new Error(`Aurora DSQL adaptation issues detected:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
  }
}

/**
 * Parse SQL file into individual statements.
 * Handles multi-line statements and comments.
 */
function parseSqlStatements(sql: string): string[] {
  // Remove SQL comments
  const noComments = sql.replaceAll(/--.*$/gm, '')

  // Split by semicolons, filter empty statements
  return noComments.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Log helper that respects LOG_LEVEL=SILENT */
function log(message: string): void {
  if (process.env.LOG_LEVEL !== 'SILENT') {
    console.log(message)
  }
}

/** Sleep helper for retry logic */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for PostgreSQL to be ready with retry logic.
 * This handles cases where PostgreSQL is still starting up in CI.
 */
async function waitForPostgres(databaseUrl: string, maxRetries = 30, retryDelayMs = 1000): Promise<postgres.Sql> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sql = postgres(databaseUrl, {onnotice: () => {}})
      // Test the connection with a simple query
      await sql`SELECT 1`
      log(`[globalSetup] PostgreSQL connection established on attempt ${attempt}`)
      return sql
    } catch (error) {
      lastError = error as Error
      if (attempt < maxRetries) {
        log(`[globalSetup] PostgreSQL not ready (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs}ms...`)
        await sleep(retryDelayMs)
      }
    }
  }

  throw new Error(`Failed to connect to PostgreSQL after ${maxRetries} attempts: ${lastError?.message}`)
}

/** Creates worker-specific database schemas AND tables before test execution. */
export async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'
  const prefix = getSchemaPrefix()

  log(`[globalSetup] Starting schema creation with prefix: "${prefix}"`)
  log(`[globalSetup] MAX_WORKERS: ${MAX_WORKERS}`)

  // Read schema migration files in order (excludes DSQL-specific role migrations)
  const migrationsDir = path.join(process.cwd(), 'migrations')
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql') && !f.includes('lambda_roles')).sort()
  const schemaMigration = migrationFiles.map((f: string) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n')

  // Wait for PostgreSQL to be ready with retry logic (handles CI startup delays)
  const sql = await waitForPostgres(databaseUrl)

  try {
    // Create schemas and tables for each worker BEFORE any tests run
    // Use parallel creation for faster setup (reduces flaky test failures)
    const createSchema = async (workerId: number) => {
      const schemaName = `${prefix}worker_${workerId}`
      log(`[globalSetup] Creating schema: ${schemaName}`)

      // Create the schema
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)

      // Adapt and execute schema migration (includes both tables and indexes)
      const adaptedSchema = adaptMigrationForSchema(schemaMigration, schemaName)
      validateAdaptations(adaptedSchema)
      const schemaStatements = parseSqlStatements(adaptedSchema)
      for (let i = 0; i < schemaStatements.length; i++) {
        const statement = schemaStatements[i]!
        try {
          await sql.unsafe(statement)
        } catch (stmtError) {
          // Log the failing statement for debugging — include first 120 chars
          const preview = statement.slice(0, 120).replaceAll('\n', ' ')
          console.error(`[globalSetup] Statement ${i + 1}/${schemaStatements.length} failed in ${schemaName}: ${preview}`)
          console.error(`[globalSetup] Error:`, stmtError)
          throw stmtError
        }
      }

      log(`[globalSetup] Schema ${schemaName} ready with ${schemaStatements.length} statements`)
    }

    // Create schemas sequentially to avoid connection pool contention
    // and PostgreSQL catalog lock conflicts during parallel CREATE TABLE.
    // With fsync=off + tmpfs, sequential creation is fast enough (~2-5s total).
    for (let workerId = 1; workerId <= MAX_WORKERS; workerId++) {
      await createSchema(workerId)
    }

    log(`[globalSetup] All ${MAX_WORKERS} worker schemas created successfully`)
  } catch (error) {
    console.error('[globalSetup] ERROR creating schemas:', error)
    throw error
  } finally {
    await sql.end()
  }
}

/** Drops all worker schemas after test execution completes. */
export async function teardown(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://test:test@localhost:5432/media_downloader_test'
  const prefix = getSchemaPrefix()

  // Suppress PostgreSQL NOTICE messages during cleanup
  const sql = postgres(databaseUrl, {onnotice: () => {}})

  try {
    for (let i = 1; i <= MAX_WORKERS; i++) {
      const schemaName = `${prefix}worker_${i}`
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    }
  } finally {
    await sql.end()
  }
}
