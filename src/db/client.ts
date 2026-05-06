/**
 * Drizzle ORM Client Wrapper for Aurora DSQL
 *
 * Provides pre-configured wrappers around \@mantleframework/database functions
 * using project env vars (DSQL_ENDPOINT, DSQL_REGION, DSQL_ROLE_NAME).
 *
 * @see \@mantleframework/database for IAM auth, token refresh, connection caching
 */
import {
  closeDrizzleClient as _closeDrizzleClient,
  getDrizzleClient as _getDrizzleClient,
  onConnectionInvalidated,
  withTransaction as _withTransaction
} from '@mantleframework/database'
import type {DatabaseConfig, TransactionClient} from '@mantleframework/database'
import {DsqlClusterArn} from '@mantleframework/core'
import {getRequiredEnv} from '@mantleframework/env'

function getDbConfig(): DatabaseConfig {
  const username = getRequiredEnv('DSQL_ROLE_NAME')
  return {
    provider: 'aurora-dsql',
    endpoint: DsqlClusterArn(getRequiredEnv('DSQL_ENDPOINT')),
    region: getRequiredEnv('DSQL_REGION'),
    username,
    isAdmin: username === 'admin'
  }
}

/** Returns a Drizzle client configured for the project's Aurora DSQL instance. */
export function getDrizzleClient() {
  return _getDrizzleClient(getDbConfig())
}

/** Closes the Drizzle client connection for the project's Aurora DSQL instance. */
export function closeDrizzleClient() {
  return _closeDrizzleClient(getDbConfig())
}

/** Runs `fn` inside a database transaction, rolling back on error. */
export async function withTransaction<T>(fn: (tx: Parameters<Parameters<typeof _withTransaction>[1]>[0]) => Promise<T>): Promise<T> {
  const db = await getDrizzleClient()
  return _withTransaction(db, fn)
}

export { onConnectionInvalidated }
export type { TransactionClient }
