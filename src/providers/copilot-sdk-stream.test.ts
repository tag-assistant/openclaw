import type { Context } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildErrorMessage,
  contextToPrompt,
  isRateLimitError,
  isTransientError,
} from "./copilot-sdk-stream.js";

describe("isRateLimitError", () => {
  it.each([
    "rate limit exceeded",
    "Rate limit exceeded",
    "429 Too Many Requests",
    "too many requests",
    "quota exceeded",
    "throttled by server",
    "Resource exhausted",
    "rate_limit_exceeded",
  ])("detects '%s' as rate limit", (msg) => {
    expect(isRateLimitError(msg)).toBe(true);
  });

  it.each([
    "authentication failed",
    "model not found",
    "invalid request",
    "500 internal server error",
  ])("does not flag '%s' as rate limit", (msg) => {
    expect(isRateLimitError(msg)).toBe(false);
  });
});

describe("isTransientError", () => {
  it.each([
    "request timed out",
    "timeout waiting for response",
    "server overloaded",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "socket hang up",
    "ECONNRESET",
    "write EPIPE",
  ])("detects '%s' as transient", (msg) => {
    expect(isTransientError(msg)).toBe(true);
  });

  it.each(["authentication failed", "rate limit exceeded", "invalid JSON", "billing error"])(
    "does not flag '%s' as transient",
    (msg) => {
      expect(isTransientError(msg)).toBe(false);
    },
  );
});

describe("buildErrorMessage", () => {
  it("prepends status code when provided", () => {
    expect(buildErrorMessage("rate limit exceeded", 429)).toBe("429 rate limit exceeded");
  });

  it("returns raw message when no status code", () => {
    expect(buildErrorMessage("something failed")).toBe("something failed");
  });

  it("returns raw message when status code is 0/undefined", () => {
    expect(buildErrorMessage("fail", 0)).toBe("fail");
    expect(buildErrorMessage("fail", undefined)).toBe("fail");
  });
});

describe("contextToPrompt", () => {
  it("extracts the last user message", () => {
    const context: Context = {
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "first question", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          api: "openai-completions",
          provider: "github-copilot",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "second question", timestamp: 3 },
      ],
    };
    expect(contextToPrompt(context)).toBe("second question");
  });

  it("handles content arrays with text blocks", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
          timestamp: 1,
        },
      ],
    };
    expect(contextToPrompt(context)).toBe("hello \nworld");
  });

  it("returns empty string when no user messages", () => {
    const context: Context = { messages: [] };
    expect(contextToPrompt(context)).toBe("");
  });

  it("skips non-user messages", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I am assistant" }],
          api: "openai-completions",
          provider: "github-copilot",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      ],
    };
    expect(contextToPrompt(context)).toBe("");
  });
});
