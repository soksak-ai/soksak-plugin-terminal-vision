// The committed entry is the one this source produces.
//
// plugin.json names main.js as the entry and the release packs it, so a commit whose source moved
// without a rebuild ships an entry that is not its source. The release build catches it — after the
// commit exists, which made it a repeated cycle of commit, fail, rebuild, amend.
//
// This fails in the same run as the source change instead.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the committed entry", () => {
  it("is what the current source builds", () => {
    const root = join(import.meta.dirname, "..", "..");
    const committed = readFileSync(join(root, "main.js"));
    // --check builds into memory and compares, which is what the release does. Running it here
    // moves the same verdict to the moment the source changes.
    execFileSync("node", ["build.mjs", "--check"], { cwd: join(root, "frontend"), stdio: "pipe" });
    expect(readFileSync(join(root, "main.js")).equals(committed)).toBe(true);
  });
});
