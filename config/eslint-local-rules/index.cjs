/**
 * ESLint Local Rules Plugin
 * Project-specific ESLint rules for in-editor convention enforcement
 *
 * Rules duplicated in @mantleframework/eslint-rules have been removed.
 * Only project-specific rules remain here.
 */

const noDirectAwsSdkImport = require('./rules/no-direct-aws-sdk-import.cjs')
const useEntityMockHelper = require('./rules/use-entity-mock-helper.cjs')
const noDomainLeakage = require('./rules/no-domain-leakage.cjs')
const integrationTestLocalstack = require('./rules/integration-test-localstack.cjs')
const awsSdkMockPattern = require('./rules/aws-sdk-mock-pattern.cjs')

module.exports = {
  rules: {
    'no-direct-aws-sdk-import': noDirectAwsSdkImport,
    'use-entity-mock-helper': useEntityMockHelper,
    'no-domain-leakage': noDomainLeakage,
    'integration-test-localstack': integrationTestLocalstack,
    'aws-sdk-mock-pattern': awsSdkMockPattern
  }
}
