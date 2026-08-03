/**
 * Type utilities and factory helpers for Lambda handler tests.
 *
 * Framework handler factories return BrandedLambda<TInner, TLambda>, carrying the inner handler
 * type via a phantom property. MockedModule<T> extracts it so tests get typed inner params
 * while replacing the return type with Record<string, unknown> (since buildValidatedResponse is mocked).
 *
 * Factory helpers (makeAuthorizedParams, etc.) provide defaults for required fields so tests
 * only specify the fields they care about.
 */
import {createBoundEmitEvent} from '@j0nathan-ll0yd/core'
import type {
  ApiHandlerParams,
  AuthorizedApiParams,
  AuthorizedOptionalApiParams,
  SessionApiParams,
  ValidatedApiParams,
  WrapperMetadata
} from '@j0nathan-ll0yd/core'
import type {APIGatewayProxyEvent, Context} from 'aws-lambda'

// ============================================================================
// MockedModule type — branded inner extraction with permissive return
// ============================================================================

/** Recursively makes all properties optional — needed because tests pass partial nested objects (e.g., context: {awsRequestId}) */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/** Make each element of a tuple optional */
type OptionalArgs<T extends unknown[]> = { [K in keyof T]?: DeepPartial<T[K]> }

/**
 * Transform inner handler for test usage:
 * - All params become optional (DeepPartial) — tests pass only fields they care about
 * - Return becomes Record<string, unknown> — buildValidatedResponse is mocked
 * - Handles zero-arg, single-arg, and multi-arg handlers
 */
type MockInner<T> = T extends (...args: infer A) => unknown ? (...args: OptionalArgs<A>) => Promise<Record<string, unknown>> :
  T

/**
 * Extracts inner handler types from a module using BrandedLambda.
 * - Params become Partial (tests only pass fields they use, but typos are caught)
 * - Return becomes Record<string, unknown> (mocked buildValidatedResponse returns custom shapes)
 * - Non-handler exports pass through unchanged
 *
 * @example
 * ```ts
 * import type {MockedModule} from '#test/helpers/handler-test-types'
 * import type * as Mod from '#lambdas/api/user/subscribe.post.js'
 *
 * const {handler} = (await import('#lambdas/api/user/subscribe.post.js')) as unknown as MockedModule<typeof Mod>
 * // Typed! handler({userId: 'x', body: {endpointArn: '...'}}) — field names checked, body shape checked
 * ```
 */
export type MockedModule<TModule extends Record<string, unknown>> = {
  [K in keyof TModule]: TModule[K] extends {readonly __innerHandler?: infer I} ? MockInner<I> : TModule[K]
}

// ============================================================================
// Factory helpers — provide defaults for required handler params
// ============================================================================

const defaultMetadata: WrapperMetadata = {traceId: 'test-trace', correlationId: 'test-correlation'}

const defaultBoundEmitters = createBoundEmitEvent(defaultMetadata)

const defaultContext = {
  awsRequestId: 'test-req-id',
  callbackWaitsForEmptyEventLoop: true,
  functionName: 'test',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-west-2:123:function:test',
  logGroupName: '/aws/lambda/test',
  logStreamName: 'test',
  memoryLimitInMB: '128',
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {}
} satisfies Context

/** Create AuthorizedApiParams (auth: 'authorizer') with defaults. Only specify fields your test cares about. */
export function makeAuthorizedParams<TBody = undefined, TQuery = undefined, TPath = undefined>(
  overrides: Partial<AuthorizedApiParams<TBody, TQuery, TPath>> & {userId: string}
): AuthorizedApiParams<TBody, TQuery, TPath> {
  return {
    event: {} as APIGatewayProxyEvent,
    context: defaultContext,
    metadata: defaultMetadata,
    ...defaultBoundEmitters,
    authorizer: {},
    userStatus: 'Authenticated',
    body: undefined as AuthorizedApiParams<TBody, TQuery, TPath>['body'],
    query: undefined as AuthorizedApiParams<TBody, TQuery, TPath>['query'],
    path: undefined as AuthorizedApiParams<TBody, TQuery, TPath>['path'],
    ...overrides
  }
}

/** Create AuthorizedOptionalApiParams (auth: 'authorizer-optional') with defaults. */
export function makeOptionalAuthParams<TBody = undefined, TQuery = undefined, TPath = undefined>(
  overrides: Partial<AuthorizedOptionalApiParams<TBody, TQuery, TPath>> = {}
): AuthorizedOptionalApiParams<TBody, TQuery, TPath> {
  return {
    event: {} as APIGatewayProxyEvent,
    context: defaultContext,
    metadata: defaultMetadata,
    ...defaultBoundEmitters,
    authorizer: {},
    userId: undefined,
    userStatus: 'Anonymous',
    body: undefined as AuthorizedOptionalApiParams<TBody, TQuery, TPath>['body'],
    query: undefined as AuthorizedOptionalApiParams<TBody, TQuery, TPath>['query'],
    path: undefined as AuthorizedOptionalApiParams<TBody, TQuery, TPath>['path'],
    ...overrides
  }
}

/** Create ValidatedApiParams (auth: 'none' with body schema) with defaults. */
export function makeValidatedParams<TBody>(overrides: Partial<ValidatedApiParams<TBody>> & {body: TBody}): ValidatedApiParams<TBody> {
  return {event: {} as APIGatewayProxyEvent, context: defaultContext, metadata: defaultMetadata, ...defaultBoundEmitters, ...overrides}
}

/** Create ApiHandlerParams (auth: 'none', no schema) with defaults. */
export function makeApiParams(overrides: Partial<ApiHandlerParams> = {}): ApiHandlerParams {
  return {event: {} as APIGatewayProxyEvent, context: defaultContext, metadata: defaultMetadata, ...defaultBoundEmitters, ...overrides}
}

/** Create SessionApiParams (auth: 'session') with defaults. */
export function makeSessionParams<TBody = undefined, TQuery = undefined, TPath = undefined>(
  overrides: Partial<SessionApiParams<TBody, TQuery, TPath>> & {userId: string}
): SessionApiParams<TBody, TQuery, TPath> {
  return {
    event: {} as APIGatewayProxyEvent,
    context: defaultContext,
    metadata: defaultMetadata,
    ...defaultBoundEmitters,
    session: {
      user: {id: overrides.userId, email: 'test@test.com', emailVerified: true},
      session: {id: 'sess-1', token: 'tok-1', expiresAt: new Date(Date.now() + 86400000)}
    },
    body: undefined as SessionApiParams<TBody, TQuery, TPath>['body'],
    query: undefined as SessionApiParams<TBody, TQuery, TPath>['query'],
    path: undefined as SessionApiParams<TBody, TQuery, TPath>['path'],
    ...overrides
  }
}
