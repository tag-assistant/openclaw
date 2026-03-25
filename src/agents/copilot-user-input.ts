import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/copilot-user-input");

export type UserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
};

export type UserInputResponse = {
  answer: string;
  wasFreeform: boolean;
};

export type UserInputHandlerFn = (request: UserInputRequest) => Promise<UserInputResponse>;

export type TimeoutUserInputHandlerOptions = {
  handler: UserInputHandlerFn;
  timeoutMs?: number;
  defaultAnswer?: string;
};

/**
 * Wraps a user input handler with timeout logic.
 * If the inner handler doesn't resolve within `timeoutMs`, returns a fallback response.
 */
export function createTimeoutUserInputHandler(
  options: TimeoutUserInputHandlerOptions,
): UserInputHandlerFn {
  const { handler, timeoutMs = 120_000, defaultAnswer } = options;
  const fallbackAnswer = defaultAnswer ?? "No response";

  return async (request: UserInputRequest): Promise<UserInputResponse> => {
    const result = await Promise.race([
      handler(request),
      new Promise<UserInputResponse>((resolve) => {
        setTimeout(() => {
          log.warn("user input handler timed out", {
            timeoutMs,
            questionLength: request.question.length,
          });
          resolve({ answer: fallbackAnswer, wasFreeform: true });
        }, timeoutMs);
      }),
    ]);
    return result;
  };
}
