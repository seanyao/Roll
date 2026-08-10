/**
 * E2 — spec-frontmatter reader for the per-story `target_submodule:` field.
 *
 * A submodule story declares its target either in the backlog row tag
 * (`target-submodule:…`, parsed by core parseTargetSubmodule) OR in its
 * spec.md frontmatter (`target_submodule: …`). The runner resolves the picked
 * story's submodule by consulting BOTH; this covers the frontmatter reader.
 */
import { describe, expect, it } from "vitest";
import { planManagedWorkspaceBootstrap, resolveTargetSubmodule, targetSubmoduleFromSpecText } from "../src/lib/target-submodule.js";

describe("targetSubmoduleFromSpecText — E2 spec frontmatter", () => {
  it("returns undefined when there is no frontmatter", () => {
    expect(targetSubmoduleFromSpecText("# Just a body\n")).toBeUndefined();
  });

  it("returns undefined when frontmatter omits target_submodule", () => {
    const spec = "---\nepic: x\ndeliverable_url: https://a\n---\nbody\n";
    expect(targetSubmoduleFromSpecText(spec)).toBeUndefined();
  });

  it("reads a scalar target_submodule from frontmatter", () => {
    const spec = "---\nepic: contractor\ntarget_submodule: dukang-service-online\n---\nbody\n";
    expect(targetSubmoduleFromSpecText(spec)).toBe("dukang-service-online");
  });

  it("strips quotes and inline comments", () => {
    const spec = '---\ntarget_submodule: "dukang-service-online"  # the backend\n---\n';
    expect(targetSubmoduleFromSpecText(spec)).toBe("dukang-service-online");
  });

  it("ignores a target_submodule OUTSIDE the frontmatter block", () => {
    const spec = "---\nepic: x\n---\nbody target_submodule: not-this\n";
    expect(targetSubmoduleFromSpecText(spec)).toBeUndefined();
  });

  it("uses one transport-neutral precedence order for Cycle and host Delta", () => {
    const spec = "---\ntarget_submodule: modules/declared\n---\nmentions modules/inferred\n";
    expect(resolveTargetSubmodule({
      storyDescription: "target-submodule:modules/from-backlog",
      specText: spec,
      gitmodulesText: "path = modules/inferred\npath = modules/declared\n",
      defaultSubmodule: "modules/default",
    })).toBe("modules/from-backlog");
    expect(resolveTargetSubmodule({
      specText: spec,
      gitmodulesText: "path = modules/inferred\npath = modules/declared\n",
      defaultSubmodule: "modules/default",
    })).toBe("modules/declared");
  });

  it("freezes the one caller-neutral target and bootstrap policy for Cycle plus host", () => {
    const immutableInputs = {
      storyDescription: "target-submodule:modules/from-backlog",
      specText: "---\ntarget_submodule: modules/from-spec\n---\n",
      gitmodulesText: "path = modules/from-backlog\npath = modules/from-spec\n",
      defaultSubmodule: "modules/default",
    };
    const cycle = planManagedWorkspaceBootstrap(immutableInputs);
    const host = planManagedWorkspaceBootstrap(immutableInputs);
    expect(cycle).toEqual({
      targetSubmodule: "modules/from-backlog",
      linkRoll: true,
      initializeSkills: true,
      installDependencies: true,
      policyPrebuild: true,
    });
    expect(host).toEqual(cycle);
  });
});
