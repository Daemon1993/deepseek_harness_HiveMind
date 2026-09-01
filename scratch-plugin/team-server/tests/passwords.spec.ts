import { describe, expect, it } from 'vitest'
import { hashPassword, isPasswordHash, verifyPassword } from '../src/passwords.ts'

describe('team account password hashing', () => {
  it('verifies the original password against its hash', async () => {
    const hash = await hashPassword('a123456')
    expect(isPasswordHash(hash)).toBe(true)
    await expect(verifyPassword('a123456', hash)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('a123456')
    await expect(verifyPassword('a123457', hash)).resolves.toBe(false)
  })

  it('produces a different salt per password', async () => {
    const first = await hashPassword('same-password')
    const second = await hashPassword('same-password')
    expect(first).not.toBe(second)
    await expect(verifyPassword('same-password', second)).resolves.toBe(true)
  })

  it('never verifies legacy plaintext, malformed, or empty stored values', async () => {
    await expect(verifyPassword('123456', '123456')).resolves.toBe(false)
    await expect(verifyPassword('123456', '')).resolves.toBe(false)
    await expect(verifyPassword('123456', 'scrypt$v=1$garbage')).resolves.toBe(false)
    await expect(verifyPassword('', await hashPassword('a123456'))).resolves.toBe(false)
  })

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow()
  })
})
