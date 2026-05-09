import {defineConfig} from 'drizzle-kit'

/**
 * Drizzle Kit Configuration
 *
 * Used for generating SQL migrations from the Drizzle schema.
 * This config is for SQL generation only - not for direct database connections.
 *
 * Usage:
 *   pnpm run db:export   - Export current schema as SQL
 *   pnpm run db:generate - Generate migration from schema diff
 *
 * Note: Aurora DSQL requires manual post-processing of generated SQL:
 *   - Replace CREATE INDEX with CREATE INDEX ASYNC
 *   - Add IF NOT EXISTS to all statements
 *
 * @see docs/wiki/Conventions/Database-Migrations.md
 */
export default defineConfig({dialect: 'postgresql', schema: './src/db/schema.ts', out: './migrations'})
