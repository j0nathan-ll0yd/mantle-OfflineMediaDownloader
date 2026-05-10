import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineLambda, withObservability} from '@mantleframework/core'
import {logInfo} from '@mantleframework/observability'
import {applyPermissions, runMigrations, validatePermissions} from '@mantleframework/database'
import type {MigrateResult, PermissionsResult, ValidatePermissionsResult} from '@mantleframework/database'
import {DsqlClusterArn} from '@mantleframework/core'
import {getRequiredEnv} from '@mantleframework/env'

const __dirname = dirname(fileURLToPath(import.meta.url))

defineLambda({timeout: 300})

interface MigrateDSQLResult {
  migrations: MigrateResult
  permissions: PermissionsResult
  validation: ValidatePermissionsResult
}

export const handler = withObservability({operationName: 'MigrateDSQL'}, async () => {
  const database = {
    provider: 'aurora-dsql' as const,
    endpoint: DsqlClusterArn(getRequiredEnv('DSQL_ENDPOINT')),
    region: getRequiredEnv('AWS_REGION'),
    isAdmin: true
  }
  const logger = (msg: string) => logInfo(msg)

  // 1. Schema migrations (DDL) -- append-only, tracked
  const migrationResult = await runMigrations({migrationsFolder: join(__dirname, 'migrations'), database, logger})

  // 2. Permissions (DCL) -- idempotent, re-applied every deploy
  const permissionResult = await applyPermissions({permissionsFolder: join(__dirname, 'permissions'), database, logger})

  // 3. Validate grants -- detect tables that DSQL silently skipped, re-apply
  const validationResult = await validatePermissions({permissionsFolder: join(__dirname, 'permissions'), database, logger})

  return {migrations: migrationResult, permissions: permissionResult, validation: validationResult} satisfies MigrateDSQLResult
})
