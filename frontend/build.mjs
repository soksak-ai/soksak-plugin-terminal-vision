// Bundles this plugin's entry into the file plugin.json names. The host imports one ESM module.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error("usage: node build.mjs [--check]");
}
const checking = arguments_[0] === "--check";
const output = `../${manifest.entry}`;

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minifyWhitespace: true,
  outfile: output,
  legalComments: "none",
  logLevel: "info",
  write: !checking,
});
if (checking) {
  const expected = readFileSync(new URL(output, import.meta.url));
  if (result.outputFiles?.length !== 1 || !expected.equals(result.outputFiles[0].contents)) {
    throw new Error(`generated ${manifest.entry} does not match the canonical plugin entry`);
  }
}
