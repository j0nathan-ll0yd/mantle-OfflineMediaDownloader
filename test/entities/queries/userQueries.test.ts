/**
 * Unit tests for User Queries
 *
 * Tests mutable logic: null coalescing (result[0] ?? null),
 * non-null assertions on returning(), and Zod validation passthrough.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDefineQueryMock, createMockDrizzleDb} from '#test/helpers/defineQuery-mock'
import {createMockUser} from '#test/helpers/entity-fixtures'

const mockDb = createMockDrizzleDb()

vi.mock('#db/defineQuery', () => createDefineQueryMock(mockDb))
vi.mock('#db/schema', () => ({users: {id: 'id', email: 'email'}}))
vi.mock('#db/zodSchemas',
  () => ({userInsertSchema: {parse: vi.fn((v: unknown) => v)}, userUpdateSchema: {partial: vi.fn(() => ({parse: vi.fn((v: unknown) => v)}))}}))
vi.mock('@mantleframework/database', () => ({DatabaseOperation: {Select: 'Select', Insert: 'Insert', Update: 'Update', Delete: 'Delete'}}))
vi.mock('@mantleframework/database/orm', () => ({eq: vi.fn((_col: unknown, _val: unknown) => 'eq-condition')}))

const {getUser, getUsersByEmail, createUser, updateUser, deleteUser} = await import('#entities/queries/userQueries')

describe('User Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getUser', () => {
    it('should return user when found', async () => {
      const mockUser = createMockUser()
      mockDb._setSelectResult([mockUser])

      const result = await getUser('user-1')

      expect(result).toEqual(mockUser)
    })

    it('should return null when user not found (null coalescing)', async () => {
      mockDb._setSelectResult([])

      const result = await getUser('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getUsersByEmail', () => {
    it('should return matching users', async () => {
      const users = [createMockUser(), createMockUser({id: 'user-2'})]
      mockDb._setSelectResult(users)

      const result = await getUsersByEmail('test@example.com')

      expect(result).toEqual(users)
    })

    it('should return empty array when no users match', async () => {
      mockDb._setSelectResult([])

      const result = await getUsersByEmail('nobody@example.com')

      expect(result).toEqual([])
    })
  })

  describe('createUser', () => {
    it('should return the created user', async () => {
      const mockUser = createMockUser()
      mockDb._setInsertResult([mockUser])

      const result = await createUser({email: 'test@example.com', emailVerified: true, name: 'Test'})

      expect(result).toEqual(mockUser)
    })
  })

  describe('updateUser', () => {
    it('should return the updated user', async () => {
      const mockUser = createMockUser({name: 'Updated'})
      mockDb._setUpdateResult([mockUser])

      const result = await updateUser('user-1', {name: 'Updated'})

      expect(result).toEqual(mockUser)
    })
  })

  describe('deleteUser', () => {
    it('should complete without error', async () => {
      mockDb._setDeleteResult([])

      await expect(deleteUser('user-1')).resolves.toBeUndefined()
    })
  })
})
