// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  emptyTerminalThemeOverrides, resolveTerminalTheme, TERMINAL_ANSI_PALETTE,
} from "@soksak/soksak-contract-plugin-terminal";
import {
  createVisionRenderer,
  encodeProxyKey,
  ingestTerminalSurfaceState,
  shownLog,
  type SurfaceApp,
} from "./presenter";

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.dataset.themeMode = "dark";

interface Delivered { label: string; message: Record<string, unknown> }

const ownedState = (value: Record<string, unknown> = {}) => ({
  generation: 7, phase: "live", session: 1, ...value,
});

function fakeApp(overrides: Partial<SurfaceApp> = {}) {
  const delivered: Delivered[] = [];
  const providers: Parameters<NonNullable<SurfaceApp["provideSurfaceInput"]>>[0][] = [];
  const app: SurfaceApp & { commands?: { execute?(name: string, args: Record<string, unknown>): Promise<unknown> } } = {
    surface: {
      label: (kind, viewId) => `${kind}.win-test.${viewId}`,
      deliver: async (label, message) => {
        delivered.push({ label, message });
        if (message.verb === "read") return { text: "ready\n$ " };
        if (message.verb === "selection") return {
          active: false, text: "", kind: null, anchor: null, focus: null,
          gestureId: null, sequence: 0,
        };
        if (message.verb === "focus") return {
          focused: message.focused === true,
          cursorPresentation: message.focused === true ? "engine" : "hollow-block",
        };
        if (message.verb === "state") return {
          generation: 7, phase: "live", session: 1, sequence: 3, cols: 80, rows: 24,
        };
        return {};
      },
    },
    provideSurfaceInput: (provider) => {
      providers.push(provider);
      return () => {};
    },
    settings: { get: () => undefined },
    commands: { execute: async (name: string) => (name === "app.environment" ? { loginShell: "/bin/zsh" } : {}) },
    ...overrides,
  };
  return { app, delivered, providers };
}

const options = {
  nodeSuffix: "1",
  containerGeneration: 7,
  hostPixels: () => ({ width: 640, height: 384 }),
  requestViewport: () => {},
};

describe("the vision surface presenter", () => {
  it("declares one native pane under the terminal kind with a complete source", async () => {
    const { app } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.2", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const screen = container.querySelector('[data-native-surface="terminal"]');
    expect(screen).not.toBeNull();
    expect(screen!.getAttribute("data-native-surface-id")).toBe("terminal.win-test.tab-a-2");
    expect(screen!.getAttribute("data-native-generation")).toBe("7");
    const source = JSON.parse(screen!.getAttribute("data-native-source")!);
    expect(source.pane).toBe("tab-a.2");
    expect(source.window).toBe("win-test");
    expect(source.ptyUnit).toBe("soksak-sidecar-pty");
    expect(source.engineUnit).toBe("soksak-sidecar-terminal-alacritty");
    expect(source.pixelW).toBe("640");
    expect(source.pixelH).toBe("384");
    expect(source.fontPt).toBe("13");
    expect(source.shell).toBe("/bin/zsh");
    expect(screen!.getAttribute("data-native-layer")).toBe("0");
    expect((screen as HTMLElement).style.inset).toBe("0px");
    expect(JSON.parse(source.theme)).toMatchObject({ mode: "dark", ansi: expect.any(Array) });
    expect(JSON.parse(source.theme).ansi).toHaveLength(256);
    expect(source).not.toHaveProperty("cols");
    presenter.dispose();
  });

  it("honors the engine setting when it names an offered engine", async () => {
    const { app } = fakeApp({ settings: { get: (key) => (key === "engine" ? "vt100" : undefined) } });
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const source = JSON.parse(container.querySelector("[data-native-source]")!.getAttribute("data-native-source")!);
    expect(source.engineUnit).toBe("soksak-sidecar-terminal-vt100");
    presenter.dispose();
  });

  it("maps every presenter door onto its deliver verb", async () => {
    const { app, delivered } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 1, generation: 7 })).toBe(true);
    await presenter.sendText!("ls\r");
    presenter.read(4);
    presenter.focus();
    presenter.scrollTo!(5);
    presenter.scrollLines!(-3);
    await presenter.selection!();
    presenter.dispose();
    await Promise.resolve();
    const verbs = delivered.map((entry) => entry.message.verb);
    expect(delivered.find((entry) => entry.message.verb === "input")).toEqual({
      label: "terminal.win-test.tab-a-1",
      message: { verb: "input", data: "ls\r" },
    });
    expect(verbs).toContain("read");
    expect(verbs).toContain("focus");
    expect(verbs).toContain("selection");
    expect(delivered.find((entry) => entry.message.verb === "scroll" && entry.message.offset === 5)).toBeTruthy();
    expect(delivered.find((entry) => entry.message.verb === "scroll" && entry.message.lines === -3)).toBeTruthy();
    expect(delivered.at(-1)!.message).toEqual({ verb: "stop", intent: "detach" });
  });

  it("awaits the native read and returns the requested trailing lines", async () => {
    const { app } = fakeApp();
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-a.1", () => {}, options,
    );
    await expect(presenter.read(1)).resolves.toBe("$ ");
    presenter.dispose();
  });

  it("awaits the native selection reply instead of returning stale presenter state", async () => {
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => message.verb === "selection"
          ? {
              active: true, text: "native selection", kind: "simple", gestureId: "sel-1",
              anchor: { row: 0, col: 0, side: "left" },
              focus: { row: 0, col: 5, side: "right" }, sequence: 1,
            }
          : {},
      },
    });
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await expect(Promise.resolve(presenter.selection?.())).resolves.toBe("native selection");
    presenter.dispose();
  });

  it("awaits the native scroll reply before publishing the new viewport", async () => {
    let releaseScroll!: () => void;
    const held = new Promise<void>((resolve) => { releaseScroll = resolve; });
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "state") return ownedState({ sequence: 1, cols: 10, rows: 5, offset: 0, historySize: 20 });
          if (message.verb === "scroll") {
            await held;
            return { sequence: 2, cols: 10, rows: 5, offset: 5, historySize: 20 };
          }
          if (message.verb === "focus") return { focused: message.focused, cursorPresentation: "engine" };
          return {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-scroll.1", () => {}, options,
    );
    expect(ingestTerminalSurfaceState({ pane: "tab-scroll.1", sequence: 1, generation: 7 })).toBe(true);
    await vi.waitFor(() => expect(presenter.scrollState?.()).toEqual({ offset: 0, historySize: 20 }));
    const moving = presenter.scrollLines?.(5);
    expect(moving).toBeInstanceOf(Promise);
    expect(presenter.scrollState?.()).toEqual({ offset: 0, historySize: 20 });
    releaseScroll();
    await moving;
    expect(presenter.scrollState?.()).toEqual({ offset: 5, historySize: 20 });
    presenter.dispose();
  });

  it("waits for text from surface state events without polling", async () => {
    let text = "";
    let reads = 0;
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "read") { reads += 1; return { text }; }
          if (message.verb === "state") return ownedState({ sequence: 1, cols: 80, rows: 24 });
          return {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-a.1", () => {}, options,
    );
    const waiting = presenter.waitForText("READY", 1000);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reads).toBe(0);
    text = "READY";
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 2, generation: 7 })).toBe(true);
    await expect(waiting).resolves.toBe("READY");
    expect(reads).toBe(1);
    presenter.dispose();
  });

  it("does not read before the first native surface state event", async () => {
    let ready = false;
    let reads = 0;
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "state") {
            ready = true;
            return ownedState({ sequence: 1, cols: 80, rows: 24 });
          }
          if (message.verb === "read") {
            reads += 1;
            if (!ready) throw new Error("NOT_FOUND: surface is not open yet");
            return { text: "READY" };
          }
          return {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-ready.1", () => {}, options,
    );
    const waiting = presenter.waitForText("READY", 1000);
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(ingestTerminalSurfaceState({ pane: "tab-ready.1", sequence: 1, generation: 7 })).toBe(true);
    await expect(waiting).resolves.toBe("READY");
    expect(reads).toBe(1);
    presenter.dispose();
  });

  it("holds input until the first native surface state event", async () => {
    const inputs: string[] = [];
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "state") return ownedState({ sequence: 1, cols: 80, rows: 24 });
          if (message.verb === "input") inputs.push(String(message.data));
          return {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-input-ready.1", () => {}, options,
    );
    const sent = presenter.sendText!("typed-before-ready");
    await Promise.resolve();
    expect(inputs).toEqual([]);
    expect(ingestTerminalSurfaceState({ pane: "tab-input-ready.1", sequence: 1, generation: 7 })).toBe(true);
    await sent;
    expect(inputs).toEqual(["typed-before-ready"]);
    presenter.dispose();
  });

  it("does not let an older native generation satisfy readiness", async () => {
    let generation = 6;
    const inputs: string[] = [];
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "state") return {
            generation, phase: "live", session: 1, sequence: 1, cols: 80, rows: 24,
          };
          if (message.verb === "input") inputs.push(String(message.data));
          return {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-generation.1", () => {}, options,
    );
    const sent = presenter.sendText!("owned-generation");
    expect(ingestTerminalSurfaceState({ pane: "tab-generation.1", sequence: 1, generation: 6 })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(inputs).toEqual([]);
    generation = 7;
    expect(ingestTerminalSurfaceState({ pane: "tab-generation.1", sequence: 2, generation: 7 })).toBe(true);
    await sent;
    expect(inputs).toEqual(["owned-generation"]);
    presenter.dispose();
  });

  it("reads the rendered sequence from the state push, not from a counter", async () => {
    const { app } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(presenter.renderedOutputSequence!()).toBeNull();
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 9, generation: 7, cols: 120, rows: 30 })).toBe(true);
    expect(presenter.renderedOutputSequence!()).toBe(9);
    expect(presenter.size()).toEqual({ cols: 120, rows: 30 });
    presenter.dispose();
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 10, generation: 7 })).toBe(false);
  });

  it("declares only intrinsic pane visibility and keeps host presentation on its separate axis", async () => {
    const { app } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    const screen = container.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    await vi.waitFor(() => expect(screen.dataset.nativeSurface).toBe("terminal"));
    const setVisibility = (presenter as typeof presenter & {
      setVisibility?(value: {
        intrinsicVisible: boolean; hostVisible: boolean; effectiveVisible: boolean; dim: number;
      }): void;
    }).setVisibility;
    expect(setVisibility).toBeTypeOf("function");

    // Core hides the whole view through the ancestor. Repeating that false in this declaration
    // would veto the compositor's pre-DOM target stage.
    setVisibility?.({ intrinsicVisible: true, hostVisible: false, effectiveVisible: false, dim: 0.5 });
    expect(screen.dataset.nativeVisible).toBe("true");
    expect(screen.dataset.nativeAlpha).toBe("0.5");

    // Workbench maximize is intrinsic: that pane's native member itself must be hidden.
    setVisibility?.({ intrinsicVisible: false, hostVisible: true, effectiveVisible: false, dim: 0 });
    expect(screen.dataset.nativeVisible).toBe("false");
    presenter.dispose();
  });

  it("publishes the engine cursor state through the terminal screen", async () => {
    shownLog.clear();
    let phase: "on" | "off" = "off";
    const focuses: boolean[] = [];
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "focus") {
            focuses.push(message.focused === true);
            return {
              focused: message.focused === true,
              cursorPresentation: message.focused === true ? "engine" : "hollow-block",
            };
          }
          return message.verb === "state" ? ownedState({
            sequence: 9, cols: 120, rows: 30,
            cursorRow: 3, cursorColumn: 7, cursorVisible: true,
            cursorShape: "bar", cursorBlinking: true,
            cursorAnimation: { intervalMs: 750, phase },
          }) : {};
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    const changed = vi.fn();
    const presentation = presenter as typeof presenter & {
      onPresentationChanged(callback: () => void): { dispose(): void };
    };
    expect(typeof presentation.onPresentationChanged).toBe("function");
    const subscription = presentation.onPresentationChanged(changed);
    const input = container.querySelector("textarea")!;
    input.focus();
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 9, generation: 7 })).toBe(true);
    const screen = container.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    await vi.waitFor(() => expect(screen.dataset.cursorShape).toBe("bar"));
    expect(shownLog.get("terminal.win-test.tab-a-1")).toMatchObject({
      stateEvents: 1,
      stateReads: 1,
      stateFailures: 0,
      lastRead: { cursorShape: "bar", cursorVisible: true },
    });
    expect(screen.dataset).toMatchObject({
      cursorRow: "3", cursorColumn: "7", cursorVisible: "true",
      cursorShape: "bar", cursorBlinking: "true",
      cursorAnimationIntervalMs: "750", cursorAnimationPhase: "off",
      cursorActive: "false",
    });
    phase = "on";
    ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 10, generation: 7 });
    await vi.waitFor(() => expect(screen.dataset.cursorAnimationPhase).toBe("on"));
    expect(screen.dataset.cursorActive).toBe("true");
    expect(changed).toHaveBeenCalled();
    input.blur();
    expect(screen.dataset.cursorActive).toBe("false");
    await vi.waitFor(() => expect(focuses).toEqual([true, false]));
    subscription.dispose();
    presenter.dispose();
    container.remove();
  });

  it("forwards a complete host theme and exposes the applied engine state", async () => {
    const terminalOverrides = emptyTerminalThemeOverrides();
    terminalOverrides.foreground = "#abcdef";
    const baseTheme = {
      foreground: "#202020", background: "#f0f0f0", cursor: "#303030",
      cursorAccent: "#f0f0f0", selectionBackground: "#c0c0c0",
      ansi: [...TERMINAL_ANSI_PALETTE],
    };
    const applied = {
      themeMode: "light" as const, baseTheme, terminalOverrides,
      effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
    };
    const themeMessages: Record<string, unknown>[] = [];
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          themeMessages.push(message);
          return message.verb === "theme" ? applied : {};
        },
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-a.1", () => {}, options,
    ) as ReturnType<ReturnType<typeof createVisionRenderer>["create"]> & {
      themeStatus(): typeof applied;
      setTheme(status: typeof applied): Promise<void>;
    };
    expect(typeof presenter.themeStatus).toBe("function");
    expect(typeof presenter.setTheme).toBe("function");
    await presenter.setTheme(applied);
    expect(themeMessages.find((message) => message.verb === "theme"))
      .toMatchObject({ verb: "theme", theme: { mode: "light", fg: "#202020", bg: "#f0f0f0" } });
    expect(presenter.themeStatus()).toEqual(applied);
    presenter.dispose();
  });

  it("accepts an engine theme by field values regardless of JSON property order", async () => {
    const terminalOverrides = emptyTerminalThemeOverrides();
    terminalOverrides.background = "#234567";
    const baseTheme = {
      foreground: "#eeeeee", background: "#111111", cursor: "#ffffff",
      cursorAccent: "#111111", selectionBackground: "#555555",
      ansi: [...TERMINAL_ANSI_PALETTE],
    };
    const expected = resolveTerminalTheme(baseTheme, terminalOverrides);
    const reorderedEffective = {
      ansi: expected.ansi, selectionBackground: expected.selectionBackground,
      foreground: expected.foreground, cursorAccent: expected.cursorAccent,
      background: expected.background, cursor: expected.cursor,
    };
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => message.verb === "state" ? ownedState({
          themeMode: "dark", baseTheme, terminalOverrides, effectiveTheme: reorderedEffective,
        }) : {},
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-order.1", () => {}, options,
    ) as ReturnType<ReturnType<typeof createVisionRenderer>["create"]> & {
      themeStatus(): { terminalOverrides: { background: string | null } };
    };
    expect(ingestTerminalSurfaceState({ pane: "tab-order.1", sequence: 1, generation: 7 })).toBe(true);
    await vi.waitFor(() => expect(presenter.themeStatus().terminalOverrides.background).toBe("#234567"));
    presenter.dispose();
  });

  it("refuses an undeclared host theme mode instead of using a fallback", () => {
    const mode = document.documentElement.dataset.themeMode;
    delete document.documentElement.dataset.themeMode;
    const { app } = fakeApp();
    expect(() => createVisionRenderer(app).create(
      document.createElement("div"), "tab-a.1", () => {}, options,
    )).toThrow(/theme mode/);
    document.documentElement.dataset.themeMode = mode ?? "dark";
  });

  it("owns its labels for pointer input while the pane lives", async () => {
    const { app, providers } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(providers).toHaveLength(1);
    expect(providers[0].owns("terminal.win-test.tab-a-1")).toBe(true);
    expect(providers[0].labelOfView?.("tab-a")).toBe("terminal.win-test.tab-a-1");
    expect(providers[0].owns("terminal.win-test.tab-zz-9")).toBe(false);
    presenter.dispose();
    expect(providers[0].owns("terminal.win-test.tab-a-1")).toBe(false);
    expect(providers[0].labelOfView?.("tab-a")).toBeNull();
  });

  it("focuses the terminal input on native pointer down before the next typed key", async () => {
    const send = vi.fn();
    const { app, providers } = fakeApp();
    const container = document.createElement("div");
    document.body.append(container);
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", send, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = container.querySelector("textarea")!;
    expect(document.activeElement).not.toBe(input);
    await providers[0].sendInput("terminal.win-test.tab-a-1", {
      x: 10, y: 12, kind: "down", button: "left", clickCount: 1,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    expect(send).toHaveBeenCalledWith("a");
    presenter.dispose();
    container.remove();
  });

  it("routes the native surface drag through the same engine selection transaction", async () => {
    const messages: Record<string, unknown>[] = [];
    let selectionSequence = 0;
    const { app, providers } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          messages.push(message);
          if (message.verb === "state") return ownedState({
            sequence: 1, cols: 10, rows: 5,
            modes: {
              mouseClick: false, mouseDrag: false, mouseMotion: false,
              sgrMouse: false, utf8Mouse: false, alternateScroll: false,
            },
          });
          if (message.verb === "selection") {
            selectionSequence += 1;
            return {
              active: true, text: "native-dragged", kind: "simple", gestureId: message.gestureId,
              anchor: message.point, focus: message.point, sequence: selectionSequence,
            };
          }
          return {};
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const presenter = createVisionRenderer(app).create(container, "tab-native-drag.1", () => {}, options);
    expect(ingestTerminalSurfaceState({ pane: "tab-native-drag.1", sequence: 1, generation: 7 })).toBe(true);
    const screen = container.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    screen.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50,
      width: 100, height: 50, toJSON: () => ({}),
    });
    await vi.waitFor(() => expect(screen.dataset.surfaceReady).toBe("true"));

    await providers[0].sendInput("terminal.win-test.tab-native-drag-1", {
      x: 15, y: 15, kind: "down", button: "left", clickCount: 1,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await providers[0].sendInput("terminal.win-test.tab-native-drag-1", {
      x: 45, y: 15, kind: "drag", button: "left", clickCount: 0,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await providers[0].sendInput("terminal.win-test.tab-native-drag-1", {
      x: 45, y: 15, kind: "up", button: "left", clickCount: 1,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    const focuses = messages.filter((message) => message.verb === "focus");
    expect(focuses).toContainEqual({ verb: "focus", focused: true });
    expect(focuses.every((message) => typeof message.focused === "boolean")).toBe(true);
    await vi.waitFor(() => expect(messages.filter((message) => message.verb === "selection")).toHaveLength(3));
    const selection = messages.filter((message) => message.verb === "selection");
    expect(selection.map((message) => message.phase)).toEqual(["begin", "update", "end"]);
    expect(selection.map((message) => message.point)).toEqual([
      { row: 1, col: 1, side: "right" },
      { row: 1, col: 4, side: "right" },
      { row: 1, col: 4, side: "right" },
    ]);
    expect(new Set(selection.map((message) => message.gestureId)).size).toBe(1);
    presenter.dispose();
    container.remove();
  });

  it("routes owner wheel input through the native engine surface", async () => {
    const messages: Record<string, unknown>[] = [];
    const { app, providers } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          messages.push(message);
          if (message.verb === "state") return ownedState({ sequence: 1, cols: 10, rows: 5 });
          if (message.verb === "wheel") return {
            route: "scrollback", offset: 2, historySize: 20, written: 0,
          };
          return {};
        },
      },
    });
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-wheel.1", () => {}, options);
    expect(ingestTerminalSurfaceState({ pane: "tab-wheel.1", sequence: 1, generation: 7 })).toBe(true);
    const screen = container.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    await vi.waitFor(() => expect(screen.dataset.surfaceReady).toBe("true"));
    await providers[0].sendWheel("terminal.win-test.tab-wheel-1", {
      x: 12, y: 24, deltaX: 0, deltaY: -2, deltaMode: "line",
      modifiers: { shift: true, alt: false, control: false, meta: false },
    });
    expect(messages.find((message) => message.verb === "wheel")).toEqual({
      verb: "wheel", point: { x: 12, y: 24 }, deltaX: 0, deltaY: -2, deltaMode: "line",
      modifiers: { shift: true, alt: false, control: false, meta: false },
    });
    expect(screen.dataset.wheelRoute).toBe("scrollback");
    expect(screen.dataset.wheelSequence).toBe("1");
    screen.getBoundingClientRect = () => ({
      x: 5, y: 10, left: 5, top: 10, right: 105, bottom: 60,
      width: 100, height: 50, toJSON: () => ({}),
    });
    screen.dispatchEvent(new WheelEvent("wheel", {
      clientX: 17, clientY: 34, deltaX: 0, deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE,
      ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await vi.waitFor(() => expect(screen.dataset.wheelSequence).toBe("2"));
    expect(messages.filter((message) => message.verb === "wheel").at(-1)).toEqual({
      verb: "wheel", point: { x: 12, y: 24 }, deltaX: 0, deltaY: 3, deltaMode: "line",
      modifiers: { shift: false, alt: false, control: true, meta: false },
    });
    presenter.dispose();
  });

  it("keeps pointer and wheel delivery in one chronological input queue", async () => {
    const order: string[] = [];
    let releasePointer!: () => void;
    const pointerHeld = new Promise<void>((resolve) => { releasePointer = resolve; });
    const { app, providers } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "state") return ownedState({
            sequence: 1, cols: 10, rows: 5,
            modes: {
              mouseClick: true, mouseDrag: true, mouseMotion: false,
              sgrMouse: true, utf8Mouse: false, alternateScroll: false,
            },
          });
          if (message.verb === "pointer") {
            order.push("pointer:start");
            await pointerHeld;
            order.push("pointer:end");
            return { route: "mouse-report", written: 8 };
          }
          if (message.verb === "wheel") {
            order.push("wheel");
            return { route: "mouse-report", offset: 0, historySize: 0, written: 6 };
          }
          return {};
        },
      },
    });
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-input-order.1", () => {}, options);
    expect(ingestTerminalSurfaceState({ pane: "tab-input-order.1", sequence: 1, generation: 7 })).toBe(true);
    await vi.waitFor(() => expect(container.querySelector<HTMLElement>("[data-native-surface]")!
      .dataset.mouseTracking).toBe("true"));
    const pointer = providers[0].sendInput("terminal.win-test.tab-input-order-1", {
      x: 12, y: 24, kind: "drag", button: "left", clickCount: 0,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await vi.waitFor(() => expect(order).toEqual(["pointer:start"]));
    const wheel = providers[0].sendWheel("terminal.win-test.tab-input-order-1", {
      x: 12, y: 24, deltaX: 0, deltaY: -1, deltaMode: "line",
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await Promise.resolve();
    expect(order).toEqual(["pointer:start"]);
    releasePointer();
    await Promise.all([pointer, wheel]);
    expect(order).toEqual(["pointer:start", "pointer:end", "wheel"]);
    presenter.dispose();
  });

  it("serializes an ungrabbed pointer drag into exact cell selection gestures", async () => {
    const messages: Record<string, unknown>[] = [];
    let selectionSequence = 0;
    let grabbed = false;
    const { app, providers } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          messages.push(message);
          if (message.verb === "state") return ownedState({
            sequence: 1, cols: 10, rows: 5,
            modes: {
              mouseClick: grabbed, mouseDrag: grabbed, mouseMotion: false,
              sgrMouse: false, utf8Mouse: false, alternateScroll: false,
            },
          });
          if (message.verb === "selection") {
            selectionSequence += 1;
            return {
              active: true, text: "dragged", kind: "simple", gestureId: message.gestureId,
              anchor: message.point, focus: message.point, sequence: selectionSequence,
            };
          }
          if (message.verb === "pointer") return { route: "mouse-report", written: 8 };
          if (message.verb === "focus") return {
            focused: message.focused,
            cursorPresentation: message.focused ? "engine" : "hollow-block",
          };
          return {};
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const presenter = createVisionRenderer(app).create(container, "tab-drag.1", () => {}, options);
    const screen = container.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    screen.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50,
      width: 100, height: 50, toJSON: () => ({}),
    });
    expect(ingestTerminalSurfaceState({ pane: "tab-drag.1", sequence: 1, generation: 7 })).toBe(true);
    await vi.waitFor(() => expect(screen.dataset.surfaceReady).toBe("true"));
    const fire = (type: string, x: number, buttons: number, shiftKey = false) => screen.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: 15, button: 0, buttons, detail: 1, shiftKey, bubbles: true, cancelable: true,
    }));
    fire("pointerdown", 15, 1);
    fire("pointermove", 45, 1);
    fire("pointerup", 45, 0);
    await vi.waitFor(() => expect(messages.filter((message) => message.verb === "selection")).toHaveLength(3));
    const selection = messages.filter((message) => message.verb === "selection");
    expect(selection.map((message) => message.phase)).toEqual(["begin", "update", "end"]);
    expect(selection.map((message) => message.point)).toEqual([
      { row: 1, col: 1, side: "right" },
      { row: 1, col: 4, side: "right" },
      { row: 1, col: 4, side: "right" },
    ]);
    expect(new Set(selection.map((message) => message.gestureId)).size).toBe(1);

    grabbed = true;
    expect(ingestTerminalSurfaceState({ pane: "tab-drag.1", sequence: 2, generation: 7 })).toBe(true);
    await vi.waitFor(() => expect(screen.dataset.mouseTracking).toBe("true"));
    messages.length = 0;
    fire("pointerdown", 15, 1);
    fire("pointermove", 45, 1);
    fire("pointerup", 45, 0);
    await vi.waitFor(() => expect(messages.filter((message) => message.verb === "pointer")).toHaveLength(3));
    expect(messages.filter((message) => message.verb === "selection")).toHaveLength(0);
    expect(messages.filter((message) => message.verb === "pointer").map((message) => message.phase))
      .toEqual(["down", "move", "up"]);
    expect(screen.dataset.pointerSequence).toBe("3");
    messages.length = 0;
    await providers[0].sendInput("terminal.win-test.tab-drag-1", {
      x: 15, y: 15, kind: "down", button: "left", clickCount: 1,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await providers[0].sendInput("terminal.win-test.tab-drag-1", {
      x: 45, y: 15, kind: "drag", button: "left", clickCount: 0,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await providers[0].sendInput("terminal.win-test.tab-drag-1", {
      x: 45, y: 15, kind: "up", button: "left", clickCount: 1,
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
    await vi.waitFor(() => expect(messages.filter((message) => message.verb === "pointer")).toHaveLength(3));
    expect(messages.filter((message) => message.verb === "pointer")).toEqual([
      { verb: "pointer", point: { x: 15, y: 15 }, phase: "down", button: "left", clickCount: 1,
        modifiers: { shift: false, alt: false, control: false, meta: false } },
      { verb: "pointer", point: { x: 45, y: 15 }, phase: "move", button: "left", clickCount: 0,
        modifiers: { shift: false, alt: false, control: false, meta: false } },
      { verb: "pointer", point: { x: 45, y: 15 }, phase: "up", button: "left", clickCount: 1,
        modifiers: { shift: false, alt: false, control: false, meta: false } },
    ]);
    expect(screen.dataset.pointerSequence).toBe("6");
    fire("pointerdown", 15, 1, true);
    fire("pointerup", 45, 0, true);
    await vi.waitFor(() => expect(messages.filter((message) => message.verb === "selection")).toHaveLength(2));
    presenter.dispose();
    container.remove();
  });

  it("routes typed keys to the pane and leaves shortcuts alone", async () => {
    const send = vi.fn();
    const { app } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", send, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = container.querySelector("textarea")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(send).toHaveBeenNthCalledWith(1, "a");
    expect(send).toHaveBeenNthCalledWith(2, "\r");
    expect(encodeProxyKey({ key: "c", ctrlKey: true, altKey: false, metaKey: false, isComposing: false })).toBe("\x03");
    expect(encodeProxyKey({ key: "v", ctrlKey: false, altKey: false, metaKey: true, isComposing: false })).toBeNull();
    presenter.dispose();
  });

  it("refuses by name when the surface capability is absent", async () => {
    const { app } = fakeApp({ surface: undefined });
    const container = document.createElement("div");
    expect(() => createVisionRenderer(app).create(container, "tab-a.1", () => {}, options))
      .toThrow(/SURFACE_CAPABILITY_ABSENT/);
  });
});
