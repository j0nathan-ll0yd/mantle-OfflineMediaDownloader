import {sql} from 'drizzle-orm'
import {defineLambda} from '@j0nathan-ll0yd/core'
import {DsqlClusterArn} from '@j0nathan-ll0yd/core'
import {getDrizzleClient} from '@j0nathan-ll0yd/database'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {defineMcpHandler, frameworkTools, McpAuthMode} from '@j0nathan-ll0yd/mcp'
import type {McpDatabaseConnection} from '@j0nathan-ll0yd/mcp'

defineLambda({timeout: 30, memorySize: 512, env: ['DATA_BUCKET', 'EVENT_BUS_NAME'], bind: {DATA_BUCKET: 'files'}})

async function getDevToolsConnection(): Promise<McpDatabaseConnection> {
  const db = await getDrizzleClient({
    provider: 'aurora-dsql',
    endpoint: DsqlClusterArn(getRequiredEnv('DSQL_ENDPOINT')),
    region: getRequiredEnv('DSQL_REGION'),
    username: 'lambda_dev_tools',
    isAdmin: false
  })
  return {
    execute: async (query: string) => {
      const result = await db.execute(sql.raw(query))
      return [...result]
    }
  }
}

export const {handler} = defineMcpHandler({
  serverName: 'media-downloader-dev-tools',
  auth: McpAuthMode.bearer,
  tools: frameworkTools({getConnection: getDevToolsConnection})
})
