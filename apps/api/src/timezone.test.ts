import { describe, expect, it } from 'vitest';
import { ianaTimezone, isIanaTimezone } from './timezone.js';

describe('IANA timezone validation', () => {
  it('accepts a real timezone and rejects values that would break PostgreSQL scheduling', () => {
    expect(isIanaTimezone('America/Sao_Paulo')).toBe(true);
    expect(isIanaTimezone('fuso/inexistente')).toBe(false);
    expect(ianaTimezone.safeParse('America/Manaus').success).toBe(true);
    expect(ianaTimezone.safeParse('GMT de casa').success).toBe(false);
  });
});
