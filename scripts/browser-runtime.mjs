import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

/** Keep embedded SQLite on browser APIs, including inside Electron. */
export const sqliteBrowserRuntime = {
  name: "sqlite-browser-runtime",
  setup(builder) {
    // The inline build embeds its WebAssembly bytes; no extra release asset is needed.
    builder.onLoad({ filter: /sql-wasm-inline\.js$/ }, async ({ path }) => ({
      contents: (await transform(await readFile(path, "utf8"), {
        define: { "globalThis.process": "undefined" }, target: "es2022"
      })).code,
      loader: "js"
    }));
    builder.onResolve({ filter: /^node:(?:fs|crypto)$/ }, args => {
      if (/sql-wasm-inline\.js$/.test(args.importer)) return { path: args.path, namespace: "sqlite-browser-only" };
    });
    builder.onLoad({ filter: /.*/, namespace: "sqlite-browser-only" }, () => ({
      contents: 'throw new Error("Desktop SQLite APIs are disabled in Quiz maker.");', loader: "js"
    }));
  }
};
