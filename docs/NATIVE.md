# Vision — the native path

The pixels of a vision pane are painted by its render sidecar; this plugin declares the surface,
forwards commands and publishes status. The plan of record lives with the workspace owner; this
document states what the repository itself promises.

## Process map

| Work | Process |
| --- | --- |
| VT parsing, grid mirror, glyph rasterization, Metal, IOSurface ring | engine sidecar (one per engine) |
| Surface composition, keyboard/IME/mouse capture, geometry, parking pixels | the application (`wails-service-terminal-surface`) |
| Shell | one child of the PTY sidecar per pane |
| This plugin | declaration, commands, status — no cell, no glyph, no frame |

A pane adds no process. The web content process is not on the hot path.

## Rules

1. The hot path holds no webview: keys, echo, frames and paint travel between the sidecar and
   the application's AppKit side only.
2. Pixels are painted by the process that owns the grid. This repository must never grow a
   renderer: a painter here is the defect this plugin exists to remove.
3. The surface is declared, never opened: the seven `data-native-*` attributes are its lifetime.
4. Refusals carry names. No fallback renderer, no silent substitution.
5. Judgement is numbers: `surface.composition`, `layout.alignment`, the state the service and
   sidecar publish, `window.snapshot` for observation.
6. Cursor shape, visibility, position, blink policy and blink phase come from the engine and
   renderer `surface.state`. This plugin mirrors that state into the public terminal DOM and
   status event. It does not parse CSI or create a blink timer.
7. The declaration carries an explicit `light|dark` base theme. A host theme epoch sends one
   `surface.theme` command. Only a complete `surface.state` reply becomes `themeStatus`; no
   unthemed fallback or polling path exists. Text waits subscribe to state events and use one
   deadline timeout only.

The `shownlog` diagnostic command reports the count and last payload of surface frame events,
successful state reads and failed reads per pane. A failed state delivery is recorded by name; it
is not replaced by a timer or retry loop.

## Seams this plugin consumes

- `soksak-spec-sidecar-surface` — the IOSurface ring, its channel and the `surface.*` commands.
- `soksak-spec-plugin-terminal` — the standard commands, nodes and status every terminal
  implementation answers.
- The shared plugin kit's surface delivery mode — split, restore, status and command routing
  without a frame loop.

## Verification

```sh
make verify REGISTRY=http://host:port/
```

Performance numbers land in [PERF.md](PERF.md) as the measured stages complete; targets are
written before code and never lowered after it.
