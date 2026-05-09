/**
 * DSQL Permissions Generator
 *
 * Generates per-Lambda database permissions from entity query `@RequiresTable` decorators.
 * This is a comprehensive generator that replaces both generateTerraformPermissions.ts
 * and generateDbRolesMigration.ts with a unified approach.
 *
 * Generates from build/entity-permissions.json:
 * 1. infra/dsql_permissions.tf - Terraform locals and for_each resources
 * 2. migrations/0002_lambda_roles.sql - Per-Lambda PostgreSQL roles with GRANTs
 * 3. build/dsql-permissions-report.md - Human-readable report
 *
 * Usage: pnpm run generate:dsql-permissions
 *
 * @see docs/wiki/Infrastructure/Database-Permissions.md
 */
import {execSync} from 'child_process'
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'fs'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'
import {writeIfChanged, WriteResult} from './lib/writeIfChanged.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '..')

interface TablePermission {
  table: string
  operations: string[]
}

interface LambdaPermissions {
  tables: TablePermission[]
  computedAccessLevel: 'readonly' | 'readwrite' | 'admin'
}

interface PermissionsManifest {
  lambdas: Record<string, LambdaPermissions>
  generatedAt: string
}

/**
 * Convert PascalCase Lambda name to snake_case PostgreSQL role name.
 * ListFiles -\> lambda_list_files
 * S3ObjectCreated -\> lambda_s3_object_created
 */
function lambdaNameToRoleName(lambdaName: string): string {
  // Special case for admin (MigrateDSQL uses built-in admin role)
  if (lambdaName === 'MigrateDSQL') {
    return 'admin'
  }
  return 'lambda_' + lambdaName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/_{2,}/g, '_')
}

/**
 * Generate GRANT statements for a role's table permissions.
 * Groups operations by table for cleaner SQL.
 */
function generateGrants(roleName: string, tables: TablePermission[]): string[] {
  return tables.map((t) => {
    const ops = t.operations.join(', ')
    return `GRANT ${ops} ON ${t.table} TO ${roleName};`
  })
}

/**
 * Generate Terraform HCL for per-Lambda DSQL permissions.
 */
function generateTerraformHcl(manifest: PermissionsManifest): string {
  const lines: string[] = [
    '# Auto-generated from @RequiresTable decorators',
    '# Do not edit manually - run: pnpm run generate:dsql-permissions',
    `# Generated at: ${new Date().toISOString()}`,
    '',
    'locals {',
    '  # Per-Lambda PostgreSQL role configuration',
    '  # Maps Lambda function names to their PostgreSQL role and admin status',
    '  lambda_dsql_roles = {'
  ]

  const entries = Object.entries(manifest.lambdas).sort((a, b) => a[0].localeCompare(b[0]))

  for (const [lambdaName, perms] of entries) {
    const roleName = lambdaNameToRoleName(lambdaName)
    const requiresAdmin = perms.computedAccessLevel === 'admin'
    lines.push(`    "${lambdaName}" = {`)
    lines.push(`      role_name      = "${roleName}"`)
    lines.push(`      requires_admin = ${requiresAdmin}`)
    lines.push('    }')
  }

  lines.push('  }')
  lines.push('')
  lines.push('  # Partition by IAM requirement')
  lines.push('  # Non-admin Lambdas use dsql:DbConnect with custom PostgreSQL roles')
  lines.push('  lambda_dsql_connect = {')
  lines.push('    for k, v in local.lambda_dsql_roles : k => v if !v.requires_admin')
  lines.push('  }')
  lines.push('')
  lines.push('  # Admin Lambdas use dsql:DbConnectAdmin with built-in admin user')
  lines.push('  lambda_dsql_admin = {')
  lines.push('    for k, v in local.lambda_dsql_roles : k => v if v.requires_admin')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push('# =============================================================================')
  lines.push('# IAM Policy Attachments (generated with for_each)')
  lines.push('# =============================================================================')
  lines.push('# These replace the hardcoded aws_iam_role_policy_attachment resources')
  lines.push('# in individual Lambda .tf files.')
  lines.push('')
  lines.push('resource "aws_iam_role_policy_attachment" "lambda_dsql_connect" {')
  lines.push('  for_each   = local.lambda_dsql_connect')
  lines.push('  role       = "${var.resource_prefix}-${each.key}"')
  lines.push('  policy_arn = aws_iam_policy.LambdaDSQLConnect.arn')
  lines.push('}')
  lines.push('')
  lines.push('resource "aws_iam_role_policy_attachment" "lambda_dsql_admin" {')
  lines.push('  for_each   = local.lambda_dsql_admin')
  lines.push('  role       = "${var.resource_prefix}-${each.key}"')
  lines.push('  policy_arn = aws_iam_policy.LambdaDSQLAdminConnect.arn')
  lines.push('}')
  lines.push('')

  return lines.join('\n')
}

/**
 * Generate SQL migration for per-Lambda PostgreSQL roles.
 */
function generateSqlMigration(manifest: PermissionsManifest): string {
  const lines: string[] = [
    '-- Migration: 0002_lambda_roles',
    '-- Description: Per-Lambda PostgreSQL roles with fine-grained table permissions',
    '-- Auto-generated from @RequiresTable decorators',
    `-- Generated at: ${new Date().toISOString()}`,
    '--',
    '-- This migration creates per-Lambda PostgreSQL roles and grants them',
    '-- exactly the table permissions declared in their @RequiresTable decorators.',
    '-- Note: ${AWS_ACCOUNT_ID} is replaced at runtime by MigrateDSQL handler.',
    '',
    '-- =============================================================================',
    '-- CREATE ROLES (per-Lambda with LOGIN for IAM auth)',
    '-- =============================================================================',
    ''
  ]

  const entries = Object.entries(manifest.lambdas).sort((a, b) => a[0].localeCompare(b[0]))

  // Create roles (skip admin which is built-in)
  for (const [lambdaName, perms] of entries) {
    if (perms.computedAccessLevel === 'admin') {
      lines.push(`-- ${lambdaName}: Uses built-in admin role (DDL/DML access)`)
      continue
    }
    const roleName = lambdaNameToRoleName(lambdaName)
    lines.push(`CREATE ROLE ${roleName} WITH LOGIN;`)
  }

  lines.push('')
  lines.push('-- =============================================================================')
  lines.push('-- GRANT TABLE PERMISSIONS (per-Lambda least-privilege)')
  lines.push('-- =============================================================================')
  lines.push('')

  // Grant table permissions
  for (const [lambdaName, perms] of entries) {
    if (perms.computedAccessLevel === 'admin') {
      continue // Admin has full access, no explicit grants needed
    }
    const roleName = lambdaNameToRoleName(lambdaName)
    const tableList = perms.tables.map((t) => t.table).join(', ')
    lines.push(`-- ${lambdaName}: ${tableList}`)
    const grants = generateGrants(roleName, perms.tables)
    lines.push(...grants)
    lines.push('')
  }

  lines.push('-- =============================================================================')
  lines.push('-- AWS IAM GRANT (associate Lambda IAM roles with PostgreSQL roles)')
  lines.push('-- =============================================================================')
  lines.push('-- These statements link AWS IAM roles to PostgreSQL roles for authentication.')
  lines.push('-- ${AWS_ACCOUNT_ID} and ${RESOURCE_PREFIX} are replaced at runtime by MigrateDSQL handler.')
  lines.push('')

  // AWS IAM GRANT statements
  for (const [lambdaName, perms] of entries) {
    if (perms.computedAccessLevel === 'admin') {
      lines.push(`-- ${lambdaName}: Uses admin (no IAM GRANT needed, uses DbConnectAdmin)`)
      continue
    }
    const roleName = lambdaNameToRoleName(lambdaName)
    lines.push(`AWS IAM GRANT ${roleName} TO 'arn:aws:iam::\${AWS_ACCOUNT_ID}:role/\${RESOURCE_PREFIX}-${lambdaName}';`)
  }

  lines.push('')

  return lines.join('\n')
}

/**
 * Generate human-readable report of permissions.
 */
function generateReport(manifest: PermissionsManifest): string {
  const lines: string[] = [
    '# DSQL Permissions Report',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Summary',
    ''
  ]

  const entries = Object.entries(manifest.lambdas).sort((a, b) => a[0].localeCompare(b[0]))
  const counts = {readonly: 0, readwrite: 0, admin: 0}
  for (const [, perms] of entries) {
    counts[perms.computedAccessLevel]++
  }

  lines.push(`- **Total Lambdas**: ${entries.length}`)
  lines.push(`- **Readonly**: ${counts.readonly}`)
  lines.push(`- **Readwrite**: ${counts.readwrite}`)
  lines.push(`- **Admin**: ${counts.admin}`)
  lines.push('')
  lines.push('## Per-Lambda Permissions')
  lines.push('')

  for (const [lambdaName, perms] of entries) {
    const roleName = lambdaNameToRoleName(lambdaName)
    lines.push(`### ${lambdaName}`)
    lines.push('')
    lines.push(`- **PostgreSQL Role**: \`${roleName}\``)
    lines.push(`- **Access Level**: ${perms.computedAccessLevel}`)
    lines.push('')

    if (perms.tables.length > 0) {
      lines.push('| Table | Operations |')
      lines.push('|-------|------------|')
      for (const t of perms.tables) {
        lines.push(`| ${t.table} | ${t.operations.join(', ')} |`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const manifestPath = join(projectRoot, 'build/entity-permissions.json')

  if (!existsSync(manifestPath)) {
    console.error('Error: build/entity-permissions.json not found.')
    console.error('Run: pnpm run extract:entity-permissions first.')
    process.exit(1)
  }

  const manifest: PermissionsManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

  // Manual overrides for Lambdas that access DB through service layers not traced by dependency graph
  // These Lambdas use sessionService, BetterAuth, or Drizzle directly instead of entity queries
  const manualOverrides: Record<string, LambdaPermissions> = {
    // Uses sessionService -> entity queries (indirect, not traced)
    ApiGatewayAuthorizer: {tables: [{table: 'sessions', operations: ['SELECT']}], computedAccessLevel: 'readonly'},
    // Uses sessionService -> entity queries (indirect, not traced)
    RefreshToken: {tables: [{table: 'sessions', operations: ['SELECT', 'UPDATE']}], computedAccessLevel: 'readwrite'},
    // Uses BetterAuth which manages sessions/accounts/users internally
    LoginUser: {
      tables: [
        {table: 'users', operations: ['SELECT', 'INSERT', 'UPDATE']},
        {table: 'sessions', operations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']},
        {table: 'accounts', operations: ['SELECT', 'INSERT']}
      ],
      computedAccessLevel: 'readwrite'
    },
    // Uses Drizzle directly for cleanup operations
    CleanupExpiredRecords: {
      tables: [
        {table: 'sessions', operations: ['SELECT', 'DELETE']},
        {table: 'verification', operations: ['SELECT', 'DELETE']},
        {table: 'file_downloads', operations: ['SELECT', 'DELETE']}
      ],
      computedAccessLevel: 'readwrite'
    },
    // Uses Drizzle directly for migrations - needs admin access
    MigrateDSQL: {
      tables: [], // Admin uses all tables
      computedAccessLevel: 'admin'
    }
  }

  // Merge manual overrides (don't override if already present from entity tracing)
  for (const [name, perms] of Object.entries(manualOverrides)) {
    if (!manifest.lambdas[name]) {
      manifest.lambdas[name] = perms
      console.log(`Added manual override: ${name} (${perms.computedAccessLevel})`)
    }
  }

  console.log(`Loaded permissions for ${Object.keys(manifest.lambdas).length} Lambdas`)
  console.log('')

  // Ensure directories exist
  const terraformDir = join(projectRoot, 'terraform')
  const migrationsDir = join(projectRoot, 'migrations')
  const buildDir = join(projectRoot, 'build')

  if (!existsSync(terraformDir)) {
    mkdirSync(terraformDir, {recursive: true})
  }
  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, {recursive: true})
  }
  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, {recursive: true})
  }

  // Generate Terraform HCL - format with tofu fmt if available
  const terraformHcl = generateTerraformHcl(manifest)
  const terraformPath = join(terraformDir, 'dsql_permissions.tf')
  let formattedTerraform = terraformHcl

  // Try to format with tofu if available (optional - may not be installed in CI)
  try {
    execSync('which tofu', {stdio: 'pipe'})
    const tempPath = join(terraformDir, 'dsql_permissions_tmp.tf')
    writeFileSync(tempPath, terraformHcl)
    execSync(`tofu fmt ${tempPath}`, {stdio: 'pipe'})
    formattedTerraform = readFileSync(tempPath, 'utf-8')
    unlinkSync(tempPath)
  } catch {
    console.log('Note: tofu not installed, skipping Terraform formatting')
  }

  const terraformResult = writeIfChanged(terraformPath, formattedTerraform)

  // Generate SQL migration
  const sqlMigration = generateSqlMigration(manifest)
  const migrationPath = join(migrationsDir, '0002_lambda_roles.sql')
  const migrationResult = writeIfChanged(migrationPath, sqlMigration)

  // Generate report
  const report = generateReport(manifest)
  const reportPath = join(buildDir, 'dsql-permissions-report.md')
  const reportResult = writeIfChanged(reportPath, report)

  // Report write results
  const logResult = (result: WriteResult) => {
    if (result.written) {
      console.log(`${result.reason === 'new' ? 'Created' : 'Updated'}: ${result.path}`)
    } else {
      console.log(`No changes: ${result.path}`)
    }
  }
  logResult(terraformResult)
  logResult(migrationResult)
  logResult(reportResult)

  // Summary
  console.log('')
  console.log('=== Access Level Summary ===')
  const counts = {readonly: 0, readwrite: 0, admin: 0}
  for (const perms of Object.values(manifest.lambdas)) {
    counts[perms.computedAccessLevel]++
  }
  console.log(`  readonly:  ${counts.readonly} Lambdas`)
  console.log(`  readwrite: ${counts.readwrite} Lambdas`)
  console.log(`  admin:     ${counts.admin} Lambdas`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Update infra/aurora_dsql.tf with new IAM policies')
  console.log('  2. Remove hardcoded DSQL config from Lambda .tf files')
  console.log('  3. Run: cd infra && tofu validate')
}

main().catch((error) => {
  console.error('Failed to generate DSQL permissions:', error)
  process.exit(1)
})
