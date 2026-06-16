/**
 * RegisterUser Lambda (Better Auth Version)
 *
 * Registers a new user or logs in existing user via Sign in with Apple using Better Auth OAuth.
 * Fully delegates OAuth verification, user creation, and session creation to Better Auth.
 *
 * Trigger: API Gateway POST /user/register
 * Input: UserRegistrationRequest with idToken and optional name fields
 * Output: APIGatewayProxyResult with session token
 */
import {getAuth} from '@mantleframework/auth'
import {buildValidatedResponse, defineLambda} from '@mantleframework/core'
import {getRequiredEnv} from '@mantleframework/env'
import {UnexpectedError} from '@mantleframework/errors'
import {logInfo, metrics, MetricUnit} from '@mantleframework/observability'
import {defineApiHandler, z} from '@mantleframework/validation'
import {getDrizzleClient} from '#db/client'
import {accounts, sessions, users, verification} from '#db/schema'
import {updateUser} from '#entities/queries'
import {userRegistrationResponseSchema} from '#types/api-schema'
import type {GetSessionResult, SignInSocialTokenResult} from '#types/betterAuth'

defineLambda({
  secrets: {AUTH_SECRET: 'platform.key', APPLE_CLIENT_ID: 'signInWithApple.config', APPLE_CLIENT_SECRET: 'signInWithApple.authKey'},
  staticEnvVars: {APPLE_APP_BUNDLE_IDENTIFIER: 'lifegames.OfflineMediaDownloader'}
})

/** Result of a successful sign-in/registration */
interface AuthRegistrationResult {
  token: string
  userId: string
  sessionId: string
  expiresAt: string | Date
  isNewUser: boolean
  user: SignInSocialTokenResult['user']
}

/** Sign in or register a user via Better Auth with Apple ID token */
async function signInWithApple(idToken: string, ipAddress: string | undefined, userAgent: string): Promise<AuthRegistrationResult> {
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
    body: {provider: 'apple', idToken: {token: idToken}}
  })

  const result = rawResult as SignInSocialTokenResult
  const sessionResult = await auth.api.getSession({headers: new Headers({Authorization: `Bearer ${result.token}`})}) as GetSessionResult | null

  if (!sessionResult?.session) {
    throw new UnexpectedError('signInSocial succeeded but getSession returned null — is bearer plugin enabled?')
  }

  const isNewUser = !result.user?.createdAt || Date.now() - new Date(result.user.createdAt).getTime() < 5000

  return {
    token: result.token,
    userId: result.user.id,
    sessionId: sessionResult.session.id,
    expiresAt: sessionResult.session.expiresAt,
    isNewUser,
    user: result.user
  }
}

const RegistrationRequestSchema = z.object({idToken: z.string(), firstName: z.string().optional(), lastName: z.string().optional()})

const api = defineApiHandler({auth: 'none', schema: RegistrationRequestSchema, operationName: 'RegisterUser'})
export const handler = api(async ({event, context, body}) => {
  const ipAddress = event.requestContext?.identity?.sourceIp
  const userAgent = event.headers?.['user-agent'] || ''

  const result = await signInWithApple(body.idToken, ipAddress, userAgent)

  if (result.isNewUser && (body.firstName || body.lastName)) {
    const fullName = [body.firstName, body.lastName].filter(Boolean).join(' ')
    await updateUser(result.userId, {name: fullName, firstName: body.firstName || '', lastName: body.lastName || ''})
    logInfo('RegisterUser: Updated new user with name from iOS app', {userId: result.userId, hasFirstName: !!body.firstName, hasLastName: !!body.lastName})
  }

  if (result.isNewUser) {
    metrics.addMetric('NewUserRegistration', MetricUnit.Count, 1)
  }

  logInfo('RegisterUser: Better Auth sign-in/registration successful', {
    userId: result.userId,
    sessionToken: 'present',
    sessionId: result.sessionId.slice(0, 8),
    expiresAt: result.expiresAt,
    isNewUser: result.isNewUser
  })

  return buildValidatedResponse(context, 200, {
    token: result.token,
    expiresAt: new Date(result.expiresAt).toISOString(),
    sessionId: result.sessionId,
    userId: result.userId
  }, userRegistrationResponseSchema)
})
