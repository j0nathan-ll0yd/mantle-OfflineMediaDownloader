import {sql} from 'drizzle-orm'
import {defineLambda} from '@mantleframework/core'
import {getDrizzleClient} from '@mantleframework/database'
import {getRequiredEnv} from '@mantleframework/env'
import {defineMcpHandler, frameworkTools, McpAuthMode} from '@mantleframework/mcp'
import type {McpDatabaseConnection} from '@mantleframework/mcp'

// mantle-ignore observability-coverage — defineMcpHandler wraps with withObservability internally
defineLambda({timeout: 30, memorySize: 512, env: ['DATA_BUCKET', 'EVENT_BUS_NAME']})

async function getDevToolsConnection(): Promise<McpDatabaseConnection> {
  const db = await getDrizzleClient({
    provider: 'aurora-dsql',
    endpoint: getRequiredEnv('DSQL_ENDPOINT'),
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
