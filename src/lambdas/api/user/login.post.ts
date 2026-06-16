/**
 * LoginUser Lambda (Better Auth Version)
 *
 * Logs in an existing user via Sign in with Apple using Better Auth OAuth.
 * Fully delegates OAuth verification and session creation to Better Auth.
 *
 * Trigger: API Gateway POST /user/login
 * Input: UserLoginRequest with idToken
 * Output: APIGatewayProxyResult with session token
 */
import {getAuth} from '@mantleframework/auth'
import {buildValidatedResponse, defineLambda} from '@mantleframework/core'
import {getRequiredEnv} from '@mantleframework/env'
import {UnexpectedError} from '@mantleframework/errors'
import {logInfo} from '@mantleframework/observability'
import {defineApiHandler, z} from '@mantleframework/validation'
import {getDrizzleClient} from '#db/client'
import {accounts, sessions, users, verification} from '#db/schema'
import {userLoginResponseSchema} from '#types/api-schema'
import type {GetSessionResult, SignInSocialTokenResult} from '#types/betterAuth'

defineLambda({
  secrets: {AUTH_SECRET: 'platform.key', APPLE_CLIENT_ID: 'signInWithApple.config', APPLE_CLIENT_SECRET: 'signInWithApple.authKey'},
  staticEnvVars: {APPLE_APP_BUNDLE_IDENTIFIER: 'lifegames.OfflineMediaDownloader'}
})

const LoginRequestSchema = z.object({idToken: z.string()})

const api = defineApiHandler({auth: 'none', schema: LoginRequestSchema, operationName: 'LoginUser'})
export const handler = api(async ({event, context, body}) => {
  // Sign in using Better Auth with ID token from iOS app
  const ipAddress = event.requestContext?.identity?.sourceIp
  const userAgent = event.headers?.['user-agent'] || ''

  const auth = await getAuth(getDrizzleClient, {
    secret: getRequiredEnv('AUTH_SECRET'),
    baseURL: getRequiredEnv('AUTH_BASE_URL'),
    schema: {user: users, session: sessions, account: accounts, verification},
    socialProviders: {
      apple: {
        clientId: getRequiredEnv('APPLE_CLIENT_ID'),
        clientSecret: getRequiredEnv('APPLE_CLIENT_SECRET'),
        appBundleIdentifier: getRequiredEnv('APPLE_APP_BUNDLE_IDENTIFIER')
      }
    }
  })
  const rawResult = await auth.api.signInSocial({
    headers: {'user-agent': userAgent, 'x-forwarded-for': ipAddress || ''},
    body: {provider: 'apple', idToken: {token: body.idToken}}
  })

  // signInSocial returns { token, user } in the ID token flow (no redirect)
  const result = rawResult as SignInSocialTokenResult

  // signInSocial only returns { token, user } — no session metadata.
  // Use bearer plugin's getSession to retrieve session metadata via Authorization header.
  const sessionResult = await auth.api.getSession({headers: new Headers({Authorization: `Bearer ${result.token}`})}) as GetSessionResult | null

  if (!sessionResult?.session) {
    throw new UnexpectedError('signInSocial succeeded but getSession returned null — is bearer plugin enabled?')
  }

  const session = sessionResult.session

  logInfo('LoginUser: Better Auth sign-in successful', {
    userId: result.user.id,
    sessionToken: 'present',
    sessionId: session.id.slice(0, 8),
    expiresAt: session.expiresAt
  })

  return buildValidatedResponse(context, 200, {
    token: result.token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    sessionId: session.id,
    userId: result.user.id
  }, userLoginResponseSchema)
})
