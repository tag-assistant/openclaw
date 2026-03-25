import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutUserInputHandler } from "./copilot-user-input.js";
import type { UserInputRequest, UserInputResponse } from "./copilot-user-input.js";

describe("copilot-user-input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createTimeoutUserInputHandler", () => {
    it("forwards request to inner handler and returns its result", async () => {
      const inner = vi
        .fn<(req: UserInputRequest) => Promise<UserInputResponse>>()
        .mockResolvedValue({
          answer: "Yes",
          wasFreeform: false,
        });

      const handler = createTimeoutUserInputHandler({ handler: inner });
      const resultPromise = handler({ question: "Continue?", choices: ["Yes", "No"] });

      // No timeout needed — inner resolves immediately
      const result = await resultPromise;
      expect(result).toEqual({ answer: "Yes", wasFreeform: false });
      expect(inner).toHaveBeenCalledWith({ question: "Continue?", choices: ["Yes", "No"] });
    });

    it("returns default answer on timeout", async () => {
      const inner = vi
        .fn<(req: UserInputRequest) => Promise<UserInputResponse>>()
        .mockImplementation(
          () => new Promise(() => {}), // never resolves
        );

      const handler = createTimeoutUserInputHandler({
        handler: inner,
        timeoutMs: 5_000,
      });
      const resultPromise = handler({ question: "Are you there?" });

      vi.advanceTimersByTime(5_000);
      const result = await resultPromise;
      expect(result).toEqual({ answer: "No response", wasFreeform: true });
    });

    it("uses custom defaultAnswer on timeout", async () => {
      const inner = vi
        .fn<(req: UserInputRequest) => Promise<UserInputResponse>>()
        .mockImplementation(() => new Promise(() => {}));

      const handler = createTimeoutUserInputHandler({
        handler: inner,
        timeoutMs: 1_000,
        defaultAnswer: "Skipped by user",
      });
      const resultPromise = handler({ question: "Pick one" });

      vi.advanceTimersByTime(1_000);
      const result = await resultPromise;
      expect(result).toEqual({ answer: "Skipped by user", wasFreeform: true });
    });

    it("returns inner result when it resolves before timeout", async () => {
      const inner = vi
        .fn<(req: UserInputRequest) => Promise<UserInputResponse>>()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ answer: "Quick!", wasFreeform: true }), 100);
            }),
        );

      const handler = createTimeoutUserInputHandler({
        handler: inner,
        timeoutMs: 5_000,
      });
      const resultPromise = handler({ question: "Fast?" });

      vi.advanceTimersByTime(100);
      const result = await resultPromise;
      expect(result).toEqual({ answer: "Quick!", wasFreeform: true });
    });

    it("defaults timeoutMs to 120000", async () => {
      const inner = vi
        .fn<(req: UserInputRequest) => Promise<UserInputResponse>>()
        .mockImplementation(() => new Promise(() => {}));

      const handler = createTimeoutUserInputHandler({ handler: inner });
      const resultPromise = handler({ question: "Long wait?" });

      // Should NOT have timed out yet at 119s
      vi.advanceTimersByTime(119_000);
      // Use a microtask check — the promise should still be pending
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Now advance past 120s
      vi.advanceTimersByTime(1_000);
      const result = await resultPromise;
      expect(result).toEqual({ answer: "No response", wasFreeform: true });
    });
  });
});
