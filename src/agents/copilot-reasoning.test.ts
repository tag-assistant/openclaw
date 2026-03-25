import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import {
  mapThinkLevelToReasoningEffort,
  validateReasoningEffort,
  type ReasoningModelInfo,
} from "./copilot-reasoning.js";

describe("mapThinkLevelToReasoningEffort", () => {
  const cases: [ThinkLevel | undefined, string | undefined][] = [
    ["off", undefined],
    ["minimal", undefined],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["adaptive", undefined],
    [undefined, undefined],
  ];

  it.each(cases)("maps %s → %s", (input, expected) => {
    expect(mapThinkLevelToReasoningEffort(input)).toBe(expected);
  });
});

describe("validateReasoningEffort", () => {
  it("returns undefined when effort is undefined", () => {
    expect(validateReasoningEffort(undefined, {} as ReasoningModelInfo)).toBeUndefined();
  });

  it("returns undefined when model doesn't support reasoning", () => {
    expect(validateReasoningEffort("high", { capabilities: { supports: {} } })).toBeUndefined();
  });

  it("returns undefined when modelInfo is undefined", () => {
    expect(validateReasoningEffort("high", undefined)).toBeUndefined();
  });

  it("returns the effort when model supports it", () => {
    const model: ReasoningModelInfo = {
      capabilities: { supports: { reasoningEffort: true } },
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    };
    expect(validateReasoningEffort("high", model)).toBe("high");
  });

  it("falls back to model default when effort not in supported list", () => {
    const model: ReasoningModelInfo = {
      capabilities: { supports: { reasoningEffort: true } },
      supportedReasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    };
    expect(validateReasoningEffort("xhigh", model)).toBe("medium");
  });

  it("returns effort when no supportedReasoningEfforts list", () => {
    const model: ReasoningModelInfo = {
      capabilities: { supports: { reasoningEffort: true } },
    };
    expect(validateReasoningEffort("high", model)).toBe("high");
  });

  it("returns undefined when unsupported and no default", () => {
    const model: ReasoningModelInfo = {
      capabilities: { supports: { reasoningEffort: true } },
      supportedReasoningEfforts: ["low"],
    };
    expect(validateReasoningEffort("xhigh", model)).toBeUndefined();
  });
});
