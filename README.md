# soksak-plugin-terminal-vision

A terminal whose pixels are painted by its render sidecar.

This plugin runs without a webview renderer: the engine sidecar paints the grid it
already owns into an IOSurface ring (`soksak-spec-sidecar-surface`), the application composites
that surface inside the tab view, and this plugin declares the surface, forwards commands and
publishes status. The hot path — keys, echo, frames, paint — never enters the web content
process. The presenter mirrors the engine-owned cursor state into the contract DOM and publishes
changes through the shared terminal status path. It parses no control sequence and runs no cursor
timer.

## Verification

```sh
make lock REGISTRY=http://host:port/
make verify REGISTRY=http://host:port/
make attest OUT=/absolute/release-output STORE=/absolute/local/releases REGISTRY=http://host:port/
```
