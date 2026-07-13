import { IntegrationError } from "@atlas/integrations";
import { describe, expect, it } from "vitest";

import { hasScheduledRetry } from "../src/handlers.js";

describe("worker retry policy", () => {
  it("falls back immediately for a non-retryable integration failure", () => {
    expect(hasScheduledRetry(new IntegrationError("unauthorized", false), 0)).toBe(false);
  });

  it("keeps the 10 second, 1 minute and 5 minute retry sequence", () => {
    const error = new IntegrationError("temporarily unavailable", true);
    expect(hasScheduledRetry(error, 0)).toBe(true);
    expect(hasScheduledRetry(error, 1)).toBe(true);
    expect(hasScheduledRetry(error, 2)).toBe(true);
    expect(hasScheduledRetry(error, 3)).toBe(false);
  });
});
