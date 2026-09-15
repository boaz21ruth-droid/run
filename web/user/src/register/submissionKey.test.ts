import { describe, expect, it } from "vitest";
import { SubmissionKey } from "./submissionKey";

describe("SubmissionKey", () => {
  it("同一请求体重试时沿用同一个键，请求体变化才换新键", () => {
    let n = 0;
    const keys = new SubmissionKey(() => `generated-key-${++n}`);

    const first = keys.keyFor('{"a":1}');
    expect(keys.keyFor('{"a":1}')).toBe(first);
    const second = keys.keyFor('{"a":2}');
    expect(second).not.toBe(first);
    expect(keys.keyFor('{"a":2}')).toBe(second);
  });

  it("默认用 crypto.randomUUID，格式满足 Idempotency-Key 要求", () => {
    expect(new SubmissionKey().keyFor("{}")).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
