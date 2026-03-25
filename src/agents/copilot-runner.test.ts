import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock copilot-sdk.js — the runner delegates to this module
const checkCopilotAvailableMock = vi.fn();
const runCopilotAgentMock = vi.fn();

vi.mock("./copilot-sdk.js", () => ({
  checkCopilotAvailable: (...args: unknown[]) => checkCopilotAvailableMock(...args),
  runCopilotAgent: (...args: unknown[]) => runCopilotAgentMock(...args),
}));

// Mock copilot-session-hooks.js to verify it's called and hooks are passed through
const buildCopilotSessionHooksMock = vi.fn();
vi.mock("./copilot-session-hooks.js", () => ({
  buildCopilotSessionHooks: (...args: unknown[]) => buildCopilotSessionHooksMock(...args),
}));

// Stub out bootstrap/docs resolution to avoid filesystem side effects
vi.mock("./bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
  makeBootstrapWarn: vi.fn(() => () => {}),
}));
vi.mock("./docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => null),
}));

import { runCopilotCliAgent } from "./copilot-runner.js";
import { FailoverError } from "./failover-error.js";

describe("runCopilotCliAgent", () => {
  beforeEach(() => {
    checkCopilotAvailableMock.mockReset();
    runCopilotAgentMock.mockReset();
    buildCopilotSessionHooksMock.mockReset();
    buildCopilotSessionHooksMock.mockReturnValue({ onSessionStart: vi.fn() });
  });

  it("throws FailoverError when copilot is not available", async () => {
    checkCopilotAvailableMock.mockReturnValue({
      available: false,
      reason: "copilot CLI not found on PATH",
    });

    await expect(
      runCopilotCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hello",
        timeoutMs: 5_000,
        runId: "run-1",
      }),
    ).rejects.toThrow(FailoverError);

    expect(runCopilotAgentMock).not.toHaveBeenCalled();
  });

  it("runs prompt through copilot SDK and returns result", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "Hello! I can help with that.",
      sessionId: "copilot-session-abc",
    });

    const result = await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      model: "gpt-4o",
      timeoutMs: 5_000,
      runId: "run-1",
    });

    expect(result.payloads).toBeDefined();
    expect(result.payloads?.[0]?.text).toBe("Hello! I can help with that.");
    expect(result.meta?.agentMeta?.provider).toBe("copilot-cli");
    expect(result.meta?.agentMeta?.model).toBe("gpt-4o");
    expect(result.meta?.agentMeta?.sessionId).toBe("copilot-session-abc");
    expect(result.meta?.durationMs).toBeGreaterThanOrEqual(0);

    // Verify the SDK was called with the right params
    expect(runCopilotAgentMock).toHaveBeenCalledTimes(1);
    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.prompt).toBe("hello");
    expect(sdkArgs.model).toBe("gpt-4o");
    expect(sdkArgs.workspaceDir).toBe("/tmp");
    expect(sdkArgs.timeoutMs).toBe(5_000);
  });

  it("passes through cliSessionId as sessionId for resume", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "Resumed session.",
      sessionId: "copilot-session-existing",
    });

    await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 5_000,
      runId: "run-2",
      cliSessionId: "copilot-session-existing",
    });

    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.sessionId).toBe("copilot-session-existing");
  });

  it("returns empty payloads when response is empty", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "",
      sessionId: "copilot-session-empty",
    });

    const result = await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      timeoutMs: 5_000,
      runId: "run-3",
    });

    expect(result.payloads).toBeUndefined();
  });

  it("wraps SDK errors as FailoverError when appropriate", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockRejectedValueOnce(new Error("rate limit exceeded"));

    await expect(
      runCopilotCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hello",
        timeoutMs: 5_000,
        runId: "run-4",
      }),
    ).rejects.toThrow(FailoverError);
  });

  it("passes through non-failover errors unchanged", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    const unexpectedError = new TypeError("unexpected type issue");
    runCopilotAgentMock.mockRejectedValueOnce(unexpectedError);

    await expect(
      runCopilotCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hello",
        timeoutMs: 5_000,
        runId: "run-5",
      }),
    ).rejects.toThrow(unexpectedError);
  });

  it("uses default model when none specified", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "ok",
      sessionId: "sid-default",
    });

    const result = await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      timeoutMs: 5_000,
      runId: "run-6",
    });

    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    // When model is "default", SDK receives undefined so it uses its own default
    expect(sdkArgs.model).toBeUndefined();
    expect(result.meta?.agentMeta?.model).toBe("default");
  });

  it("builds session hooks and passes them to runCopilotAgent", async () => {
    const fakeHooks = { onSessionStart: vi.fn(), onPreToolUse: vi.fn() };
    buildCopilotSessionHooksMock.mockReturnValue(fakeHooks);
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "hooked",
      sessionId: "copilot-session-hooks",
    });

    await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      timeoutMs: 5_000,
      runId: "run-hooks",
    });

    // Verify buildCopilotSessionHooks was called
    expect(buildCopilotSessionHooksMock).toHaveBeenCalledTimes(1);

    // Verify hooks were passed through to runCopilotAgent
    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.hooks).toBe(fakeHooks);
  });

  it("does not pass hooks when buildCopilotSessionHooks returns undefined", async () => {
    buildCopilotSessionHooksMock.mockReturnValue(undefined);
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "no hooks",
      sessionId: "copilot-session-no-hooks",
    });

    await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      timeoutMs: 5_000,
      runId: "run-no-hooks",
    });

    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.hooks).toBeUndefined();
  });
});
