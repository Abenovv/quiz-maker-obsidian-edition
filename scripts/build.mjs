import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const ownLicense = (await readFile("LICENSE", "utf8")).replace(/\r\n/g, "\n");
const reactLicense = (await readFile("node_modules/react/LICENSE", "utf8")).replace(/\r\n/g, "\n");
const licenseBanner = "/* Quiz maker\n\n" + ownLicense + "\nBundled React, ReactDOM and scheduler\n\n" + reactLicense + "\n*/";
const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian"],
  write: false,
  outfile: "main.js",
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "text" },
  logLevel: "warning",
  banner: { js: licenseBanner }
});
const cssSources = await Promise.all(["styles/base.css", "styles/components.css"].map(path => readFile(path, "utf8")));
const css = cssSources.map(text => text.replace(/\r\n/g, "\n").trimEnd()).join("\n\n") + "\n";
await transform(css, { loader: "css", minify: false, logLevel: "warning" });
const javascript = result.outputFiles.find(file => file.path.endsWith("main.js"));
if (!javascript) throw new Error("The plugin build produced no JavaScript.");
const manifestBytes = await readFile("manifest.json");
const checksums = new Map([["main.js", javascript.contents], ["manifest.json", manifestBytes], ["styles.css", Buffer.from(css)]]);
const sums = Array.from(checksums, ([path, bytes]) => createHash("sha256").update(bytes).digest("hex") + "  " + path).join("\n") + "\n";
await Promise.all([writeFile("main.js", javascript.contents), writeFile("styles.css", css), writeFile("SHA256SUMS", sums)]);
console.log("Built Quiz maker: " + Math.round(javascript.contents.length / 1024) + " KiB JavaScript.");
