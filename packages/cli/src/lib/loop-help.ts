/**
 * US-DOSSIER-035 — grouped `roll loop --help` (design frame 4).
 *
 * The flat ~18-verb pipe list becomes four labeled bands so a user instantly
 * sees "control it vs watch it": control · observe · alerts · maintain, in the
 * design order, each listing exactly the subcommands frame 4 assigns it. A
 * fifth `internal` band lists the loop-AGENT cycle-gate verbs so no live
 * subcommand is dropped (AC5) while the four user-facing bands match the design.
 *
 * Single-language per resolved locale; the EN and 中 headers each render their
 * own block (never inline on one line).
 */
import type { Lang } from "@roll/spec";
import { c, pad } from "../render.js";

/** Each band: a label, its color, and the verbs the design frame 4 lists. */
interface Band {
  key: string;
  color: string;
  en: string;
  zh: string;
  verbs: string;
}

const BANDS: Band[] = [
  // US-LOOP-113: `on`/`off`/`now`/`fallback` installed, removed, or poked a
  // resident scheduler and are gone. `pause`/`resume` stay — PAUSE is a live gate
  // the correction circuit breaker writes automatically, so `resume` is the only
  // supported way out of a paused project.
  { key: "control", color: "amber", en: "control", zh: "作动", verbs: "go · goal · pause · resume · reset · recover · reconcile" },
  { key: "observe", color: "green", en: "observe", zh: "传感", verbs: "watch · status · runs · log · events · signals · eval · cycles · cycle" },
  { key: "alerts", color: "red", en: "alerts", zh: "告警", verbs: "alert list · alert ack · alert resolve · alert log" },
  { key: "maintain", color: "muted", en: "maintain", zh: "维护", verbs: "gc · fmt · mute · unmute · reconcile-pending · pardon-skip-list" },
  // Agent-invoked entry points — live, but not user-facing daily verbs. Listed
  // so AC5's "no live subcommand dropped" holds without polluting the four
  // design bands.
  { key: "internal", color: "faint", en: "internal", zh: "内部", verbs: "run-once · story · notify · enforce-tcr · precheck-ci · hotfix-head-context · agent-routes · adversarial · review-resize · self-downgrade · exhaustion-split" },
];

/** US-LOOP-113: the run-state model in `--help`. The old three states described a
 *  daemon's lifecycle — ACTIVE meant "lanes armed", DORMANT meant "the lane
 *  unloaded itself", and a dormant loop had to be "woken". With no resident lane
 *  there are two honest states and nothing to wake: a session drives, or the owner
 *  has paused autonomous progress. EN and 中 each get their own block. */
const STATE_LINES: Record<Lang, string[]> = {
  en: [
    `${c("blue", pad("states", 10))}ACTIVE (a session may drive cards) · PAUSED (you or a tripped breaker stopped autonomous progress → roll loop resume)`,
    `${c("blue", pad("drive", 10))}open an agent session and run roll loop go — nothing advances on its own`,
  ],
  zh: [
    `${c("blue", pad("状态", 10))}ACTIVE 运行中(会话可推进卡片) · PAUSED 已暂停(你或跳闸的熔断器停掉了自主推进 → roll loop resume)`,
    `${c("blue", pad("驱动", 10))}开一个 agent 会话跑 roll loop go —— 没有任何东西会自行推进`,
  ],
};

/** Render the grouped `roll loop --help` body for the resolved locale. */
export function renderLoopHelp(lang: Lang): string {
  const title =
    lang === "zh"
      ? "用法：roll loop <子命令>\n自治交付循环——按作动/传感/告警/维护分组。"
      : "Usage: roll loop <subcommand>\nThe autonomous delivery loop — grouped control / observe / alerts / maintain.";
  const lines = BANDS.map((b) => `${c(b.color, pad(lang === "zh" ? b.zh : b.en, 10))}${b.verbs}`);
  return `${title}\n\n${lines.join("\n")}\n\n${STATE_LINES[lang].join("\n")}\n`;
}
