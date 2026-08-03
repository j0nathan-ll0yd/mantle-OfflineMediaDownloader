/**
 * User Queries - Drizzle ORM queries for user operations.
 *
 * All queries are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 * OAuth account data is managed by Better Auth in the accounts table.
 *
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@j0nathan-ll0yd/database'
import {eq} from '@j0nathan-ll0yd/database/orm'
import type {InferInsertModel, InferSelectModel} from '@j0nathan-ll0yd/database/orm'
import {defineQuery} from '#db/defineQuery'
import {users} from '#db/schema'
import {userInsertSchema, userUpdateSchema} from '#db/zodSchemas'

export type UserRow = InferSelectModel<typeof users>

export type UserItem = UserRow

export type CreateUserInput = Omit<InferInsertModel<typeof users>, 'id' | 'createdAt' | 'updatedAt'> & {id?: string}

export type UpdateUserInput = Partial<Omit<InferInsertModel<typeof users>, 'id' | 'createdAt'>>

/**
 * Gets a user by ID.
 * @param id - The user's UUID
 * @returns The user, or null if not found
 */
export const getUser = defineQuery({tables: [{table: users, operations: [DatabaseOperation.Select]}]},
  async function getUser(db, id: string): Promise<UserItem | null> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1)
    return result[0] ?? null
  })

/**
 * Finds users by email.
 * @param email - The email address to search for
 * @returns Array of users matching the email
 */
export const getUsersByEmail = defineQuery({tables: [{table: users, operations: [DatabaseOperation.Select]}]},
  async function getUsersByEmail(db, email: string): Promise<UserItem[]> {
    return db.select().from(users).where(eq(users.email, email))
  })

/**
 * Creates a new user.
 * @param input - The user data
 * @returns The created user
 */
export const createUser = defineQuery({tables: [{table: users, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createUser(db, input: CreateUserInput): Promise<UserItem> {
    const validatedUser = userInsertSchema.parse(input)
    const [user] = await db.insert(users).values({...validatedUser, updatedAt: new Date()}).returning()
    return user!
  })

/**
 * Updates a user by ID.
 * @param id - The user's UUID
 * @param data - The fields to update
 * @returns The updated user
 */
export const updateUser = defineQuery({tables: [{table: users, operations: [DatabaseOperation.Select, DatabaseOperation.Update]}]},
  async function updateUser(db, id: string, data: UpdateUserInput): Promise<UserItem> {
    const validatedData = userUpdateSchema.partial().parse(data)
    const [updated] = await db.update(users).set({...validatedData, updatedAt: new Date()}).where(eq(users.id, id)).returning()
    return updated!
  })

/**
 * Deletes a user by ID.
 * Note: Does NOT cascade - call deleteUserCascade for full cleanup.
 * @param id - The user's UUID
 */
export const deleteUser = defineQuery({tables: [{table: users, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteUser(db, id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id))
  })
