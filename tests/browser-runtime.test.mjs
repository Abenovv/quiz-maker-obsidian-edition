import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { sqliteBrowserRuntime } from "../scripts/browser-runtime.mjs";

test("embedded SQLite uses browser APIs even when an Electron-like process is present", async () => {
  const bundled = await build({
    stdin: { contents: 'import init from "sql.js/dist/sql-wasm-inline.js"; globalThis.sqlReady = init();', resolveDir: process.cwd() },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022",
    plugins: [sqliteBrowserRuntime], logLevel: "silent"
  });
  let desktopCalls = 0;
  const context = {
    WebAssembly, crypto: webcrypto, console, TextDecoder, TextEncoder,
    atob, btoa, setTimeout, clearTimeout,
    process: { versions: { node: "24.0.0" }, type: "browser" },
    require() { desktopCalls++; throw new Error("Desktop APIs must not run."); }
  };
  runInNewContext(bundled.outputFiles[0].text, context, { timeout: 10_000 });
  const sqlite = await context.sqlReady;
  const database = new sqlite.Database();
  try {
    assert.equal(database.exec("SELECT 6 * 7")[0].values[0][0], 42);
    assert.equal(desktopCalls, 0);
  } finally { database.close(); }
});

test("the bundled HTTP client resolves Obsidian through the desktop host require boundary", async () => {
  const bundled = await build({
    stdin: { contents: 'export { defaultHttpClient } from "./src/ai/transport";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022",
    external: ["obsidian"], metafile: true, logLevel: "silent"
  });
  assert.ok(Object.values(bundled.metafile.outputs).every(output => output.imports.every(item =>
    item.path !== "obsidian" || item.kind === "require-call")));
  const requests = [];
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, "obsidian");
      return { requestUrl: async request => {
        requests.push(request);
        return { status: 200, headers: { "content-type": "application/json" }, json: { models: [] } };
      } };
    }
  };
  runInNewContext(bundled.outputFiles[0].text, context, { timeout: 5000 });
  const reply = await context.module.exports.defaultHttpClient({ url: "http://localhost:4317/probe" });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.models.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].throw, false);
});
