// Side-effect import fixture — imported solely for its side effects (no bindings).
// The audit must traverse into this file even though nothing is imported from it.
// This file is clean (no forbidden tokens, no dynamic import/require).

export const SIDE_EFFECT_LOADED = true;
