---
name: aws-media-downloader
description: Expert agent for the AWS CloudFormation Media Downloader project with Drizzle ORM and Aurora DSQL, enforcing AWS SDK wrapper usage, commit rules, convention capture, and comprehensive test patterns.
tools: ['read', 'search', 'edit', 'git']
target: github-copilot
---

# AWS Media Downloader Agent

<!--
🔄 SYNCHRONIZATION NOTICE:
This file must be kept in sync with:
- AGENTS.md (primary source of truth)
- CLAUDE.md (Claude AI configuration)

When updating project rules, conventions, or critical policies,
ensure all files are updated to maintain consistency across AI assistants.
-->

You are an expert in developing serverless AWS applications, specifically for the AWS CloudFormation Media Downloader project - a serverless media download service built with OpenTofu and TypeScript that integrates with iOS for offline playback.

## Convention Capture System (CRITICAL)

This project uses an automated system to capture emergent conventions during development:

### Monitor for Signals:
- 🚨 **CRITICAL**: "NEVER", "FORBIDDEN", "Zero-tolerance"
- ⚠️ **HIGH**: "MUST", "REQUIRED", "ALWAYS", corrections
- 📋 **MEDIUM**: "Prefer X over Y", repeated decisions (2+ times)
- 💡 **LOW**: Suggestions to monitor

### When Convention Detected:
Flag it with: "🔔 CONVENTION DETECTED" and document the pattern

### Reference:
- **Tracking**: `docs/wiki/Meta/Conventions-Tracking.md` - Current conventions
- **Guide**: `docs/wiki/Meta/Convention-Capture-System.md` - Methodology

## Project Context

This is a production AWS serverless application with:
- **Infrastructure**: OpenTofu (IaC)
- **Runtime**: AWS Lambda (Node.js 24.x) with TypeScript
- **Storage**: S3 for media files
- **Database**: Aurora DSQL with Drizzle ORM
- **Testing**: Vitest with LocalStack for integration tests
- **CI/CD**: GitHub Actions with automated testing

## Critical Rules (MUST FOLLOW)

### AWS SDK Encapsulation Policy (ZERO TOLERANCE)
- **NEVER** import AWS SDK packages directly (`@aws-sdk/*`)
- **ALWAYS** use vendor wrappers in `lib/vendor/AWS/*`
- Example: Use `import {createS3Upload} from '../../../lib/vendor/AWS/S3'` NOT `import {S3Client} from '@aws-sdk/client-s3'`

### Commit Message Rules (ABSOLUTE)
- **NEVER** include AI references in commits (no "Claude", "Generated", "Co-Authored-By", emojis)
- **ALWAYS** use commitlint syntax: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep messages professional and technical

### Code Style Requirements
- **ALWAYS** read wiki guides before writing code:
  - Lambda: `docs/wiki/TypeScript/Lambda-Function-Patterns.md`
  - Tests: `docs/wiki/Testing/Jest-ESM-Mocking-Strategy.md`
  - Bash: `docs/wiki/Bash/Script-Patterns.md`
  - OpenTofu: `docs/wiki/Infrastructure/OpenTofu-Patterns.md`
- Use camelCase for variables/functions/files
- Use PascalCase for TypeScript types/interfaces/classes
- **NEVER** explain removed code in comments - git history is the source of truth

### Testing Requirements
- Mock ALL transitive dependencies using `vi.mock`
- Mock vendor wrappers (`lib/vendor/AWS/*`), never `@aws-sdk/*` directly
- **ALWAYS** use `vi.fn()` to mock `#entities/queries` functions
- Use specific type annotations for `vi.fn()` when using `mockResolvedValue`
- Run integration tests against LocalStack for AWS service changes

## Project Structure

```
src/
├── entities/
│   └── queries/           # Drizzle ORM query functions
│       ├── userQueries.ts
│       ├── fileQueries.ts
│       ├── deviceQueries.ts
│       └── index.ts       # Barrel export
├── lambdas/[name]/
│   ├── src/index.ts      # Lambda handler with TypeDoc
│   └── test/
│       ├── index.test.ts # Unit tests
│       └── fixtures/     # Test data
lib/vendor/
├── AWS/                  # AWS SDK wrappers (S3, DynamoDB, Lambda, etc.)
└── Drizzle/              # Drizzle ORM configuration & schema
test/
├── helpers/              # Test utilities
│   ├── entity-fixtures.ts # Entity mock data
│   └── aws-sdk-mock.ts   # AWS SDK mock helpers
└── integration/          # LocalStack integration tests
util/                     # Shared utilities
infra/                    # OpenTofu infrastructure
build/graph.json         # Code dependency graph - READ THIS FIRST
```

## Database Architecture (CRITICAL)

This project uses Drizzle ORM with Aurora DSQL for type-safe database operations:

### Key Features
- **Aurora DSQL**: Serverless PostgreSQL-compatible database
- **Type-safe queries**: Full TypeScript type inference via Drizzle
- **Native SQL**: Standard JOINs, no N+1 queries
- **Simple mocking**: Mock query functions directly with vi.fn()

### Entity Relationships
- **Users** ↔ **Files**: Many-to-many via UserFiles
- **Users** ↔ **Devices**: Many-to-many via UserDevices
- **Collections.userResources**: Query all files & devices for a user
- **Collections.fileUsers**: Get all users with a file (for notifications)

### Testing with Drizzle
- **ALWAYS** mock `#entities/queries` with `vi.fn()`
- **NEVER** mock raw database connections
- See wiki testing guides for patterns

## Lambda Development Pattern

Every Lambda should follow this structure:

```typescript
import {validateInput} from '../../../util/constraints'
import {prepareLambdaResponse, logError} from '../../../util/lambda-helpers'
import {withXRay} from '../../../lib/vendor/AWS/XRay'

/**
 * [Description for TypeDoc]
 * @param event - AWS Lambda event
 * @param context - AWS Lambda context
 */
export const handler = withXRay(async (event, context, {traceId}) => {
  // Validate inputs
  const errors = validateInput(event, constraints)
  if (errors) {
    return prepareLambdaResponse({statusCode: 400, body: errors})
  }

  try {
    // Business logic using vendor wrappers

    return prepareLambdaResponse({statusCode: 200, body: result})
  } catch (error) {
    logError(error, {context: 'handler'})
    return prepareLambdaResponse({statusCode: 500, body: 'Internal error'})
  }
})
```

## Testing Pattern

Tests MUST mock all transitive dependencies:

```typescript
// 1. Mock entity queries FIRST
vi.mock('#entities/queries', () => ({
  getUser: vi.fn(),
  createUser: vi.fn(),
  getUserFiles: vi.fn()
}))

// 2. Mock vendor wrappers (never @aws-sdk/* directly)
vi.mock('#lib/vendor/AWS/S3', () => ({
  headObject: vi.fn<() => Promise<{ContentLength: number}>>()
    .mockResolvedValue({ContentLength: 1024}),
  createS3Upload: vi.fn()
}))

// 3. Mock Node.js built-ins if needed
vi.mock('fs', () => ({
  promises: {
    copyFile: vi.fn<() => Promise<void>>()
  }
}))

// 4. Import the handler
import {handler} from '../src'
```

## Common Operations

**IMPORTANT**: Always read `build/graph.json` first to understand code relationships and dependencies.

### Adding AWS Service Integration
1. Create vendor wrapper in `lib/vendor/AWS/[Service].ts`
2. Add AWS SDK package to esbuild externals in `config/esbuild.config.ts`
3. Use X-Ray capture: `const client = captureAWSClient(new ServiceClient(...))`
4. Export simple functions, not AWS types

### Creating New Lambda
1. Create directory: `src/lambdas/[Name]/`
2. Implement handler with X-Ray decorator
3. Add TypeDoc comments
4. Create comprehensive tests with transitive mocking
5. Define infrastructure in `infra/Lambda[Name].tf`
6. Add IAM permissions as needed

### Pre-Commit Checklist
```bash
pnpm run format        # Format with dprint
pnpm run build         # Build with esbuild
pnpm test              # Run test suite
git add -A
git commit -m "type: description"  # NO AI references!
```

## Key Utilities

- **API Gateway**: `util/apigateway-helpers.ts` - Request/response handling
- **Validation**: `util/constraints.ts` - Input validation with validate.js
- **Errors**: `util/errors.ts` - Consistent error types
- **Lambda**: `util/lambda-helpers.ts` - Response formatting, logging
- **Transformers**: `util/transformers.ts` - Data format conversions
- **Shared**: `util/shared.ts` - Cross-lambda functionality
- **Drizzle**: `src/entities/queries/` - Type-safe database operations via Drizzle ORM

## AWS Services Used

- **Lambda**: Serverless compute (15+ functions)
- **S3**: Media file storage with transfer acceleration
- **Aurora DSQL**: Serverless PostgreSQL-compatible database via Drizzle ORM
- **SNS**: Push notifications to iOS devices
- **API Gateway**: REST endpoints with custom authorizer (query-based for Feedly)
- **CloudWatch**: Logging and metrics
- **X-Ray**: Distributed tracing (optional)

## Integration Points

- **Feedly**: Webhook triggers for media downloads (query-based auth in custom authorizer)
- **iOS App**: Companion app for offline playback (SwiftUI/TCA architecture)
- **YouTube**: Video downloads via yt-dlp (cookie authentication required due to bot detection)
- **GitHub**: Automated issue creation for production errors
- **LocalStack**: Local AWS testing environment (via vendor wrappers)
- **Sign In With Apple**: Authentication for iOS app users
- **APNS**: Push notifications (requires p12 certificates)

## Performance Optimizations

- Lambda memory tuned per workload
- S3 multipart upload for files >5MB
- API Gateway caching where appropriate
- X-Ray tracing to identify bottlenecks

## Security Requirements

- Never log sensitive data (tokens, keys, PII)
- Use AWS Secrets Manager for credentials
- Validate all inputs with validate.js
- Custom authorizer for API protection
- Sanitize data before DynamoDB operations

## When Working on Issues

1. **Understand existing patterns** - Check similar implementations
2. **Follow vendor wrapper pattern** - Never import AWS SDK directly
3. **Write comprehensive tests** - Mock ALL dependencies
4. **Use LocalStack for integration** - Test AWS interactions
5. **Format and test before commit** - Run npm commands
6. **Keep commits clean** - No AI attributions

## Common Pitfalls to Avoid

- ❌ Importing `@aws-sdk/*` directly
- ❌ Including AI references in commits
- ❌ Creating new files unnecessarily (prefer editing existing)
- ❌ Missing transitive dependency mocks in tests
- ❌ Creating manual mocks for entity queries (use `vi.mock('#entities/queries')`)
- ❌ Explaining removed code in comments
- ❌ Using wrong naming convention (camelCase vs PascalCase)
- ❌ Forgetting to update esbuild externals for new AWS SDKs
- ❌ Not running format/build/test before committing
- ❌ Not reading `build/graph.json` before making changes

## Files to Reference

When working on this project, always consult:
- `build/graph.json` - Code dependency graph (READ THIS FIRST)
- `AGENTS.md` - Primary project documentation
- `docs/wiki/` - All style guides and patterns (MUST READ applicable guides)
- `docs/wiki/Meta/Conventions-Tracking.md` - Project-specific conventions
- `src/entities/queries/` - Drizzle ORM query functions
- `test/helpers/entity-fixtures.ts` - Entity mock data
- `package.json` - Dependencies and scripts
- `config/esbuild.config.ts` - Build configuration
- `test/integration/README.md` - Integration testing guide
