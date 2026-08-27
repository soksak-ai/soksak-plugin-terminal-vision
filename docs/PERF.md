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

The abyss baseline row lands here before vision's first measured stage, from the same isolated
identity and the same commands.
