// The theme the source carries: the host's terminal tokens, read once per
// declaration and again when the theme verb re-sends them.
import { TERMINAL_ANSI_PALETTE, TERMINAL_THEME_CONTRACT } from "@soksak/soksak-contract-plugin-terminal";
import { readTerminalTheme } from "@soksak/soksak-kit-plugin-terminal";
import type { TerminalSurfaceTheme } from "./surface";

// Outside a themed document (a bare test DOM) the tokens are empty and the kit
// reader refuses; the contract palette and these neutrals stand in so a source
// is always a complete document.
const UNTHEMED = {
  foreground: "#e6e6e6",
  background: "#101014",
  cursor: "#e6e6e6",
  cursorAccent: "#101014",
  selectionBackground: "#264f78",
};

export function readSurfaceTheme(root: HTMLElement): TerminalSurfaceTheme {
  let resolved: typeof UNTHEMED;
  try {
    resolved = readTerminalTheme(root.ownerDocument.documentElement);
  } catch {
    resolved = UNTHEMED;
  }
  const style = getComputedStyle(root);
  const ansi = TERMINAL_ANSI_PALETTE.map((fallback, index) => {
    const declared = style.getPropertyValue(`${TERMINAL_THEME_CONTRACT.properties.ansiPrefix}${index}`).trim();
    return declared || fallback;
  });
  return {
    fg: resolved.foreground,
    bg: resolved.background,
    cursor: resolved.cursor,
    cursorAccent: resolved.cursorAccent,
    selectionBg: resolved.selectionBackground,
    selectionFg: resolved.foreground,
    ansi,
  };
}
