import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock copilot-sdk.js — the runner delegates to this module
const checkCopilotAvailableMock = vi.fn();
const runCopilotAgentMock = vi.fn();

vi.mock("./copilot-sdk.js", () => ({
  checkCopilotAvailable: (...args: unknown[]) => checkCopilotAvailableMock(...args),
  runCopilotAgent: (...args: unknown[]) => runCopilotAgentMock(...args),
}));

// Mock bundle-mcp to control MCP server loading in tests
const loadEnabledBundleMcpConfigMock = vi.fn();
vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: (...args: unknown[]) => loadEnabledBundleMcpConfigMock(...args),
  extractMcpServerMap: vi.fn(),
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
    loadEnabledBundleMcpConfigMock.mockReset();
    // Default: no MCP servers
    loadEnabledBundleMcpConfigMock.mockReturnValue({
      config: { mcpServers: {} },
      diagnostics: [],
    });
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

  it("passes MCP servers to SDK when bundle-mcp config has servers", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "MCP available",
      sessionId: "sid-mcp",
    });
    loadEnabledBundleMcpConfigMock.mockReturnValue({
      config: {
        mcpServers: {
          "my-server": {
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "secret" },
            cwd: "/tmp/plugins/my-server",
            tools: ["search", "read"],
          },
          "remote-server": {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer abc" },
            tools: ["query"],
          },
        },
      },
      diagnostics: [],
    });

    await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "use mcp",
      timeoutMs: 5_000,
      runId: "run-mcp",
    });

    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.mcpServers).toBeDefined();
    expect(Object.keys(sdkArgs.mcpServers)).toEqual(["my-server", "remote-server"]);
    expect(sdkArgs.mcpServers["my-server"]).toEqual({
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "secret" },
      cwd: "/tmp/plugins/my-server",
      tools: ["search", "read"],
    });
    expect(sdkArgs.mcpServers["remote-server"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
      tools: ["query"],
    });
  });

  it("does not pass mcpServers when no MCP servers are configured", async () => {
    checkCopilotAvailableMock.mockReturnValue({ available: true });
    runCopilotAgentMock.mockResolvedValueOnce({
      text: "no mcp",
      sessionId: "sid-nomcp",
    });

    await runCopilotCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      timeoutMs: 5_000,
      runId: "run-nomcp",
    });

    const sdkArgs = runCopilotAgentMock.mock.calls[0]?.[0];
    expect(sdkArgs.mcpServers).toBeUndefined();
  });
});
