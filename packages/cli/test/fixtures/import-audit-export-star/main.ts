// Entry fixture: uses `export * from` to re-export everything from reexported.ts.
// The audit must resolve this pattern and traverse reexported.ts.
export * from "./reexported.js";

export const ENTRY_VALUE = "entry";
