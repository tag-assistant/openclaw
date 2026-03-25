/**
 * Maps OpenClaw ThinkLevel to the Copilot SDK's ReasoningEffort.
 */
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";

/** SDK reasoning effort levels. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Model info subset needed for validation. */
export interface ReasoningModelInfo {
  capabilities?: { supports?: { reasoningEffort?: boolean } };
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

/**
 * Convert an OpenClaw ThinkLevel to a Copilot SDK ReasoningEffort.
 * Returns undefined when reasoning should not be explicitly set.
 */
export function mapThinkLevelToReasoningEffort(
  thinkLevel: ThinkLevel | undefined,
): ReasoningEffort | undefined {
  switch (thinkLevel) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    // "off", "minimal", "adaptive", undefined → don't set
    default:
      return undefined;
  }
}

/**
 * Validate that the model supports the requested reasoning effort.
 * Falls back to the model's default if the level isn't supported,
 * or undefined if the model doesn't support reasoning at all.
 */
export function validateReasoningEffort(
  effort: ReasoningEffort | undefined,
  modelInfo: ReasoningModelInfo | undefined,
): ReasoningEffort | undefined {
  if (!effort) {
    return undefined;
  }
  if (!modelInfo?.capabilities?.supports?.reasoningEffort) {
    return undefined;
  }

  const supported = modelInfo.supportedReasoningEfforts;
  if (supported && !supported.includes(effort)) {
    return modelInfo.defaultReasoningEffort ?? undefined;
  }

  return effort;
}
