# Vision — performance record

Targets are written before code and never lowered after it. Every number below is measured by a
`sok` command or a committed benchmark; a capture is observation, never a verdict.

## Stage 0 — measured before code (2026-08-27)

| Measurement | Result | Consequence |
| --- | --- | --- |
| Decode one dense 200×60 frame as JSON (440,429 bytes, 6,000 runs, Go `encoding/json`, 200 iterations) | **5.37 ms/op, 1.60 MB/op, 18,529 allocs/op** | The frame wire is removed, not optimized: the render sidecar paints its own grid and no frame crosses to the application |

## Targets (judged at stage 5, isolated identity)

| Item | Target | Judged by |
| --- | --- | --- |
| Attachment | `unapplied = undeclared = misparented = 0`, `worst = 0`, `lag/drift/off = 0` | `sok surface.composition`, `sok layout.alignment` |
| Key to displayed frame | p50 ≤ 4 ms, p95 ≤ 8 ms — at most half of the abyss baseline | `state.latency` ring of 256, 200 presses |
| 10 MiB of output | wall clock ≤ sidecar-alone parse × 1.2, application main thread < 1 %, frame bytes into the application = 0 | sidecar and application `state` |
| Memory per pane | application increment ≈ 0 (a shared IOSurface reference), sidecar increment ≤ 3 ring surfaces × pane pixels × 4 B | `phys_footprint` deltas, panes 1 → 9 |
| Idle CPU | application ≤ 0.1 %, sidecar ≤ 0.2 % over 10 s | `state.cpuPct10s` |
| Occluded CPU | both 0.0 %, `ticks10s == 0` | `state` after moving to another space |
| Resize | cell-quantized and debounced, commit `appliedMs` ≤ 2 ms, one `addSubview` per pane | receipts, `state.attachCount`, a 5 s recording diff |
| IME | no composition text in `read`, exactly one write after commit | Korean input, `read`, `state.bytesWritten` |
| Recovery | warm after a restart under the same pane key; killing the render sidecar recovers the pane and never the application | `recovery-status`, a kill run |

## Abyss baseline — the comparison denominator (measured 2026-08-27)

Isolated identity `terminalux`, window `win-zgzpmf` (visible, not occluded), renderer
`alacritty-frame`, plugin `soksak-plugin-terminal-abyss` 0.0.1 (development record), fresh tab.

| Measurement | Result | Method |
| --- | --- | --- |
| Key to render advance, 200 presses, 0 timeouts | **p50 20.35 ms, p95 41.93 ms** (min 15.61, max 112.12) | t0 before `ui.input.key` on `terminal-input/1`; advance = `plugin.status` `presentation.renderSequence` past its pre-press value |
| Measurement floor | status poll p50 9.1 ms; `ui.input.key` call p50 7.24 ms | one `sok` process per call — true echo latency sits below the reported figure by at most one poll interval |
| 10 MiB `cat` | **925 ms wall (10.81 MiB/s)**, 48 frames rendered, `recovery.gaps` 0, pty bytes 10,617,424, max render duration 5 ms | `send` → server-side `wait contains` marker; `status` deltas before/after |

Consequences: the fixed vision target (p50 ≤ 4 ms, p95 ≤ 8 ms) is stricter than half of this
baseline (10.2 / 21.0 ms), so the target stands as written. The 10 MiB wall clock improved from
6,226 ms (2026-08-26 canonical run, `local/docs/TERMINAL-BASELINE.md`) to 925 ms after the sidecar
work of 2026-08-27 — the denominator here is the current tree.
