// Activation: the shared kit runs the panes, the workbench and every standard
// command; this plugin contributes one thing — a renderer whose pixels live in
// a native surface a sidecar paints.
import {
  activateProviderTerminalPlugin,
  type ProviderTerminalPluginConfig,
  type ProviderTerminalPluginHost,
} from "@soksak/soksak-kit-plugin-terminal";
import { manifest } from "../manifest";
import { createVisionRenderer, ingestTerminalSurfaceState, shownLog, type SurfaceApp } from "./presenter";

export const PLUGIN_ID = "soksak-plugin-terminal-vision";
export const ENGINES = ["alacritty", "ghostty", "kitty", "shitty", "vt100", "wezterm"] as const;

interface TerminalHostEvents {
  on(event: "layout.reflow", callback: () => void): { dispose(): void };
  on(event: "window.gone", callback: (payload: { windowLabel?: string }) => void): { dispose(): void };
  on(event: "paths.dropped", callback: (payload: {
    paneId: string | null;
    grants: Array<{ id: string; kind: "file" | "image" }>;
  }) => void): { dispose(): void };
  on(event: "terminal-surface.state", callback: (payload: { pane: string; sequence: number }) => void): { dispose(): void };
}

export interface TerminalHost extends Omit<ProviderTerminalPluginHost, "events">, Omit<SurfaceApp, "events"> {
  events?: TerminalHostEvents;
  terminal?: ProviderTerminalPluginHost["terminal"] & { getCwd?(pane: string): string | undefined };
}

export interface ActivateContext {
  app: TerminalHost;
  subscriptions: { dispose(): void }[];
}

export function activate(context: ActivateContext): void {
  const app = context.app;
  if (app.events) {
    context.subscriptions.push(app.events.on("terminal-surface.state", (payload) => {
      ingestTerminalSurfaceState(payload);
    }));
  }
  const viewParam = { type: "string", description: { en: "Terminal view id", ko: "터미널 뷰 ID" } };
  const config = {
    pluginId: PLUGIN_ID,
    engineId: "alacritty",
    ptySidecarId: "soksak-sidecar-pty",
    terminalSidecarId: "soksak-sidecar-terminal-alacritty",
    engines: {
      setting: "engine",
      sidecars: Object.fromEntries(ENGINES.map((engine) => [engine, `soksak-sidecar-terminal-${engine}`])),
    },
    programId: "terminal-vision",
    label: manifest.name,
    renderer: createVisionRenderer(app),
    extensions: [
      {
        name: "exec", danger: "inject" as const,
        params: { cmd: { type: "string", required: true, description: { en: "Command to run", ko: "실행할 명령" } }, view: viewParam },
        handler(params: Record<string, unknown>, screen: { pane: string; writable: boolean; send(data: string): void } | undefined) {
          const cmd = typeof params.cmd === "string" ? params.cmd : "";
          if (!screen?.writable) return { sent: false };
          screen.send(`${cmd}\r`);
          return { view: screen.pane, sent: cmd.length + 1 };
        },
      },
      {
        name: "shownlog", params: {},
        handler() {
          return { panes: Object.fromEntries(shownLog) };
        },
      },
      {
        name: "cwd", params: { view: viewParam },
        handler(_params: Record<string, unknown>, screen: { pane: string } | undefined) {
          return { view: screen?.pane ?? null, cwd: screen ? app.terminal?.getCwd?.(screen.pane) ?? null : null };
        },
      },
    ],
  };
  activateProviderTerminalPlugin(app, context.subscriptions, config as unknown as ProviderTerminalPluginConfig);
}
