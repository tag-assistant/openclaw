import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @github/copilot-sdk module
const mockSetModel = vi.fn().mockResolvedValue(undefined);
const mockSendAndWait = vi.fn().mockResolvedValue({ data: { content: "hello" } });
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockGetAuthStatus = vi.fn().mockResolvedValue({
  isAuthenticated: true,
  authType: "token",
  login: "test-user",
});
const mockCreateSession = vi.fn().mockResolvedValue({
  sessionId: "sess-new",
  setModel: mockSetModel,
  sendAndWait: mockSendAndWait,
  destroy: mockDestroy,
});
const mockResumeSession = vi.fn().mockResolvedValue({
  sessionId: "sess-resumed",
  setModel: mockSetModel,
  sendAndWait: mockSendAndWait,
  destroy: mockDestroy,
});

vi.mock("@github/copilot-sdk", () => {
  const MockClient = vi.fn(function (this: Record<string, unknown>) {
    this.getAuthStatus = mockGetAuthStatus;
    this.createSession = mockCreateSession;
    this.resumeSession = mockResumeSession;
    this.listModels = vi.fn().mockResolvedValue([]);
    this.stop = mockStop;
  });
  return { CopilotClient: MockClient };
});

// Must import after mock setup
const { runCopilotAgent } = await import("./copilot-sdk.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockSendAndWait.mockResolvedValue({ data: { content: "response" } });
});

describe("runCopilotAgent dynamic model switching", () => {
  it("does not call setModel when modelOverride is not set", async () => {
    const result = await runCopilotAgent({
      prompt: "hi",
      model: "gpt-4o",
    });

    expect(mockSetModel).not.toHaveBeenCalled();
    expect(result.model).toBe("gpt-4o");
    expect(result.text).toBe("response");
  });

  it("calls setModel when modelOverride is provided on new session", async () => {
    const result = await runCopilotAgent({
      prompt: "hi",
      model: "gpt-4o",
      modelOverride: "claude-sonnet-4",
    });

    expect(mockSetModel).toHaveBeenCalledWith("claude-sonnet-4");
    expect(result.model).toBe("claude-sonnet-4");
    expect(result.sessionId).toBe("sess-new");
  });

  it("calls setModel when modelOverride is provided on resumed session", async () => {
    const result = await runCopilotAgent({
      prompt: "hi",
      model: "gpt-4o",
      modelOverride: "claude-sonnet-4",
      sessionId: "existing-session",
    });

    expect(mockResumeSession).toHaveBeenCalledWith("existing-session", expect.any(Object));
    expect(mockSetModel).toHaveBeenCalledWith("claude-sonnet-4");
    expect(result.model).toBe("claude-sonnet-4");
    expect(result.sessionId).toBe("sess-resumed");
  });

  it("returns model as undefined when no model or override specified", async () => {
    const result = await runCopilotAgent({
      prompt: "hi",
    });

    expect(mockSetModel).not.toHaveBeenCalled();
    expect(result.model).toBeUndefined();
  });
});
