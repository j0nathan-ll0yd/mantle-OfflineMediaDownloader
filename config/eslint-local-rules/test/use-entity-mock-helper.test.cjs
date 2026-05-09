/**
 * Tests for use-entity-mock-helper ESLint rule
 *
 * Rule detects deprecated legacy entity mocking patterns.
 * With native Drizzle query functions, tests should mock #entities/queries directly.
 */

const {RuleTester} = require('eslint')
const rule = require('../rules/use-entity-mock-helper.cjs')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  }
})

ruleTester.run('use-entity-mock-helper', rule, {
  valid: [
    // Allowed: Native Drizzle query mocking
    {
      code: `vi.mock('#entities/queries', () => ({
        getUser: vi.fn(),
        createUser: vi.fn(),
        updateUser: vi.fn()
      }))`,
      filename: 'src/lambdas/LoginUser/test/index.test.ts'
    },
    // Allowed: Non-entity mock in test file
    {
      code: `vi.mock('#lib/vendor/AWS/S3', () => ({
        uploadFile: vi.fn()
      }))`,
      filename: 'src/lambdas/StartFileUpload/test/index.test.ts'
    },
    // Allowed: Non-test file (rule doesn't apply)
    {
      code: `vi.mock('#entities/Users', () => ({
        Users: { get: vi.fn() }
      }))`,
      filename: 'src/lambdas/ListFiles/src/index.ts'
    },
    // Allowed: Mock helper file itself
    {
      code: `export function createMockHelpers(config) {
        return { getUser: vi.fn() }
      }`,
      filename: 'test/helpers/drizzle-mock.ts'
    },
    // Allowed: jest.mock with non-entity module
    {
      code: `jest.mock('#lib/vendor/BetterAuth/config', () => ({
        getAuth: jest.fn()
      }))`,
      filename: 'src/lambdas/LoginUser/test/index.test.ts'
    }
  ],
  invalid: [
    // Deprecated: Legacy entity mock path
    {
      code: `vi.mock('#entities/Users', () => ({
        Users: {
          get: vi.fn(),
          query: { byEmail: vi.fn() }
        }
      }))`,
      filename: 'src/lambdas/LoginUser/test/index.test.ts',
      errors: [{messageId: 'legacyEntityMock'}]
    },
    // Deprecated: Legacy mock for Files entity
    {
      code: `vi.mock('#entities/Files', () => ({
        Files: { create: vi.fn(), get: vi.fn() }
      }))`,
      filename: 'src/lambdas/ListFiles/test/index.test.ts',
      errors: [{messageId: 'legacyEntityMock'}]
    },
    // Deprecated: jest.mock with legacy entity path
    {
      code: `jest.mock('#entities/Devices', () => ({
        Devices: { get: jest.fn() }
      }))`,
      filename: 'src/lambdas/RegisterDevice/test/index.test.ts',
      errors: [{messageId: 'legacyEntityMock'}]
    },
    // Deprecated: Mocking legacy UserFiles entity
    {
      code: `vi.mock('#entities/UserFiles', () => ({
        UserFiles: { query: { byUser: vi.fn() } }
      }))`,
      filename: 'test/integration/user-files.test.ts',
      errors: [{messageId: 'legacyEntityMock'}]
    },
    // Deprecated: Using createEntityMock helper
    {
      code: `vi.mock('#entities/Users', () => ({
        Users: createEntityMock({queryIndexes: ['byEmail']})
      }))`,
      filename: 'src/lambdas/LoginUser/test/index.test.ts',
      errors: [{messageId: 'legacyEntityMock'}, {messageId: 'deprecatedHelper'}]
    }
  ]
})

console.log('use-entity-mock-helper: All tests passed!')
