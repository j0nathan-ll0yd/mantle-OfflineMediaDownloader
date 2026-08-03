/**
 * Prepared Queries for Performance-Critical Paths
 *
 * Prepared statements are cached across Lambda invocations,
 * providing 10-15% performance improvement for frequently-called queries.
 *
 * @see {@link https://orm.drizzle.team/docs/perf-queries | Drizzle Prepared Statements}
 */
import {DatabaseOperation} from '@j0nathan-ll0yd/database'
import {eq, sql} from '@j0nathan-ll0yd/database/orm'
import {definePreparedQuery} from '#db/defineQuery'
import {files, sessions, userFiles} from '#db/schema'
import type {FileRow} from './fileQueries'
import type {SessionRow} from './sessionQueries'

/**
 * Gets a file by S3 key using a prepared statement.
 * Use this for hot paths like S3ObjectCreated Lambda.
 * @param key - The S3 object key
 * @returns The file row or null if not found
 */
export const getFileByKeyPrepared = definePreparedQuery({tables: [{table: files, operations: [DatabaseOperation.Select]}]},
  async function getFileByKeyPrepared(db, key: string): Promise<FileRow | null> {
    const prepared = db.select().from(files).where(eq(files.key, sql.placeholder('key'))).prepare('get_file_by_key')
    const results = await prepared.execute({key})
    return results[0] ?? null
  })

/**
 * Gets all files for a user using a prepared statement.
 * Use this for hot paths like ListFiles Lambda.
 * @param userId - The user's unique identifier
 * @returns Array of file rows
 */
export const getUserFilesPrepared = definePreparedQuery({
  tables: [
    {table: userFiles, operations: [DatabaseOperation.Select]},
    {table: files, operations: [DatabaseOperation.Select]}
  ]
}, async function getUserFilesPrepared(db, userId: string): Promise<FileRow[]> {
  const prepared = db.select({file: files}).from(userFiles).innerJoin(files, eq(userFiles.fileId, files.fileId)).where(
    eq(userFiles.userId, sql.placeholder('userId'))
  ).prepare('get_user_files')
  const results = await prepared.execute({userId})
  return results.map((r) => r.file)
})

/**
 * Gets a session by token using a prepared statement.
 * Use this for hot paths like ApiGatewayAuthorizer Lambda.
 * @param token - The session token
 * @returns The session row or null if not found
 */
export const getSessionByTokenPrepared = definePreparedQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select]}]},
  async function getSessionByTokenPrepared(db, token: string): Promise<SessionRow | null> {
    const prepared = db.select().from(sessions).where(eq(sessions.token, sql.placeholder('token'))).limit(1).prepare('get_session_by_token')
    const results = await prepared.execute({token})
    return results[0] ?? null
  })
