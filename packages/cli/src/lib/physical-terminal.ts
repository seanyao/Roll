/**
 * @responsibility Defines the physical terminal spec used to launch terminal apps.
 */
export interface PhysicalTerminalSpec {
  app: string;
  command: string;
  evidence: string;
}

export type PhysicalTerminalParseResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; spec: PhysicalTerminalSpec };

function frontmatter(specText: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(specText);
  return m === null ? null : (m[1] ?? "");
}

function stripInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === "'" || ch === '"') && (i === 0 || value[i - 1] !== "\\")) {
      quote = quote === ch ? null : quote === null ? ch : quote;
      continue;
    }
    if (ch === "#" && quote === null && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function stripQuotes(value: string): string {
  const stripped = stripInlineComment(value.trim());
  if ((stripped.startsWith('"') && stripped.endsWith('"')) || (stripped.startsWith("'") && stripped.endsWith("'"))) {
    return stripped.slice(1, -1);
  }
  return stripped;
}

export function parsePhysicalTerminalSpec(specText: string): PhysicalTerminalParseResult {
  const fm = frontmatter(specText);
  if (fm === null) return { kind: "absent" };
  const lines = fm.split(/\r?\n/);
  const declared = lines.findIndex((line) => /^physical_terminal(?:\s|:|$)/.test(line));
  if (declared === -1) return { kind: "absent" };
  const mapping = /^physical_terminal\s*:(.*)$/.exec(lines[declared] ?? "");
  if (mapping === null || stripInlineComment(mapping[1] ?? "").trim() !== "") {
    return { kind: "invalid", reason: "physical_terminal must be a mapping" };
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(declared + 1)) {
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break;
    const m = /^\s+(?:-\s*)?(app|command|evidence):\s*(.+?)\s*$/.exec(line);
    if (m === null) continue;
    const key = m[1] ?? "";
    const value = stripQuotes(m[2] ?? "");
    if (value !== "") fields.set(key, value);
  }

  const command = fields.get("command");
  if (command === undefined || command === "") {
    return { kind: "invalid", reason: "physical_terminal.command is required" };
  }
  const spec = {
    app: fields.get("app") ?? "Terminal.app",
    command,
    evidence: fields.get("evidence") ?? "screenshot",
  };
  if (spec.app !== "Terminal.app") {
    return { kind: "invalid", reason: "physical_terminal.app must be Terminal.app" };
  }
  if (spec.evidence !== "screenshot") {
    return { kind: "invalid", reason: "physical_terminal.evidence must be screenshot" };
  }
  return { kind: "ok", spec };
}

export function physicalTerminalFromSpecText(specText: string): PhysicalTerminalSpec | null {
  const parsed = parsePhysicalTerminalSpec(specText);
  return parsed.kind === "ok" ? parsed.spec : null;
}

export function physicalTerminalParseError(specText: string): string | null {
  const parsed = parsePhysicalTerminalSpec(specText);
  return parsed.kind === "invalid" ? parsed.reason : null;
}

export function declaresPhysicalTerminalSpec(specText: string): boolean {
  return parsePhysicalTerminalSpec(specText).kind !== "absent";
}
