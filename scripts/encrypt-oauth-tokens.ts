/**
 * One-time migration script: encrypt existing plaintext OAuth tokens in the accounts table.
 *
 * BetterAuth's `encryptOAuthTokens` option encrypts OAuth tokens at rest using AES-256-GCM
 * (actually XChaCha20-Poly1305 via \@noble/ciphers) with AUTH_SECRET as the key material.
 * Before enabling that option, existing plaintext tokens must be encrypted first — otherwise
 * BetterAuth will attempt to decrypt plaintext strings and throw an error.
 *
 * Encryption format (plain string key path):
 *   symmetricEncrypt(\{ key: AUTH_SECRET, data: plaintext \}) → raw hex string
 *   The nonce is prepended to the ciphertext, all encoded as hex.
 *
 * Idempotency:
 *   Already-encrypted values are all-hex strings of at least 64 characters.
 *   Plaintext OAuth tokens (JWTs start with "eyJ", opaque tokens use base64url) are never
 *   pure hex, so this heuristic is safe. Rows where all token columns pass the hex check
 *   are skipped without any DB write.
 *
 * Usage:
 *   npx tsx scripts/encrypt-oauth-tokens.ts
 *   npx tsx scripts/encrypt-oauth-tokens.ts --dry-run
 *
 * Required env vars:
 *   AUTH_SECRET      - BetterAuth secret (same value used at runtime)
 *   DSQL_ENDPOINT    - Aurora DSQL cluster endpoint
 *   DSQL_REGION      - AWS region
 *   DSQL_ROLE_NAME   - PostgreSQL role name (use 'admin' for migration scripts)
 *
 * @see docs/wiki/Authentication/OAuth-Token-Encryption.md
 */
import {isNotNull, or} from 'drizzle-orm'
import {eq} from 'drizzle-orm'
import {symmetricDecrypt, symmetricEncrypt} from 'better-auth/crypto'
import {getRequiredEnv} from '@mantleframework/env'
import {closeDrizzleClient, getDrizzleClient} from '#db/client'
import {accounts} from '#db/schema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string
  accessToken: string | null
  refreshToken: string | null
  idToken: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a token value appears to already be encrypted.
 *
 * BetterAuth symmetricEncrypt (plain string key) produces a raw hex string.
 * Plaintext OAuth tokens are either JWTs ("eyJ...") or opaque base64url strings —
 * neither is a pure lowercase hex sequence of significant length.
 *
 * The minimum length check (64 chars = 32 bytes) guards against unlikely edge cases
 * where a very short token might coincidentally be hex.
 */
function isLikelyEncrypted(value: string): boolean {
  return value.length >= 64 && /^[0-9a-f]+$/.test(value)
}

/**
 * Encrypt a single token value and validate the round-trip.
 * Returns the encrypted hex string, or throws on mismatch.
 */
async function encryptAndValidate(plaintext: string, secret: string): Promise<string> {
  const encrypted = await symmetricEncrypt({key: secret, data: plaintext})

  // Round-trip validation
  const decrypted = await symmetricDecrypt({key: secret, data: encrypted})
  if (decrypted !== plaintext) {
    throw new Error(`Round-trip validation failed: decrypted value does not match original plaintext`)
  }

  return encrypted
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run')

  if (isDryRun) {
    console.log('[DRY RUN] No changes will be written to the database.')
  }

  const secret = getRequiredEnv('AUTH_SECRET')

  console.log('Connecting to database...')
  const db = await getDrizzleClient()

  // Query all account rows that have at least one non-null token column
  console.log('Querying accounts with OAuth tokens...')
  const rows = await db.select({id: accounts.id, accessToken: accounts.accessToken, refreshToken: accounts.refreshToken, idToken: accounts.idToken}).from(
    accounts
  ).where(or(isNotNull(accounts.accessToken), isNotNull(accounts.refreshToken), isNotNull(accounts.idToken))) as AccountRow[]

  console.log(`Found ${rows.length} account row(s) with at least one token column.`)

  if (rows.length === 0) {
    console.log('Nothing to do.')
    await closeDrizzleClient()
    return
  }

  // Count how many tokens need encryption (for dry-run summary)
  let totalAccessTokens = 0
  let totalRefreshTokens = 0
  let totalIdTokens = 0
  let alreadyEncryptedCount = 0

  for (const row of rows) {
    if (row.accessToken !== null) {
      if (isLikelyEncrypted(row.accessToken)) {
        alreadyEncryptedCount++
      } else {
        totalAccessTokens++
      }
    }
    if (row.refreshToken !== null) {
      if (isLikelyEncrypted(row.refreshToken)) {
        alreadyEncryptedCount++
      } else {
        totalRefreshTokens++
      }
    }
    if (row.idToken !== null) {
      if (isLikelyEncrypted(row.idToken)) {
        alreadyEncryptedCount++
      } else {
        totalIdTokens++
      }
    }
  }

  const totalToEncrypt = totalAccessTokens + totalRefreshTokens + totalIdTokens
  console.log(`Tokens to encrypt:  access_token=${totalAccessTokens}, refresh_token=${totalRefreshTokens}, id_token=${totalIdTokens}`)
  console.log(`Already encrypted:  ${alreadyEncryptedCount} token(s) will be skipped`)

  if (isDryRun) {
    console.log(`\n[DRY RUN] Would encrypt ${totalToEncrypt} token(s) across ${rows.length} row(s). No changes made.`)
    await closeDrizzleClient()
    return
  }

  if (totalToEncrypt === 0) {
    console.log('All tokens are already encrypted. Nothing to do.')
    await closeDrizzleClient()
    return
  }

  // Process each row
  let processedRows = 0
  let skippedRows = 0
  let errorRows = 0

  for (const row of rows) {
    try {
      const updates: Partial<{accessToken: string; refreshToken: string; idToken: string}> = {}

      // access_token
      if (row.accessToken !== null) {
        if (!isLikelyEncrypted(row.accessToken)) {
          updates.accessToken = await encryptAndValidate(row.accessToken, secret)
        }
      }

      // refresh_token
      if (row.refreshToken !== null) {
        if (!isLikelyEncrypted(row.refreshToken)) {
          updates.refreshToken = await encryptAndValidate(row.refreshToken, secret)
        }
      }

      // id_token
      if (row.idToken !== null) {
        if (!isLikelyEncrypted(row.idToken)) {
          updates.idToken = await encryptAndValidate(row.idToken, secret)
        }
      }

      const hasUpdates = Object.keys(updates).length > 0

      if (hasUpdates) {
        await db.update(accounts).set({...updates, updatedAt: new Date()}).where(eq(accounts.id, row.id))
        processedRows++
        console.log(`  [OK] Row ${row.id}: encrypted ${Object.keys(updates).join(', ')}`)
      } else {
        skippedRows++
        console.log(`  [SKIP] Row ${row.id}: all tokens already encrypted`)
      }
    } catch (err) {
      errorRows++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  [ERROR] Row ${row.id}: ${message}`)
    }
  }

  // Summary
  console.log('\n--- Summary ---')
  console.log(`Total rows:        ${rows.length}`)
  console.log(`Rows updated:      ${processedRows}`)
  console.log(`Rows skipped:      ${skippedRows}`)
  console.log(`Rows with errors:  ${errorRows}`)

  await closeDrizzleClient()

  if (errorRows > 0) {
    console.error(`\nMigration completed with ${errorRows} error(s). Review errors above before enabling encryptOAuthTokens.`)
    process.exit(1)
  }

  console.log('\nMigration complete. You can now safely enable encryptOAuthTokens in your BetterAuth config.')
  process.exit(0)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error('Fatal error:', message)
  process.exit(1)
})
