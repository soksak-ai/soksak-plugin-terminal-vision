import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMINAL_PLUGIN_CONTRACT, TERMINAL_PLUGIN_NODES, validateTerminalPluginManifestCommands } from "@soksak/soksak-contract-plugin-terminal";

describe("terminal plugin manifest contract", () => {
  it("declares every common terminal command, the native surface, and its runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    expect(manifest.id).toBe("soksak-plugin-terminal-vision");
    expect(manifest.name).toEqual({ en: "Vision Terminal", ko: "Vision 터미널" });
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.dependencies).toEqual({
      "@soksak/soksak-contract-plugin-terminal": "0.0.13",
      "@soksak/soksak-kit-plugin-terminal": "0.0.71",
    });
    expect(manifest).not.toHaveProperty("spec");
    expect(manifest.appVersionRequirement).toBe("0.0.1");
    expect(manifest.entry).toBe("main.js");
    expect(manifest.implements).toEqual([TERMINAL_PLUGIN_CONTRACT]);

    // The surface permission opens the label, the deliver verb and the pointer provider. The
    // webview permission would show a person a consent sentence about a web view this plugin
    // never drives.
    expect(manifest.permissions).toContain("surface");
    expect(manifest.permissions).not.toContain("webview");
    expect(manifest.permissions).toContain("ui:statusbar");
    expect(manifest.permissions).toContain("clipboard:read");
    expect(manifest.permissions).toContain("clipboard:write");

    // One view, one native surface: the pane's pixels are a sidecar's IOSurface.
    expect(manifest.contributes.views).toEqual([
      expect.objectContaining({ id: "content", surfaces: ["tab"], nativeSurface: true }),
    ]);

    const engines = ["alacritty", "ghostty", "kitty", "shitty", "vt100", "wezterm"];
    expect(manifest.runtimeDependencies.sidecars).toEqual([
      { id: "soksak-sidecar-pty", version: "0.0.13" },
      { id: "soksak-sidecar-terminal-alacritty", version: "0.0.23" },
      { id: "soksak-sidecar-terminal-ghostty", version: "0.0.23" },
      { id: "soksak-sidecar-terminal-kitty", version: "0.0.19" },
      { id: "soksak-sidecar-terminal-shitty", version: "0.0.18" },
      { id: "soksak-sidecar-terminal-vt100", version: "0.0.22" },
      { id: "soksak-sidecar-terminal-wezterm", version: "0.0.22" },
    ]);

    const setting = (key: string) => manifest.configuration.find((item: { key: string }) => item.key === key);
    expect(setting("engine")).toMatchObject({ type: "enum", enum: engines, default: "alacritty" });
    expect(setting("fontSize")).toMatchObject({ type: "number", default: 13 });
    expect(setting("renderer")).toBeUndefined();

    expect(validateTerminalPluginManifestCommands(manifest.contributes.commands)).toEqual([]);
    const names = manifest.contributes.commands.map((command: { name: string }) => command.name);
    for (const name of ["split", "pane.close", "pane.focus", "pane.resize", "pane.equalize",
      "pane.maximize", "pane.broadcast", "pane.title", "scroll", "selection", "read", "send",
      "copy", "paste", "drop", "status", "wait"]) {
      expect(names).toContain(name);
    }

    const nodes = manifest.contributes.nodes.map((node: { id: string }) => node.id);
    for (const node of TERMINAL_PLUGIN_NODES) expect(nodes).toContain(node);
    expect(nodes).toContain("terminal-drop-target");
    expect(nodes).toContain("pane");
    expect(nodes).toContain("gutter");

    expect(manifest.contributes.programs).toEqual([
      expect.objectContaining({ id: "terminal-vision", kind: "view", view: "content" }),
    ]);
  });
});
