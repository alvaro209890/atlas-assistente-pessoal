import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Os dados enviados não são válidos.', result.error.flatten());
  }
  return result.data;
}
interface PgLikeError extends Error {
  code?: string;
  constraint?: string;
}

export function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    void reply.status(error.statusCode).send({
      message: error.message,
      error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
    });
    return;
  }

  if (error instanceof ZodError) {
    void reply.status(400).send({
      message: 'Os dados enviados não são válidos.',
      error: { code: 'VALIDATION_ERROR', message: 'Os dados enviados não são válidos.', details: error.flatten() },
    });
    return;
  }

  const pgError = error as PgLikeError;
  if (pgError.code === '23505') {
    void reply.status(409).send({
      message: 'Esse registro já existe.',
      error: { code: 'CONFLICT', message: 'Esse registro já existe.' },
    });
    return;
  }
  if (pgError.code === '23503') {
    void reply.status(409).send({
      message: 'O registro está ligado a outro item e não pode ser alterado assim.',
      error: { code: 'REFERENCE_CONFLICT', message: 'O registro está ligado a outro item e não pode ser alterado assim.' },
    });
    return;
  }

  request.log.error({ err: error }, 'request failed');
  void reply.status(500).send({
    message: 'Não foi possível concluir a solicitação.',
    error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a solicitação.' },
  });
}
