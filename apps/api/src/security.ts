import { createHash, createHmac, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string, rounds: number): Promise<string> {
  return hash(password, rounds);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string, secret?: string): string {
  return secret
    ? createHmac('sha256', secret).update(token).digest('hex')
    : createHash('sha256').update(token).digest('hex');
}
