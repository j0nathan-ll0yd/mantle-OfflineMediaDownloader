import {Project} from 'ts-morph'
import {describe, expect, it} from 'vitest'
import {buildTableIndex, extractEntityAccess} from '../../graphrag/extract'

const SCHEMA = `
declare function pgTable(name: string, columns: object): {id: string}
export const users = pgTable('users', {})
export const files = pgTable('files', {})
export const devices = pgTable('devices', {})
`

const USER_QUERIES = `
import {users} from '#db/schema'
export type UserRow = {id: string}
export const getUser = async (id: string) => [users, id]
`

const FILE_QUERIES = `
import {files} from '#db/schema'
export const getFile = async (id: string) => [files, id]
`

const DEVICE_QUERIES = `
import {devices} from '#db/schema'
export const getDevice = async (id: string) => [devices, id]
`

const QUERIES_INDEX = `
export {getUser, type UserRow} from './userQueries'
export {getFile} from './fileQueries'
export {getDevice} from './deviceQueries'
`

/** Build an in-memory project shaped like this repo: schema tables, query files, and the #entities/queries index */
function createProject(lambdaSource: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {baseUrl: '/', paths: {'#db/*': ['src/db/*'], '#entities/*': ['src/entities/*']}}
  })
  project.createSourceFile('/src/db/schema.ts', SCHEMA)
  project.createSourceFile('/src/entities/queries/userQueries.ts', USER_QUERIES)
  project.createSourceFile('/src/entities/queries/fileQueries.ts', FILE_QUERIES)
  project.createSourceFile('/src/entities/queries/deviceQueries.ts', DEVICE_QUERIES)
  project.createSourceFile('/src/entities/queries/index.ts', QUERIES_INDEX)
  project.createSourceFile('/src/lambdas/api/example.post.ts', lambdaSource)
  const tables = buildTableIndex(project.getSourceFileOrThrow('/src/db/schema.ts'))
  return {project, tables}
}

describe('graphrag extractEntityAccess', () => {
  it('emits exactly the entities owned by the named queries a Lambda imports', () => {
    const {project, tables} = createProject(`
      import {getFile, getUser} from '#entities/queries'
      export const handler = async () => [await getUser('u'), await getFile('f')]
    `)

    const entities = extractEntityAccess(project, tables, ['/src/lambdas/api/example.post.ts'])

    expect(entities).toEqual(['Users', 'Files'])
  })

  it('emits no entities for a Lambda that imports no queries', () => {
    const {project, tables} = createProject(`
      import type {UserRow} from '#entities/queries'
      export const handler = async (row: UserRow) => row.id
    `)

    const entities = extractEntityAccess(project, tables, ['/src/lambdas/api/example.post.ts'])

    expect(entities).toEqual([])
  })
})
