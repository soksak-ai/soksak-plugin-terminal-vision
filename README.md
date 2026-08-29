# soksak-plugin-terminal-vision

A terminal whose pixels are painted by its render sidecar.

This plugin runs without a webview renderer: the engine sidecar paints the grid it
already owns into an IOSurface ring (`soksak-spec-sidecar-surface`), the application composites
that surface inside the tab view, and this plugin declares the surface, forwards commands and
publishes status. The hot path — keys, echo, frames, paint — never enters the web content
process. The presenter mirrors the engine-owned cursor state into the contract DOM and publishes
changes through the shared terminal status path. It parses no control sequence and runs no cursor
timer.

Visibility follows the shared compositor ownership contract. Workbench pane visibility alone is
written to the surface's intrinsic `data-native-visible`; Core workspace, tab, and overlay
presentation remains on the host ancestor and is never copied into the Plugin declaration. Host
dim changes only native alpha. The Kit supplies all four observable facts—intrinsic, host,
effective, and dim—through one `TerminalVisibilityState` update.

Native `read` and `selection` replies are asynchronous presenter results. The Plugin returns the
resolved engine text or propagates the refusal; it never reports a cached empty success while an
IPC request is still in flight.

Pointer selection is event-driven. The presenter converts the current surface rectangle and
engine grid into cell/side points, serializes begin/update/end under one gesture ID, and adopts only
non-stale snapshots. An ungrabbed mouse selects normally; while the engine reports mouse tracking,
Shift explicitly forces local selection. No timer or provider-name branch is used.

## Verification

```sh
make lock REGISTRY=http://host:port/
make verify REGISTRY=http://host:port/
make attest OUT=/absolute/release-output STORE=/absolute/local/releases REGISTRY=http://host:port/
```
