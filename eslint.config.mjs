import {createMantleEslintConfig} from '@j0nathan-ll0yd/eslint-config'
import {createRequire} from 'node:module'

// Load local ESLint rules plugin (CommonJS module)
const require = createRequire(import.meta.url)
const localRulesPlugin = require('./config/eslint-local-rules/index.cjs')

export default createMantleEslintConfig({
  tsconfigRootDir: import.meta.dirname,
  ignores: [
    '**/docs',
    '**/secure',
    '**/static',
    '**/temp',
    '**/terraform',
    '**/coverage-reports',
    '**/bin',
    '**/.github',
    '**/.idea',
    '**/.webpackCache',
    'src/types/terraform.d.ts',
    'config/.dependency-cruiser.cjs',
    'config/eslint-local-rules/**',
    '**/*.fixture.ts',
    'infra/cloudfront-functions/**/*'
  ],
  localRulesPlugin,
  localRules: {
    'local-rules/no-direct-aws-sdk-import': 'error',
    'local-rules/use-entity-mock-helper': 'error',
    'local-rules/no-domain-leakage': 'error',
    'local-rules/integration-test-localstack': 'error',
    'local-rules/aws-sdk-mock-pattern': 'warn'
  },
  overrides: [
    // Relaxed JSDoc requirements for scripts and tooling (self-documenting per Code-Comments.md)
    {
      files: ['scripts/**/*.ts', 'graphrag/**/*.ts', 'config/**/*.ts'],
      rules: {
        'jsdoc/require-jsdoc': 'off',
        'jsdoc/require-param': 'off',
        'jsdoc/require-param-description': 'off',
        'jsdoc/require-returns': 'off',
        'jsdoc/require-returns-description': 'off'
      }
    },
    // Vendor wrappers are thin SDK facades - function names and types are self-documenting
    {files: ['src/lib/vendor/**/*.ts'], ignores: ['src/lib/vendor/**/*.test.ts'], rules: {'jsdoc/require-jsdoc': 'off'}},
    // Test helpers, setup files, and Lambda tests can import AWS SDK directly for mocking purposes
    // aws-sdk-client-mock requires direct SDK access for type-safe mocking
    {files: ['test/helpers/aws-sdk-mock.ts', 'test/setup.ts', 'src/lambdas/*/test/*.test.ts'], rules: {'local-rules/no-direct-aws-sdk-import': 'off'}},
    // Lambda handlers require a JSDoc description block (purpose documentation)
    // No @param/@returns tags required - TypeScript types are sufficient
    {
      files: ['src/lambdas/*/src/index.ts'],
      rules: {
        'jsdoc/require-jsdoc': ['error', {
          publicOnly: true,
          require: {FunctionDeclaration: true, MethodDefinition: false, ArrowFunctionExpression: false},
          contexts: ['ExportNamedDeclaration > FunctionDeclaration', 'ExportDefaultDeclaration > FunctionDeclaration'],
          enableFixer: false
        }],
        // Enforce consistent import order in Lambda handlers
        'local-rules/import-order': 'warn'
      }
    },
    // TypeScript bracket access is type-safe — security/detect-object-injection is a false positive
    {files: ['**/*.ts', '**/*.mts'], rules: {'security/detect-object-injection': 'off'}},
    // Relaxed TSDoc for test files and helpers
    {files: ['test/**/*.ts', 'test/**/*.mts'], rules: {'tsdoc/syntax': 'off'}},
    // Global rule overrides for false positives
    // AWS SDK response types mark nested properties as possibly undefined even after null checks
    // TypeScript's type narrowing is correct — the ?. and ?? are necessary safety guards
    {files: ['**/*.ts', '**/*.mts'], rules: {'@typescript-eslint/no-unnecessary-condition': 'off'}},
    // Set.has() is not always a meaningful improvement over Array.includes() for small arrays
    {files: ['**/*.ts', '**/*.mts'], rules: {'unicorn/prefer-set-has': 'off'}}
  ]
})
