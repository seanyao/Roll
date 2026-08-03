#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditRegisteredWorkspaceContextTree,
  renderWorkspaceContextAuditHuman,
  renderWorkspaceContextAuditJson,
} from "../packages/cli/dist/lib/workspace-context-audit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");
const report = auditRegisteredWorkspaceContextTree(root);
process.stdout.write(`${json ? renderWorkspaceContextAuditJson(report) : `${renderWorkspaceContextAuditHuman(report)}\n`}`);
process.exitCode = report.summary.violations === 0 ? 0 : 1;
