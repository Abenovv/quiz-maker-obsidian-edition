import { defineConfig } from "eslint/config";
import json from "@eslint/json";
import obsidianmd from "eslint-plugin-obsidianmd";
import { PlainTextParser } from "eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";

// The official manifest rule expects a JavaScript object expression. Check
// strict JSON first, then wrap it without changing any line numbers.
const manifestProcessor = {
  preprocess(text) {
    JSON.parse(text);
    return ["(" + text + "\n)"];
  },
  postprocess(results) {
    return results.flat().map(message => ({
      ...message,
      column: message.line === 1 ? Math.max(1, message.column - 1) : message.column,
      endColumn: message.endLine === 1 ? Math.max(1, message.endColumn - 1) : message.endColumn
    }));
  }
};

const recommended = obsidianmd.configs.recommended.map(config =>
  !config.files && (config.rules || config.languageOptions)
    ? { ...config, files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"] }
    : config
);

export default defineConfig([
  { ignores: ["node_modules/**", "main.js", "styles.css", "scripts/**", "tests/**", "preview/**", "docs/**", "assets/**"] },
  ...recommended,
  {
    files: ["versions.json"],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"],
  },
  {
    files: ["manifest.json"],
    processor: manifestProcessor,
    rules: { "obsidianmd/validate-manifest": "error" }
  },
  {
    files: ["LICENSE"],
    languageOptions: { parser: PlainTextParser },
    rules: { "obsidianmd/validate-license": "error" }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
]);
