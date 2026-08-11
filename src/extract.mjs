import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveBin } from "./resolveBin.mjs";

function countChar(haystack, ch) {
  let count = 0;
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i] === ch) count += 1;
  }
  return count;
}

function createStdoutFilter(writeLine) {
  let buffer = "";
  let skippingOptions = false;
  let braceDepth = 0;

  const flush = (data) => {
    buffer += data.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = rawLine.replace(/\r$/, "");

      // Skip the locize sponsorship banner printed by i18next-scanner.
      if (line.includes("locize.com")) continue;

      if (skippingOptions) {
        braceDepth += countChar(line, "{") - countChar(line, "}");
        if (braceDepth <= 0) {
          skippingOptions = false;
          braceDepth = 0;
        }
        continue;
      }

      if (line.startsWith("i18next-scanner: options=")) {
        skippingOptions = true;
        braceDepth = countChar(line, "{") - countChar(line, "}");
        if (braceDepth <= 0) {
          skippingOptions = false;
          braceDepth = 0;
        }
        continue;
      }

      if (line.trim().length === 0) {
        writeLine("\n");
        continue;
      }

      writeLine(`${line}\n`);
    }
  };

  const end = () => {
    if (buffer.length > 0) {
      const line = buffer;
      buffer = "";
      if (
        !line.includes("locize.com") &&
        !line.startsWith("i18next-scanner: options=")
      ) {
        writeLine(`${line}\n`);
      }
    }
  };

  return { flush, end };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}\n${stderr}`,
          ),
        );
    });
  });
}

const PYTHON_AST_SCRIPT = String.raw`
import ast, json, sys
from pathlib import Path

DICT_KEYS = set(json.loads(sys.argv[2])) if len(sys.argv) > 2 else {"error"}
ERROR_CALL_NAMES = set(json.loads(sys.argv[3])) if len(sys.argv) > 3 else {"ValidationError"}
EXCLUDED_DIR_NAMES = set(json.loads(sys.argv[4])) if len(sys.argv) > 4 else set()

def call_name(node):
  func = node.func
  if isinstance(func, ast.Attribute):
    return func.attr
  if isinstance(func, ast.Name):
    return func.id
  return None

class Collector(ast.NodeVisitor):
  def __init__(self):
    self.items = []

  def collect_strings(self, node):
    # Walks dicts/lists/tuples/sets of string literals, e.g. the argument of
    # raise serializers.ValidationError({'field': 'message'}) or
    # raise serializers.ValidationError(['message one', 'message two']).
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
      if node.value.strip():
        self.items.append(node.value)
    elif isinstance(node, ast.Dict):
      for v in node.values:
        self.collect_strings(v)
    elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
      for el in node.elts:
        self.collect_strings(el)

  def visit_Dict(self, node):
    # Matches dicts keyed by a known error key, e.g. {"error": "..."},
    # anywhere in the code (not just inside a matched call).
    for k, v in zip(node.keys, node.values):
      if isinstance(k, ast.Constant) and k.value in DICT_KEYS:
        if isinstance(v, ast.Constant) and isinstance(v.value, str):
          self.items.append(v.value)
        elif isinstance(v, (ast.List, ast.Tuple)):
          for el in v.elts:
            if isinstance(el, ast.Constant) and isinstance(el.value, str):
              self.items.append(el.value)
    self.generic_visit(node)

  def visit_Call(self, node):
    # Matches calls like serializers.ValidationError(...) or
    # ValidationError(...) and collects every string literal in their
    # arguments, regardless of dict key names.
    if call_name(node) in ERROR_CALL_NAMES:
      for arg in node.args:
        self.collect_strings(arg)
      for kw in node.keywords:
        if kw.value is not None:
          self.collect_strings(kw.value)
    self.generic_visit(node)

def should_skip(path: Path) -> bool:
  parts = set(path.parts)
  return any(p in EXCLUDED_DIR_NAMES for p in parts)

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
out = []
seen = set()
files_scanned = 0

for py_file in root.rglob("*.py"):
  if should_skip(py_file):
    continue
  files_scanned += 1
  try:
    src = py_file.read_text(encoding="utf-8")
  except Exception:
    continue
  try:
    tree = ast.parse(src, filename=str(py_file))
  except SyntaxError:
    continue
  c = Collector()
  c.visit(tree)
  for s in c.items:
    if s not in seen:
      seen.add(s)
      out.append(s)

sys.stdout.write(json.dumps({"filesScanned": files_scanned, "errorStrings": out}, ensure_ascii=False))
`;

async function extractPythonErrorStrings({
  rootDir,
  dictKeys,
  errorCallNames,
  excludedDirs,
}) {
  const candidates = ["python3", "python"];
  let lastErr;
  for (const cmd of candidates) {
    try {
      const { stdout } = await run(cmd, [
        "-c",
        PYTHON_AST_SCRIPT,
        rootDir,
        JSON.stringify(dictKeys),
        JSON.stringify(errorCallNames),
        JSON.stringify(excludedDirs),
      ]);
      const parsed = JSON.parse(stdout || "{}");
      return {
        filesScanned: Number(parsed.filesScanned ?? 0),
        errorStrings: Array.isArray(parsed.errorStrings)
          ? parsed.errorStrings
          : [],
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw (
    lastErr ??
    new Error("Unable to run python to extract backend error strings")
  );
}

export async function mergeBackendErrorsIntoLocales(config) {
  const { projectRoot, localesDir, defaultLng, defaultNs, backend } = config;
  if (!backend?.enabled) return;

  const rootDir = path.resolve(projectRoot, backend.rootDir ?? "..");
  const dictKeys =
    backend.dictKeys && backend.dictKeys.length > 0
      ? backend.dictKeys
      : [backend.dictKey ?? "error"];
  const errorCallNames =
    backend.errorCallNames && backend.errorCallNames.length > 0
      ? backend.errorCallNames
      : ["ValidationError"];

  const { filesScanned, errorStrings } = await extractPythonErrorStrings({
    rootDir,
    dictKeys,
    errorCallNames,
    excludedDirs: backend.excludedDirs ?? [],
  });

  const targetLangs = backend.mergeTargetLangs ?? [];

  if (!errorStrings || errorStrings.length === 0) {
    process.stdout.write(
      `\n[backend] No backend error strings found (scanned ${filesScanned} .py files).\n`,
    );
    return;
  }

  const defaultLocalePath = path.join(
    projectRoot,
    localesDir,
    defaultLng,
    `${defaultNs}.json`,
  );
  const defaultJson = await readJson(defaultLocalePath);

  const targetByLang = new Map();
  for (const lang of targetLangs) {
    const langPath = path.join(
      projectRoot,
      localesDir,
      lang,
      `${defaultNs}.json`,
    );
    targetByLang.set(lang, { path: langPath, json: await readJson(langPath), added: 0 });
  }

  let addedDefault = 0;
  for (const msg of errorStrings) {
    if (typeof msg !== "string") continue;
    const key = msg.trim();
    if (!key) continue;

    if (!Object.prototype.hasOwnProperty.call(defaultJson, key)) {
      defaultJson[key] = key;
      addedDefault += 1;
    }

    for (const lang of targetLangs) {
      const entry = targetByLang.get(lang);
      if (!entry) continue;
      if (Object.prototype.hasOwnProperty.call(entry.json, key)) continue;
      entry.json[key] = "";
      entry.added += 1;
    }
  }

  const addedTargets = [...targetByLang.values()].reduce(
    (sum, x) => sum + x.added,
    0,
  );

  if (addedDefault === 0 && addedTargets === 0) {
    process.stdout.write(
      `\n[backend] Found ${errorStrings.length} backend error strings, nothing new to add.\n`,
    );
    return;
  }

  if (addedDefault > 0) await writeJson(defaultLocalePath, defaultJson);
  for (const entry of targetByLang.values()) {
    if (entry.added > 0) await writeJson(entry.path, entry.json);
  }

  const perLang = [...targetByLang.entries()]
    .map(([lang, e]) => `${lang}=${e.added}`)
    .join(", ");
  process.stdout.write(
    `\n[backend] Added backend error strings (${defaultLng}=${addedDefault}, ${perLang}) (scanned ${filesScanned} .py files).\n`,
  );
}

async function writeScannerConfig(config, tmpDir) {
  const { source, langs, defaultLng, defaultNs, localesDir } = config;

  const scannerConfig = {
    input: source.globs,
    output: "./",
    options: {
      debug: false,
      func: { list: source.funcList, extensions: source.extensions },
      trans: {
        component: "Trans",
        i18nKey: "i18nKey",
        defaultsKey: "defaults",
        extensions: source.extensions,
      },
      lngs: langs,
      defaultLng,
      defaultNs,
      keySeparator: false,
      nsSeparator: false,
      defaultValue: `__DEFAULT_VALUE_PLACEHOLDER__`,
      resource: {
        loadPath: `${localesDir}/{{lng}}/{{ns}}.json`,
        savePath: `${localesDir}/{{lng}}/{{ns}}.json`,
        jsonIndent: 2,
      },
    },
  };

  const configPath = path.join(tmpDir, "i18next-scanner.config.cjs");
  const body = `module.exports = ${JSON.stringify(scannerConfig, null, 2).replace(
    '"__DEFAULT_VALUE_PLACEHOLDER__"',
    `(lng, ns, key) => (lng === ${JSON.stringify(defaultLng)} ? key : "")`,
  )};\n`;
  await writeFile(configPath, body, "utf8");
  return configPath;
}

export async function runFrontendExtract(config, extraArgs = []) {
  const { projectRoot } = config;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "i18n-extract-"));

  try {
    const configPath = await writeScannerConfig(config, tmpDir);
    const scannerBin = resolveBin("i18next-scanner", { cwd: projectRoot });

    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [scannerBin, "--config", configPath, ...extraArgs],
        {
          cwd: projectRoot,
          stdio: ["inherit", "pipe", "pipe"],
          env: process.env,
        },
      );

      const stdoutFilter = createStdoutFilter((line) =>
        process.stdout.write(line),
      );
      child.stdout.on("data", (d) => stdoutFilter.flush(d));
      child.stdout.on("end", () => stdoutFilter.end());
      child.stderr.pipe(process.stderr);

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`i18next-scanner exited with code ${code}`));
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function runExtract(config, { backendOnly = false, frontendOnly = false } = {}) {
  if (backendOnly && frontendOnly) {
    throw new Error("Use only one of --backend-only or --frontend-only");
  }

  if (backendOnly) {
    await mergeBackendErrorsIntoLocales(config);
    return;
  }

  await runFrontendExtract(config);

  if (frontendOnly) return;

  try {
    await mergeBackendErrorsIntoLocales(config);
  } catch (err) {
    process.stdout.write(
      `\n[backend] WARNING: failed to extract backend error strings: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
