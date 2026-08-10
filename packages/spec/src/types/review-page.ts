/**
 * @responsibility Declares the review-page block and page types.
 */
export type ReviewPageKind = "design" | "acceptance";

export type DesignReviewBlockKind =
  | "summary"
  | "architecture-map"
  | "flow"
  | "contract-table"
  | "decision-matrix"
  | "prototype-frame"
  | "risk-board"
  | "signoff";

export interface DesignReviewPage {
  kind: "design";
  id: string;
  title: string;
  sourceSpecPath: string;
  status: "draft" | "awaiting-signoff" | "split-ready" | "cards-created";
  generatedAt: string;
  blocks: DesignReviewBlock[];
  artifacts: Array<{ label: string; path: string; kind: "markdown" | "html" | "spec" | "transcript" }>;
}

export interface DesignReviewBlock {
  kind: DesignReviewBlockKind;
  title: string;
  summary?: string;
  items?: Array<Record<string, string>>;
  nodes?: Array<{ id: string; label: string; role?: string }>;
  edges?: Array<{ from: string; to: string; label?: string }>;
  frames?: Array<{ title: string; surface: "cli" | "web" | "app" | "config"; body: string[] }>;
}
