// The surface presenter: it declares a native pane and delivers verbs to the
// service that owns it. It opens no session, attaches no stream and polls no
// frame — the pixels never pass through this process.
import {
  readTerminalThemeStatus,
  terminalNodeId,
  type TerminalPresenter,
  type TerminalPresenterOptions,
  type TerminalRendererAdapter,
  type TerminalVisibilityState,
} from "@soksak/soksak-kit-plugin-terminal";
import {
  resolveTerminalTheme,
  type TerminalThemeStatus,
} from "@soksak/soksak-contract-plugin-terminal";
import {
  SURFACE_KIND,
  nativeTerminalAttributes,
  primaryFontFamily,
  surfaceToken,
  windowOfLabel,
  type TerminalSurfaceSource,
} from "./surface";
import { surfaceThemeFromStatus } from "./theme";

export interface SurfaceCapability {
  label(kind: string, viewId: string): string;
  deliver(label: string, message: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface SurfacePointerInput {
  x: number;
  y: number;
  kind: "down" | "up" | "move" | "drag" | "enter" | "exit";
  button: "left" | "middle" | "right";
  clickCount: number;
  modifiers: { shift: boolean; alt: boolean; control: boolean; meta: boolean };
}

export interface SurfaceWheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  deltaMode: "pixel" | "line" | "page";
  modifiers: { shift: boolean; alt: boolean; control: boolean; meta: boolean };
}

export interface SurfaceApp {
  surface?: SurfaceCapability;
  provideSurfaceInput?(provider: {
    owns(label: string): boolean;
    labelOfView?(viewId: string): string | null;
    sendInput(label: string, input: SurfacePointerInput): Promise<void>;
    sendWheel(label: string, input: SurfaceWheelInput): Promise<void>;
    inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
  }): () => void;
  settings?: { get(key: string): unknown };
  events?: {
    on(event: "terminal-surface.state", listener: (payload: {
      pane: string; sequence: number; generation: number;
    }) => void): { dispose(): void };
  };
}

export const PTY_UNIT = "soksak-sidecar-pty";
export const ENGINE_UNITS: Readonly<Record<string, string>> = Object.freeze({
  alacritty: "soksak-sidecar-terminal-alacritty",
  ghostty: "soksak-sidecar-terminal-ghostty",
  kitty: "soksak-sidecar-terminal-kitty",
  shitty: "soksak-sidecar-terminal-shitty",
  vt100: "soksak-sidecar-terminal-vt100",
  wezterm: "soksak-sidecar-terminal-wezterm",
});
const DEFAULT_ENGINE = "alacritty";

interface SurfaceState {
  sequence: number | null;
  cols: number;
  rows: number;
  offset: number;
  historySize: number;
  text: string;
  selection: SurfaceSelectionSnapshot;
  modes: SurfaceModes | null;
  cursorRow: number;
  cursorColumn: number;
  cursorVisible: boolean;
  cursorShape: "block" | "underline" | "bar";
  cursorBlinking: boolean;
  cursorAnimation: { intervalMs: number; phase: "steady" | "on" | "off" };
  theme: TerminalThemeStatus;
}

interface SurfaceModes {
  mouseClick: boolean;
  mouseDrag: boolean;
  mouseMotion: boolean;
  sgrMouse: boolean;
  utf8Mouse: boolean;
  alternateScroll: boolean;
}

interface SurfaceSelectionPoint {
  row: number;
  col: number;
  side: "left" | "right";
}

interface SurfaceSelectionSnapshot {
  active: boolean;
  text: string;
  kind: "simple" | "block" | "semantic" | "line" | "extend" | null;
  anchor: SurfaceSelectionPoint | null;
  focus: SurfaceSelectionPoint | null;
  gestureId: string | null;
  sequence: number;
}

const emptySelection = (): SurfaceSelectionSnapshot => ({
  active: false, text: "", kind: null, anchor: null, focus: null, gestureId: null, sequence: 0,
});

function cloneTerminalThemeStatus(status: TerminalThemeStatus): TerminalThemeStatus {
  return {
    themeMode: status.themeMode,
    baseTheme: { ...status.baseTheme, ansi: [...status.baseTheme.ansi] },
    terminalOverrides: { ...status.terminalOverrides, ansi: [...status.terminalOverrides.ansi] },
    effectiveTheme: { ...status.effectiveTheme, ansi: [...status.effectiveTheme.ansi] },
  };
}

function terminalThemeStatus(value: Record<string, unknown>): TerminalThemeStatus | null {
  if (value.themeMode !== "light" && value.themeMode !== "dark") return null;
  if (!value.baseTheme || typeof value.baseTheme !== "object"
    || !value.terminalOverrides || typeof value.terminalOverrides !== "object"
    || !value.effectiveTheme || typeof value.effectiveTheme !== "object") return null;
  const candidate = {
    themeMode: value.themeMode,
    baseTheme: value.baseTheme,
    terminalOverrides: value.terminalOverrides,
    effectiveTheme: value.effectiveTheme,
  } as TerminalThemeStatus;
  try {
    const expected = resolveTerminalTheme(candidate.baseTheme, candidate.terminalOverrides);
    const actual = candidate.effectiveTheme;
    if (actual.foreground !== expected.foreground
      || actual.background !== expected.background
      || actual.cursor !== expected.cursor
      || actual.cursorAccent !== expected.cursorAccent
      || actual.selectionBackground !== expected.selectionBackground
      || actual.ansi.length !== expected.ansi.length
      || actual.ansi.some((color, index) => color !== expected.ansi[index])) return null;
    return cloneTerminalThemeStatus({ ...candidate, effectiveTheme: expected });
  } catch {
    return null;
  }
}

function surfaceModes(value: unknown): SurfaceModes | null {
  if (!value || typeof value !== "object") return null;
  const mode = value as Record<string, unknown>;
  for (const key of ["mouseClick", "mouseDrag", "mouseMotion", "sgrMouse", "utf8Mouse", "alternateScroll"]) {
    if (typeof mode[key] !== "boolean") return null;
  }
  return mode as unknown as SurfaceModes;
}

function surfaceSelectionPoint(value: unknown): SurfaceSelectionPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  if (!Number.isSafeInteger(point.row) || Number(point.row) < 0
    || !Number.isSafeInteger(point.col) || Number(point.col) < 0
    || (point.side !== "left" && point.side !== "right")) return null;
  return { row: Number(point.row), col: Number(point.col), side: point.side };
}

function surfaceSelectionSnapshot(value: unknown): SurfaceSelectionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.active !== "boolean" || typeof snapshot.text !== "string"
    || !Number.isSafeInteger(snapshot.sequence) || Number(snapshot.sequence) < 0) return null;
  if (!snapshot.active) {
    if (snapshot.text !== "" || snapshot.kind !== null || snapshot.anchor !== null
      || snapshot.focus !== null || snapshot.gestureId !== null) return null;
    return emptySelectionWithSequence(Number(snapshot.sequence));
  }
  if (snapshot.kind !== "simple" && snapshot.kind !== "block" && snapshot.kind !== "semantic"
    && snapshot.kind !== "line" && snapshot.kind !== "extend") return null;
  const anchor = surfaceSelectionPoint(snapshot.anchor);
  const focus = surfaceSelectionPoint(snapshot.focus);
  if (!anchor || !focus || typeof snapshot.gestureId !== "string" || snapshot.gestureId === "") return null;
  return {
    active: true, text: snapshot.text, kind: snapshot.kind,
    anchor, focus, gestureId: snapshot.gestureId, sequence: Number(snapshot.sequence),
  };
}

function emptySelectionWithSequence(sequence: number): SurfaceSelectionSnapshot {
  return { ...emptySelection(), sequence };
}

interface PresenterObservation {
  setVisibility: number;
  lastIntrinsicVisible: boolean;
  lastHostVisible: boolean;
  lastEffectiveVisible: boolean;
  focus: number;
  declWrites: number;
  seq: Array<{ intrinsic: boolean; host: boolean; effective: boolean; dim: number; t: number; n: number }>;
  stateEvents: number;
  stateReads: number;
  stateFailures: number;
  lastEvent: Record<string, unknown> | null;
  lastRead: Record<string, unknown> | null;
  lastError: string | null;
}

/** Per-label counters a diagnostic command reads: what reached each presenter.
 *  seq keeps the LAST 24 events; n is a global order across every pane. */
export const shownLog = new Map<string, PresenterObservation>();
let shownEventCounter = 0;
function logOf(label: string) {
  let entry = shownLog.get(label);
  if (!entry) {
    entry = {
      setVisibility: 0,
      lastIntrinsicVisible: true,
      lastHostVisible: true,
      lastEffectiveVisible: true,
      focus: 0, declWrites: 0, seq: [],
      stateEvents: 0, stateReads: 0, stateFailures: 0,
      lastEvent: null, lastRead: null, lastError: null,
    };
    shownLog.set(label, entry);
  }
  return entry;
}

// The state push from the service names its pane by label; the door routes it
// without any timer of its own (idle IPC stays zero).
const stateDoors = new Map<string, (payload: Record<string, unknown>) => void>();

/** Feed one `terminal-surface.state` payload to the pane it names. Returns
 *  whether a pane held that label. The core relays the service's push here
 *  once its event map carries the name; tests call it directly. */
export function ingestTerminalSurfaceState(payload: Record<string, unknown>): boolean {
  const pane = typeof payload.pane === "string" ? payload.pane : "";
  const door = stateDoors.get(pane);
  if (!door) return false;
  door(payload);
  return true;
}

/** A deliberately small key table: the real input path is the native view in
 *  the app process; this element serves `ui.input.key` automation and typing
 *  before focus lands natively. */
export function encodeProxyKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">): string | null {
  if (event.isComposing || event.metaKey) return null;
  switch (event.key) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return "\x1b[A";
    case "ArrowDown": return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft": return "\x1b[D";
    case "Home": return "\x1b[H";
    case "End": return "\x1b[F";
  }
  if (event.key.length !== 1) return null;
  if (event.ctrlKey) {
    const code = event.key.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
  }
  return event.altKey ? `\x1b${event.key}` : event.key;
}

export function createVisionRenderer(app: SurfaceApp): TerminalRendererAdapter {
  const live = new Set<string>();
  const labelByView = new Map<string, string>();
  const focusInputByLabel = new Map<string, () => Promise<void>>();
  const pointerInputByLabel = new Map<string, (input: SurfacePointerInput) => Promise<void>>();
  const wheelInputByLabel = new Map<string, (input: SurfaceWheelInput) => Promise<void>>();
  let pointerRegistered = false;
  const registerPointerProvider = (surface: SurfaceCapability) => {
    if (pointerRegistered || !app.provideSurfaceInput) return;
    pointerRegistered = true;
    app.provideSurfaceInput({
      owns: (label) => live.has(label),
      labelOfView: (viewId) => labelByView.get(viewId) ?? null,
      sendInput: async (label, input) => {
        if (input.kind === "down") {
          await focusInputByLabel.get(label)?.();
        }
        const route = pointerInputByLabel.get(label);
        if (!route) throw new Error(`terminal surface ${label} has no live pointer route`);
        await route(input);
      },
      sendWheel: async (label, input) => {
        const route = wheelInputByLabel.get(label);
        if (!route) throw new Error(`terminal surface ${label} has no live wheel route`);
        await route(input);
      },
      inputState: (label, at) => surface.deliver(label, { verb: "state", ...(at ? { at } : {}) }),
    });
  };
  let loginShellPromise: Promise<string> | null = null;
  const loginShell = () => (loginShellPromise ??= (async () => {
    // The kit host carries the commands door; its exact type stays the kit's.
    const commands = (app as { commands?: { execute?(name: string, args: Record<string, unknown>): Promise<unknown> } }).commands;
    const executed = await commands?.execute?.("app.environment", {});
    const data = executed && typeof executed === "object" && "data" in executed
      ? (executed as { data?: unknown }).data : executed;
    const shell = data && typeof data === "object"
      ? (data as { loginShell?: unknown }).loginShell : undefined;
    if (typeof shell !== "string" || shell === "") {
      throw new Error("app.environment returned no login shell");
    }
    return shell;
  })());
  return {
    delivery: "surface",
    rendererId: "vision",
    rendererProfile: "native-surface",
    create(container: HTMLElement, pane: string, send: (text: string) => void, options: TerminalPresenterOptions): TerminalPresenter {
      const surface = app.surface;
      if (!surface) {
        throw new Error("SURFACE_CAPABILITY_ABSENT: the surface permission did not open this door");
      }
      registerPointerProvider(surface);
      const document = container.ownerDocument;
      const label = surface.label(SURFACE_KIND, surfaceToken(pane));
      const deliver = (message: Record<string, unknown>) => surface.deliver(label, message);
      const box = () => {
        const px = options.hostPixels();
        return { width: Math.max(1, Math.round(px.width)), height: Math.max(1, Math.round(px.height)) };
      };
      const settingNumber = (key: string, fallback: number): number => {
        const value = app.settings?.get(key);
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
      };
      const engineOf = (): string => {
        const value = app.settings?.get("engine");
        return typeof value === "string" && value in ENGINE_UNITS ? value : DEFAULT_ENGINE;
      };
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
      const pixels = box();
      const initialThemeStatus = readTerminalThemeStatus(document.documentElement);
      const source: TerminalSurfaceSource = {
        window: windowOfLabel(label),
        pane,
        ptyUnit: PTY_UNIT,
        engineUnit: ENGINE_UNITS[engineOf()],
        pixelW: String(pixels.width),
        pixelH: String(pixels.height),
        scale: String(document.defaultView?.devicePixelRatio ?? 1),
        fontFamily: primaryFontFamily(mono),
        fontPt: String(settingNumber("fontSize", 13)),
        theme: JSON.stringify(surfaceThemeFromStatus(initialThemeStatus)),
        shell: "",
        ...(options.cwd ? { cwd: options.cwd } : {}),
      };
      const screen = document.createElement("div");
      screen.dataset.node = terminalNodeId("terminal-screen", options.nodeSuffix);
      // The native surface follows the pane's exact content geometry. Browser and terminal
      // declarations must not invent separate insets; the compositor compares both in the same
      // CSS coordinate space and any border belongs to the shared presentation layer.
      Object.assign(screen.style, { position: "absolute", inset: "0" });
      const generation = options.containerGeneration;
      let declared = false;
      // Workbench pane visibility is intrinsic to this Plugin declaration. Core view visibility
      // lives on the host ancestor and is never copied here. dim remains native alpha because the
      // document focus-lighting veil cannot darken a child surface composited above it.
      let intrinsicVisible = true;
      let dim = 0;
      const writeDeclaration = () => {
        logOf(label).declWrites += 1;
        for (const [name, value] of Object.entries(
          nativeTerminalAttributes({
            // All native surfaces share the compositor's default layer unless a contract owner
            // explicitly requests ordering. The browser surface uses 0; inventing 10 here made
            // terminal and browser presentation differ for no declared reason.
            id: label, generation, source, layer: 0,
            visible: intrinsicVisible, alpha: 1 - dim,
          }),
        )) {
          screen.setAttribute(name, value);
        }
      };
      // The declaration is complete only with the login shell; it lands as
      // soon as app.environment answers, and never in a partial form.
      void loginShell().then((shell) => {
        source.shell = shell;
        declared = true;
        writeDeclaration();
      });
      const input = document.createElement("textarea");
      input.dataset.node = terminalNodeId("terminal-input", options.nodeSuffix);
      input.setAttribute("aria-label", "terminal input");
      Object.assign(input.style, {
        position: "absolute", left: "0", top: "0", width: "1px", height: "1px",
        opacity: "0", border: "0", padding: "0", resize: "none",
      });
      const onKeydown = (event: KeyboardEvent) => {
        const text = encodeProxyKey(event);
        if (text === null) return;
        event.preventDefault();
        send(text);
      };
      input.addEventListener("keydown", onKeydown);
      // Composed text (IME) reaches the pty only when the composition ends;
      // encodeProxyKey drops every keydown while composing.
      const onCompositionEnd = (event: CompositionEvent) => {
        if (event.data) send(event.data);
        input.value = "";
      };
      const onPaste = (event: ClipboardEvent) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text") ?? "";
        if (text) send(text);
      };
      input.addEventListener("compositionend", onCompositionEnd);
      input.addEventListener("paste", onPaste);
      if (!container.style.position) container.style.position = "relative";
      container.append(screen, input);
      live.add(label);
      labelByView.set(pane.slice(0, pane.lastIndexOf(".")), label);

      const state: SurfaceState = {
        sequence: null, cols: 0, rows: 0, offset: 0, historySize: 0, text: "",
        selection: emptySelection(), modes: null,
        cursorRow: 0, cursorColumn: 0, cursorVisible: false, cursorShape: "block",
        cursorBlinking: false, cursorAnimation: { intervalMs: 0, phase: "steady" },
        theme: initialThemeStatus,
      };
      const presentationListeners = new Set<() => void>();
      const stateEventListeners = new Set<() => void>();
      const syncCursorPresentation = () => {
        const focused = document.activeElement === input;
        screen.dataset.cursorRow = String(state.cursorRow);
        screen.dataset.cursorColumn = String(state.cursorColumn);
        screen.dataset.cursorVisible = String(state.cursorVisible);
        screen.dataset.cursorShape = state.cursorShape;
        screen.dataset.cursorBlinking = String(state.cursorBlinking);
        screen.dataset.cursorAnimationIntervalMs = String(state.cursorAnimation.intervalMs);
        screen.dataset.cursorAnimationPhase = state.cursorAnimation.phase;
        screen.dataset.cursorPresentation = focused ? "engine" : "hollow-block";
        screen.dataset.cursorActive = String(
          state.cursorVisible && state.cursorAnimation.phase !== "off" && focused,
        );
      };
      let deliveredFocus: boolean | null = null;
      const deliverFocus = async (focused: boolean): Promise<void> => {
        if (deliveredFocus === focused) return;
        deliveredFocus = focused;
        try {
          const reply = await deliver({ verb: "focus", focused });
          if (reply.focused !== focused) throw new Error("surface.focus returned another focus state");
          screen.dataset.cursorPresentation = String(reply.cursorPresentation);
          delete screen.dataset.focusError;
        } catch (error) {
          deliveredFocus = null;
          screen.dataset.focusError = String(error);
          throw error;
        }
      };
      focusInputByLabel.set(label, async () => {
        input.focus();
        await deliverFocus(true);
      });
      const onInputFocus = () => {
        syncCursorPresentation();
        if (surfaceStateReady) void deliverFocus(document.activeElement === input).catch(() => {});
      };
      input.addEventListener("focus", onInputFocus);
      input.addEventListener("blur", onInputFocus);
      syncCursorPresentation();
      const adoptSelection = (value: unknown): SurfaceSelectionSnapshot | null => {
        const next = surfaceSelectionSnapshot(value);
        if (!next || next.sequence < state.selection.sequence) return null;
        state.selection = next;
        screen.dataset.selectionActive = String(next.active);
        screen.dataset.selectionText = next.text;
        screen.dataset.selectionSequence = String(next.sequence);
        if (next.kind) screen.dataset.selectionKind = next.kind;
        else delete screen.dataset.selectionKind;
        if (next.gestureId) screen.dataset.selectionGestureId = next.gestureId;
        else delete screen.dataset.selectionGestureId;
        delete screen.dataset.selectionError;
        return next;
      };
      adoptSelection(state.selection);
      const ingest = (payload: Record<string, unknown>) => {
        let presentationChanged = false;
        if (typeof payload.sequence === "number") state.sequence = Math.max(state.sequence ?? 0, payload.sequence);
        if (typeof payload.cols === "number") state.cols = payload.cols;
        if (typeof payload.rows === "number") state.rows = payload.rows;
        if (typeof payload.offset === "number" && state.offset !== payload.offset) {
          state.offset = payload.offset;
          presentationChanged = true;
        }
        if (typeof payload.historySize === "number" && state.historySize !== payload.historySize) {
          state.historySize = payload.historySize;
          presentationChanged = true;
        }
        if (typeof payload.text === "string") state.text = payload.text;
        const nextModes = surfaceModes(payload.modes);
        if (nextModes) {
          state.modes = nextModes;
          screen.dataset.mouseTracking = String(
            nextModes.mouseClick || nextModes.mouseDrag || nextModes.mouseMotion,
          );
          screen.dataset.alternateScroll = String(nextModes.alternateScroll);
        }
        adoptSelection(payload.selection);
        const setCursorNumber = (key: "cursorRow" | "cursorColumn", value: unknown) => {
          if (!Number.isSafeInteger(value) || Number(value) < 0 || state[key] === Number(value)) return;
          state[key] = Number(value);
          presentationChanged = true;
        };
        setCursorNumber("cursorRow", payload.cursorRow);
        setCursorNumber("cursorColumn", payload.cursorColumn);
        if (typeof payload.cursorVisible === "boolean" && state.cursorVisible !== payload.cursorVisible) {
          state.cursorVisible = payload.cursorVisible;
          presentationChanged = true;
        }
        if ((payload.cursorShape === "block" || payload.cursorShape === "underline" || payload.cursorShape === "bar")
          && state.cursorShape !== payload.cursorShape) {
          state.cursorShape = payload.cursorShape;
          presentationChanged = true;
        }
        if (typeof payload.cursorBlinking === "boolean" && state.cursorBlinking !== payload.cursorBlinking) {
          state.cursorBlinking = payload.cursorBlinking;
          presentationChanged = true;
        }
        const animation = payload.cursorAnimation;
        if (animation && typeof animation === "object") {
          const value = animation as { intervalMs?: unknown; phase?: unknown };
          if (Number.isFinite(value.intervalMs) && Number(value.intervalMs) >= 0
            && state.cursorAnimation.intervalMs !== Number(value.intervalMs)) {
            state.cursorAnimation.intervalMs = Number(value.intervalMs);
            presentationChanged = true;
          }
          if ((value.phase === "steady" || value.phase === "on" || value.phase === "off")
            && state.cursorAnimation.phase !== value.phase) {
            state.cursorAnimation.phase = value.phase;
            presentationChanged = true;
          }
        }
        const nextTheme = terminalThemeStatus(payload);
        if (nextTheme && JSON.stringify(nextTheme) !== JSON.stringify(state.theme)) {
          state.theme = nextTheme;
          presentationChanged = true;
        }
        if (presentationChanged) {
          syncCursorPresentation();
          for (const listener of presentationListeners) listener();
        }
      };
      type GestureKind = "simple" | "block" | "semantic" | "line" | "extend";
      let activeGesture: { id: string; kind: GestureKind; pointerId: number | null } | null = null;
      let selectionQueue = Promise.resolve();
      const selectionPoint = (x: number, y: number): SurfaceSelectionPoint | null => {
        if (state.cols < 1 || state.rows < 1) return null;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const localX = Math.max(0, Math.min(rect.width - Number.EPSILON, x));
        const localY = Math.max(0, Math.min(rect.height - Number.EPSILON, y));
        const columnValue = localX / rect.width * state.cols;
        return {
          row: Math.min(state.rows - 1, Math.floor(localY / rect.height * state.rows)),
          col: Math.min(state.cols - 1, Math.floor(columnValue)),
          side: columnValue - Math.floor(columnValue) < 0.5 ? "left" : "right",
        };
      };
      const modifiers = (event: PointerEvent) => ({
        shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, meta: event.metaKey,
      });
      const mouseTracking = () => state.modes !== null
        && (state.modes.mouseClick || state.modes.mouseDrag || state.modes.mouseMotion);
      let surfaceInputQueue = Promise.resolve();
      const enqueueSurfaceInput = (
        operation: () => Promise<void>,
        recordError: (error: unknown) => void,
      ): Promise<void> => {
        const running = surfaceInputQueue.catch(() => {}).then(operation);
        surfaceInputQueue = running.catch(recordError);
        return running;
      };
      const enqueueSelection = (message: Record<string, unknown>): Promise<void> => {
        selectionQueue = selectionQueue
          .catch(() => {})
          .then(async () => {
            const reply = await deliver({ verb: "selection", ...message });
            if (!adoptSelection(reply)) throw new Error("surface.selection returned no valid snapshot");
          })
          .catch((error) => {
            screen.dataset.selectionError = String(error);
          });
        return selectionQueue;
      };
      const localSelection = (event: PointerEvent) => {
        return event.shiftKey || (state.modes !== null && !mouseTracking());
      };
      const kindOf = (event: PointerEvent): GestureKind => {
        if (event.ctrlKey && event.altKey) return "block";
        if (event.detail >= 3) return "line";
        if (event.detail === 2) return "semantic";
        return "simple";
      };
      const onPointerDown = (event: PointerEvent) => {
        input.focus();
        if (!localSelection(event)) {
          const button = event.button === 0 ? "left" : event.button === 1 ? "middle"
            : event.button === 2 ? "right" : null;
          if (!button || !mouseTracking()) return;
          const rect = screen.getBoundingClientRect();
          event.preventDefault();
          void enqueuePointer({
            x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top),
            kind: "down", button, clickCount: Math.max(1, event.detail), modifiers: modifiers(event),
          }, true).catch(() => {});
          return;
        }
        void deliverFocus(true).catch(() => {});
        if (event.button !== 0) return;
        const rect = screen.getBoundingClientRect();
        const point = selectionPoint(event.clientX - rect.left, event.clientY - rect.top);
        if (!point) return;
        event.preventDefault();
        const id = crypto.randomUUID();
        activeGesture = {
          id, kind: kindOf(event), pointerId: Number.isSafeInteger(event.pointerId) ? event.pointerId : null,
        };
        if (activeGesture.pointerId !== null) {
          try { screen.setPointerCapture?.(activeGesture.pointerId); } catch { /* detached test node */ }
        }
        enqueueSelection({
          action: "gesture", gestureId: id, phase: "begin", kind: activeGesture.kind,
          point, modifiers: modifiers(event),
        });
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!activeGesture) {
          if (!mouseTracking() || event.shiftKey) return;
          const button = (event.buttons & 1) !== 0 ? "left" : (event.buttons & 4) !== 0
            ? "middle" : (event.buttons & 2) !== 0 ? "right" : "left";
          const rect = screen.getBoundingClientRect();
          event.preventDefault();
          void enqueuePointer({
            x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top),
            kind: event.buttons === 0 ? "move" : "drag", button, clickCount: 0,
            modifiers: modifiers(event),
          }).catch(() => {});
          return;
        }
        if ((event.buttons & 1) === 0) return;
        const rect = screen.getBoundingClientRect();
        const point = selectionPoint(event.clientX - rect.left, event.clientY - rect.top);
        if (!point) return;
        event.preventDefault();
        enqueueSelection({
          action: "gesture", gestureId: activeGesture.id, phase: "update", kind: activeGesture.kind,
          point, modifiers: modifiers(event),
        });
      };
      const onPointerUp = (event: PointerEvent) => {
        if (!activeGesture) {
          if (!mouseTracking() || event.shiftKey) return;
          const button = event.button === 0 ? "left" : event.button === 1 ? "middle"
            : event.button === 2 ? "right" : null;
          if (!button) return;
          const rect = screen.getBoundingClientRect();
          event.preventDefault();
          void enqueuePointer({
            x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top),
            kind: "up", button, clickCount: Math.max(1, event.detail), modifiers: modifiers(event),
          }).catch(() => {});
          return;
        }
        if (event.button !== 0) return;
        const gesture = activeGesture;
        activeGesture = null;
        const rect = screen.getBoundingClientRect();
        const point = selectionPoint(event.clientX - rect.left, event.clientY - rect.top);
        if (!point) return;
        event.preventDefault();
        enqueueSelection({
          action: "gesture", gestureId: gesture.id, phase: "end", kind: gesture.kind,
          point, modifiers: modifiers(event),
        });
      };
      const onPointerCancel = () => {
        if (!activeGesture) return;
        activeGesture = null;
        enqueueSelection({ action: "clear" });
      };
      let pointerSequence = 0;
      const enqueuePointer = (event: SurfacePointerInput, focusFirst = false): Promise<void> => enqueueSurfaceInput(async () => {
        const phase = event.kind === "down" ? "down" : event.kind === "up" ? "up"
          : event.kind === "move" || event.kind === "drag" ? "move" : null;
        if (!phase) return;
        if (focusFirst) {
          input.focus();
          await deliverFocus(true);
        }
        const reply = await deliver({
          verb: "pointer", point: { x: event.x, y: event.y }, phase,
          button: event.kind === "move" ? "none" : event.button,
          clickCount: event.clickCount, modifiers: event.modifiers,
        });
        if (reply.route !== "mouse-report" && reply.route !== "ignored") {
          throw new Error("surface.pointer returned no valid route");
        }
        const written = Number(reply.written);
        if (!Number.isSafeInteger(written) || written < 0) {
          throw new Error("surface.pointer returned no valid written count");
        }
        pointerSequence += 1;
        screen.dataset.pointerRoute = reply.route;
        screen.dataset.pointerWritten = String(written);
        screen.dataset.pointerSequence = String(pointerSequence);
        delete screen.dataset.pointerError;
      }, (error) => {
        screen.dataset.pointerError = String(error);
      });
      pointerInputByLabel.set(label, async (event) => {
        const grabbed = mouseTracking();
        if (grabbed && !event.modifiers.shift) {
          await enqueuePointer(event);
          return;
        }
        if (event.button !== "left") return;
        if (event.kind === "down") {
          if (state.modes === null) return;
          const point = selectionPoint(event.x, event.y);
          if (!point) return;
          const id = crypto.randomUUID();
          activeGesture = { id, kind: event.clickCount >= 3 ? "line" : event.clickCount === 2 ? "semantic" : "simple", pointerId: null };
          await enqueueSelection({
            action: "gesture", gestureId: id, phase: "begin", kind: activeGesture.kind,
            point, modifiers: event.modifiers,
          });
          return;
        }
        if (event.kind === "drag" && activeGesture) {
          const point = selectionPoint(event.x, event.y);
          if (!point) return;
          await enqueueSelection({
            action: "gesture", gestureId: activeGesture.id, phase: "update", kind: activeGesture.kind,
            point, modifiers: event.modifiers,
          });
          return;
        }
        if (event.kind === "up" && activeGesture) {
          const gesture = activeGesture;
          activeGesture = null;
          const point = selectionPoint(event.x, event.y);
          if (!point) return;
          await enqueueSelection({
            action: "gesture", gestureId: gesture.id, phase: "end", kind: gesture.kind,
            point, modifiers: event.modifiers,
          });
        }
      });
      let wheelSequence = 0;
      const enqueueWheel = (event: SurfaceWheelInput): Promise<void> => {
        return enqueueSurfaceInput(async () => {
            const reply = await deliver({
              verb: "wheel", point: { x: event.x, y: event.y },
              deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
              modifiers: event.modifiers,
            });
            const route = reply.route;
            if (route !== "scrollback" && route !== "mouse-report"
              && route !== "alternate-scroll" && route !== "ignored") {
              throw new Error("surface.wheel returned no valid route");
            }
            const written = Number(reply.written);
            if (!Number.isSafeInteger(written) || written < 0) {
              throw new Error("surface.wheel returned no valid written count");
            }
            ingest(reply);
            wheelSequence += 1;
            screen.dataset.wheelRoute = route;
            screen.dataset.wheelWritten = String(written);
            screen.dataset.wheelSequence = String(wheelSequence);
            delete screen.dataset.wheelError;
          }, (error) => {
          screen.dataset.wheelError = String(error);
        });
      };
      wheelInputByLabel.set(label, enqueueWheel);
      const onWheel = (event: WheelEvent) => {
        if (event.deltaX === 0 && event.deltaY === 0) return;
        const rect = screen.getBoundingClientRect();
        event.preventDefault();
        void enqueueWheel({
          x: Math.max(0, event.clientX - rect.left),
          y: Math.max(0, event.clientY - rect.top),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? "line" : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? "page" : "pixel",
          modifiers: {
            shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, meta: event.metaKey,
          },
        }).catch(() => {});
      };
      screen.addEventListener("pointerdown", onPointerDown);
      screen.addEventListener("pointermove", onPointerMove);
      screen.addEventListener("pointerup", onPointerUp);
      screen.addEventListener("pointercancel", onPointerCancel);
      screen.addEventListener("wheel", onWheel, { passive: false });
      let surfaceStateReady = false;
      let settleSurfaceReady!: (ready: boolean) => void;
      let surfaceReadySettled = false;
      const surfaceReady = new Promise<boolean>((resolve) => { settleSurfaceReady = resolve; });
      const settleReadiness = (ready: boolean) => {
        if (surfaceReadySettled) return;
        surfaceReadySettled = true;
        settleSurfaceReady(ready);
      };
      stateDoors.set(pane, (payload) => {
        const observation = logOf(label);
        observation.stateEvents += 1;
        observation.lastEvent = { ...payload };
        if (payload.generation !== generation) {
          observation.stateFailures += 1;
          observation.lastError = `terminal surface ${pane} event does not belong to generation ${generation}`;
          for (const listener of stateEventListeners) listener();
          return;
        }
        ingest(payload);
        // The event is the frame edge. Read the richer service-owned state once at that edge;
        // no timer or polling loop reconstructs cols/rows from the DOM.
        void deliver({ verb: "state" }).then((reply) => {
          observation.stateReads += 1;
          observation.lastRead = { ...reply };
          if (reply.generation !== generation || reply.phase !== "live"
            || !Number.isSafeInteger(reply.session) || Number(reply.session) < 1) {
            observation.stateFailures += 1;
            observation.lastError = `terminal surface ${pane} state does not belong to generation ${generation}`;
            return;
          }
          observation.lastError = null;
          ingest(reply);
          surfaceStateReady = true;
          settleReadiness(true);
          screen.dataset.surfaceReady = "true";
          void deliverFocus(document.activeElement === input).catch(() => {});
        }).catch((error) => {
          observation.stateFailures += 1;
          observation.lastError = String(error);
        }).finally(() => {
          for (const listener of stateEventListeners) listener();
        });
      });
      const readText = async (lines?: number): Promise<string> => {
        const reply = await deliver({ verb: "read", ...(typeof lines === "number" ? { lines } : {}) });
        if (typeof reply.text !== "string") throw new Error("surface.read returned no text");
        state.text = reply.text;
        if (typeof lines !== "number" || lines <= 0) return state.text;
        const rows = state.text.split("\n");
        return rows.slice(Math.max(0, rows.length - lines)).join("\n");
      };

      let disposed = false;
      const awaitSurfaceOwner = async () => {
        if (!surfaceStateReady && !await surfaceReady) {
          throw new Error(`terminal surface ${pane} was disposed before it became ready`);
        }
      };
      return {
        root: container,
        size: () => ({ cols: state.cols, rows: state.rows }),
        metrics: () => null,
        fit() {
          const next = box();
          const scale = document.defaultView?.devicePixelRatio ?? 1;
          // An unchanged box is not a resize. Re-sending it winds the pty
          // through SIGWINCH and the shell repaints its prompt every time.
          if (source.pixelW === String(next.width) && source.pixelH === String(next.height)
            && source.scale === String(scale)) return;
          source.pixelW = String(next.width);
          source.pixelH = String(next.height);
          source.scale = String(scale);
          if (declared) screen.setAttribute("data-native-source", JSON.stringify(source));
          // The declaration moves the layer; the verb moves the cells.
          void deliver({ verb: "resize", pixelW: next.width, pixelH: next.height, scale })
            .catch(() => {});
        },
        ready: awaitSurfaceOwner,
        sendText: async (data) => {
          await awaitSurfaceOwner();
          // Selection belongs to the engine grid. The first confirmed input after a copy must
          // retire that overlay before the PTY can mutate cells under it; otherwise row damage
          // repaints input while preserving stale selection colors over the previous frame.
          if (state.selection.active) {
            await enqueueSelection({ action: "clear" });
          }
          await deliver({ verb: "input", data });
        },
        renderedOutputSequence: () => state.sequence,
        themeStatus: () => cloneTerminalThemeStatus(state.theme),
        async setTheme(next) {
          const theme = surfaceThemeFromStatus(next);
          const reply = await deliver({ verb: "theme", theme });
          if (!terminalThemeStatus(reply)) {
            throw new Error("surface.theme returned no valid terminal theme state");
          }
          source.theme = JSON.stringify(theme);
          if (declared) screen.setAttribute("data-native-source", JSON.stringify(source));
          ingest(reply);
        },
        onPresentationChanged(callback) {
          presentationListeners.add(callback);
          return { dispose: () => void presentationListeners.delete(callback) };
        },
        read: readText,
        async selection() {
          await selectionQueue;
          const reply = await deliver({ verb: "selection", action: "read" });
          const selection = adoptSelection(reply);
          if (!selection) throw new Error("surface.selection returned no valid snapshot");
          return selection.text;
        },
        async waitForText(contains, timeoutMs) {
          return new Promise<string>((resolve, reject) => {
            let reading = false;
            let pending = false;
            let settled = false;
            const cleanup = () => {
              clearTimeout(deadline);
              stateEventListeners.delete(onState);
            };
            const finish = (answer: string) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(answer);
            };
            const fail = (error: unknown) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error);
            };
            const check = async () => {
              if (settled) return;
              if (reading) { pending = true; return; }
              reading = true;
              try {
                const text = await readText();
                if (text.includes(contains)) finish(text);
              } catch (error) {
                fail(error);
              } finally {
                reading = false;
                if (pending && !settled) { pending = false; void check(); }
              }
            };
            const onState = () => { if (surfaceStateReady) void check(); };
            const deadline = setTimeout(() => {
              fail(new Error(`TIMEOUT: ${JSON.stringify(contains)} did not appear within ${timeoutMs}ms`));
            }, Math.max(0, timeoutMs));
            stateEventListeners.add(onState);
            if (surfaceStateReady) void check();
          });
        },
        focus() {
          input.focus();
          return true;
        },
        setVisibility(next: TerminalVisibilityState) {
          const entry = logOf(label);
          entry.setVisibility += 1;
          entry.lastIntrinsicVisible = next.intrinsicVisible;
          entry.lastHostVisible = next.hostVisible;
          entry.lastEffectiveVisible = next.effectiveVisible;
          entry.seq.push({
            intrinsic: next.intrinsicVisible,
            host: next.hostVisible,
            effective: next.effectiveVisible,
            dim: next.dim,
            t: Date.now() % 1000000,
            n: ++shownEventCounter,
          });
          if (entry.seq.length > 24) entry.seq.shift();
          intrinsicVisible = next.intrinsicVisible;
          dim = next.dim;
          if (declared) writeDeclaration();
          else {
            screen.setAttribute("data-native-visible", String(next.intrinsicVisible));
            screen.setAttribute("data-native-alpha", String(1 - next.dim));
          }
        },
        scrollState: () => ({ offset: state.offset, historySize: state.historySize }),
        async scrollLines(lines) {
          ingest(await deliver({ verb: "scroll", lines }));
        },
        async scrollTo(offset) {
          ingest(await deliver({ verb: "scroll", offset }));
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          settleReadiness(false);
          stateDoors.delete(pane);
          stateEventListeners.clear();
          live.delete(label);
          labelByView.delete(pane.slice(0, pane.lastIndexOf(".")));
          focusInputByLabel.delete(label);
          pointerInputByLabel.delete(label);
          wheelInputByLabel.delete(label);
          input.removeEventListener("keydown", onKeydown);
          input.removeEventListener("compositionend", onCompositionEnd);
          input.removeEventListener("paste", onPaste);
          input.removeEventListener("focus", onInputFocus);
          input.removeEventListener("blur", onInputFocus);
          screen.removeEventListener("pointerdown", onPointerDown);
          screen.removeEventListener("pointermove", onPointerMove);
          screen.removeEventListener("pointerup", onPointerUp);
          screen.removeEventListener("pointercancel", onPointerCancel);
          screen.removeEventListener("wheel", onWheel);
          presentationListeners.clear();
          screen.remove();
          input.remove();
        },
      };
    },
  };
}
