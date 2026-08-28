// The theme the source carries: one validated host base, read on declaration
// and again at the host theme epoch.
import { resolveTerminalTheme, type TerminalThemeStatus } from "@soksak/soksak-contract-plugin-terminal";
import { readTerminalThemeStatus } from "@soksak/soksak-kit-plugin-terminal";
import type { TerminalSurfaceTheme } from "./surface";

export function surfaceThemeFromStatus(status: TerminalThemeStatus): TerminalSurfaceTheme {
  const effective = resolveTerminalTheme(status.baseTheme, status.terminalOverrides);
  if (JSON.stringify(effective) !== JSON.stringify(status.effectiveTheme)) {
    throw new Error("terminal effectiveTheme does not match baseTheme and terminalOverrides");
  }
  const base = status.baseTheme;
  return {
    mode: status.themeMode,
    fg: base.foreground,
    bg: base.background,
    cursor: base.cursor,
    cursorAccent: base.cursorAccent,
    selectionBg: base.selectionBackground,
    selectionFg: base.foreground,
    ansi: [...base.ansi],
  };
}

export function readSurfaceTheme(root: HTMLElement): TerminalSurfaceTheme {
  return surfaceThemeFromStatus(readTerminalThemeStatus(root.ownerDocument.documentElement));
}
