/**
 * Test Isolation Validator
 *
 * Generic utilities re-exported from framework.
 * Instance-specific validateCleanState kept locally.
 */

import {sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {getWorkerSchema} from './postgres-helpers'

// Re-export generic utilities from framework
export { logIsolationConfig, validateResourceIsolation } from '@j0nathan-ll0yd/testing/integration'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDb = PostgresJsDatabase<any>

/**
 * Validates that the database connection is using the correct worker schema.
 * Wrapper around the framework's validateSchemaIsolation that auto-resolves the expected schema.
 *
 * @param db - Drizzle database instance
 * @returns The current schema name if validation passes
 * @throws Error if schema doesn't match expected worker schema
 */
export async function validateSchemaIsolation(db: AnyDrizzleDb): Promise<string> {
  const expectedSchema = getWorkerSchema()

  const result = await db.execute(sql`SELECT current_schema()`)
  const currentSchema = result[0]?.current_schema as string | undefined

  if (!currentSchema || currentSchema !== expectedSchema) {
    throw new Error(
      `[ISOLATION ERROR] Schema mismatch: expected '${expectedSchema}', got '${currentSchema ?? 'undefined'}'. ` +
        'This indicates a test isolation failure - tests may be sharing data.'
    )
  }

  return currentSchema
}

/**
 * Validates that key tables are empty (useful after truncation).
 * Instance-specific — uses media-downloader table names.
 *
 * @param db - Drizzle database instance
 * @param schema - Schema name to check
 * @returns Object with table counts
 */
export async function validateCleanState(db: AnyDrizzleDb, schema: string): Promise<Record<string, number>> {
  const tables = ['users', 'files', 'devices', 'sessions', 'accounts', 'user_files', 'user_devices', 'file_downloads', 'verification_token']

  const counts: Record<string, number> = {}
  const warnings: string[] = []

  for (const table of tables) {
    try {
      const result = await db.execute(sql.raw(`SELECT COUNT(*) as count FROM "${schema}"."${table}"`))
      const count = Number(result[0]?.count ?? 0)
      counts[table] = count

      if (count > 0) {
        warnings.push(`${table}: ${count} rows`)
      }
    } catch {
      // Table might not exist in schema
      counts[table] = -1
    }
  }

  if (warnings.length > 0 && process.env.LOG_LEVEL !== 'SILENT') {
    console.warn(`[ISOLATION WARNING] Residual data found in ${schema}:`, warnings.join(', '))
  }

  return counts
}
