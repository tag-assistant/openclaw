import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionHooks } from "./copilot-sdk.js";

const log = createSubsystemLogger("agents/copilot-hooks");

/**
 * Tools that are denied by default in hook-managed sessions.
 * These are high-risk tools that should require explicit opt-in.
 */
const DENIED_TOOLS = new Set(["delete_file", "delete_directory", "execute_command", "run_shell"]);

/**
 * Build observability hooks for Copilot SDK sessions.
 * Logs all hook events via the subsystem logger and optionally denies
 * dangerous tool invocations.
 */
export function buildCopilotSessionHooks(options?: {
  /** Additional tool names to deny. Merged with the built-in deny list. */
  denyTools?: string[];
  /** Disable the built-in tool deny list entirely. */
  disableToolDenyList?: boolean;
}): SessionHooks {
  const startedAt = Date.now();
  const denySet = options?.disableToolDenyList
    ? new Set(options?.denyTools ?? [])
    : new Set([...DENIED_TOOLS, ...(options?.denyTools ?? [])]);

  return {
    onSessionStart: (input, { sessionId }) => {
      log.info("session started", {
        sessionId,
        source: input.source,
      });
    },

    onSessionEnd: (input, { sessionId }) => {
      const durationMs = Date.now() - startedAt;
      log.info("session ended", {
        sessionId,
        reason: input.reason,
        durationMs,
        ...(input.error ? { error: input.error } : {}),
      });
    },

    onPreToolUse: (input, { sessionId }) => {
      log.info("pre-tool-use", {
        sessionId,
        tool: input.toolName,
        argsKeys:
          input.toolArgs && typeof input.toolArgs === "object"
            ? Object.keys(input.toolArgs as Record<string, unknown>)
            : undefined,
      });

      if (denySet.has(input.toolName)) {
        log.warn("tool denied by hook policy", {
          sessionId,
          tool: input.toolName,
        });
        return {
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Tool "${input.toolName}" is denied by session hook policy.`,
        };
      }
    },

    onPostToolUse: (input, { sessionId }) => {
      const resultStr = input.toolResult != null ? JSON.stringify(input.toolResult) : "";
      log.info("post-tool-use", {
        sessionId,
        tool: input.toolName,
        resultLength: resultStr.length,
      });
    },

    onUserPromptSubmitted: (input, { sessionId }) => {
      // Log prompt length only — not content, for privacy
      log.info("user prompt submitted", {
        sessionId,
        promptLength: input.prompt.length,
      });
    },

    onErrorOccurred: (input, { sessionId }) => {
      log.error("error occurred", {
        sessionId,
        error: input.error,
        context: input.errorContext,
        recoverable: input.recoverable,
      });

      if (input.recoverable) {
        return {
          errorHandling: "retry" as const,
          retryCount: 1,
        };
      }
    },
  };
}
