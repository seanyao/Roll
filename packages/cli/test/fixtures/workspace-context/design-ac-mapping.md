# Workspace context design AC evidence map

| Design AC | Story AC | Executable evidence |
|---|---|---|
| D15-01 | US-WS-040 AC10 | `workspace-context-case-map.test.ts` validates that every detailed design row has concrete evidence. |
| D15-02 | US-WS-040 AC2 | `workspace-context.critical.e2e.test.ts`; `workspace-alias.difftest.test.ts`. |
| D15-03 | US-WS-040 AC3 | `workspace-context.critical.e2e.test.ts`; `workspace-create.e2e.test.ts`. |
| D15-04 | US-WS-040 AC5 | `agent-workspace-clarify.e2e.test.ts`; `workspace-interaction.e2e.test.ts`. |
| D15-05 | US-WS-040 AC5 | `workspace-requirement.e2e.test.ts`; requirement discovery focused suites. |
| D15-06 | US-WS-040 AC4 | `workspace-edit.e2e.test.ts` preview/race/recovery/idempotency cases. |
| D15-07 | US-WS-040 AC4 | `workspace-edit.e2e.test.ts` byte-preservation cases. |
| D15-08 | US-WS-040 AC1, AC6 | generated compatibility and validation-case matrices plus strict skills audit. |
| D15-09 | US-WS-040 AC5, AC7 | clarification and public boundary fail-closed cases. |
| D15-10 | US-WS-040 AC1, AC9, AC10 | generated matrices, CI gates, and US-WS-041 dependency. |
| D15-11 | US-WS-040 AC3 | `workspace-create-recovery.e2e.test.ts`. |
| D15-12 | US-WS-040 AC5, AC6 | requirement and cycle repository execution-context suites. |
| D15-13 | US-WS-040 AC5, AC7 | `agent-workspace-clarify.e2e.test.ts` zero-mutation stopping handoff. |
| D15-14 | US-WS-040 AC5, AC7 | agent/direct interaction select/create/repair/cancel/EOF/stale-answer suites. |
| D15-15 | US-WS-040 AC3, AC5 | create preview authorization and clarification create-intent tests. |
