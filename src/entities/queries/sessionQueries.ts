/**
 * Session Queries - Drizzle ORM queries for session operations.
 * All queries are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 *
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@mantleframework/database'
import {eq, lt} from '@mantleframework/database/orm'
import type {InferInsertModel, InferSelectModel} from '@mantleframework/database/orm'
import {defineQuery} from '#db/defineQuery'
import {accounts, sessions, verification} from '#db/schema'
import {accountInsertSchema, sessionInsertSchema, sessionUpdateSchema, verificationInsertSchema} from '#db/zodSchemas'

export type SessionRow = InferSelectModel<typeof sessions>
export type AccountRow = InferSelectModel<typeof accounts>
export type VerificationRow = InferSelectModel<typeof verification>

export type CreateSessionInput = Omit<InferInsertModel<typeof sessions>, 'id' | 'createdAt' | 'updatedAt'>
export type UpdateSessionInput = Partial<Omit<InferInsertModel<typeof sessions>, 'id' | 'createdAt'>>

export type CreateAccountInput = Omit<InferInsertModel<typeof accounts>, 'id' | 'createdAt' | 'updatedAt'>
export type UpdateAccountInput = Partial<Omit<InferInsertModel<typeof accounts>, 'id' | 'createdAt'>>

export type CreateVerificationInput = Omit<InferInsertModel<typeof verification>, 'id' | 'createdAt' | 'updatedAt'>

// Session Operations

/**
 * Gets a session by ID.
 * @param id - The session's unique identifier
 * @returns The session row or null if not found
 */
export const getSession = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select]}]},
  async function getSession(db, id: string): Promise<SessionRow | null> {
    const result = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets a session by token.
 * @param token - The session token
 * @returns The session row or null if not found
 */
export const getSessionByToken = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select]}]},
  async function getSessionByToken(db, token: string): Promise<SessionRow | null> {
    const result = await db.select().from(sessions).where(eq(sessions.token, token)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets all sessions for a user.
 * @param userId - The user's unique identifier
 * @returns Array of session rows for the user
 */
export const getSessionsByUserId = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select]}]},
  async function getSessionsByUserId(db, userId: string): Promise<SessionRow[]> {
    return await db.select().from(sessions).where(eq(sessions.userId, userId))
  })

/**
 * Creates a new session.
 * @param input - The session data to create
 * @returns The created session row
 */
export const createSession = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createSession(db, input: CreateSessionInput): Promise<SessionRow> {
    // Validate session input against schema
    const validatedInput = sessionInsertSchema.parse(input)
    const [session] = await db.insert(sessions).values(validatedInput).returning()
    return session!
  })

/**
 * Updates a session by ID.
 * @param id - The session's unique identifier
 * @param data - The fields to update
 * @returns The updated session row
 */
export const updateSession = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select, DatabaseOperation.Update]}]},
  async function updateSession(db, id: string, data: UpdateSessionInput): Promise<SessionRow> {
    // Validate partial update data against schema
    const validatedData = sessionUpdateSchema.partial().parse(data)
    const [updated] = await db.update(sessions).set({...validatedData, updatedAt: new Date()}).where(eq(sessions.id, id)).returning()
    return updated!
  })

/**
 * Deletes a session by ID.
 * @param id - The session's unique identifier
 */
export const deleteSession = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteSession(db, id: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, id))
  })

/**
 * Deletes all sessions for a user.
 * @param userId - The user's unique identifier
 */
export const deleteSessionsByUserId = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteSessionsByUserId(db, userId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId))
  })

/**
 * Deletes expired sessions.
 * @returns Count of deleted records
 */
export const deleteExpiredSessions = defineQuery({tables: [{table: sessions, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteExpiredSessions(db): Promise<number> {
    const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({id: sessions.id})
    return result.length
  })

// Account Operations

/**
 * Gets an account by ID.
 * @param id - The account's unique identifier
 * @returns The account row or null if not found
 */
export const getAccount = defineQuery({tables: [{table: accounts, operations: [DatabaseOperation.Select]}]},
  async function getAccount(db, id: string): Promise<AccountRow | null> {
    const result = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets all accounts for a user.
 * @param userId - The user's unique identifier
 * @returns Array of account rows for the user
 */
export const getAccountsByUserId = defineQuery({tables: [{table: accounts, operations: [DatabaseOperation.Select]}]},
  async function getAccountsByUserId(db, userId: string): Promise<AccountRow[]> {
    return await db.select().from(accounts).where(eq(accounts.userId, userId))
  })

/**
 * Creates a new account.
 * @param input - The account data to create
 * @returns The created account row
 */
export const createAccount = defineQuery({tables: [{table: accounts, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createAccount(db, input: CreateAccountInput): Promise<AccountRow> {
    // Validate account input against schema
    const validatedInput = accountInsertSchema.parse(input)
    const [account] = await db.insert(accounts).values(validatedInput).returning()
    return account!
  })

/**
 * Deletes an account by ID.
 * @param id - The account's unique identifier
 */
export const deleteAccount = defineQuery({tables: [{table: accounts, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteAccount(db, id: string): Promise<void> {
    await db.delete(accounts).where(eq(accounts.id, id))
  })

/**
 * Deletes all accounts for a user.
 * @param userId - The user's unique identifier
 */
export const deleteAccountsByUserId = defineQuery({tables: [{table: accounts, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteAccountsByUserId(db, userId: string): Promise<void> {
    await db.delete(accounts).where(eq(accounts.userId, userId))
  })

// Verification Operations

/**
 * Gets a verification token by identifier.
 * @param identifier - The verification identifier
 * @returns The verification row or null if not found
 */
export const getVerificationByIdentifier = defineQuery({tables: [{table: verification, operations: [DatabaseOperation.Select]}]},
  async function getVerificationByIdentifier(db, identifier: string): Promise<VerificationRow | null> {
    const result = await db.select().from(verification).where(eq(verification.identifier, identifier)).limit(1)
    return result[0] ?? null
  })

/**
 * Creates a new verification token.
 * @param input - The verification data to create
 * @returns The created verification row
 */
export const createVerification = defineQuery({tables: [{table: verification, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createVerification(db, input: CreateVerificationInput): Promise<VerificationRow> {
    // Validate verification input against schema
    const validatedInput = verificationInsertSchema.parse(input)
    const [token] = await db.insert(verification).values(validatedInput).returning()
    return token!
  })

/**
 * Deletes a verification token by ID.
 * @param id - The verification token's unique identifier
 */
export const deleteVerification = defineQuery({tables: [{table: verification, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteVerification(db, id: string): Promise<void> {
    await db.delete(verification).where(eq(verification.id, id))
  })

/**
 * Deletes expired verification tokens.
 * @returns Count of deleted records
 */
export const deleteExpiredVerifications = defineQuery({tables: [{table: verification, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteExpiredVerifications(db): Promise<number> {
    const result = await db.delete(verification).where(lt(verification.expiresAt, new Date())).returning({id: verification.id})
    return result.length
  })
