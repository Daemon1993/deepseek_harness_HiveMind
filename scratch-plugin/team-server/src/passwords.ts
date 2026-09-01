/**
 * Password hashing for team accounts. Passwords are never stored or compared
 * as plaintext: each stored value is a self-describing scrypt record
 * `scrypt$v=1$N$r$p$<salt-b64url>$<hash-b64url>` with a per-password random
 * salt, and verification re-derives the hash and compares it in constant
 * time. An empty string is the sentinel for "no password set" and never
 * verifies.
 * @module dsh-team-server/passwords
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const PREFIX = 'scrypt$v=1'
const SALT_BYTES = 16
const KEY_BYTES = 64
/** scrypt work factors (OWASP minimum recommendation). */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

type ScryptOptions = { N: number; r: number; p: number }

/**
 * Derive a key with the given scrypt work factors.
 * @param password - plaintext password to derive from.
 * @param salt - per-password random salt.
 * @param keyLength - derived key length in bytes.
 * @param options - scrypt work factors.
 * @returns the derived key.
 */
function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) rejectPromise(error)
      else resolvePromise(derivedKey)
    })
  })
}

/**
 * Whether a stored value is a hash this module produced. Empty strings are
 * not hashes: they are the "no password set" sentinel.
 * @param stored - the persisted password column value.
 * @returns true when the value is a scrypt record produced by {@link hashPassword}.
 */
export function isPasswordHash(stored: string): boolean {
  return stored.startsWith(`${PREFIX}$`)
}

/**
 * Hash a plaintext password into a self-describing scrypt record.
 * @param password - the plaintext password; must be non-empty.
 * @returns the encoded record to persist.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('team-server: cannot hash an empty password')
  const salt = randomBytes(SALT_BYTES)
  const derived = await deriveKey(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/**
 * Verify a plaintext password against a stored hash in constant time.
 * Malformed, legacy-plaintext, or empty stored values never verify, so an
 * un-migrated row locks the account instead of falling back to plaintext
 * comparison.
 * @param password - the plaintext password submitted by the caller.
 * @param stored - the persisted hash (or the empty sentinel).
 * @returns true when the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length === 0 || !isPasswordHash(stored)) return false
  const parts = stored.split('$')
  if (parts.length !== 7) return false
  const nText = parts[2]
  const rText = parts[3]
  const pText = parts[4]
  const saltB64 = parts[5]
  const hashB64 = parts[6]
  if (nText === undefined || rText === undefined || pText === undefined
    || saltB64 === undefined || hashB64 === undefined) return false
  const N = Number(nText)
  const r = Number(rText)
  const p = Number(pText)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1) return false
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false
  const derived = await deriveKey(password, salt, expected.length, { N, r, p })
  return timingSafeEqual(derived, expected)
}
