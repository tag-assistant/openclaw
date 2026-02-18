import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Types ──────────────────────────────────────────────────────────────────

interface PeonSoundsConfig {
  packsDir?: string;
  activePack?: string;
  enabledPacks?: string[];
  favoritePacks?: string[];
  maxFavoriteSoundsPerPack?: number;
  volume?: number;
  maxPromptPacks?: number;
}

interface PackManifest {
  name: string;
  display_name?: string;
  language?: string;
  categories: Record<string, { sounds: Array<{ file: string; label: string }> }>;
}

interface SoundEntry {
  path: string;
  label: string;
  category: string;
  pack: string;
  language: string;
}

// ── Catalog ────────────────────────────────────────────────────────────────

let cachedCatalog: Map<string, SoundEntry> | null = null;
let cachedMtime = 0;

function buildCatalog(packsDir: string, enabledPacks?: string[]): Map<string, SoundEntry> {
  const enabled = enabledPacks ? new Set(enabledPacks) : null;

  let entries: string[];
  try {
    entries = readdirSync(packsDir);
  } catch {
    return new Map();
  }

  // Simple mtime cache
  try {
    const mtime = statSync(packsDir).mtimeMs;
    if (cachedCatalog && mtime === cachedMtime) return cachedCatalog;
    cachedMtime = mtime;
  } catch {
    /* ignore */
  }

  const catalog = new Map<string, SoundEntry>();

  for (const packName of entries) {
    if (enabled && !enabled.has(packName)) continue;

    const manifestPath = join(packsDir, packName, "openpeon.json");
    let manifest: PackManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }

    const lang = manifest.language ?? "en";

    for (const [category, catData] of Object.entries(manifest.categories)) {
      for (const sound of catData.sounds) {
        const fileName = sound.file
          .split("/")
          .pop()!
          .replace(/\.(wav|mp3|ogg|m4a)$/i, "");
        const key = `${packName}/${fileName}`;
        if (!catalog.has(key)) {
          catalog.set(key, {
            path: resolve(packsDir, packName, sound.file),
            label: sound.label,
            category,
            pack: packName,
            language: lang,
          });
        }
      }
    }
  }

  cachedCatalog = catalog;
  return catalog;
}

function getPackNames(catalog: Map<string, SoundEntry>, englishOnly = true): string[] {
  const packs = new Set<string>();
  for (const entry of catalog.values()) {
    if (englishOnly && entry.language !== "en") continue;
    packs.add(entry.pack);
  }
  return [...packs].sort();
}

function getPackSounds(
  catalog: Map<string, SoundEntry>,
  pack: string,
): Array<{ key: string; label: string; category: string }> {
  const sounds: Array<{ key: string; label: string; category: string }> = [];
  for (const [key, entry] of catalog) {
    if (entry.pack === pack) {
      sounds.push({ key, label: entry.label, category: entry.category });
    }
  }
  return sounds;
}

// ── Prompt Generation (~200-300 tokens) ────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  "session.start": "Greeting",
  "session.end": "Farewell",
  "task.acknowledge": "Acknowledging",
  "task.complete": "Celebration",
  "task.error": "Error/Frustration",
  "task.progress": "Progress",
  "input.required": "Needs Input",
  "resource.limit": "Warning",
  "user.spam": "Annoyance",
};

function formatPromptCatalog(
  catalog: Map<string, SoundEntry>,
  activePack: string | undefined,
  maxPacks: number,
  favoritePacks?: string[],
  maxFavoriteSoundsPerPack = 8,
): string {
  const packs = getPackNames(catalog);
  if (packs.length === 0) return "";

  const lines: string[] = [
    `## 🔊 Sound Effects`,
    `Play sounds with the \`play_sound\` tool. Use sparingly — 0-2 per message, contextually. Mix packs freely.`,
    "",
  ];

  // Determine which packs get highlights — favorites if set, otherwise activePack as fallback
  const highlightPacks = favoritePacks?.filter((p) => packs.includes(p)) ?? [];
  if (activePack && packs.includes(activePack) && !highlightPacks.includes(activePack)) {
    highlightPacks.unshift(activePack);
  }

  // Show highlights for each featured pack — all equal, no hierarchy
  if (highlightPacks.length > 0) {
    lines.push("### Sound highlights");
    for (const pack of highlightPacks) {
      const packSounds = getPackSounds(catalog, pack);
      const byCategory = new Map<string, Array<{ key: string; label: string }>>();
      for (const s of packSounds) {
        const cat = CATEGORY_LABELS[s.category] ?? s.category;
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push({ key: s.key, label: s.label });
      }
      const picked: string[] = [];
      let added = true;
      while (picked.length < maxFavoriteSoundsPerPack && added) {
        added = false;
        for (const [, entries] of byCategory) {
          if (picked.length >= maxFavoriteSoundsPerPack) break;
          if (entries.length > 0) {
            const e = entries.shift()!;
            picked.push(`${e.key} ("${e.label}")`);
            added = true;
          }
        }
      }
      if (picked.length > 0) {
        lines.push(`**${pack}:** ${picked.join(", ")}`);
      }
    }
  }

  // List remaining packs as names only
  const shownPacks = new Set(highlightPacks);
  const otherPacks = packs.filter((p) => !shownPacks.has(p)).slice(0, maxPacks);
  if (otherPacks.length > 0) {
    const remainingCount = packs.length - shownPacks.size;
    lines.push("");
    lines.push(`### Other packs (${remainingCount} more)`);
    lines.push(otherPacks.join(", ") + (remainingCount > maxPacks ? ", ..." : ""));
    lines.push(`Use \`list_pack_sounds\` to explore any pack.`);
  }

  return lines.join("\n");
}
// ── Playback ───────────────────────────────────────────────────────────────

function playSound(filePath: string, volume: number): Promise<void> {
  if (platform !== "darwin") return Promise.resolve();
  return new Promise((resolve) => {
    const args = ["-v", String(volume), filePath];
    execFile("afplay", args, () => resolve());
  });
}

async function playSoundsSequential(paths: string[], volume: number, gap = 300): Promise<void> {
  for (let i = 0; i < paths.length; i++) {
    await playSound(paths[i], volume);
    if (i < paths.length - 1 && gap > 0) {
      await new Promise((r) => setTimeout(r, gap));
    }
  }
}

// ── Plugin Entry ───────────────────────────────────────────────────────────

export default {
  id: "peon-sounds",
  name: "Peon Sounds",
  description: "Expressive game sound effects for agent voice personality",

  register(api: OpenClawPluginApi) {
    const config: PeonSoundsConfig = (api.pluginConfig as PeonSoundsConfig) ?? {};
    const packsDir = config.packsDir ?? join(homedir(), ".openpeon", "packs");
    const volume = config.volume ?? 0.5;
    const maxPromptPacks = config.maxPromptPacks ?? 15;
    const activePack = config.activePack;
    const enabledPacks = config.enabledPacks;
    const favoritePacks = config.favoritePacks;
    const maxFavoriteSoundsPerPack = config.maxFavoriteSoundsPerPack ?? 8;

    // Check if packs exist
    if (!existsSync(packsDir)) {
      api.logger.warn(`[peon-sounds] packs dir not found: ${packsDir}`);
      return;
    }

    // ── Hook: inject compact catalog into system prompt ──
    api.on("before_prompt_build", () => {
      const catalog = buildCatalog(packsDir, enabledPacks);
      const promptText = formatPromptCatalog(
        catalog,
        activePack,
        maxPromptPacks,
        favoritePacks,
        maxFavoriteSoundsPerPack,
      );
      if (!promptText) return;
      return { prependContext: promptText };
    });

    // ── Tool: play_sound ──
    api.registerTool({
      name: "play_sound",
      description:
        "Play a game sound effect through the speaker. Use sound keys like 'pack/sound' (e.g., 'duke_nukem/Groovy', 'peon/PeonReady1'). Use sparingly to express mood.",
      parameters: {
        type: "object",
        properties: {
          sound: {
            type: "string",
            description: "Sound key in format 'pack/sound' (e.g., 'duke_nukem/KickAssChewGum')",
          },
          sounds: {
            type: "array",
            items: { type: "string" },
            description: "Multiple sound keys to play sequentially",
          },
        },
      },
      execute: async (_toolCallId: string, params: { sound?: string; sounds?: string[] }) => {
        const catalog = buildCatalog(packsDir, enabledPacks);
        const keys = params.sounds ?? (params.sound ? [params.sound] : []);

        if (keys.length === 0) return { content: [{ type: "text", text: "No sound specified" }] };
        if (keys.length > 5) return { content: [{ type: "text", text: "Max 5 sounds per call" }] };

        const paths: string[] = [];
        const played: string[] = [];
        const missing: string[] = [];

        for (const key of keys) {
          const entry = catalog.get(key);
          if (entry && existsSync(entry.path)) {
            paths.push(entry.path);
            played.push(`${key} ("${entry.label}")`);
          } else {
            missing.push(key);
          }
        }

        if (paths.length > 0) {
          // Fire-and-forget
          playSoundsSequential(paths, volume).catch(() => {});
        }

        const result: string[] = [];
        if (played.length > 0) result.push(`🔊 Playing: ${played.join(", ")}`);
        if (missing.length > 0) result.push(`⚠️ Not found: ${missing.join(", ")}`);

        return { content: [{ type: "text", text: result.join("\n") }] };
      },
    });

    // ── Tool: list_pack_sounds ──
    api.registerTool({
      name: "list_pack_sounds",
      description:
        "List all available sounds in a specific pack, or list all available pack names.",
      parameters: {
        type: "object",
        properties: {
          pack: {
            type: "string",
            description: "Pack name to list sounds for. Omit to list all pack names.",
          },
        },
      },
      execute: async (_toolCallId: string, params: { pack?: string }) => {
        const catalog = buildCatalog(packsDir, enabledPacks);

        if (!params.pack) {
          const packs = getPackNames(catalog);
          return {
            content: [
              { type: "text", text: `**Available packs (${packs.length}):**\n${packs.join(", ")}` },
            ],
          };
        }

        const sounds = getPackSounds(catalog, params.pack);
        if (sounds.length === 0) {
          return {
            content: [{ type: "text", text: `Pack "${params.pack}" not found or has no sounds.` }],
          };
        }

        const byCategory = new Map<string, string[]>();
        for (const s of sounds) {
          const cat = CATEGORY_LABELS[s.category] ?? s.category;
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat)!.push(`${s.key} — "${s.label}"`);
        }

        const lines: string[] = [`**${params.pack}** (${sounds.length} sounds):`];
        for (const [cat, entries] of byCategory) {
          lines.push(`\n**${cat}:**`);
          for (const e of entries) lines.push(`- ${e}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    const packCount = getPackNames(buildCatalog(packsDir, enabledPacks)).length;
    api.logger.info(`[peon-sounds] registered with ${packCount} packs from ${packsDir}`);
  },
};
