export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntegrationError";
  }
}

export class InvalidAiOutputError extends IntegrationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, true, options);
    this.name = "InvalidAiOutputError";
  }
}

export function isRetryableIntegrationError(error: unknown): boolean {
  if (error instanceof IntegrationError) return error.retryable;
  if (error instanceof TypeError) return true;
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}
