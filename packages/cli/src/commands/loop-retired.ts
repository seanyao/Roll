/**
 * @responsibility Prints retirement redirect stubs for the retired v2 tmux-popup loop commands.
 */
/**
 * Retirement stubs for the v2 tmux-popup loop commands `monitor` / `attach`
 * (US-PORT-007). The v3 self-contained runner already streams every cycle into
 * the tmux session `roll-loop-<slug>` (see loop-state.ts), so the old
 * auto-refresh dashboard popup (`monitor`) has no object, and attaching is a
 * plain `tmux attach`. Each stub prints a single-language redirect (follows
 * ROLL_LANG) and exits 0 — informational, never the v2 tmux behaviour.
 */
import { type Lang, resolveLang, t, v3Catalog } from "@roll/spec";
import { projectSlug } from "./dashboard.js";

function lang(): Lang {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

export function loopMonitorRetired(): number {
  process.stdout.write(t(v3Catalog, lang(), "loopv3.monitor_retired", projectSlug()) + "\n");
  return 0;
}

export function loopAttachRetired(): number {
  process.stdout.write(t(v3Catalog, lang(), "loopv3.attach_retired", projectSlug()) + "\n");
  return 0;
}

/**
 * `loop branches` (US-PORT-022). Pure user-introspection with no internal
 * caller — retired rather than ported off bash. Prints the one-line `git
 * ls-remote` that reproduces the view (single-language, follows ROLL_LANG).
 */
export function loopBranchesRetired(): number {
  process.stdout.write(t(v3Catalog, lang(), "loopv3.branches_retired") + "\n");
  return 0;
}
