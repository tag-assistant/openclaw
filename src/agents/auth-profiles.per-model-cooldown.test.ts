import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  isProfileInCooldownForModel,
  markAuthProfileFailure,
} from "./auth-profiles.js";

describe("isProfileInCooldownForModel", () => {
  function makeStore(stats: NonNullable<AuthProfileStore["usageStats"]>[string]): AuthProfileStore {
    return {
      version: 1,
      profiles: {
        "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
      },
      usageStats: { "copilot:default": stats },
    };
  }

  it("returns false when no usage stats exist", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
      },
    };
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6")).toBe(false);
  });

  it("returns true for profile-level cooldown regardless of model", () => {
    const store = makeStore({ cooldownUntil: Date.now() + 60_000 });
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6")).toBe(true);
    expect(isProfileInCooldownForModel(store, "copilot:default", "gpt-5.3")).toBe(true);
  });

  it("returns true for profile-level disabled (billing) regardless of model", () => {
    const store = makeStore({ disabledUntil: Date.now() + 60_000 });
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6")).toBe(true);
    expect(isProfileInCooldownForModel(store, "copilot:default", "gpt-5.3")).toBe(true);
  });

  it("blocks only the rate-limited model, not others", () => {
    const store = makeStore({
      modelCooldowns: {
        "claude-opus-4.6-1m": Date.now() + 60_000,
      },
    });
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6-1m")).toBe(true);
    expect(isProfileInCooldownForModel(store, "copilot:default", "gpt-5.3")).toBe(false);
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6")).toBe(false);
  });

  it("returns false when model cooldown has expired", () => {
    const store = makeStore({
      modelCooldowns: { "claude-opus-4.6-1m": Date.now() - 1_000 },
    });
    expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6-1m")).toBe(false);
  });

  it("isProfileInCooldown ignores per-model cooldowns (backward compat)", () => {
    const store = makeStore({
      modelCooldowns: { "claude-opus-4.6-1m": Date.now() + 60_000 },
    });
    expect(isProfileInCooldown(store, "copilot:default")).toBe(false);
  });
});

describe("markAuthProfileFailure with modelId", () => {
  it("scopes rate_limit cooldown to the specific model", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "copilot:default",
        reason: "rate_limit",
        agentDir,
        modelId: "claude-opus-4.6-1m",
      });

      const stats = store.usageStats?.["copilot:default"];
      // Profile-level cooldown should NOT be set.
      expect(stats?.cooldownUntil).toBeUndefined();
      // Per-model cooldown SHOULD be set.
      expect(stats?.modelCooldowns?.["claude-opus-4.6-1m"]).toBeTypeOf("number");
      expect(stats!.modelCooldowns!["claude-opus-4.6-1m"]).toBeGreaterThan(Date.now());

      // Other model is not in cooldown.
      expect(isProfileInCooldownForModel(store, "copilot:default", "gpt-5.3")).toBe(false);
      // Rate-limited model IS in cooldown.
      expect(isProfileInCooldownForModel(store, "copilot:default", "claude-opus-4.6-1m")).toBe(
        true,
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("scopes timeout cooldown to the specific model", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "copilot:default",
        reason: "timeout",
        agentDir,
        modelId: "claude-opus-4.6-1m",
      });

      const stats = store.usageStats?.["copilot:default"];
      expect(stats?.cooldownUntil).toBeUndefined();
      expect(stats?.modelCooldowns?.["claude-opus-4.6-1m"]).toBeGreaterThan(Date.now());
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("uses profile-level cooldown for auth failures even with modelId", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "copilot:default",
        reason: "auth",
        agentDir,
        modelId: "claude-opus-4.6-1m",
      });

      const stats = store.usageStats?.["copilot:default"];
      // Auth failures go to profile-level cooldown, not per-model.
      expect(stats?.cooldownUntil).toBeTypeOf("number");
      expect(stats?.modelCooldowns).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to profile-level cooldown without modelId", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "copilot:default": { type: "token", provider: "github-copilot", token: "tok" },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "copilot:default",
        reason: "rate_limit",
        agentDir,
        // No modelId — should use profile-level cooldown
      });

      const stats = store.usageStats?.["copilot:default"];
      expect(stats?.cooldownUntil).toBeTypeOf("number");
      expect(stats?.modelCooldowns).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
