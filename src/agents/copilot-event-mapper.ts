import type { SessionEvent } from "@github/copilot-sdk";

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/**
 * Creates an event handler that logs interesting Copilot SDK session events.
 * Returns the handler function to pass to `session.on(handler)`.
 */
export function createCopilotEventLogger(log: LogFn): (event: SessionEvent) => void {
  return (event: SessionEvent) => {
    const e = event as Record<string, unknown>;
    const type = e.type as string | undefined;
    if (!type) {
      return;
    }

    switch (type) {
      case "tool.execution_start":
        log("copilot tool execution started", { tool: e.toolName ?? e.name });
        break;
      case "tool.execution_complete":
        log("copilot tool execution complete", {
          tool: e.toolName ?? e.name,
          success: e.success ?? !e.error,
        });
        break;
      case "session.usage_info":
        log("copilot usage info", {
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          totalTokens: e.totalTokens,
        });
        break;
      case "assistant.reasoning":
        log("copilot reasoning in progress");
        break;
      case "session.compaction_start":
        log("copilot session compaction started");
        break;
      case "session.compaction_complete":
        log("copilot session compaction complete");
        break;
      case "subagent.started":
        log("copilot subagent started", { subagentId: e.subagentId, name: e.name });
        break;
      case "subagent.completed":
        log("copilot subagent completed", { subagentId: e.subagentId, name: e.name });
        break;
      case "subagent.failed":
        log("copilot subagent failed", {
          subagentId: e.subagentId,
          name: e.name,
          error: e.error,
        });
        break;
    }
  };
}

export type CopilotUsageInfo = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Extract aggregated usage info from a list of collected session events.
 * Sums all `session.usage_info` events for cost tracking.
 */
export function extractUsageFromEvents(events: SessionEvent[]): CopilotUsageInfo | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let found = false;

  for (const event of events) {
    const e = event as Record<string, unknown>;
    if (e.type === "session.usage_info") {
      found = true;
      promptTokens += (e.promptTokens as number) || 0;
      completionTokens += (e.completionTokens as number) || 0;
      totalTokens += (e.totalTokens as number) || 0;
    }
  }

  return found ? { promptTokens, completionTokens, totalTokens } : undefined;
}
