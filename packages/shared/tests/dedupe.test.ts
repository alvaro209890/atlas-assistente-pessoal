import { describe, expect, it } from "vitest";

import { makeBatchIdempotencyKey, makeMessageDedupeKey } from "../src/index.js";

describe("idempotency", () => {
  it("is stable regardless of batch message order", () => {
    expect(makeBatchIdempotencyKey("u", "chat", ["b", "a", "a"])).toBe(
      makeBatchIdempotencyKey("u", "chat", ["a", "b"]),
    );
  });

  it("isolates users and connections", () => {
    expect(makeMessageDedupeKey("u1", "c", "m")).not.toBe(
      makeMessageDedupeKey("u2", "c", "m"),
    );
    expect(makeMessageDedupeKey("u1", "c1", "m")).not.toBe(
      makeMessageDedupeKey("u1", "c2", "m"),
    );
  });
});
