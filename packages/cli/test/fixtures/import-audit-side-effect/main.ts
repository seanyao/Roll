// Entry fixture: side-effect import of a file with no named exports used.
// The audit must resolve and traverse side-effect.ts.
import "./side-effect.js";

export const MAIN_LOADED = true;
