import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('development seed safety', () => {
  it('requires credentials from the environment and blocks production by default', async () => {
    const source = await readFile(new URL('./seed.ts', import.meta.url), 'utf8');
    expect(source).toContain("requiredEnv('SEED_USER_EMAIL')");
    expect(source).toContain("requiredEnv('SEED_USER_PASSWORD')");
    expect(source).toContain("process.env.NODE_ENV === 'production'");
    expect(source).toContain('preferred_name');
    expect(source).toContain('INSERT INTO user_profiles');
    expect(source).not.toMatch(/password\s*=\s*['"][^'"]+['"]/i);
  });
});
