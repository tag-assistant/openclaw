import { describe, expect, it, vi } from "vitest";
import { createCopilotEventLogger, extractUsageFromEvents } from "./copilot-event-mapper.js";

describe("copilot-event-mapper", () => {
  describe("createCopilotEventLogger", () => {
    it("logs tool.execution_start events", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "tool.execution_start", toolName: "read_file" } as unknown);
      expect(log).toHaveBeenCalledWith("copilot tool execution started", { tool: "read_file" });
    });

    it("logs tool.execution_complete events", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "tool.execution_complete", toolName: "read_file", success: true } as unknown);
      expect(log).toHaveBeenCalledWith("copilot tool execution complete", {
        tool: "read_file",
        success: true,
      });
    });

    it("logs session.usage_info events", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({
        type: "session.usage_info",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      } as unknown);
      expect(log).toHaveBeenCalledWith("copilot usage info", {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });

    it("logs assistant.reasoning without content", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "assistant.reasoning", content: "secret reasoning" } as unknown);
      expect(log).toHaveBeenCalledWith("copilot reasoning in progress");
    });

    it("logs session compaction events", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "session.compaction_start" } as unknown);
      handler({ type: "session.compaction_complete" } as unknown);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith("copilot session compaction started");
      expect(log).toHaveBeenCalledWith("copilot session compaction complete");
    });

    it("logs subagent lifecycle events", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "subagent.started", subagentId: "sa-1", name: "coder" } as unknown);
      handler({ type: "subagent.completed", subagentId: "sa-1", name: "coder" } as unknown);
      handler({
        type: "subagent.failed",
        subagentId: "sa-2",
        name: "reviewer",
        error: "timeout",
      } as unknown);
      expect(log).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledWith("copilot subagent started", {
        subagentId: "sa-1",
        name: "coder",
      });
      expect(log).toHaveBeenCalledWith("copilot subagent completed", {
        subagentId: "sa-1",
        name: "coder",
      });
      expect(log).toHaveBeenCalledWith("copilot subagent failed", {
        subagentId: "sa-2",
        name: "reviewer",
        error: "timeout",
      });
    });

    it("ignores events without a type", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({} as unknown);
      expect(log).not.toHaveBeenCalled();
    });

    it("ignores unhandled event types", () => {
      const log = vi.fn();
      const handler = createCopilotEventLogger(log);
      handler({ type: "assistant.message" } as unknown);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe("extractUsageFromEvents", () => {
    it("returns undefined when no usage events", () => {
      const result = extractUsageFromEvents([{ type: "tool.execution_start" } as unknown]);
      expect(result).toBeUndefined();
    });

    it("extracts usage from a single event", () => {
      const result = extractUsageFromEvents([
        {
          type: "session.usage_info",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        } as unknown,
      ]);
      expect(result).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    });

    it("aggregates usage across multiple events", () => {
      const result = extractUsageFromEvents([
        {
          type: "session.usage_info",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        } as unknown,
        { type: "tool.execution_start" } as unknown,
        {
          type: "session.usage_info",
          promptTokens: 200,
          completionTokens: 80,
          totalTokens: 280,
        } as unknown,
      ]);
      expect(result).toEqual({ promptTokens: 300, completionTokens: 130, totalTokens: 430 });
    });

    it("handles missing numeric fields as zero", () => {
      const result = extractUsageFromEvents([
        { type: "session.usage_info", promptTokens: 100 } as unknown,
      ]);
      expect(result).toEqual({ promptTokens: 100, completionTokens: 0, totalTokens: 0 });
    });

    it("returns undefined for empty array", () => {
      expect(extractUsageFromEvents([])).toBeUndefined();
    });
  });
});
