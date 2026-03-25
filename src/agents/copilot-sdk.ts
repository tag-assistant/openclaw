import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  InfiniteSessionConfig,
  MCPServerConfig,
  ModelInfo,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";

/** Derive SessionHooks from SessionConfig since it's not directly exported. */
export type SessionHooks = NonNullable<SessionConfig["hooks"]>;
export type { MCPServerConfig as CopilotMcpServerConfig };

/**
 * SDK user-input types — defined locally until `@github/copilot-sdk` exports them.
 * These mirror the SDK's internal `UserInputRequest`, `UserInputResponse`, and `UserInputHandler`.
 */
type UserInputRequest = { question: string; choices?: string[]; allowFreeform?: boolean };
type UserInputResponse = { answer: string; wasFreeform: boolean };
type UserInputHandler = (
  request: UserInputRequest,
  invocation: unknown,
) => Promise<UserInputResponse>;

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/copilot-sdk");

/**
 * Check whether the `@github/copilot-sdk` package is resolvable.
 * The SDK bundles its own `@github/copilot` native binary, so a global
 * `copilot` on PATH is not required.
 */
export function isCopilotCliInstalled(options?: { resolveFn?: (id: string) => string }): boolean {
  const resolve = options?.resolveFn ?? ((id: string) => import.meta.resolve(id));
  try {
    resolve("@github/copilot-sdk");
    return true;
  } catch {
    return false;
  }
}

export type CopilotAvailability = {
  available: boolean;
  reason?: string;
};

let cachedAvailability: CopilotAvailability | undefined;

/**
 * Check whether the Copilot CLI binary is installed (sync, fast).
 * Result is cached for the lifetime of the process.
 * Auth is validated later via the SDK's `getAuthStatus()` during client startup.
 */
export function checkCopilotAvailable(options?: {
  resolveFn?: (id: string) => string;
}): CopilotAvailability {
  if (options) {
    // Custom resolveFn — skip cache (used in tests)
    return isCopilotCliInstalled(options)
      ? { available: true }
      : { available: false, reason: "@github/copilot-sdk is not installed" };
  }
  if (cachedAvailability) {
    return cachedAvailability;
  }
  cachedAvailability = isCopilotCliInstalled()
    ? { available: true }
    : { available: false, reason: "@github/copilot-sdk is not installed" };
  return cachedAvailability;
}

/**
 * Lazily import and create a CopilotClient. The SDK is only loaded when actually used.
 */
export async function createCopilotClient(options?: CopilotClientOptions): Promise<CopilotClient> {
  const { CopilotClient: ClientClass } = await import("@github/copilot-sdk");
  const client = new ClientClass({
    useStdio: true,
    autoStart: true,
    logLevel: "warning",
    ...options,
  });
  return client;
}

/**
 * Verify the client is authenticated. Throws if not.
 */
async function ensureAuthenticated(client: CopilotClient): Promise<void> {
  const authStatus = await client.getAuthStatus();
  if (!authStatus.isAuthenticated) {
    throw new Error(
      `copilot CLI not authenticated (run: copilot login). ${authStatus.statusMessage ?? ""}`.trim(),
    );
  }
  log.info("copilot auth verified", {
    authType: authStatus.authType,
    login: authStatus.login,
  });
}

/**
 * List available models from the Copilot SDK.
 * Requires an authenticated client. Returns null if listing fails.
 */
export async function listCopilotModels(options?: { cwd?: string }): Promise<ModelInfo[] | null> {
  let client: CopilotClient | undefined;
  try {
    client = await createCopilotClient({ cwd: options?.cwd });
    await ensureAuthenticated(client);
    const models = await client.listModels();
    return models;
  } catch (error) {
    log.warn("failed to list copilot models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
  }
}

export type CopilotAgentRunOptions = {
  prompt: string;
  model?: string;
  workspaceDir?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  sessionId?: string;
  hooks?: SessionHooks;
  /** Infinite sessions config for auto context compaction. */
  infiniteSessions?: {
    enabled?: boolean;
    backgroundCompactionThreshold?: number;
    bufferExhaustionThreshold?: number;
  };
  /** Switch to a different model mid-session (calls session.setModel() after create/resume). */
  modelOverride?: string;
  /** SDK-level tool allowlist — only these tools are available (takes precedence over excludedTools). */
  availableTools?: string[];
  /** SDK-level tool blocklist — all tools except these are available. */
  excludedTools?: string[];
  /** MCP server configs to forward to the SDK session. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Optional callback to receive all raw session events for observability. */
  onEvent?: (event: SessionEvent) => void;
  /** Handler for user input requests from the agent (enables ask_user tool). */
  onUserInput?: (request: {
    question: string;
    choices?: string[];
    allowFreeform?: boolean;
  }) => Promise<{ answer: string; wasFreeform: boolean }>;
  /** Reasoning effort level for models that support it. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
};

export type CopilotAgentRunResult = {
  text: string;
  sessionId: string;
  /** Workspace path for infinite session persistence. */
  workspacePath?: string;
  /** The model actually used (may differ from requested if setModel() was called). */
  model?: string;
};

/**
 * Run a single prompt through the Copilot SDK and return the final response.
 * Creates a client, session, sends the message, waits for idle, and cleans up.
 */
export async function runCopilotAgent(
  options: CopilotAgentRunOptions,
): Promise<CopilotAgentRunResult> {
  const client = await createCopilotClient({
    cwd: options.workspaceDir,
  });

  let session: CopilotSession | undefined;

  try {
    await ensureAuthenticated(client);

    const hasToolFilters = !!(options.availableTools?.length || options.excludedTools?.length);

    const sessionConfig: SessionConfig = {
      model: options.model,
      workingDirectory: options.workspaceDir,
      streaming: true,
      hooks: options.hooks,
      reasoningEffort: options.reasoningEffort,
      ...(options.availableTools?.length && { availableTools: options.availableTools }),
      ...(options.excludedTools?.length && { excludedTools: options.excludedTools }),
      // When tool filters are configured, auto-approve permission requests since
      // the SDK enforces the allowlist/blocklist. Otherwise deny all by default.
      onPermissionRequest: hasToolFilters
        ? async () => ({ kind: "approved" as const })
        : async () => ({
            kind: "denied-interactively-by-user" as const,
            feedback: "Tool use is not permitted in this session.",
          }),
    };

    if (options.systemPrompt) {
      sessionConfig.systemMessage = {
        mode: "append",
        content: options.systemPrompt,
      };
    }

    if (options.infiniteSessions) {
      sessionConfig.infiniteSessions = options.infiniteSessions as InfiniteSessionConfig;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      sessionConfig.mcpServers = options.mcpServers;
      log.info("configured MCP servers for session", {
        count: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
      });
    }

    if (options.onUserInput) {
      const userHandler = options.onUserInput;
      const wrappedHandler: UserInputHandler = async (request: UserInputRequest, _invocation) => {
        log.info("copilot agent requesting user input", {
          questionLength: request.question.length,
          choiceCount: request.choices?.length ?? 0,
          allowFreeform: request.allowFreeform ?? false,
        });
        const result = await userHandler({
          question: request.question,
          choices: request.choices,
          allowFreeform: request.allowFreeform,
        });
        return result as UserInputResponse;
      };
      sessionConfig.onUserInputRequest = wrappedHandler;
    }

    if (options.reasoningEffort) {
      log.info(`copilot-sdk: reasoningEffort=${options.reasoningEffort}`);
    }

    if (hasToolFilters) {
      log.info("copilot session tool filters configured", {
        availableTools: options.availableTools,
        excludedTools: options.excludedTools,
      });
    }

    if (options.sessionId) {
      session = await client.resumeSession(options.sessionId, sessionConfig);
    } else {
      session = await client.createSession(sessionConfig);
    }

    // Subscribe to session events for observability before sending
    if (options.onEvent) {
      session.on(options.onEvent);
    }

    // Apply dynamic model switch if requested
    let activeModel = options.model;
    if (options.modelOverride) {
      log.info("switching copilot session model", {
        sessionId: session.sessionId,
        from: options.model ?? "default",
        to: options.modelOverride,
      });
      await session.setModel(options.modelOverride);
      activeModel = options.modelOverride;
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const response = await session.sendAndWait({ prompt: options.prompt }, timeoutMs);

    const text = response?.data?.content ?? "";
    const sessionId = session.sessionId;

    const workspacePath = session.workspacePath;
    if (workspacePath) {
      log.info("infinite session workspace", { workspacePath, sessionId });
    }

    log.info(`copilot agent run completed`, {
      sessionId,
      model: activeModel,
      responseLength: text.length,
    });

    return { text, sessionId, workspacePath, model: activeModel };
  } finally {
    if (session) {
      try {
        // Use disconnect() instead of destroy() to persist sessions for resume
        await session.disconnect();
      } catch (err) {
        log.warn("failed to disconnect copilot session", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await client.stop();
    } catch (err) {
      log.warn("failed to stop copilot client", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle management
// ---------------------------------------------------------------------------

/**
 * Session filter for listing Copilot sessions.
 */
export type CopilotSessionFilter = {
  cwd?: string;
  repository?: string;
  branch?: string;
};

/**
 * Metadata for a persisted Copilot session.
 */
export type CopilotSessionMetadata = {
  sessionId: string;
  startTime: Date;
  modifiedTime: Date;
  summary?: string;
  isRemote: boolean;
  context?: {
    cwd?: string;
    gitRoot?: string;
    repository?: string;
    branch?: string;
  };
};

/**
 * List persisted Copilot sessions, optionally filtered.
 */
export async function listCopilotSessions(
  filter?: CopilotSessionFilter,
): Promise<CopilotSessionMetadata[]> {
  let client: CopilotClient | undefined;
  try {
    client = await createCopilotClient();
    await ensureAuthenticated(client);
    const sessions = await client.listSessions(filter);
    return sessions;
  } catch (error) {
    log.warn("failed to list copilot sessions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
  }
}

/**
 * Get the ID of the most recent Copilot session.
 */
export async function getLastCopilotSessionId(): Promise<string | null> {
  let client: CopilotClient | undefined;
  try {
    client = await createCopilotClient();
    await ensureAuthenticated(client);
    const id = await client.getLastSessionId();
    return id ?? null;
  } catch (error) {
    log.warn("failed to get last copilot session id", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
  }
}

/**
 * Explicitly destroy a persisted Copilot session.
 */
export async function destroyCopilotSession(sessionId: string): Promise<boolean> {
  let client: CopilotClient | undefined;
  try {
    client = await createCopilotClient();
    await ensureAuthenticated(client);
    const session = await client.resumeSession(sessionId, {
      onPermissionRequest: async () => ({
        kind: "denied-interactively-by-user" as const,
        feedback: "Cleanup session — no tools.",
      }),
    });
    await session.destroy();
    log.info("destroyed copilot session", { sessionId });
    return true;
  } catch (error) {
    log.warn("failed to destroy copilot session", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
  }
}
