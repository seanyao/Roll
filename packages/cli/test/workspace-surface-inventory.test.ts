import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatch, registerPorted, registeredCliOperations } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import {
  cliMatchedOperation,
  cliOperationForArgs,
  commandDecision,
  publicCommands,
} from "../src/lib/command-surface.js";
import {
  buildRegisteredWorkspaceContextMatrix,
  builtinToolContextInventory,
  cliWorkspaceContextPolicies,
  skillContextInventoryFromManifest,
  skillContextPoliciesFromManifest,
} from "../src/lib/workspace-context-policy.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const skillsRoot = join(root, "skills");

function shippedSkillIds(): string[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function skillsManifest(): unknown {
  return JSON.parse(readFileSync(join(skillsRoot, "route-cases", "skills.json"), "utf8"));
}

describe("US-WS-032 actual Workspace surface inventory", () => {
  it("enumerates CLI leaves from live registerPorted metadata", () => {
    registerAll();
    const inventory = registeredCliOperations();
    const families = [...new Set(inventory.map((entry) => entry.command))].sort();
    for (const command of publicCommands()) expect(families).toContain(command);
    for (const command of families) expect(commandDecision(command), `unclassified registered family: ${command}`).toBeDefined();
    expect(inventory).toContainEqual(expect.objectContaining({ command: "workspace", operation: "create" }));
    expect(inventory).not.toContainEqual(expect.objectContaining({ command: "workspace", operation: "init" }));
    expect(inventory).toContainEqual(expect.objectContaining({ command: "backlog", operation: "read", supportsWorkspaceSelector: true }));
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "release", operation: "consistency", route: ["consistency"] }),
      expect.objectContaining({ command: "doctor", operation: "repair-protection", route: ["repair-protection"] }),
      expect.objectContaining({ command: "agent", operation: "default", route: ["default"] }),
      expect.objectContaining({ command: "agent", operation: "set", route: ["set"] }),
      expect.objectContaining({ command: "agent", operation: "use", route: ["use"] }),
    ]));
    expect(inventory.some((entry) => entry.command === "ws")).toBe(false);
    const commandSources = readdirSync(join(root, "packages", "cli", "src", "commands"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(root, "packages", "cli", "src", "commands", name), "utf8"))
      .join("\n");
    expect(commandSources).not.toContain("--ws");
    const commandSurfaceSource = readFileSync(join(root, "packages", "cli", "src", "lib", "command-surface.ts"), "utf8");
    const registrationSource = readFileSync(join(root, "packages", "cli", "src", "commands", "index.ts"), "utf8");
    expect(commandSurfaceSource).not.toContain("PUBLIC_CLI_OPERATIONS");
    expect(registrationSource).not.toContain("cliOperations(");
  });

  it("enumerates shipped Skill.md families and built-in adapter declarations", () => {
    const skillIds = shippedSkillIds();
    const skillInventory = skillContextInventoryFromManifest(skillsManifest());
    const skillPolicies = skillContextPoliciesFromManifest(skillsManifest());
    const toolInventory = builtinToolContextInventory();
    expect(new Set(skillInventory.map((item) => item.id))).toEqual(new Set(skillIds));
    expect(new Set(skillPolicies.map((policy) => policy.id))).toEqual(new Set(skillIds));
    expect(new Set(toolInventory.map((item) => `${item.id}:${item.operation}`)).size).toBe(toolInventory.length);
  });

  it.each([
    ["unknown scope", { scope: "future_scope" }],
    ["wrong selector type", { acceptsWorkspaceSelector: "yes" }],
    ["extra field", { undocumented: true }],
    ["empty operation", { operation: "" }],
    ["unknown consumer", { contextConsumer: "project" }],
  ])("rejects malformed skill manifest policy: %s", (_name, mutation) => {
    const manifest = structuredClone(skillsManifest()) as {
      workspaceContextPolicies: Array<Record<string, unknown>>;
    };
    manifest.workspaceContextPolicies[0] = {
      ...manifest.workspaceContextPolicies[0],
      ...mutation,
    };
    expect(() => skillContextPoliciesFromManifest(manifest)).toThrow(/invalid skill policy at index 0/);
  });

  it("closes the registered inventory and matches the stable machine artifact", () => {
    registerAll();
    const matrix = buildRegisteredWorkspaceContextMatrix({
      cliRegistrations: registeredCliOperations(),
      skillInventory: skillContextInventoryFromManifest(skillsManifest()),
      skillPolicies: skillContextPoliciesFromManifest(skillsManifest()),
    });
    const artifact = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8"));
    expect(matrix).toEqual(artifact);
    expect(matrix.summary).toEqual({
      cliFamilies: new Set(matrix.rows.filter((row) => row.surface === "cli").map((row) => row.id)).size,
      cliOperations: matrix.rows.filter((row) => row.surface === "cli").length,
      skillFamilies: new Set(matrix.rows.filter((row) => row.surface === "skill").map((row) => row.id)).size,
      skillOperations: matrix.rows.filter((row) => row.surface === "skill").length,
      toolAdapters: new Set(matrix.rows.filter((row) => row.surface === "tool").map((row) => row.id)).size,
      toolOperations: matrix.rows.filter((row) => row.surface === "tool").length,
    });
  });

  it("fails when a newly registered callable route has no policy", async () => {
    registerAll();
    const currentWorkspace = registeredCliOperations().filter((entry) => entry.command === "workspace");
    registerPorted("workspace", (args) => args[0] === "future-leaf" ? 41 : 0, {
      operations: [
        ...currentWorkspace,
        {
          command: "workspace",
          operation: "future-leaf",
          route: ["future-leaf"],
          canonicalCommand: "roll workspace future-leaf",
          supportsWorkspaceSelector: false,
        },
      ],
    });
    await expect(dispatch(["workspace", "future-leaf"])).resolves.toEqual({ status: 41 });
    expect(() => buildRegisteredWorkspaceContextMatrix({
      cliRegistrations: registeredCliOperations(),
      skillInventory: skillContextInventoryFromManifest(skillsManifest()),
      skillPolicies: skillContextPoliciesFromManifest(skillsManifest()),
    })).toThrow(/missing policy: cli:workspace:future-leaf/);
  });

  it("blocks an unregistered nested leaf before a handler can hide it behind destructuring or Set.has", async () => {
    registerAll();
    const currentWorkspace = registeredCliOperations()
      .filter((entry) => entry.command === "workspace" && entry.operation !== "future-leaf");
    let handlerRuns = 0;
    const hiddenLeaves = new Set(["future"]);
    registerPorted("workspace", (args) => {
      const [family, leaf] = args;
      if (family === "issue" && leaf !== undefined && hiddenLeaves.has(leaf)) {
        handlerRuns += 1;
        return 41;
      }
      return 0;
    }, { operations: currentWorkspace });

    await expect(dispatch(["workspace", "issue", "future"])).resolves.toEqual({ status: 1 });
    expect(handlerRuns).toBe(0);
  });

  it("uses executable matchers to distinguish config reads, writes, nested routes, and ambiguity", () => {
    registerAll();
    const config = registeredCliOperations().filter((entry) => entry.command === "config");
    expect(cliOperationForArgs("config", ["lang"], config)?.operation).toBe("read");
    expect(cliOperationForArgs("config", ["lang", "en"], config)?.operation).toBe("write");
    expect(cliOperationForArgs("config", ["prices"], config)?.operation).toBe("prices");
    expect(cliOperationForArgs("config", ["future"], config)).toBeUndefined();

    const ambiguous = [
      cliMatchedOperation("status", "one", [], [], () => true),
      cliMatchedOperation("status", "two", [], [], () => true),
    ];
    expect(cliOperationForArgs("status", [], ambiguous)).toBeUndefined();
  });

  it("splits Workspace doctor read/mutation operations and excludes retired scheduler routes", () => {
    registerAll();
    const inventory = registeredCliOperations();
    const policies = cliWorkspaceContextPolicies(inventory);
    const workspace = inventory.filter((entry) => entry.command === "workspace");
    const loop = inventory.filter((entry) => entry.command === "loop");

    expect(cliOperationForArgs("workspace", ["doctor", "roll"], workspace)?.operation).toBe("doctor.read");
    expect(cliOperationForArgs("workspace", ["doctor", "roll", "--repair", "rebuild_cache:product"], workspace)?.operation).toBe("doctor.repair");
    expect(policies.find((policy) => policy.id === "workspace" && policy.operation === "doctor.read")?.scope)
      .toBe("workspace_required_read");
    expect(policies.find((policy) => policy.id === "workspace" && policy.operation === "doctor.repair")?.scope)
      .toBe("workspace_required_mutation");

    for (const operation of ["on", "off", "now", "fallback", "fallback.status", "fallback.start", "fallback.stop", "test"]) {
      expect(loop.find((entry) => entry.operation === operation)).toBeUndefined();
      expect(policies.find((policy) => policy.id === "loop" && policy.operation === operation)).toBeUndefined();
    }
  });

  it("excludes retired loop routes from live inventory and the compatibility matrix", () => {
    registerAll();
    const retired = new Set(["monitor", "attach", "branches", "test-quality-check", "on", "off", "now", "fallback", "test"]);
    const inventory = registeredCliOperations();
    const matrix = buildRegisteredWorkspaceContextMatrix({
      cliRegistrations: inventory,
      skillInventory: skillContextInventoryFromManifest(skillsManifest()),
      skillPolicies: skillContextPoliciesFromManifest(skillsManifest()),
    });

    expect(inventory.filter((entry) => entry.command === "loop" && retired.has(entry.operation))).toEqual([]);
    expect(matrix.rows.filter((row) => row.surface === "cli" && row.id === "loop" && retired.has(row.operation)))
      .toEqual([]);
  });

  it("preserves a legitimate positional single-operation command at runtime", async () => {
    registerAll();
    const operations = registeredCliOperations().filter((entry) => entry.command === "idea");
    const observed: string[][] = [];
    registerPorted("idea", (args) => {
      observed.push(args);
      return 43;
    }, { operations });
    await expect(dispatch(["idea", "capture", "this", "requirement"])).resolves.toEqual({ status: 43 });
    expect(observed).toEqual([["capture", "this", "requirement"]]);
  });

  it("fails when an independently declared shipped skill operation has no policy", () => {
    const manifest = structuredClone(skillsManifest()) as {
      skillOperations: Array<{ id: string; operations: string[] }>;
    };
    manifest.skillOperations[0]?.operations.push("future-operation");
    expect(() => buildRegisteredWorkspaceContextMatrix({
      cliRegistrations: registeredCliOperations(),
      skillPolicies: skillContextPoliciesFromManifest(manifest),
      skillInventory: skillContextInventoryFromManifest(manifest),
    })).toThrow(/missing policy: skill:.*:future-operation/);
  });
});
