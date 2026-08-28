# soksak-plugin-terminal-vision

A terminal whose pixels are painted by its render sidecar.

This plugin runs without a webview renderer: the engine sidecar paints the grid it
already owns into an IOSurface ring (`soksak-spec-sidecar-surface`), the application composites
that surface inside the tab view, and this plugin declares the surface, forwards commands and
publishes status. The hot path — keys, echo, frames, paint — never enters the web content
process.

The presenter arrives with the shared kit's `delivery: "surface"` mode; until that lands this
repository holds the manifest, its gates and the build skeleton.

## Verification

```sh
make lock REGISTRY=http://host:port/
make verify REGISTRY=http://host:port/
make attest OUT=/absolute/release-output STORE=/absolute/local/releases REGISTRY=http://host:port/
```
