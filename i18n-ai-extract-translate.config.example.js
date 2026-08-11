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
    // Dict literals { "<key>": "..." } are collected when the key is one of these.
    dictKeys: ["error"],
    // Calls to any of these (matched by their last attribute segment, so
    // "ValidationError" also matches serializers.ValidationError(...)) have
    // ALL string literals in their arguments collected, regardless of dict
    // key — this catches DRF-style raise serializers.ValidationError({"field": "..."}).
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
    mergeTargetLangs: ["ar", "ch"],
  },
  translate: {
    sourceLang: "eng",
    targetLangs: ["ar", "ch"],
    model: "auto",
    chunkSize: 40,
  },
};
