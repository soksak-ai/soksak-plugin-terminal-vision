import { describe, expect, it } from "vitest";
import {
  SURFACE_KIND,
  nativeTerminalAttributes,
  primaryFontFamily,
  surfaceToken,
  windowOfLabel,
  type TerminalSurfaceSource,
} from "./surface";

const source: TerminalSurfaceSource = {
  window: "win-a",
  pane: "tab-b.2",
  ptyUnit: "soksak-sidecar-pty",
  engineUnit: "soksak-sidecar-terminal-alacritty",
  pixelW: "640",
  pixelH: "384",
  scale: "2",
  fontFamily: "Menlo",
  fontPt: "13",
  theme: JSON.stringify({
    mode: "dark",
    fg: "#e6e6e6", bg: "#0a0a0a", cursor: "#e6e6e6", cursorAccent: "#0a0a0a",
    selectionBg: "#264f78", selectionFg: "#e6e6e6", ansi: ["#000000"],
  }),
  shell: "/bin/zsh",
};

describe("the terminal surface declaration", () => {
  it("writes the seven attributes under the terminal kind", () => {
    const attributes = nativeTerminalAttributes({ id: "terminal.win-a.tab-b-2", generation: 1, source });
    expect(Object.keys(attributes).sort()).toEqual([
      "data-native-alpha", "data-native-generation", "data-native-layer",
      "data-native-source", "data-native-surface", "data-native-surface-id",
      "data-native-visible",
    ]);
    expect(attributes["data-native-surface"]).toBe(SURFACE_KIND);
    expect(SURFACE_KIND).toBe("terminal");
    expect(attributes["data-native-visible"]).toBe("true");
    expect(attributes["data-native-alpha"]).toBe("1");
    expect(attributes["data-native-layer"]).toBe("0");
    const parsed = JSON.parse(attributes["data-native-source"]);
    expect(parsed).toEqual(source);
    expect(parsed).not.toHaveProperty("cols");
    expect(parsed).not.toHaveProperty("rows");
  });

  it("folds the pane key's delimiter out of the label token", () => {
    expect(surfaceToken("tab-b.2")).toBe("tab-b-2");
    expect(surfaceToken("tab-b")).toBe("tab-b");
  });

  it("reads the window back from a three-field label and refuses any other shape", () => {
    expect(windowOfLabel("terminal.win-a.tab-b-2")).toBe("win-a");
    expect(() => windowOfLabel("terminal.win-a.tab-b.2")).toThrow(/three fields/);
    expect(() => windowOfLabel("win-a")).toThrow(/three fields/);
  });

  it("hands coretext the first face of a css font list", () => {
    expect(primaryFontFamily('"SF Mono", Menlo, monospace')).toBe("SF Mono");
    expect(primaryFontFamily("Menlo, monospace")).toBe("Menlo");
    expect(primaryFontFamily("")).toBe("Menlo");
  });
});
