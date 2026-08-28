// The surface presenter: it declares a native pane and delivers verbs to the
// service that owns it. It opens no session, attaches no stream and polls no
// frame — the pixels never pass through this process.
import {
  terminalNodeId,
  type TerminalPresenter,
  type TerminalPresenterOptions,
  type TerminalRendererAdapter,
} from "@soksak/soksak-kit-plugin-terminal";
import {
  SURFACE_KIND,
  nativeTerminalAttributes,
  primaryFontFamily,
  surfaceToken,
  windowOfLabel,
  type TerminalSurfaceSource,
} from "./surface";
import { readSurfaceTheme } from "./theme";

export interface SurfaceCapability {
  label(kind: string, viewId: string): string;
  deliver(label: string, message: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface SurfacePointerInput {
  x: number;
  y: number;
  kind: "down" | "up" | "move" | "drag" | "enter" | "exit";
  button: "left" | "right";
  clickCount: number;
}

export interface SurfaceApp {
  surface?: SurfaceCapability;
  provideSurfaceInput?(provider: {
    owns(label: string): boolean;
    sendInput(label: string, input: SurfacePointerInput): Promise<void>;
    inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
  }): () => void;
  settings?: { get(key: string): unknown };
  events?: {
    on(event: "terminal-surface.state", listener: (payload: { pane: string; sequence: number }) => void): { dispose(): void };
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
  selection: string;
  cursorRow: number;
  cursorColumn: number;
  cursorVisible: boolean;
  cursorShape: "block" | "underline" | "bar";
  cursorBlinking: boolean;
  cursorAnimation: { intervalMs: number; phase: "steady" | "on" | "off" };
}

/** Per-label counters a diagnostic command reads: what reached each presenter.
 *  seq keeps the LAST 24 events; n is a global order across every pane. */
export const shownLog = new Map<string, { setShown: number; lastShown: boolean; focus: number; declWrites: number; seq: Array<{ v: boolean; d: number; t: number; n: number }> }>();
let shownEventCounter = 0;
function logOf(label: string) {
  let entry = shownLog.get(label);
  if (!entry) { entry = { setShown: 0, lastShown: true, focus: 0, declWrites: 0, seq: [] }; shownLog.set(label, entry); }
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
  let pointerRegistered = false;
  const registerPointerProvider = (surface: SurfaceCapability) => {
    if (pointerRegistered || !app.provideSurfaceInput) return;
    pointerRegistered = true;
    app.provideSurfaceInput({
      owns: (label) => live.has(label),
      sendInput: (label, input) =>
        surface.deliver(label, { verb: "input", pointer: input as unknown as Record<string, unknown> }).then(() => undefined),
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
        theme: JSON.stringify(readSurfaceTheme(container)),
        shell: "",
      };
      const screen = document.createElement("div");
      screen.dataset.node = terminalNodeId("terminal-screen", options.nodeSuffix);
      // The native surface follows the pane's exact content geometry. Browser and terminal
      // declarations must not invent separate insets; the compositor compares both in the same
      // CSS coordinate space and any border belongs to the shared presentation layer.
      Object.assign(screen.style, { position: "absolute", inset: "0" });
      const generation = 1;
      let declared = false;
      // The declaration is the single owner of visible and alpha. dim is the
      // focus lighting the host reports (0..1), applied to the layer's own
      // alpha exactly as the browser plugin does — the document veil above the
      // layer cannot darken it.
      let shown = true;
      let dim = 0;
      const writeDeclaration = () => {
        logOf(label).declWrites += 1;
        for (const [name, value] of Object.entries(
          nativeTerminalAttributes({
            // All native surfaces share the compositor's default layer unless a contract owner
            // explicitly requests ordering. The browser surface uses 0; inventing 10 here made
            // terminal and browser presentation differ for no declared reason.
            id: label, generation, source, layer: 0,
            visible: shown, alpha: 1 - dim,
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
      // The native layer passes clicks through; the container is what the
      // click lands on, and the hidden textarea is where keys must go.
      const onMousedown = () => {
        input.focus();
        void deliver({ verb: "focus" }).catch(() => {});
      };
      container.addEventListener("mousedown", onMousedown);

      const state: SurfaceState = {
        sequence: null, cols: 0, rows: 0, offset: 0, historySize: 0, text: "", selection: "",
        cursorRow: 0, cursorColumn: 0, cursorVisible: false, cursorShape: "block",
        cursorBlinking: false, cursorAnimation: { intervalMs: 0, phase: "steady" },
      };
      const presentationListeners = new Set<() => void>();
      const syncCursorPresentation = () => {
        screen.dataset.cursorRow = String(state.cursorRow);
        screen.dataset.cursorColumn = String(state.cursorColumn);
        screen.dataset.cursorVisible = String(state.cursorVisible);
        screen.dataset.cursorShape = state.cursorShape;
        screen.dataset.cursorBlinking = String(state.cursorBlinking);
        screen.dataset.cursorAnimationIntervalMs = String(state.cursorAnimation.intervalMs);
        screen.dataset.cursorAnimationPhase = state.cursorAnimation.phase;
        screen.dataset.cursorActive = String(
          state.cursorVisible && state.cursorAnimation.phase !== "off" && document.activeElement === input,
        );
      };
      const onInputFocus = () => syncCursorPresentation();
      input.addEventListener("focus", onInputFocus);
      input.addEventListener("blur", onInputFocus);
      syncCursorPresentation();
      const ingest = (payload: Record<string, unknown>) => {
        if (typeof payload.sequence === "number") state.sequence = Math.max(state.sequence ?? 0, payload.sequence);
        if (typeof payload.cols === "number") state.cols = payload.cols;
        if (typeof payload.rows === "number") state.rows = payload.rows;
        if (typeof payload.offset === "number") state.offset = payload.offset;
        if (typeof payload.historySize === "number") state.historySize = payload.historySize;
        if (typeof payload.text === "string") state.text = payload.text;
        let cursorChanged = false;
        const setCursorNumber = (key: "cursorRow" | "cursorColumn", value: unknown) => {
          if (!Number.isSafeInteger(value) || Number(value) < 0 || state[key] === Number(value)) return;
          state[key] = Number(value);
          cursorChanged = true;
        };
        setCursorNumber("cursorRow", payload.cursorRow);
        setCursorNumber("cursorColumn", payload.cursorColumn);
        if (typeof payload.cursorVisible === "boolean" && state.cursorVisible !== payload.cursorVisible) {
          state.cursorVisible = payload.cursorVisible;
          cursorChanged = true;
        }
        if ((payload.cursorShape === "block" || payload.cursorShape === "underline" || payload.cursorShape === "bar")
          && state.cursorShape !== payload.cursorShape) {
          state.cursorShape = payload.cursorShape;
          cursorChanged = true;
        }
        if (typeof payload.cursorBlinking === "boolean" && state.cursorBlinking !== payload.cursorBlinking) {
          state.cursorBlinking = payload.cursorBlinking;
          cursorChanged = true;
        }
        const animation = payload.cursorAnimation;
        if (animation && typeof animation === "object") {
          const value = animation as { intervalMs?: unknown; phase?: unknown };
          if (Number.isFinite(value.intervalMs) && Number(value.intervalMs) >= 0
            && state.cursorAnimation.intervalMs !== Number(value.intervalMs)) {
            state.cursorAnimation.intervalMs = Number(value.intervalMs);
            cursorChanged = true;
          }
          if ((value.phase === "steady" || value.phase === "on" || value.phase === "off")
            && state.cursorAnimation.phase !== value.phase) {
            state.cursorAnimation.phase = value.phase;
            cursorChanged = true;
          }
        }
        if (cursorChanged) {
          syncCursorPresentation();
          for (const listener of presentationListeners) listener();
        }
      };
      stateDoors.set(pane, (payload) => {
        ingest(payload);
        // The event is the frame edge. Read the richer service-owned state once at that edge;
        // no timer or polling loop reconstructs cols/rows from the DOM.
        void deliver({ verb: "state" }).then(ingest).catch(() => {});
      });
      const refreshText = (lines?: number) =>
        deliver({ verb: "read", ...(typeof lines === "number" ? { lines } : {}) })
          .then((reply) => { if (typeof reply.text === "string") state.text = reply.text; })
          .catch(() => {});

      let disposed = false;
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
        sendText: (data) => deliver({ verb: "input", data }).then(() => undefined),
        renderedOutputSequence: () => state.sequence,
        onPresentationChanged(callback) {
          presentationListeners.add(callback);
          return { dispose: () => void presentationListeners.delete(callback) };
        },
        read(lines) {
          void refreshText(lines);
          if (typeof lines !== "number" || lines <= 0) return state.text;
          const rows = state.text.split("\n");
          return rows.slice(Math.max(0, rows.length - lines)).join("\n");
        },
        selection() {
          void deliver({ verb: "selection" })
            .then((reply) => { if (typeof reply.text === "string") state.selection = reply.text; })
            .catch(() => {});
          return state.selection;
        },
        async waitForText(contains, timeoutMs) {
          const until = Date.now() + Math.max(0, timeoutMs);
          for (;;) {
            await refreshText();
            if (state.text.includes(contains)) return state.text;
            if (Date.now() >= until) {
              throw new Error(`TIMEOUT: ${JSON.stringify(contains)} did not appear within ${timeoutMs}ms`);
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        },
        focus() {
          input.focus();
          void deliver({ verb: "focus" }).catch(() => {});
          return true;
        },
        setShown(next: boolean, dimNext = 0) {
          const entry = logOf(label);
          entry.setShown += 1;
          entry.lastShown = next;
          entry.seq.push({ v: next, d: dimNext, t: Date.now() % 1000000, n: ++shownEventCounter });
          if (entry.seq.length > 24) entry.seq.shift();
          // visible hides the layer for an overlay's time; dim darkens it while
          // it stays shown but unfocused. Both live in the one declaration.
          shown = next;
          dim = dimNext;
          if (declared) writeDeclaration();
          else {
            screen.setAttribute("data-native-visible", String(next));
            screen.setAttribute("data-native-alpha", String(1 - dimNext));
          }
        },
        scrollState: () => ({ offset: state.offset, historySize: state.historySize }),
        scrollLines(lines) {
          void deliver({ verb: "scroll", lines }).then(ingest).catch(() => {});
        },
        scrollTo(offset) {
          state.offset = offset;
          void deliver({ verb: "scroll", offset }).then(ingest).catch(() => {});
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          stateDoors.delete(pane);
          live.delete(label);
          input.removeEventListener("keydown", onKeydown);
          input.removeEventListener("compositionend", onCompositionEnd);
          input.removeEventListener("paste", onPaste);
          input.removeEventListener("focus", onInputFocus);
          input.removeEventListener("blur", onInputFocus);
          container.removeEventListener("mousedown", onMousedown);
          presentationListeners.clear();
          screen.remove();
          input.remove();
          void deliver({ verb: "stop", intent: "detach" }).catch(() => {});
        },
      };
    },
  };
}
