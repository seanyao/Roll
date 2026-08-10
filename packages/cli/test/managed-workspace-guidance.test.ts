import { describe, expect, it, vi } from "vitest";
import { allocationRecovery, releaseRecovery, reservationRefused } from "../src/runner/managed-workspace-guidance.js";

describe("US-LOOP-124 localized lifecycle guidance", () => {
  it("freezes the complete EN and ZH refusal/recovery contract", () => {
    for (const locale of ["en", "zh"] as const) {
      vi.stubEnv("ROLL_LANG", locale);
      expect([
        reservationRefused("US-LOOP-124", "cycle"),
        allocationRecovery("US-LOOP-124", "allocated event exists but Git target is missing"),
        releaseRecovery("cycle-124", "HEAD changed after the durable release request"),
      ].join("\n")).toMatchSnapshot();
    }
    vi.unstubAllEnvs();
  });
});
