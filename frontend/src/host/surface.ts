// The native surface this plugin declares: seven attributes on one element, and
// a source document the terminal-surface service reads. The pixels come from a
// render sidecar; this process only declares where they belong.

/** The kind of this plugin's surfaces. One word, in one place — the declaration
 *  and the label must agree with the service that places them. */
export const SURFACE_KIND = "terminal";

export interface TerminalSurfaceTheme {
  mode: "light" | "dark";
  fg: string;
  bg: string;
  cursor: string;
  cursorAccent: string;
  selectionBg: string;
  selectionFg: string;
  ansi: readonly string[];
}

/** What the service needs to run one pane: identity, sidecar units, the pixel
 *  box, the face and the theme. Cell counts are absent on purpose — the sidecar
 *  computes cols and rows from the box (the app never counts cells). */
/** The service reads the source as a string map: numbers travel as decimal
 *  strings and the theme travels as one JSON document (compositor sources
 *  hold strings only). */
export interface TerminalSurfaceSource {
  window: string;
  pane: string;
  ptyUnit: string;
  engineUnit: string;
  pixelW: string;
  pixelH: string;
  scale: string;
  fontFamily: string;
  fontPt: string;
  theme: string;
  shell: string;
  cwd?: string;
}

export interface TerminalSurfaceDeclaration {
  id: string;
  generation: number;
  source: TerminalSurfaceSource;
  visible?: boolean;
  alpha?: number;
  layer?: number;
}

/** A pane key `<view>.<k>` holds the label delimiter; the token folds it away
 *  so the assembled label still decomposes to exactly three fields. */
export function surfaceToken(pane: string): string {
  return pane.replaceAll(".", "-");
}

/** The window field of an assembled label `<kind>.<window>.<token>` — read
 *  back, never rebuilt (labels come only from the core's assembler). */
export function windowOfLabel(label: string): string {
  const fields = label.split(".");
  if (fields.length !== 3) {
    throw new Error(`a surface label holds three fields; ${JSON.stringify(label)} does not`);
  }
  return fields[1];
}

/** CoreText takes one face name; a CSS font list hands over its first entry. */
export function primaryFontFamily(list: string): string {
  const first = list.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return first || "Menlo";
}

export function nativeTerminalAttributes(
  declaration: TerminalSurfaceDeclaration,
): Record<string, string> {
  return {
    "data-native-surface": SURFACE_KIND,
    "data-native-surface-id": declaration.id,
    "data-native-generation": String(declaration.generation),
    "data-native-source": JSON.stringify(declaration.source),
    "data-native-visible": String(declaration.visible ?? true),
    "data-native-alpha": String(declaration.alpha ?? 1),
    "data-native-layer": String(declaration.layer ?? 0),
  };
}
