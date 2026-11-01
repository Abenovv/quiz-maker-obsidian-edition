import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let enabled = false;

/** Older official lint dependencies need minimatch's callable default export. */
export function enableLintCompatibility() {
  if (enabled) return;
  const require = createRequire(import.meta.url);
  if (require("minimatch/package.json").version !== "11.0.1") {
    throw new Error("Install the pinned development dependencies with npm ci before linting.");
  }
  const adapter = new URL("./minimatch-compat.cjs", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "minimatch" && context.parentURL !== adapter) {
        return { url: adapter, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  });
  enabled = true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  enableLintCompatibility();
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
  await import(pathToFileURL(cli).href);
}
