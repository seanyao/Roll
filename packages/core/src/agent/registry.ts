/**
 * @responsibility Owns agent identity, availability and slot-config decision logic.
 * AgentRegistry — TS port of the v2 agent identity / availability / slot-config
 * path. Pure decision logic with all I/O (filesystem, PATH probing, clock)
 * injected so it is unit-testable and oracle-diffable without touching a real
 * machine.
 *
 * v2 oracle (frozen bash, bin/roll):
 *   - `_agent_bin_names`            (~98-109):  agent → binary-name list.
 *   - `_canonical_agent_name`       (~115-120): antigravity|gemini → agy.
 *   - `_agent_display_name`         (~125-130): human label (agy parenthesised).
 *   - `_agent_installed_by_name`    (~137-169): PATH/dir detection per agent.
 *   - `_agent_is_known`             (~178-185): name-validity (deepseek MODEL, not an agent).
 *   - `_agents_installed`           (~524-532): registry order, installed-only.
 *   - `_first_installed_agent`      (~1121-1130): first-installed scan order.
 *   - `_agent_cache_dir`            (~537-543): probe cache dir (env-overridable).
 *   - `_agent_probe_ttl`            (~546-552): TTL seconds (env-overridable).
 *   - `_agent_probe`                (~559-582): one-shot --version probe.
 *   - `_agent_available`            (~587-634): cache-read → probe → cache-write.
 *   - `_agents_config_path`         (~205-215): agents.yaml path resolution.
 *   - `_agents_line_agent_value`    (~222-235): token-boundary `agent:` extract.
 *   - `_agents_config_slot`         (~237-300): read a slot's agent value.
 *   - `_agents_config_set_slot`     (~309-373): atomic in-place slot rewrite.
 *
 * Agent identity is derived from AgentSpec (`AGENTS`) so registry, CLI listing,
 * doctor/setup probes, and spawn coverage share one first-class roster.
 */
import { type FileStore, nodeFileStore } from "../backlog/infra-default.js";
import { AGENTS, canonicalAgentIdentityName, getAgentIdentitySpec } from "./specs.js";
import type { AgentName } from "@roll/spec";

// ── Identity / canonicalization (pure) ───────────────────────────────────────

export function canonicalAgentName(name: string): string {
  return canonicalAgentIdentityName(name);
}

/** Human-facing label. `agy` shows the product name + binary in parens. */
export function agentDisplayName(name: string): string {
  return getAgentIdentitySpec(name)?.displayName ?? name;
}

/**
 * agent → binary-name candidates (first found on PATH wins). `null` for an
 * agent with no PATH binary (the bash `*) return 1` arm). Mirrors
 * `_agent_bin_names`, but the candidate table is derived from `AGENTS`.
 */
export function agentBinNames(agent: string): string[] | null {
  const spec = getAgentIdentitySpec(agent);
  return spec === undefined ? null : [...spec.cliBin];
}

/**
 * Is NAME a known agent in this machine's registry? "Known" means it has a
 * binary-name entry after canonicalization. This is a name-validity check, NOT
 * an installed check. `openai` and `deepseek` are provider/model aliases in the
 * spec layer, not first-class agent names here.
 */
export function agentIsKnown(name: string): boolean {
  return getAgentIdentitySpec(name) !== undefined;
}

// ── Installed detection (injected environment probes) ────────────────────────

/**
 * The host environment the registry probes for installed agents. All of it is
 * injected so installed-detection is deterministic in tests (fabricated PATH /
 * HOME) and the core stays pure.
 */
export interface AgentEnv {
  /** True iff `bin` is an executable file on the current PATH. Mirrors
   *  bash `command -v <bin>` for the binary-name agents. */
  commandOnPath(bin: string): boolean;
  /** True iff a directory exists at `path` (relative to HOME, expanded by the
   *  caller). Mirrors bash `[[ -d <path> ]]`. */
  dirExists(path: string): boolean;
  /** True iff an executable file exists at `path`. Mirrors `[[ -x <path> ]]`. */
  fileExecutable(path: string): boolean;
  /** Absolute HOME directory (bash `$HOME`). */
  home: string;
}

/**
 * Detect whether an agent (by name) is usable on this machine. For CLI-only
 * agents this is "binary on PATH"; GUI/bundled agents keep their special-case
 * paths. Unknown agents fall back to dir-existence of an optional `dir` hint
 * (forward-compatible with operator-registered entries). Mirrors
 * `_agent_installed_by_name` (note bash does NOT canonicalise its arg).
 */
export function agentInstalledByName(env: AgentEnv, agent: string, dir?: string): boolean {
  const bins = agentBinNames(agent);
  if (bins !== null) return bins.some((b) => env.commandOnPath(b));
  // Unknown agent — fall back to dir presence so user-added entries still work.
  return dir !== undefined && dir !== "" && env.dirExists(dir);
}

/**
 * Candidate routable agents. US-AGENT-043 keeps exactly six first-class agent
 * names; provider/model aliases stay in AgentSpec only.
 */
export const AGENT_REGISTRY_NAMES: readonly string[] = AGENTS.map((spec) => spec.name);

/** Agents actually installed on this machine, in registry order. Mirrors
 *  `_agents_installed`. */
export function agentsInstalled(env: AgentEnv): string[] {
  return AGENT_REGISTRY_NAMES.filter((a) => agentInstalledByName(env, a));
}

/**
 * First-installed scan order, used as the last-resort routing fallback. It
 * matches the six-agent roster; removed agent tokens are never fallback targets.
 */
const FIRST_INSTALLED_ORDER = AGENT_REGISTRY_NAMES;

export function firstInstalledAgent(env: AgentEnv): string | undefined {
  return FIRST_INSTALLED_ORDER.find((a) => agentInstalledByName(env, a));
}

// ── Availability probe + TTL cache ───────────────────────────────────────────

/** Clock + prober injected into {@link agentAvailable} so the cache TTL logic
 *  is unit-testable without real time or real binaries. */
export interface ProbeDeps {
  /** Current unix epoch seconds (bash `date +%s`). */
  now(): number;
  /** One-shot online probe for the (canonical) agent name: true ⇒ online.
   *  Mirrors `_agent_installed_by_name && _agent_probe`. */
  probe(name: string): boolean;
}

/** Default probe TTL in seconds (bash default 30 min). */
export const DEFAULT_PROBE_TTL = 1800;

/**
 * Resolve the probe TTL, honoring `ROLL_AGENT_PROBE_TTL` exactly like bash
 * `_agent_probe_ttl`: empty or non-numeric falls back to the 30-min default.
 */
export function probeTtl(rawTtl: string | undefined): number {
  if (rawTtl === undefined || rawTtl === "" || /[^0-9]/.test(rawTtl)) {
    return DEFAULT_PROBE_TTL;
  }
  return Number(rawTtl);
}

/**
 * Resolve the availability cache directory, mirroring `_agent_cache_dir`:
 * `ROLL_AGENT_CACHE_DIR` wins, else the project-local `.roll/cache/agent-availability`.
 */
export function agentCacheDir(rawCacheDir: string | undefined): string {
  if (rawCacheDir !== undefined && rawCacheDir !== "") return rawCacheDir;
  return ".roll/cache/agent-availability";
}

/** The on-disk cache entry shape (`checked_at=` / `status=` lines). */
export interface ProbeCacheEntry {
  checkedAt: number;
  status: "online" | "offline";
}

/**
 * Parse a cache file body, mirroring the bash key=value scan: lines
 * `checked_at=<n>` / `status=<s>`. A non-numeric `checked_at` is treated as
 * absent (bash blanks it). Returns `undefined` when either field is missing.
 */
export function parseProbeCache(body: string): ProbeCacheEntry | undefined {
  let checkedAt = "";
  let status = "";
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("checked_at=")) checkedAt = line.slice("checked_at=".length);
    else if (line.startsWith("status=")) status = line.slice("status=".length);
  }
  if (/[^0-9]/.test(checkedAt) || checkedAt === "") return undefined;
  if (status === "") return undefined;
  if (status !== "online" && status !== "offline") {
    // bash trusts whatever string it cached; we only ever write online/offline,
    // but mirror its "any non-empty status" acceptance by failing closed here so
    // a corrupt cache re-probes rather than mis-reporting.
    return undefined;
  }
  return { checkedAt: Number(checkedAt), status };
}

/** Serialise a cache entry to the exact bash byte shape (trailing newline each). */
export function renderProbeCache(entry: ProbeCacheEntry): string {
  return `checked_at=${entry.checkedAt}\nstatus=${entry.status}\n`;
}

/** Result of an availability check (mirrors bash stdout "online"/"offline" + exit). */
export interface AvailabilityResult {
  status: "online" | "offline";
  online: boolean;
  /** A fresh cache entry to persist, or `undefined` on a trusted cache hit. */
  cacheWrite?: ProbeCacheEntry;
}

/**
 * Pure availability decision over a cache-file body + injected clock/prober.
 * Mirrors `_agent_available`'s control flow without doing the I/O itself:
 *
 *   - cacheBody present, parses, and `0 <= age < ttl`, and `!noCache`
 *       → trust the cached status, no re-probe, no cacheWrite.
 *   - otherwise → probe; status = online iff `probe(name)`; emit a cacheWrite.
 *
 * `name` is canonicalised here exactly like bash (`_canonical_agent_name`).
 * An empty name is offline (bash early-returns offline). The caller is
 * responsible for reading the cache file and persisting `cacheWrite` atomically.
 */
export function agentAvailable(
  name: string,
  deps: ProbeDeps,
  opts: { cacheBody?: string; ttl?: number; noCache?: boolean } = {},
): AvailabilityResult {
  const canonical = canonicalAgentName(name);
  if (canonical === "") return { status: "offline", online: false };

  const ttl = opts.ttl ?? DEFAULT_PROBE_TTL;
  const now = deps.now();

  if (opts.noCache !== true && opts.cacheBody !== undefined) {
    const entry = parseProbeCache(opts.cacheBody);
    if (entry !== undefined) {
      const age = now - entry.checkedAt;
      if (age >= 0 && age < ttl) {
        return { status: entry.status, online: entry.status === "online" };
      }
    }
  }

  const status: "online" | "offline" = deps.probe(canonical) ? "online" : "offline";
  return { status, online: status === "online", cacheWrite: { checkedAt: now, status } };
}

// ── Slot config (agents.yaml) read / write ───────────────────────────────────

/** The four routing slots an agents.yaml (schema v3) carries. */
export type AgentSlot = "easy" | "default" | "hard" | "fallback";

/**
 * Extract an `agent:` value from a single yaml line, only when `agent:` sits at
 * a token boundary (line start, or right after `{`, `,`, or whitespace) — so
 * `no_agent:` / `sub_agent:` / `agent_x:` do not false-match. Returns the RAW
 * (un-trimmed) value, or `undefined` when the line has no agent key. Mirrors
 * `_agents_line_agent_value` (tabs collapsed to spaces first).
 */
export function lineAgentValue(line: string): string | undefined {
  const s = line.replace(/\t/g, " ");
  if (s.startsWith("agent:")) return s.slice("agent:".length);
  // *[ ,{]agent:* — find the last boundary-preceded `agent:`. bash's glob
  // `*[ ,{]agent:*` strips the SHORTEST leading match (`${s#*[ ,{]agent:}`), i.e.
  // the FIRST boundary-preceded occurrence.
  const m = /[ ,{]agent:/.exec(s);
  if (m === null) return undefined;
  return s.slice(m.index + m[0].length);
}

/** Strip flow punctuation / quotes / inline comment / surrounding space from a
 *  raw agent value, exactly like the bash post-processing in `_agents_config_slot`. */
function cleanAgentValue(raw: string): string {
  let v = raw;
  const hash = v.indexOf("#");
  if (hash >= 0) v = v.slice(0, hash);
  v = v.replace(/[{}",']/g, "").replace(/,/g, "");
  return v.trim();
}

/**
 * The raw `agent:` value extracted by {@link lineAgentValue} from an inline-flow
 * slot runs to end-of-line, so for `{ agent: pi, model: X }` it carries the
 * trailing `, model: X` too. Truncate at a boundary `model:` (line start, or
 * after `{`, `,`, or whitespace) so {@link cleanAgentValue} sees only the agent
 * token. A nested-form agent line (`agent: pi`) has no such suffix and is
 * returned unchanged.
 */
function stripTrailingModel(rawAgent: string): string {
  const m = /(^|[ ,{])model:/.exec(rawAgent);
  return m === null ? rawAgent : rawAgent.slice(0, m.index);
}

/**
 * Extract a `model:` value from a single yaml line, only when `model:` sits at a
 * token boundary (line start, or right after `{`, `,`, or whitespace) — so
 * `sub_model:` / `model_x:` do not false-match. Returns the RAW (un-trimmed)
 * value, or `undefined` when the line has no model key. Mirrors
 * {@link lineAgentValue}'s boundary handling so a model rides alongside an agent
 * in the same inline-flow slot (`{ agent: pi, model: bailian/glm-5.2 }`).
 *
 * NOTE: a model value may itself carry a `:` (e.g. `deepseek/deepseek-v4-pro:high`
 * — the `:thinking` effort suffix). The boundary regex anchors on `model:` only,
 * so the trailing `:high` stays in the captured value; {@link cleanAgentValue}
 * (which only strips flow punctuation, never `:`) preserves it intact.
 */
export function lineModelValue(line: string): string | undefined {
  const s = line.replace(/\t/g, " ");
  if (s.startsWith("model:")) return s.slice("model:".length);
  const m = /[ ,{]model:/.exec(s);
  if (m === null) return undefined;
  return s.slice(m.index + m[0].length);
}

/** A resolved slot: the agent token, plus an optional NATIVE `--model` argument
 *  (folds any `:thinking` effort suffix; absent ⇒ spawn with the agent's own
 *  default model). */
export interface SlotConfig {
  agent: string;
  model?: string;
}

/**
 * Read a slot's agent value from agents.yaml text. Mirrors `_agents_config_slot`:
 * find the slot's top-level block (`^<slot>:` through the next non-indented key),
 * read its first `agent:` value (inline flow form or a nested indented line),
 * then clean it. Returns `undefined` when the file has no such block or the slot
 * has no agent value. Does NOT warn on unknown agents (that is a caller concern;
 * see {@link AgentRegistry.readSlot}).
 */
export function readSlotFromText(text: string, slot: AgentSlot): SlotConfig | undefined {
  let inBlock = false;
  let agent = "";
  let found = false;
  // Model is scanned across the WHOLE slot block (it may sit on the header's
  // inline-flow line beside the agent, or on its own nested line) — independent
  // of the agent's first-hit short-circuit below.
  let modelRaw: string | undefined;
  const slotHeader = `${slot}:`;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    // Slot header: `slot:` exactly, `slot: ...`, or `slot:{...}`.
    if (line === slotHeader || line.startsWith(`${slot}: `) || line.startsWith(`${slot}:{`)) {
      inBlock = true;
      if (modelRaw === undefined) modelRaw = lineModelValue(line);
      const v = lineAgentValue(line);
      if (v !== undefined) {
        agent = v;
        found = true;
      }
    } else if (line.length > 0 && line[0] !== " ") {
      // A new top-level key (no leading space) ends the slot block.
      if (inBlock) break;
    } else if (inBlock) {
      if (modelRaw === undefined) modelRaw = lineModelValue(line);
      if (!found) {
        const v = lineAgentValue(line);
        if (v !== undefined) {
          agent = v;
          found = true;
        }
      }
    }
    // Inline-flow short-circuit: a `slot:{...}`/`slot: { ... }` header carries
    // the whole slot on one line, so once we have the agent there we are done.
    // Nested form keeps scanning until the block ends (next top-level key) so a
    // model on a later indented line is still picked up.
    if (found && (line === slotHeader || line.startsWith(`${slot}: {`) || line.startsWith(`${slot}:{`))) break;
  }
  if (!inBlock) return undefined;
  const cleanedAgent = cleanAgentValue(stripTrailingModel(agent));
  if (cleanedAgent === "") return undefined;
  const cleanedModel = modelRaw === undefined ? "" : cleanAgentValue(modelRaw);
  const canonicalAgent = canonicalAgentName(cleanedAgent);
  return cleanedModel === "" ? { agent: canonicalAgent } : { agent: canonicalAgent, model: cleanedModel };
}

/**
 * Rewrite (or create) a slot's agent value in agents.yaml text, returning the
 * new text. Mirrors `_agents_config_set_slot`'s in-place rewrite:
 *   - missing file (empty text) → seed `schema: v3\n<slot>: { agent: X }\n`.
 *   - existing slot → replace its header with the canonical inline form and drop
 *     any nested `agent:` lines in its block; every other line is preserved.
 *   - absent slot → append the inline form.
 * The caller persists the result atomically (tmp + rename).
 */
export function setSlotInText(text: string, slot: AgentSlot, agent: string, model?: string): string {
  const newLine =
    model !== undefined && model !== ""
      ? `${slot}: { agent: ${agent}, model: ${model} }`
      : `${slot}: { agent: ${agent} }`;
  if (text === "") {
    return `schema: v3\n${newLine}\n`;
  }

  const slotHeader = `${slot}:`;
  const out: string[] = [];
  let inBlock = false;
  let found = false;

  // Preserve a trailing-newline shape: split keeps a final "" for a trailing \n.
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadTrailingNewline) lines.pop();

  for (const line of lines) {
    const raw = line.replace(/\r$/, "");
    if (raw === slotHeader || raw.startsWith(`${slot}: `) || raw.startsWith(`${slot}:{`)) {
      out.push(newLine);
      inBlock = true;
      found = true;
      // If the header itself carried an inline `{...}`, the slot is complete.
      if (raw.includes("{")) inBlock = false;
      continue;
    }
    if (raw.length > 0 && raw[0] !== " ") {
      inBlock = false;
    }
    if (inBlock && (lineAgentValue(raw) !== undefined || lineModelValue(raw) !== undefined)) {
      // Drop the old nested agent / model lines — the canonical inline header
      // above now carries both.
      continue;
    }
    out.push(line);
  }

  if (!found) out.push(newLine);

  return out.join("\n") + (hadTrailingNewline ? "\n" : "");
}

/**
 * FIX-935 — read the set of agents explicitly configured across all routing
 * slots in an agents.yaml file. This is the project-config allowlist for
 * scoring and pairing: we never auto-enable a machine-detected agent (e.g.
 * codex or claude) that the project has not declared in its routing config.
 *
 * Pure (text → names) so tests and callers can inject file contents. Returns
 * canonical agent names in registry order; empty array when the file has no
 * configured slots or is unreadable.
 */
export function readAgentsYamlAllowedAgents(text: string): string[] {
  const slots: AgentSlot[] = ["easy", "default", "hard", "fallback"];
  const configured = new Set<string>();
  for (const slot of slots) {
    const cfg = readSlotFromText(text, slot);
    if (cfg?.agent !== undefined && cfg.agent !== "") {
      configured.add(cfg.agent);
    }
  }
  return AGENT_REGISTRY_NAMES.filter((a) => configured.has(a as string));
}

/**
 * US-AGENT-050 — read the disabled flag for an agent from agents.yaml text.
 * Returns `{ disabled: true }` when the agent has `disabled: true` in its
 * block; otherwise `{ disabled: false }`. Pure (text → result).
 */
export function readAgentDisabledFromText(text: string, agent: AgentName): { disabled: boolean } {
  if (text === "") return { disabled: false };
  let inAgents = false;
  let inAgent = false;
  let indent = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trimStart();
    if (trimmed === "") continue;
    const depth = line.length - trimmed.length;
    if (!inAgents) {
      if (trimmed === "agents:" || trimmed.startsWith("agents:")) {
        inAgents = true;
      }
      continue;
    }
    if (depth === 0 && trimmed !== "" && !trimmed.startsWith("agents:")) {
      // Left the agents block
      break;
    }
    if (!inAgent) {
      // Look for agent entry
      if (depth === 2 && (trimmed === `${agent}:` || trimmed.startsWith(`${agent}:`))) {
        inAgent = true;
        indent = depth;
        // Check inline: `  kimi: { adapter: kimi, disabled: true }`
        if (trimmed.includes("disabled: true") || trimmed.includes("disabled:true")) return { disabled: true };
      }
      continue;
    }
    // Inside target agent block
    if (depth <= indent) {
      // End of agent block
      break;
    }
    if (depth === indent + 2 && (trimmed === "disabled: true" || trimmed === "disabled:true")) {
      return { disabled: true };
    }
  }
  return { disabled: false };
}

/**
 * US-AGENT-050 — set the disabled flag for an agent in agents.yaml text.
 * Adds or removes `disabled: true` within the agent's block. Pure (text →
 * new text). Returns the original text unchanged when the agent is not found.
 */
export function setAgentDisabledInText(text: string, agent: AgentName, disabled: boolean): string {
  if (text === "") return text;
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadTrailingNewline) lines.pop();

  let inAgents = false;
  let inAgent = false;
  let agentDepth = 0;
  let agentIndex = -1;
  let disabledIndex = -1;
  let blockEndIndex = -1;

  // First pass: locate the agent block
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (trimmed === "") continue;
    const depth = line.length - trimmed.length;

    if (!inAgents) {
      if (trimmed === "agents:" || trimmed.startsWith("agents:")) {
        inAgents = true;
      }
      continue;
    }
    if (depth === 0 && trimmed !== "" && !trimmed.startsWith("agents:")) {
      break;
    }
    if (!inAgent) {
      if (depth === 2 && (trimmed === `${agent}:` || trimmed.startsWith(`${agent}:`))) {
        inAgent = true;
        agentDepth = depth;
        agentIndex = i;
        // Check inline: `  kimi: { ..., disabled: true }` → inline disable is handled separately
        if (trimmed.includes("{")) {
          // Inline flow form — handle differently
          if (disabled) {
            if (!trimmed.includes("disabled:")) {
              const bracketIdx = trimmed.lastIndexOf("}");
              if (bracketIdx >= 0) {
                lines[i] = trimmed.slice(0, bracketIdx) + ", disabled: true" + trimmed.slice(bracketIdx);
              }
            }
          } else {
            lines[i] = trimmed
              .replace(/,?\s*disabled:\s*true\s*,?/g, (m) => (m.includes(",") ? "," : ""))
              .replace(/,\s*}/g, " }");
          }
          return lines.join("\n") + (hadTrailingNewline ? "\n" : "");
        }
      }
      continue;
    }
    // Inside agent block
    if (depth <= agentDepth) {
      blockEndIndex = i;
      break;
    }
    if (depth === agentDepth + 2 && (trimmed === "disabled: true" || trimmed === "disabled:true")) {
      disabledIndex = i;
    }
  }

  if (!inAgent) return hadTrailingNewline ? lines.join("\n") + "\n" : lines.join("\n");

  if (disabled) {
    // Add disabled: true if not already present
    if (disabledIndex < 0) {
      // Insert after the agent header line
      const insertAt = blockEndIndex < 0 ? lines.length : blockEndIndex;
      const baseIndent = " ".repeat(agentDepth + 2);
      lines.splice(insertAt, 0, `${baseIndent}disabled: true`);
    }
  } else {
    // Remove disabled: true if present
    if (disabledIndex >= 0) {
      lines.splice(disabledIndex, 1);
    }
  }

  return lines.join("\n") + (hadTrailingNewline ? "\n" : "");
}

/**
 * Bound registry over an {@link AgentEnv} (installed detection), a
 * {@link FileStore} (slot config read/write), and optional {@link ProbeDeps}
 * (availability). The slot config path is resolved from
 * `ROLL_AGENTS_CONFIG` → `.roll/agents.yaml`, mirroring `_agents_config_path`.
 */
export class AgentRegistry {
  constructor(
    private readonly env: AgentEnv,
    private readonly fs: FileStore = nodeFileStore,
  ) {}

  /**
   * Resolve the agents.yaml path. Mirrors `_agents_config_path`: the env override
   * `ROLL_AGENTS_CONFIG` wins only when it points at an existing file (the caller
   * supplies `fileExists`); otherwise `.roll/agents.yaml`. For writes, bash
   * defaults to `.roll/agents.yaml` when neither exists, which is what `undefined`
   * → that literal means to callers of {@link setSlot}.
   */
  configPath(override: string | undefined, fileExists: (p: string) => boolean): string | undefined {
    if (override !== undefined && override !== "" && fileExists(override)) return override;
    if (fileExists(".roll/agents.yaml")) return ".roll/agents.yaml";
    return undefined;
  }

  /** Read a slot's `{ agent, model? }` from the file at `path` (returns
   *  `undefined` when the file is unreadable or the slot has no value). */
  readSlot(path: string, slot: AgentSlot): SlotConfig | undefined {
    let text: string;
    try {
      text = this.fs.readText(path);
    } catch {
      return undefined;
    }
    return readSlotFromText(text, slot);
  }

  /** Atomically write `agent` (and an optional `model`) into `slot` at `path`
   *  (read-modify-write; seeds a fresh file when `path` does not yet exist). */
  setSlot(path: string, slot: AgentSlot, agent: string, model?: string): void {
    let text = "";
    try {
      text = this.fs.readText(path);
    } catch {
      text = "";
    }
    this.fs.writeFileAtomic(path, setSlotInText(text, slot, agent, model));
  }

  /** Pass-throughs to the pure identity helpers, scoped to this registry. */
  isInstalled(agent: string, dir?: string): boolean {
    return agentInstalledByName(this.env, agent, dir);
  }
  installed(): string[] {
    return agentsInstalled(this.env);
  }
  firstInstalled(): string | undefined {
    return firstInstalledAgent(this.env);
  }
}
