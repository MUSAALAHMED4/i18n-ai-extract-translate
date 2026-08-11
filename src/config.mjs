import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_FILENAMES = [
  "i18n-ai-extract-translate.config.mjs",
  "i18n-ai-extract-translate.config.js",
  "i18n-ai-extract-translate.config.cjs",
  "i18n-ai-extract-translate.config.json",
];

const DEFAULT_CONFIG = {
  // Where source code lives, relative to the project root.
  source: {
    globs: ["src/**/*.{js,jsx,ts,tsx}"],
    extensions: [".js", ".jsx", ".ts", ".tsx"],
    funcList: ["t", "i18next.t"],
  },
  // All locales to maintain, and which one is authoritative.
  langs: ["eng"],
  defaultLng: "eng",
  defaultNs: "translation",
  // Relative to the project root.
  localesDir: "src/i18n/locales",
  // Optional: also mine a Python backend for hard-coded error strings.
  backend: {
    enabled: false,
    // Root directory to scan for *.py files, relative to the project root.
    rootDir: "..",
    // Dict literals of the form { "<key>": "..." } are collected when the
    // key matches one of dictKeys (kept for backward compat: dictKey is
    // used as a fallback if dictKeys is empty).
    dictKey: "error",
    dictKeys: ["error"],
    // Calls to any of these functions/exceptions (matched by their last
    // attribute segment, e.g. "ValidationError" also matches
    // `serializers.ValidationError(...)`) have ALL string literals in their
    // arguments collected, regardless of dict key names — this catches
    // patterns like `raise serializers.ValidationError({"field": "..."})`.
    errorCallNames: ["ValidationError"],
    excludedDirs: [
      "__pycache__",
      "migrations",
      "node_modules",
      ".git",
      ".venv",
      "venv",
      "env",
      "static",
      "media",
      "frontend",
    ],
    // Which locales (besides defaultLng) get an empty placeholder for new backend strings.
    mergeTargetLangs: [],
  },
  // AI translation (Gemini).
  translate: {
    sourceLang: "eng",
    targetLangs: [],
    model: "auto",
    chunkSize: 40,
  },
};

function deepMerge(base, override) {
  if (override == null) return base;
  if (
    typeof base !== "object" ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  ) {
    return override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig({ cwd = process.cwd() } = {}) {
  let userConfig = {};

  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(cwd, filename);
    if (!(await fileExists(filePath))) continue;

    if (filename.endsWith(".json")) {
      userConfig = JSON.parse(await readFile(filePath, "utf8"));
    } else {
      const mod = await import(pathToFileURL(filePath).href);
      userConfig = mod.default ?? mod;
    }
    break;
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig);
  merged.projectRoot = cwd;
  return merged;
}
