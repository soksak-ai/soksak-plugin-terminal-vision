// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createVisionRenderer,
  encodeProxyKey,
  ingestTerminalSurfaceState,
  shownLog,
  type SurfaceApp,
} from "./presenter";

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

  it("owns its labels for pointer input while the pane lives", async () => {
    const { app, providers } = fakeApp();
    const container = document.createElement("div");
    const presenter = createVisionRenderer(app).create(container, "tab-a.1", () => {}, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(providers).toHaveLength(1);
    expect(providers[0].owns("terminal.win-test.tab-a-1")).toBe(true);
    expect(providers[0].owns("terminal.win-test.tab-zz-9")).toBe(false);
    presenter.dispose();
    expect(providers[0].owns("terminal.win-test.tab-a-1")).toBe(false);
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
