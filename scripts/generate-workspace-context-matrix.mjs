#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registeredCliOperations } from "../packages/cli/dist/bridge.js";
import { registerAll } from "../packages/cli/dist/commands/index.js";
import {
  buildRegisteredWorkspaceContextMatrix,
  skillContextInventoryFromManifest,
  skillContextPoliciesFromManifest,
} from "../packages/cli/dist/lib/workspace-context-policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(root, "skills");
const manifest = JSON.parse(fs.readFileSync(path.join(skillsRoot, "route-cases", "skills.json"), "utf8"));

registerAll();
const matrix = buildRegisteredWorkspaceContextMatrix({
  cliRegistrations: registeredCliOperations(),
  skillInventory: skillContextInventoryFromManifest(manifest),
  skillPolicies: skillContextPoliciesFromManifest(manifest),
});

const output = path.join(root, "docs", "generated", "workspace-context-compatibility-matrix.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
