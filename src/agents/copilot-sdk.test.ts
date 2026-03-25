import { afterEach, describe, expect, it, vi } from "vitest";

// Mock CopilotClient and CopilotSession for runCopilotAgent tests
const mockSession = {
  sendAndWait: vi.fn(),
  destroy: vi.fn(),
  sessionId: "mock-session-id",
};
const mockClient = {
  stop: vi.fn(),
  createSession: vi.fn().mockResolvedValue(mockSession),
  resumeSession: vi.fn().mockResolvedValue(mockSession),
  getAuthStatus: vi
    .fn()
    .mockResolvedValue({ isAuthenticated: true, authType: "user", login: "octocat" }),
  listModels: vi.fn(),
};

vi.mock("@github/copilot-sdk", () => {
  // Use a real class so vitest treats it as a constructor
  return {
    CopilotClient: class MockCopilotClient {
      constructor() {
        return mockClient;
      }
    },
  };
});

describe("copilot-sdk", () => {
  afterEach(() => {
    mockSession.sendAndWait.mockReset();
    mockSession.destroy.mockReset().mockResolvedValue(undefined);
    mockClient.stop.mockReset().mockResolvedValue(undefined);
    mockClient.createSession.mockReset().mockResolvedValue(mockSession);
    mockClient.resumeSession.mockReset().mockResolvedValue(mockSession);
    mockClient.getAuthStatus
      .mockReset()
      .mockResolvedValue({ isAuthenticated: true, authType: "user", login: "octocat" });
    mockClient.listModels.mockReset();
  });

  describe("isCopilotCliInstalled", () => {
    it("returns true when @github/copilot-sdk is resolvable", async () => {
      const resolveFn = vi
        .fn()
        .mockReturnValue("file:///node_modules/@github/copilot-sdk/index.js");
      const { isCopilotCliInstalled } = await import("./copilot-sdk.js");
      expect(isCopilotCliInstalled({ resolveFn })).toBe(true);
      expect(resolveFn).toHaveBeenCalledWith("@github/copilot-sdk");
    });

    it("returns false when @github/copilot-sdk is not installed", async () => {
      const resolveFn = vi.fn().mockImplementation(() => {
        throw new Error("ERR_MODULE_NOT_FOUND");
      });
      const { isCopilotCliInstalled } = await import("./copilot-sdk.js");
      expect(isCopilotCliInstalled({ resolveFn })).toBe(false);
    });
  });

  describe("checkCopilotAvailable", () => {
    it("returns unavailable when SDK is not installed", async () => {
      const resolveFn = vi.fn().mockImplementation(() => {
        throw new Error("ERR_MODULE_NOT_FOUND");
      });

      const { checkCopilotAvailable } = await import("./copilot-sdk.js");
      const result = checkCopilotAvailable({ resolveFn });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("not installed");
    });

    it("returns available when SDK is installed", async () => {
      const resolveFn = vi
        .fn()
        .mockReturnValue("file:///node_modules/@github/copilot-sdk/index.js");

      const { checkCopilotAvailable } = await import("./copilot-sdk.js");
      const result = checkCopilotAvailable({ resolveFn });
      expect(result.available).toBe(true);
    });
  });

  describe("runCopilotAgent", () => {
    it("verifies auth before creating session", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "Hello from copilot!" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "Say hello",
        model: "gpt-4o",
        workspaceDir: "/tmp",
        timeoutMs: 5_000,
      });

      expect(mockClient.getAuthStatus).toHaveBeenCalledTimes(1);
      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    });

    it("throws when not authenticated", async () => {
      mockClient.getAuthStatus.mockResolvedValueOnce({
        isAuthenticated: false,
        statusMessage: "No token",
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await expect(runCopilotAgent({ prompt: "hi", timeoutMs: 5_000 })).rejects.toThrow(
        "copilot CLI not authenticated",
      );
      expect(mockClient.createSession).not.toHaveBeenCalled();
      expect(mockClient.stop).toHaveBeenCalled();
    });

    it("creates a new session and sends the prompt", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "Hello from copilot!" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      const result = await runCopilotAgent({
        prompt: "Say hello",
        model: "gpt-4o",
        workspaceDir: "/tmp",
        timeoutMs: 5_000,
      });

      expect(result.text).toBe("Hello from copilot!");
      expect(result.sessionId).toBe("mock-session-id");
      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
      expect(mockClient.resumeSession).not.toHaveBeenCalled();
      expect(mockSession.sendAndWait).toHaveBeenCalledWith({ prompt: "Say hello" }, 5_000);
      expect(mockSession.destroy).toHaveBeenCalled();
      expect(mockClient.stop).toHaveBeenCalled();
    });

    it("resumes existing session when sessionId is provided", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "Resumed!" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "continue",
        sessionId: "existing-session-123",
        timeoutMs: 5_000,
      });

      expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
      expect(mockClient.resumeSession).toHaveBeenCalledWith(
        "existing-session-123",
        expect.any(Object),
      );
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it("returns empty string when response has no content", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce(undefined);

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      const result = await runCopilotAgent({
        prompt: "empty",
        timeoutMs: 5_000,
      });

      expect(result.text).toBe("");
    });

    it("cleans up session and client even on error", async () => {
      mockSession.sendAndWait.mockRejectedValueOnce(new Error("SDK timeout"));

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await expect(runCopilotAgent({ prompt: "boom", timeoutMs: 1_000 })).rejects.toThrow(
        "SDK timeout",
      );

      // Cleanup should still happen
      expect(mockSession.destroy).toHaveBeenCalled();
      expect(mockClient.stop).toHaveBeenCalled();
    });

    it("passes availableTools to session config and auto-approves permissions", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "tools!" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "use tools",
        availableTools: ["read", "write", "exec"],
        timeoutMs: 5_000,
      });

      const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
      expect(sessionConfig.availableTools).toEqual(["read", "write", "exec"]);
      expect(sessionConfig.excludedTools).toBeUndefined();
      // Permission handler should auto-approve when tool filters are set
      const permResult = await sessionConfig.onPermissionRequest();
      expect(permResult.kind).toBe("approved");
    });

    it("passes excludedTools to session config and auto-approves permissions", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "tools!" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "use tools",
        excludedTools: ["exec", "write"],
        timeoutMs: 5_000,
      });

      const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
      expect(sessionConfig.excludedTools).toEqual(["exec", "write"]);
      expect(sessionConfig.availableTools).toBeUndefined();
      const permResult = await sessionConfig.onPermissionRequest();
      expect(permResult.kind).toBe("approved");
    });

    it("denies permissions when no tool filters are set", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "no tools" },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "hi",
        timeoutMs: 5_000,
      });

      const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
      expect(sessionConfig.availableTools).toBeUndefined();
      expect(sessionConfig.excludedTools).toBeUndefined();
      const permResult = await sessionConfig.onPermissionRequest();
      expect(permResult.kind).toBe("denied-interactively-by-user");
    });

    it("passes system prompt as append mode", async () => {
      mockSession.sendAndWait.mockResolvedValueOnce({
        data: { content: "Got it." },
      });

      const { runCopilotAgent } = await import("./copilot-sdk.js");
      await runCopilotAgent({
        prompt: "hi",
        systemPrompt: "You are a helpful assistant.",
        timeoutMs: 5_000,
      });

      const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
      expect(sessionConfig.systemMessage).toEqual({
        mode: "append",
        content: "You are a helpful assistant.",
      });
    });
  });

  describe("listCopilotModels", () => {
    it("returns models when authenticated", async () => {
      const mockModels = [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "gpt-5", name: "GPT-5" },
      ];
      mockClient.listModels.mockResolvedValueOnce(mockModels);

      const { listCopilotModels } = await import("./copilot-sdk.js");
      const models = await listCopilotModels();
      expect(models).toEqual(mockModels);
      expect(mockClient.getAuthStatus).toHaveBeenCalled();
      expect(mockClient.stop).toHaveBeenCalled();
    });

    it("returns null when not authenticated", async () => {
      mockClient.getAuthStatus.mockResolvedValueOnce({ isAuthenticated: false });

      const { listCopilotModels } = await import("./copilot-sdk.js");
      const models = await listCopilotModels();
      expect(models).toBeNull();
      expect(mockClient.stop).toHaveBeenCalled();
    });

    it("returns null when listing fails", async () => {
      mockClient.listModels.mockRejectedValueOnce(new Error("Network error"));

      const { listCopilotModels } = await import("./copilot-sdk.js");
      const models = await listCopilotModels();
      expect(models).toBeNull();
    });
  });

  describe("createCopilotClient", () => {
    it("creates a client with default options", async () => {
      const { createCopilotClient } = await import("./copilot-sdk.js");
      const client = await createCopilotClient();
      expect(client).toBeDefined();
    });
  });
});
