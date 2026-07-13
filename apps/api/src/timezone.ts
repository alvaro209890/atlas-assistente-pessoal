import { z } from 'zod';

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export const ianaTimezone = z.string().trim().min(1).max(100)
  .refine(isIanaTimezone, 'Informe um fuso horário IANA válido, como America/Sao_Paulo.');
