import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('API configuration', () => {
  it('uses the documented local ports and required AI defaults', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.port).toBe(3000);
    expect(config.webOrigin).toBe('http://localhost:5173');
    expect(config.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(config.deepseek.model).toBe('deepseek-v4-flash');
    expect(config.deepseek.reasoningEffort).toBe('high');
  });

  it('honors root session variable names and requires a production secret', () => {
    const config = loadConfig({
      NODE_ENV: 'test', SESSION_COOKIE_NAME: 'test_session', SESSION_TTL_DAYS: '12', SESSION_SECRET: 'x'.repeat(32),
    });
    expect(config.cookie).toMatchObject({ name: 'test_session', sessionDays: 12, sessionSecret: 'x'.repeat(32) });
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({
      NODE_ENV: 'production', SESSION_SECRET: 'replace-with-at-least-32-random-characters',
    })).toThrow(/SESSION_SECRET/);
  });
});
