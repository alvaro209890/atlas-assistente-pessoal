import { describe, expect, it } from 'vitest';
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from './security.js';

describe('session and password utilities', () => {
  it('hashes opaque sessions with the server secret', () => {
    const token = createSessionToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashSessionToken(token, 'a'.repeat(32))).not.toBe(hashSessionToken(token, 'b'.repeat(32)));
    expect(hashSessionToken(token, 'a'.repeat(32))).toHaveLength(64);
  });

  it('hashes and verifies a password', async () => {
    const passwordHash = await hashPassword('uma-senha-de-teste', 8);
    await expect(verifyPassword('uma-senha-de-teste', passwordHash)).resolves.toBe(true);
    await expect(verifyPassword('senha-errada', passwordHash)).resolves.toBe(false);
  });
});
