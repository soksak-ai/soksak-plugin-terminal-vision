import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NODE_24_CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("release workflow", () => {
  it("uses the Node 24 checkout action for every repository", () => {
    const workflow = readFileSync(join(__dirname, "../../.github/workflows/release.yml"), "utf8");
    const checkoutActions = workflow.match(/actions\/checkout@[0-9a-f]+/g) ?? [];
    expect(checkoutActions.length).toBeGreaterThan(0);
    expect(new Set(checkoutActions)).toEqual(new Set([NODE_24_CHECKOUT]));
    expect(workflow).toContain("soksak-plugins/soksak-plugin-terminal-vision/.node-version");
  });
});
