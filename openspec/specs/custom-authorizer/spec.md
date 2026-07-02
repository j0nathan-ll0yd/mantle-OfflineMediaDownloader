# Custom API Gateway Authorizer

## Purpose

Guards all non-Feedly API Gateway routes by verifying an API key and optionally a Better Auth
session token before any handler Lambda is invoked. Every request MUST pass API key validation; most
routes additionally require a valid session. Routes listed in `MULTI_AUTHENTICATION_PATH_PARTS`
(device registration, device events, file listing) permit anonymous access when no Authorization
header is present.

Source of truth for behavior: `src/lambdas/standalone/ApiGatewayAuthorizer/index.ts`,
`src/lambdas/standalone/ApiGatewayAuthorizer/helpers.ts`, `src/domain/auth/sessionService.ts`.
The IAM policy shape returned by `generateAllow`/`denyAuthorization` is owned by
`src/lambdas/standalone/ApiGatewayAuthorizer/helpers.ts` — this spec does NOT restate it.

## Requirements

### Requirement: api-key-required-before-session-check

Every request SHALL include an `ApiKey` query parameter whose value matches an enabled API key
record. The authorizer SHALL deny access if the `ApiKey` parameter is absent, if no key with that
value exists, or if the matched key has `enabled: false`. This check occurs before any session token
validation.

#### Scenario: Missing API key parameter

- **GIVEN** an incoming request with no `ApiKey` query parameter
- **WHEN** the authorizer evaluates the request
- **THEN** the authorizer SHALL deny the request without inspecting the Authorization header

#### Scenario: Disabled API key

- **GIVEN** a request whose `ApiKey` matches a known key with `enabled: false`
- **WHEN** the authorizer evaluates the request
- **THEN** the authorizer SHALL deny the request

### Requirement: invalid-session-denies-not-anonymous

When an Authorization header is present with a Bearer token, the authorizer SHALL validate that
token against the Better Auth session store. If the token is present but invalid (expired, malformed,
or not found), the authorizer SHALL deny authorization. It SHALL NOT fall back to anonymous
access — an invalid token is treated as an active denial, not as a missing token.
This requirement is verified by `src/lambdas/standalone/ApiGatewayAuthorizer/test/index.test.ts`.

#### Scenario: Valid Bearer token authenticates the request

- **GIVEN** a valid, unexpired Better Auth session token in the Authorization header
- **WHEN** the authorizer processes the request
- **THEN** the authorizer SHALL allow the request with the resolved userId as the principalId
- **AND** the context SHALL carry `userStatus: Authenticated`

#### Scenario: Expired or invalid Bearer token denies immediately

- **GIVEN** an Authorization header whose Bearer token is expired or otherwise invalid
- **WHEN** the authorizer processes the request
- **THEN** the authorizer SHALL deny the request regardless of the requested path
- **AND** SHALL NOT allow anonymous fallback

### Requirement: multi-auth-paths-allow-anonymous

Paths enumerated in the `MULTI_AUTHENTICATION_PATH_PARTS` environment variable SHALL allow requests
with no Authorization header, assigning `anonymous` as the principalId and `userStatus: Anonymous`.
If an Authorization header IS present on these paths, normal session validation applies — an invalid
header still results in a denial.

#### Scenario: Device registration with no auth header

- **GIVEN** a request to a path in `MULTI_AUTHENTICATION_PATH_PARTS` with no Authorization header
- **WHEN** the authorizer processes the request
- **THEN** the authorizer SHALL allow the request with principalId `anonymous`

#### Scenario: Authenticated-only path with no auth header

- **GIVEN** a request to a path NOT in `MULTI_AUTHENTICATION_PATH_PARTS` with no Authorization header
- **WHEN** the authorizer processes the request
- **THEN** the authorizer SHALL deny the request

### Requirement: bearer-header-format-validated

The Authorization header value SHALL match the pattern `Bearer <token>` (a single space, then
alphanumeric characters and URL-safe base64 characters). A header that does not match this pattern
SHALL result in denial, not a session lookup attempt.

#### Scenario: Malformed Authorization header format

- **GIVEN** an Authorization header that does not match the `Bearer <token>` pattern
- **WHEN** the authorizer processes the request
- **THEN** the authorizer SHALL deny the request without querying the session store
