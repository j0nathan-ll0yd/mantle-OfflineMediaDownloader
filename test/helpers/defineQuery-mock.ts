/**
 * Mock utilities for defineQuery/definePreparedQuery testing.
 *
 * Provides a fully chainable mock Drizzle db that supports all query patterns
 * used in entity queries: select, insert, update, delete with chaining.
 *
 * @see src/db/defineQuery.ts for the real factory
 */
import {vi} from 'vitest'

/**
 * Terminal mock that resolves to a configurable result.
 * Used as the final step in any chain (where, returning, limit, execute).
 */
export function createTerminalMock(defaultValue: unknown = []) {
  const mock = vi.fn().mockResolvedValue(defaultValue)
  // Make it thenable so `await db.select().from(table).where(cond)` works
  const thenableMock = Object.assign(mock, {
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => mock().then(resolve, reject),
    limit: vi.fn().mockImplementation(() => thenableMock),
    returning: vi.fn().mockImplementation(() => thenableMock),
    where: vi.fn().mockImplementation(() => thenableMock)
  })
  return thenableMock
}

export interface MockDrizzleDb {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  _selectResult: unknown[]
  _insertResult: unknown[]
  _updateResult: unknown[]
  _deleteResult: unknown[]
  _setSelectResult: (result: unknown[]) => void
  _setInsertResult: (result: unknown[]) => void
  _setUpdateResult: (result: unknown[]) => void
  _setDeleteResult: (result: unknown[]) => void
}

/**
 * Creates a fully chainable mock Drizzle db.
 *
 * Supports chains like:
 * - db.select().from(table).where(cond).limit(n)
 * - db.select({col}).from(table).where(cond)
 * - db.insert(table).values(data).returning()
 * - db.insert(table).values(data).onConflictDoUpdate({...}).returning()
 * - db.insert(table).values(data).onConflictDoNothing({...}).returning()
 * - db.update(table).set(data).where(cond).returning()
 * - db.delete(table).where(cond)
 *
 * Configure results via `_setSelectResult`, `_setInsertResult`, etc.
 */
export function createMockDrizzleDb(): MockDrizzleDb {
  let selectResult: unknown[] = []
  let insertResult: unknown[] = []
  let updateResult: unknown[] = []
  let deleteResult: unknown[] = []

  // Select chain: select() -> from() -> where() -> limit() -> [resolves]
  // Also: select() -> from() -> innerJoin() -> where() -> [resolves]
  const selectChain = () => {
    const terminal = {
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(selectResult).then(resolve, reject),
      limit: vi.fn().mockImplementation(() => terminal),
      where: vi.fn().mockImplementation(() => terminal)
    }
    const fromResult = {
      where: vi.fn().mockImplementation(() => terminal),
      innerJoin: vi.fn().mockImplementation(() => fromResult),
      limit: vi.fn().mockImplementation(() => terminal),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(selectResult).then(resolve, reject)
    }
    return {from: vi.fn().mockImplementation(() => fromResult)}
  }

  // Insert chain: insert() -> values() -> returning() / onConflictDoUpdate().returning() / onConflictDoNothing().returning()
  const insertChain = () => {
    const returningFn = vi.fn().mockImplementation(() => Promise.resolve(insertResult))
    const conflictResult = {returning: returningFn}
    return {
      values: vi.fn().mockImplementation(() => ({
        returning: returningFn,
        onConflictDoUpdate: vi.fn().mockImplementation(() => conflictResult),
        onConflictDoNothing: vi.fn().mockImplementation(() => conflictResult)
      }))
    }
  }

  // Update chain: update() -> set() -> where() -> returning()
  const updateChain = () => {
    const returningFn = vi.fn().mockImplementation(() => Promise.resolve(updateResult))
    return {set: vi.fn().mockImplementation(() => ({where: vi.fn().mockImplementation(() => ({returning: returningFn}))}))}
  }

  // Delete chain: delete() -> where()
  const deleteChain = () => ({where: vi.fn().mockImplementation(() => Promise.resolve(deleteResult))})

  const db: MockDrizzleDb = {
    select: vi.fn().mockImplementation(() => selectChain()),
    insert: vi.fn().mockImplementation(() => insertChain()),
    update: vi.fn().mockImplementation(() => updateChain()),
    delete: vi.fn().mockImplementation(() => deleteChain()),
    _selectResult: selectResult,
    _insertResult: insertResult,
    _updateResult: updateResult,
    _deleteResult: deleteResult,
    _setSelectResult: (result: unknown[]) => {
      selectResult = result
    },
    _setInsertResult: (result: unknown[]) => {
      insertResult = result
    },
    _setUpdateResult: (result: unknown[]) => {
      updateResult = result
    },
    _setDeleteResult: (result: unknown[]) => {
      deleteResult = result
    }
  }

  return db
}

/**
 * Creates the mock factory for `#db/defineQuery`.
 *
 * Returns a mock module where defineQuery(config, fn) returns (...args) => fn(mockDb, ...args).
 * This allows tests to control what the mock db returns and verify query logic.
 */
export function createDefineQueryMock(db: MockDrizzleDb) {
  return {
    defineQuery: vi.fn().mockImplementation((_config: unknown, fn: (...args: unknown[]) => unknown) => {
      return (...args: unknown[]) => fn(db, ...args)
    }),
    definePreparedQuery: vi.fn().mockImplementation((_config: unknown, fn: (...args: unknown[]) => unknown) => {
      return (...args: unknown[]) => fn(db, ...args)
    })
  }
}
