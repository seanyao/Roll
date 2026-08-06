/**
 * @responsibility Declares the resolved config shapes.
 */
/** Config contracts — multi-layer resolution lives in infra; shapes live here. */
export interface RollConfig {
  /** Resolved UI language ("en" | "zh") — single-language output per locale. */
  lang?: string;
  /** Remote for cross-machine records sync, when configured. */
  rollRecordsRemote?: string;
}

export interface ProjectConfig {
  /** Project root (canonical path — identity anchor, I7). */
  root: string;
  /** Derived slug — see project.ts. */
  slug: string;
}
