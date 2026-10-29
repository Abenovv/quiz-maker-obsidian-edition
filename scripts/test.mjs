import { build } from "esbuild";
import { readdir, mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
async function discover(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const groups = await Promise.all(entries.map(entry => entry.isDirectory()
    ? discover(join(directory, entry.name))
    : [join(directory, entry.name)]));
  return groups.flat().filter(path => /\.test\.(?:ts|tsx|mjs)$/.test(path)).sort();
}
const tests = await discover("tests");
if (!tests.length) throw new Error("No tests were found.");
const prefix = join(root, ".test-run-");
const directory = await mkdtemp(prefix);
const stub = join(root, "tests/helpers/obsidian.ts");
let hasStub = false;
try { await access(stub); hasStub = true; } catch { /* Pure tests need no Obsidian runtime. */ }
try {
  const runnable = [];
  for (let index = 0; index < tests.length; index++) {
    const output = join(directory, "test-" + index + ".mjs");
    await build({
      entryPoints: [tests[index]], outfile: output, bundle: true, platform: "node", format: "esm",
      target: "node24", packages: "external", jsx: "automatic", logLevel: "warning",
      plugins: [{
        name: "test-source-boundary",
        setup(builder) {
          if (hasStub) builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
          builder.onLoad({ filter: /\.(?:ts|tsx|mjs)$/, namespace: "file" }, async ({ path }) => ({
            contents: (await readFile(path, "utf8")).replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path).href)),
            loader: path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : "js"
          }));
        }
      }]
    });
    runnable.push(output);
  }
  const result = spawnSync(process.execPath, ["--test", ...runnable], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (!directory.startsWith(prefix)) throw new Error("Unexpected test output directory.");
  await rm(directory, { recursive: true, force: true });
}
