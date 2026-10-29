import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 4318;
const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
async function bundle() {
  return build({
    absWorkingDir: root,
    entryPoints: ["preview/main.tsx"], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".svg": "text" },
    plugins: [{ name: "preview-obsidian", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(root, "preview/obsidian.ts") })); } }]
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'");
  try {
    if (url.pathname === "/preview.js") { const output = await bundle(); response.setHeader("Content-Type", contentTypes[".js"]); response.end(output.outputFiles[0].contents); return; }
    if (url.pathname === "/plugin.css") {
      const source = await Promise.all(["styles/base.css", "styles/components.css"].map(path => readFile(join(root, path), "utf8")));
      response.setHeader("Content-Type", contentTypes[".css"]); response.end(source.join("\n")); return;
    }
    const path = url.pathname === "/" ? "preview/index.html" : url.pathname === "/preview.css" ? "preview/preview.css" : url.pathname.startsWith("/assets/") ? url.pathname.slice(1) : null;
    if (!path || path.includes("..") || normalize(path).startsWith("..")) { response.writeHead(404); response.end("Not found"); return; }
    const extension = Object.keys(contentTypes).find(extension => path.endsWith(extension)) || ".html";
    response.setHeader("Content-Type", contentTypes[extension]); response.end(await readFile(join(root, path)));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Preview failed");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Quiz maker preview: http://127.0.0.1:${port}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
