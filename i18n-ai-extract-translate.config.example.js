/** @type {import('./src/config.mjs').Config} */
module.exports = {
  source: {
    globs: ["src/**/*.{js,jsx,ts,tsx}"],
    extensions: [".js", ".jsx", ".ts", ".tsx"],
    funcList: ["t", "i18next.t"],
  },
  langs: ["ar", "ch", "eng", "gr", "sp", "tr", "ua"],
  defaultLng: "eng",
  defaultNs: "translation",
  localesDir: "src/i18n/locales",
  backend: {
    enabled: true,
    rootDir: "..", // project root that contains the Python backend, relative to this config's cwd
    dictKey: "error",
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
    mergeTargetLangs: ["ar", "ch"],
  },
  translate: {
    sourceLang: "eng",
    targetLangs: ["ar", "ch"],
    model: "auto",
    chunkSize: 40,
  },
};
