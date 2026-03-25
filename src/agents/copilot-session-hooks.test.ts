import { describe, expect, it, vi } from "vitest";

// Stub logging to avoid side effects
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { buildCopilotSessionHooks } from "./copilot-session-hooks.js";

describe("buildCopilotSessionHooks", () => {
  const invocation = { sessionId: "test-session" };

  it("returns hooks with all expected handlers", () => {
    const hooks = buildCopilotSessionHooks();
    expect(hooks.onSessionStart).toBeTypeOf("function");
    expect(hooks.onSessionEnd).toBeTypeOf("function");
    expect(hooks.onPreToolUse).toBeTypeOf("function");
    expect(hooks.onPostToolUse).toBeTypeOf("function");
    expect(hooks.onUserPromptSubmitted).toBeTypeOf("function");
    expect(hooks.onErrorOccurred).toBeTypeOf("function");
  });

  it("onPreToolUse denies dangerous tools by default", () => {
    const hooks = buildCopilotSessionHooks();
    const result = hooks.onPreToolUse!(
      {
        toolName: "delete_file",
        toolArgs: { path: "/etc/hosts" },
        timestamp: Date.now(),
        cwd: "/tmp",
      },
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ permissionDecision: "deny" }));
  });

  it("onPreToolUse allows non-dangerous tools", () => {
    const hooks = buildCopilotSessionHooks();
    const result = hooks.onPreToolUse!(
      { toolName: "read_file", toolArgs: { path: "foo.ts" }, timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(result).toBeUndefined();
  });

  it("onPreToolUse respects custom denyTools", () => {
    const hooks = buildCopilotSessionHooks({ denyTools: ["my_custom_tool"] });
    const result = hooks.onPreToolUse!(
      { toolName: "my_custom_tool", toolArgs: {}, timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ permissionDecision: "deny" }));
  });

  it("onPreToolUse skips deny list when disableToolDenyList is true", () => {
    const hooks = buildCopilotSessionHooks({ disableToolDenyList: true });
    const result = hooks.onPreToolUse!(
      { toolName: "delete_file", toolArgs: {}, timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(result).toBeUndefined();
  });

  it("onErrorOccurred returns retry for recoverable errors", () => {
    const hooks = buildCopilotSessionHooks();
    const result = hooks.onErrorOccurred!(
      {
        error: "timeout",
        errorContext: "model_call",
        recoverable: true,
        timestamp: Date.now(),
        cwd: "/tmp",
      },
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ errorHandling: "retry", retryCount: 1 }));
  });

  it("onErrorOccurred returns nothing for non-recoverable errors", () => {
    const hooks = buildCopilotSessionHooks();
    const result = hooks.onErrorOccurred!(
      {
        error: "fatal",
        errorContext: "system",
        recoverable: false,
        timestamp: Date.now(),
        cwd: "/tmp",
      },
      invocation,
    );
    expect(result).toBeUndefined();
  });

  it("onUserPromptSubmitted does not expose prompt content", () => {
    const hooks = buildCopilotSessionHooks();
    // Should return void (no modifications)
    const result = hooks.onUserPromptSubmitted!(
      { prompt: "secret password is abc123", timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(result).toBeUndefined();
  });

  it("onSessionStart and onSessionEnd return void", () => {
    const hooks = buildCopilotSessionHooks();
    const startResult = hooks.onSessionStart!(
      { source: "new", timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(startResult).toBeUndefined();

    const endResult = hooks.onSessionEnd!(
      { reason: "complete", timestamp: Date.now(), cwd: "/tmp" },
      invocation,
    );
    expect(endResult).toBeUndefined();
  });
});
