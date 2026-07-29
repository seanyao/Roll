// Entry fixture: imports "./bar" (directory) — the audit must resolve to bar/index.ts.
import { INDEX_VALUE } from "./bar/index.js";

export const MAIN_VALUE = INDEX_VALUE;
