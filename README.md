# i18n-ai-extract-translate

Scans a JS/TS/React codebase for `t("...")` / `<Trans>` usages, writes the
strings into i18next-style locale JSON files, and can optionally translate
missing entries automatically with Gemini (Gemini Developer API or Vertex AI).
It can also mine a Python backend
for hard-coded error strings and merge them into the same locale files.

## Install

```bash
npm install --save-dev i18n-ai-extract-translate
```

## Installing and running this in another project (full detail)

The package is published on the public npm registry, so in most cases you just need:

```bash
npm install --save-dev i18n-ai-extract-translate
```

If you're developing this package locally and want to test changes in another project before publishing a new version, use one of the alternative methods below instead.

### Prerequisites

- **Node.js 18+** (the code relies on built-in `fetch` and ESM modules).
- **Python 3** available on `PATH` (`python3` or `python`) — **only** if you'll use the backend error-extraction feature (`backend.enabled: true`). Skip this if your project has no Python backend.
- **AI credentials** — only needed for auto-translation via the `translate` command (`extract` never needs it): a **Gemini API key** (env var `AI_KEY`) by default, or Google Cloud credentials if you use the Vertex AI provider instead. See "AI providers" below.

### Method 1 — local path dependency (for local development, before publishing a new version)

In the other project's `package.json`:

```json
{
  "devDependencies": {
    "i18n-ai-extract-translate": "file:../i18n-ai-extract-translate"
  }
}
```

The path `file:../i18n-ai-extract-translate` is relative to that project's `package.json` — adjust it to wherever the package folder actually sits on your machine. Then:

```bash
cd /path/to/other-project
npm install
```

npm creates a symlink to the package, so any change you make to `i18n-ai-extract-translate`'s code is reflected immediately without reinstalling.

### Method 2 — `npm link` (handy if you're developing both packages in parallel)

```bash
# 1) inside the package folder itself, register it as a global link
cd /path/to/i18n-ai-extract-translate
npm link

# 2) inside the other project, link to the registered package
cd /path/to/other-project
npm link i18n-ai-extract-translate
```

### Method 3 — tarball (closest to a real publish, without uploading anywhere)

```bash
# 1) build a tarball from the package folder
cd /path/to/i18n-ai-extract-translate
npm pack
# produces something like: i18n-ai-extract-translate-0.1.0.tgz

# 2) install it into the other project from the file path
cd /path/to/other-project
npm install --save-dev /path/to/i18n-ai-extract-translate/i18n-ai-extract-translate-0.1.0.tgz
```

This mirrors exactly what a real npm install would get (only the files listed in `package.json`'s `files` field are packed), so it's a good way to sanity-check before publishing.

### Method 4 — the npm registry (recommended, see the top of this section)

```bash
npm install --save-dev i18n-ai-extract-translate
```

Publishing a new version (for maintainers): bump the version in `package.json` (e.g. `npm version patch`), then `npm publish` from inside the package folder — requires `npm login` and publish access to this package.

### Post-install setup (applies to all methods above)

1. **Create a config file** at the other project's root named `i18n-ai-extract-translate.config.js` (or `.mjs`/`.cjs`/`.json`). Copy [`i18n-ai-extract-translate.config.example.js`](i18n-ai-extract-translate.config.example.js) from this package as a starting point, and adjust:
   - `source.globs` — glob patterns for your source files (JS/JSX/TS/TSX).
   - `langs`, `defaultLng`, `defaultNs` — supported locales and the default one.
   - `localesDir` — path to your locale JSON folder, relative to the project root.
   - `backend.enabled` — set to `false` if there's no Python backend, or set `backend.rootDir` to the correct backend root if `true`.
   - `translate.targetLangs` — which locales should be auto-translated.

2. **Add npm scripts** to the other project's `package.json`:

   ```json
   {
     "scripts": {
       "i18n:extract": "i18n-ai-extract-translate extract",
       "i18n:extract:backend": "i18n-ai-extract-translate extract --backend-only",
       "i18n:translate": "i18n-ai-extract-translate translate",
       "i18n:all": "i18n-ai-extract-translate all"
     }
   }
   ```

3. **Make sure the locale folders already exist** under `localesDir` (e.g. `src/i18n/locales/eng/translation.json` as at least an empty `{}` file), since `extract` reads/writes them directly.

4. **Run extract first** to confirm the config is correct:

   ```bash
   npm run i18n:extract
   ```

   If you see errors about `source.globs` or `localesDir` paths, double-check those values in the config file.

5. **(Optional) enable auto-translation**:

   ```bash
   export AI_KEY="your_gemini_api_key"
   npm run i18n:translate -- --dry-run   # preview what's missing first, no AI calls
   npm run i18n:translate                # actually translate
   ```

6. **Run everything in one shot** during day-to-day development:

   ```bash
   AI_KEY=... npm run i18n:all
   ```

### Using the package programmatically (without the CLI)

You can also import the functions directly in your own Node script instead of going through the CLI:

```js
import { loadConfig, runExtract, runTranslate, runAll } from "i18n-ai-extract-translate";

const config = await loadConfig({ cwd: process.cwd() });
await runExtract(config);
await runTranslate(config, { dryRun: true });
```

### Troubleshooting

- **`Cannot find module 'i18next-scanner/package.json'`**: make sure you ran `npm install` in the other project after adding the package to `package.json` — it carries `i18next-scanner` as its own dependency and resolves it automatically, no manual install needed.
- **`AI_KEY is not set`**: when running `translate` without `--dry-run`, you must export `AI_KEY` in the environment first.
- **No results from backend extraction**: confirm `backend.enabled: true`, that `backend.rootDir` actually points to a folder containing `.py` files, and that `python3` (or `python`) is installed and on `PATH`.
- **Changes to the package aren't reflected after `npm link`**: re-run `npm link i18n-ai-extract-translate` in the other project if the link got broken (e.g. a fresh `npm install` can remove symlinks).

## Configure

Create `i18n-ai-extract-translate.config.js` at your project root (CommonJS,
ESM, or JSON all work — see `i18n-ai-extract-translate.config.example.js` in
this repo for the full schema):

```js
module.exports = {
  source: {
    globs: ["src/**/*.{js,jsx,ts,tsx}"],
  },
  langs: ["ar", "ch", "eng"],
  defaultLng: "eng",
  defaultNs: "translation",
  localesDir: "src/i18n/locales",
  backend: {
    enabled: true,
    rootDir: "..",                    // where your Python backend lives, relative to cwd
    dictKeys: ["error"],              // collects { "error": "..." } dict literals via AST
    errorCallNames: ["ValidationError"], // also collects every string in ValidationError(...) calls
    variableNames: ["title", "message", "status_translations"], // also collects assignments to these names
    mergeTargetLangs: ["ar", "ch"],
  },
  translate: {
    provider: "gemini",              // or "vertex" — see "AI providers" below
    sourceLang: "eng",
    targetLangs: ["ar", "ch"],
  },
};
```

Add scripts to your `package.json`:

```json
{
  "scripts": {
    "i18n:extract": "i18n-ai-extract-translate extract",
    "i18n:extract:backend": "i18n-ai-extract-translate extract --backend-only",
    "i18n:translate": "i18n-ai-extract-translate translate",
    "i18n:all": "i18n-ai-extract-translate all"
  }
}
```

## Usage

```bash
# Scan source + (optionally) backend, write new keys to locale JSON files
npm run i18n:extract

# Fill in missing translations via Gemini (requires AI_KEY)
AI_KEY=... npm run i18n:translate

# See what's missing without calling the AI
npm run i18n:translate -- --dry-run

# Do both: extract, then translate if AI_KEY is set
AI_KEY=... npm run i18n:all
```

### `extract` flags

- `--backend-only` — only run the Python AST scan, skip the JS/TS scanner.
- `--frontend-only` — only run the JS/TS scanner, skip the backend merge.

### `translate` flags

- `--provider gemini|vertex` — override `translate.provider`.
- `--langs ar,ch` — override `translate.targetLangs`.
- `--source eng` — override `translate.sourceLang`.
- `--model auto|<model-name>` — defaults to auto-selecting a supported model (Gemini only; Vertex needs an explicit model).
- `--chunk 40` — batch size per request.
- `--max N` — cap how many strings get translated in this run.
- `--preview N` — how many example keys to print per language in `--dry-run`.
- `--dry-run` — report missing/likely-untranslated strings without calling the API.
- `--force` — re-translate everything, even existing values.
- `--project <gcp-project>` / `--location us-central1` — Vertex AI only, override `translate.vertex.project` / `translate.vertex.location`.

## AI providers

`translate` supports two backends, chosen via `translate.provider` (or `--provider`):

### `gemini` (default) — Gemini Developer API / AI Studio

Simplest option: one static API key.

```bash
AI_KEY=your_gemini_api_key npm run i18n:translate
```

### `vertex` — Vertex AI on Google Cloud

Use this if your team already authenticates to Google Cloud (a GCP project,
IAM, service accounts) instead of a standalone Gemini API key.

```js
translate: {
  provider: "vertex",
  vertex: {
    project: "your-gcp-project-id",
    location: "us-central1",          // default
    model: "gemini-2.0-flash-001",    // default
  },
  targetLangs: ["ar", "ch"],
},
```

Vertex needs a Google Cloud OAuth2 access token, resolved in this order:

1. `VERTEX_ACCESS_TOKEN` env var — a token you already minted yourself.
2. `GOOGLE_APPLICATION_CREDENTIALS` env var — path to a service account key
   JSON file (the library signs its own JWT and exchanges it for a token,
   no extra dependencies needed).
3. `gcloud auth application-default login` — used as a fallback via
   `gcloud auth application-default print-access-token` (handy for local dev
   if you have the `gcloud` CLI installed).

```bash
# option 2: service account key file
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run i18n:translate -- --provider vertex

# option 3: gcloud CLI (after `gcloud auth application-default login` once)
npm run i18n:translate -- --provider vertex
```

## Backend (Python) extraction

When `backend.enabled` is `true`, `extract` also walks `backend.rootDir` for
`*.py` files (skipping `backend.excludedDirs`) and collects strings from
three patterns:

1. **Dict literals** whose key matches one of `backend.dictKeys` (default:
   `["error"]`), anywhere in the code:

   ```python
   return Response({"error": "This field is required."}, status=400)
   ```

2. **Calls to any of `backend.errorCallNames`** (default: `["ValidationError"]`,
   matched by the last attribute segment, so it also matches
   `serializers.ValidationError(...)`) — every string literal in the call's
   arguments is collected, regardless of dict key names. This catches the
   common DRF pattern where the dict key is a field name, not `"error"`:

   ```python
   raise serializers.ValidationError({"support_details": "Expected a list of support detail objects."})
   raise serializers.ValidationError("Plain message error.")
   raise serializers.ValidationError(["First error.", "Second error."])
   ```

3. **Assignments to any of `backend.variableNames`** (default: `[]`, opt-in) —
   the assigned value is collected, whatever shape it is: a plain string, an
   f-string (interpolated expressions become `{{expr}}` i18next-style
   placeholders instead of their runtime value), or a dict/list of strings
   (only the values are collected, not dict keys — handy for status/code →
   label maps):

   ```python
   status_translations = {
       "requested": "Requested",
       "accepted": "Accepted",
   }
   title = "Visit Status Change"
   message = f"Visit status changed from '{old_status_ar}' to '{new_status_ar}'"
   # → "Visit status changed from '{{old_status_ar}}' to '{{new_status_ar}}'"
   ```

   Set e.g. `variableNames: ["title", "message", "status_translations"]` to
   pick these up.

Each unique string found this way is added to the default-language locale
file (value = key) and to each language listed in `backend.mergeTargetLangs`
(as an empty string, ready for `translate` to fill in). Add more exception
names to `backend.errorCallNames` (e.g. `"NotFound"`, `"PermissionDenied"`)
if your backend raises other user-facing errors.

## Notes

- `translate` requires AI credentials (see "AI providers" above) unless you
  pass `--dry-run`.
- Progress is saved to disk after every translation batch, so an interrupted
  run doesn't lose completed work.
- Values that already look non-English are left alone unless `--force` is
  passed.

## Author

MUSAALAHMED — [LinkedIn](https://www.linkedin.com/in/musa-al-ahmed-b187292a1)

## License

MIT
