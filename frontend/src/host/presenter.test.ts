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

function fakeApp(overrides: Partial<SurfaceApp> = {}) {
  const delivered: Delivered[] = [];
  const providers: Parameters<NonNullable<SurfaceApp["provideSurfaceInput"]>>[0][] = [];
  const app: SurfaceApp & { commands?: { execute?(name: string, args: Record<string, unknown>): Promise<unknown> } } = {
    surface: {
      label: (kind, viewId) => `${kind}.win-test.${viewId}`,
      deliver: async (label, message) => {
        delivered.push({ label, message });
        if (message.verb === "read") return { text: "ready\n$ " };
        if (message.verb === "state") return { sequence: 3, cols: 80, rows: 24 };
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
    await presenter.sendText!("ls\r");
    presenter.read(4);
    presenter.focus();
    presenter.scrollTo!(5);
    presenter.scrollLines!(-3);
    presenter.selection!();
    presenter.dispose();
    await Promise.resolve();
    const verbs = delivered.map((entry) => entry.message.verb);
    expect(delivered[0]).toEqual({
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

  it("waits for text from surface state events without polling", async () => {
    let text = "";
    let reads = 0;
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => {
          if (message.verb === "read") { reads += 1; return { text }; }
          if (message.verb === "state") return { sequence: 1, cols: 80, rows: 24 };
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
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 2 })).toBe(true);
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
            return { sequence: 1, cols: 80, rows: 24 };
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
    expect(ingestTerminalSurfaceState({ pane: "tab-ready.1", sequence: 1 })).toBe(true);
    await expect(waiting).resolves.toBe("READY");
    expect(reads).toBe(1);
    presenter.dispose();
  });

  it("reads the rendered sequence from the state push, not from a counter", async () => {
    const { app } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(presenter.renderedOutputSequence!()).toBeNull();
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 9, cols: 120, rows: 30 })).toBe(true);
    expect(presenter.renderedOutputSequence!()).toBe(9);
    expect(presenter.size()).toEqual({ cols: 120, rows: 30 });
    presenter.dispose();
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 10 })).toBe(false);
  });

  it("publishes the engine cursor state through the terminal screen", async () => {
    shownLog.clear();
    let phase: "on" | "off" = "off";
    const { app } = fakeApp({
      surface: {
        label: (kind, viewId) => `${kind}.win-test.${viewId}`,
        deliver: async (_label, message) => message.verb === "state" ? {
          sequence: 9, cols: 120, rows: 30,
          cursorRow: 3, cursorColumn: 7, cursorVisible: true,
          cursorShape: "bar", cursorBlinking: true,
          cursorAnimation: { intervalMs: 750, phase },
        } : {},
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
    expect(ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 9 })).toBe(true);
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
    ingestTerminalSurfaceState({ pane: "tab-a.1", sequence: 10 });
    await vi.waitFor(() => expect(screen.dataset.cursorAnimationPhase).toBe("on"));
    expect(screen.dataset.cursorActive).toBe("true");
    expect(changed).toHaveBeenCalled();
    input.blur();
    expect(screen.dataset.cursorActive).toBe("false");
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
        deliver: async (_label, message) => message.verb === "state" ? {
          themeMode: "dark", baseTheme, terminalOverrides, effectiveTheme: reorderedEffective,
        } : {},
      },
    });
    const presenter = createVisionRenderer(app).create(
      document.createElement("div"), "tab-order.1", () => {}, options,
    ) as ReturnType<ReturnType<typeof createVisionRenderer>["create"]> & {
      themeStatus(): { terminalOverrides: { background: string | null } };
    };
    expect(ingestTerminalSurfaceState({ pane: "tab-order.1", sequence: 1 })).toBe(true);
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
    });
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    expect(send).toHaveBeenCalledWith("a");
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
