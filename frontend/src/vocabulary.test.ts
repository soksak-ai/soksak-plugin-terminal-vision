import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Names this plugin emits into the document (class names and data-* names) may not carry a
// morpheme the host uses for its own chrome. TypeScript identifiers are not covered.
const BANNED = new Set(["panel", "divider", "cell", "grid", "frame", "container", "leaf", "host", "handle", "slot", "group"]);
const SOURCE = join(__dirname);

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const morphemes = (name: string) => kebab(name).split(/[-_/:]/).filter(Boolean);

function emittedNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(/dataset\.([A-Za-z][A-Za-z0-9]*)/g)) names.push(match[1]);
  for (const match of body.matchAll(/["'`]data-([a-z][a-z0-9-]*)/g)) names.push(match[1]);
  for (const match of body.matchAll(/className\s*=\s*["'`]([^"'`]+)["'`]/g)) names.push(...match[1].split(/\s+/));
  for (const match of body.matchAll(/classList\.(?:add|toggle)\(\s*["'`]([^"'`]+)["'`]/g)) names.push(match[1]);
  return names;
}

describe("emitted vocabulary", () => {
  it("keeps host chrome morphemes out of the names the plugin emits", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(SOURCE)) {
      scanned += 1;
      for (const name of emittedNames(readFileSync(file, "utf8"))) {
        if (morphemes(name).some((part) => BANNED.has(part))) offenders.push(`${file}: ${name}`);
      }
    }
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"));
    for (const node of manifest.contributes.nodes as { id: string }[]) {
      if (morphemes(node.id).some((part) => BANNED.has(part))) offenders.push(`plugin.json: ${node.id}`);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
