import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const GEMINI_API_VERSIONS = ["v1", "v1beta"];

const ARABIC_SCRIPT_RE = /[\p{Script=Arabic}]/u;
const HAN_SCRIPT_RE = /[\p{Script=Han}]/u;

const LANGUAGE_DISPLAY_NAMES = {
  ar: "Arabic",
  ch: "Traditional Chinese (Taiwan)",
  eng: "English",
  en: "English",
  gr: "German",
  sp: "Spanish",
  tr: "Turkish",
  ua: "Ukrainian",
};

function previewText(text) {
  if (typeof text !== "string") return "";
  const cleaned = text.replaceAll(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "";
  const halfLen = Math.ceil(cleaned.length / 2);
  const cap = 80;
  const take = Math.min(halfLen, cap);
  const head = cleaned.slice(0, take);
  return take < cleaned.length ? `${head}…` : head;
}

function normalizeForCompare(text) {
  return String(text ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function isMostlyLatin(text) {
  return /[A-Za-z]/.test(String(text ?? ""));
}

function isLikelyNonTranslatableToken(text) {
  const s = normalizeForCompare(text);
  if (!s) return false;
  if (/^\d+(?:[\.,]\d+)?\+?$/.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  if (/^(https?:\/\/|\/)/i.test(s)) return true;
  if (/^\{\{[^}]+\}\}$/.test(s)) return true;
  if (/^[^A-Za-z0-9]+$/.test(s)) return true;
  if (/^[A-Z0-9][A-Z0-9._+-]{0,6}$/.test(s)) return true;
  return false;
}

function isLikelyTranslatableEnglish(text) {
  const s = normalizeForCompare(text);
  if (!s) return false;
  if (!isMostlyLatin(s)) return false;
  if (isLikelyNonTranslatableToken(s)) return false;
  return s.includes(" ") || s.length > 4;
}

function hasExpectedScript(text, lang) {
  const s = String(text ?? "");
  if (lang === "ar") return ARABIC_SCRIPT_RE.test(s);
  if (lang === "ch") return HAN_SCRIPT_RE.test(s);
  return true;
}

function looksUntranslated({ sourceEnglish, translatedValue, targetLang }) {
  const src = normalizeForCompare(sourceEnglish);
  const out = normalizeForCompare(translatedValue);
  if (!out) return true;
  if (out === src) {
    if (isLikelyNonTranslatableToken(src)) return false;
    if (isMostlyLatin(src)) return true;
    return isLikelyTranslatableEnglish(src);
  }
  if (
    (targetLang === "ar" || targetLang === "ch") &&
    isLikelyTranslatableEnglish(src)
  ) {
    if (!hasExpectedScript(out, targetLang)) return true;
  }
  return false;
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTranslation({ sourceEnglish, translatedValue }) {
  if (typeof translatedValue !== "string") return translatedValue;
  const src = normalizeForCompare(sourceEnglish);
  if (!src || !isMostlyLatin(src)) return translatedValue;
  if (/^[\x00-\x7F]+$/.test(translatedValue)) return translatedValue;

  const base = typeof sourceEnglish === "string" ? sourceEnglish : "";
  const variants = [base, src, base.trim()].filter(Boolean);
  let cleaned = translatedValue;
  for (const variant of variants) {
    const escaped = escapeRegex(String(variant).trim());
    if (!escaped) continue;
    cleaned = cleaned.replace(
      new RegExp(`(?:\\s*[-–—:,/|]+\\s*)?${escaped}\\s*$`, "i"),
      "",
    );
    cleaned = cleaned.replace(
      new RegExp(`\\(\\s*${escaped}\\s*\\)\\s*$`, "i"),
      "",
    );
  }
  cleaned = cleaned.trim();
  return cleaned || translatedValue;
}

function languageDisplayName(lang) {
  return LANGUAGE_DISPLAY_NAMES[lang] ?? lang;
}

function jsonPointerEscape(segment) {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
function jsonPointerUnescape(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}
function toJsonPointer(pathSegments) {
  return `/${pathSegments.map(jsonPointerEscape).join("/")}`;
}
function fromJsonPointer(pointer) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").map(jsonPointerUnescape);
}
function pointerToKey(pointer) {
  const segments = fromJsonPointer(pointer);
  return segments.length === 0 ? pointer : segments.join(".");
}
function getAtPointer(obj, pointer) {
  const segments = fromJsonPointer(pointer);
  let current = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}
function setAtPointer(obj, pointer, value) {
  const segments = fromJsonPointer(pointer);
  if (segments.length === 0) throw new Error("Refusing to set document root");
  let current = obj;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    const segment = segments[idx];
    const nextVal = current[segment];
    if (nextVal == null || typeof nextVal !== "object" || Array.isArray(nextVal)) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}
function collectStringLeaves(obj, currentPath = []) {
  if (typeof obj === "string") return [{ pointer: toJsonPointer(currentPath), value: obj }];
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out = [];
  for (const [key, val] of Object.entries(obj)) {
    out.push(...collectStringLeaves(val, [...currentPath, key]));
  }
  return out;
}

function safeJsonParse(maybeJson) {
  try {
    return JSON.parse(maybeJson);
  } catch {
    const start = maybeJson.indexOf("{");
    const end = maybeJson.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(maybeJson.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function normalizeModelName(model) {
  const trimmed = String(model ?? "").trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

async function geminiFetch({ apiKey, version, path: apiPath, body }) {
  if (!globalThis.fetch) throw new Error("Global fetch is not available. Use Node 18+.");
  const url = `https://generativelanguage.googleapis.com/${version}/${apiPath}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const rawText = await res.text();
  return { ok: res.ok, status: res.status, rawText };
}

async function listModels({ apiKey }) {
  for (const version of GEMINI_API_VERSIONS) {
    const url = `https://generativelanguage.googleapis.com/${version}/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: "GET" });
    const rawText = await res.text();
    if (!res.ok) continue;
    try {
      const data = safeJsonParse(rawText);
      if (Array.isArray(data?.models)) return data.models;
    } catch {
      continue;
    }
  }
  return [];
}

function modelSupportsGenerateContent(modelObj) {
  const methods = modelObj?.supportedGenerationMethods;
  return Array.isArray(methods) && methods.includes("generateContent");
}

async function resolveSupportedModel({ apiKey, requestedModel }) {
  const normalizedRequested = normalizeModelName(requestedModel);
  if (normalizedRequested && normalizedRequested !== "auto") return normalizedRequested;

  const models = await listModels({ apiKey });
  const supported = models
    .filter(modelSupportsGenerateContent)
    .map((m) => normalizeModelName(m?.name))
    .filter(Boolean);

  const preferredOrder = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-1.5-pro-latest",
    "gemini-1.5-pro",
  ];

  for (const name of preferredOrder) {
    if (supported.includes(name)) return name;
  }
  if (supported.length === 0) return preferredOrder[0];
  return supported[0];
}

async function translatePointersWithGemini({
  apiKey,
  model,
  targetLang,
  targetLanguage,
  pointerToEnglish,
  attempt = 1,
}) {
  const normalizedModel = normalizeModelName(model);
  const strictMode = attempt >= 2;

  const instructions = [
    "You are a professional UI translator.",
    `Translate the JSON values from English to ${targetLanguage}.`,
    "Return ONLY a valid JSON object.",
    "Keep all JSON keys exactly the same.",
    "Preserve punctuation, capitalization style where appropriate, and any numbers.",
    "Do not keep the entire value in English.",
    "If a value includes names / brands / acronyms, keep those terms unchanged but translate surrounding words.",
    "Do not add commentary or extra keys.",
    strictMode
      ? `IMPORTANT: Output MUST be in ${targetLanguage}. Do NOT copy the English input verbatim.`
      : "",
  ].join("\n");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${instructions}\n\nJSON to translate:\n${JSON.stringify(pointerToEnglish)}` }],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };

  let lastError;
  for (const version of GEMINI_API_VERSIONS) {
    const result = await geminiFetch({
      apiKey,
      version,
      path: `models/${encodeURIComponent(normalizedModel)}:generateContent`,
      body: payload,
    });

    if (result.ok) {
      const data = safeJsonParse(result.rawText);
      const combinedText =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      if (!combinedText) {
        throw new Error(`Gemini returned no text. Raw response: ${result.rawText.slice(0, 500)}`);
      }

      const translated = safeJsonParse(combinedText);
      if (translated == null || typeof translated !== "object" || Array.isArray(translated)) {
        throw new Error("Gemini output is not a JSON object");
      }

      const expectedPointers = Object.keys(pointerToEnglish);
      let missingCount = 0;
      for (const pointer of expectedPointers) {
        if (!(pointer in translated)) missingCount += 1;
      }
      if (missingCount > 0) {
        throw new Error(`UNTRANSLATED: model response is missing ${missingCount}/${expectedPointers.length} keys`);
      }

      let unchangedCount = 0;
      for (const pointer of expectedPointers) {
        const src = pointerToEnglish[pointer];
        const out = translated[pointer];
        if (
          typeof out !== "string" ||
          looksUntranslated({ sourceEnglish: src, translatedValue: out, targetLang })
        ) {
          unchangedCount += 1;
        }
      }

      if (unchangedCount === expectedPointers.length) {
        throw new Error(`UNTRANSLATED: ${unchangedCount}/${expectedPointers.length} values look unchanged`);
      }

      return translated;
    }

    lastError = new Error(`Gemini API error (${result.status}): ${result.rawText.slice(0, 500)}`);
  }

  throw lastError ?? new Error("Gemini API request failed");
}

async function withRetry(fn, { maxAttempts = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const delayMs = Math.min(10_000, 500 * 2 ** (attempt - 1));
      if (attempt < maxAttempts && /(UNTRANSLATED|429|503|timeout|ECONNRESET|ETIMEDOUT)/i.test(message)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function runTranslate(config, cliOverrides = {}) {
  const { projectRoot, localesDir, defaultNs, translate } = config;

  const sourceLang = cliOverrides.sourceLang ?? translate.sourceLang;
  const langs = cliOverrides.langs ?? translate.targetLangs;
  const model = cliOverrides.model ?? translate.model;
  const chunkSize = cliOverrides.chunkSize ?? translate.chunkSize;
  const preview = cliOverrides.preview ?? 10;
  const dryRun = Boolean(cliOverrides.dryRun);
  const force = Boolean(cliOverrides.force);
  const max = cliOverrides.max;

  if (!langs || langs.length === 0) {
    throw new Error(
      "No target languages configured. Set translate.targetLangs in your config, or pass --langs ar,ch.",
    );
  }

  const localesRoot = path.join(projectRoot, localesDir);
  const sourceDir = path.join(localesRoot, sourceLang);
  const sourceFiles = (await readdir(sourceDir)).filter((f) => f.endsWith(".json"));
  if (sourceFiles.length === 0) {
    throw new Error(`No JSON namespaces found in ${sourceDir}`);
  }

  const missingByLang = new Map();
  const missingExamples = new Map();

  const apiKey = dryRun ? "" : process.env.AI_KEY;
  if (!dryRun && !apiKey) {
    throw new Error("AI_KEY is not set. Example: AI_KEY=... i18n-ai-extract-translate translate");
  }

  const resolvedModel = dryRun ? "" : await resolveSupportedModel({ apiKey, requestedModel: model });
  if (!dryRun && !resolvedModel) {
    throw new Error("Could not resolve a supported Gemini model. Try passing --model <modelName>.");
  }
  if (!dryRun && model === "auto") {
    process.stdout.write(`[gemini] auto-selected model: ${resolvedModel}\n`);
  }

  for (const lang of langs) {
    if (lang === sourceLang) continue;

    const targetDir = path.join(localesRoot, lang);
    await mkdir(targetDir, { recursive: true });

    for (const fileName of sourceFiles) {
      const sourcePath = path.join(sourceDir, fileName);
      const targetPath = path.join(targetDir, fileName);

      const sourceJson = await readJson(sourcePath);
      let targetJson = {};
      try {
        targetJson = await readJson(targetPath);
      } catch {
        targetJson = {};
      }

      const sourceLeaves = collectStringLeaves(sourceJson);
      const pending = [];
      let autoCopiedCountForFile = 0;
      let placeholderEmptyCountForFile = 0;

      for (const { pointer, value } of sourceLeaves) {
        if (typeof value !== "string" || value.length === 0) continue;

        const current = getAtPointer(targetJson, pointer);
        const isClearlyUntranslated =
          typeof current === "string" &&
          current.trim() !== "" &&
          looksUntranslated({ sourceEnglish: value, translatedValue: current, targetLang: lang });
        const shouldTranslate =
          force ||
          current == null ||
          (typeof current === "string" && current.trim() === "") ||
          isClearlyUntranslated;

        if (shouldTranslate) {
          if (isLikelyNonTranslatableToken(value)) {
            if (!dryRun) {
              const canWriteDirectly =
                force || current == null || (typeof current === "string" && current.trim() === "");
              if (canWriteDirectly) {
                setAtPointer(targetJson, pointer, value);
                autoCopiedCountForFile += 1;
              }
            }
            continue;
          }

          if (!dryRun) {
            const canSetEmptyPlaceholder =
              current == null ||
              (typeof current === "string" && current.trim() === "") ||
              isClearlyUntranslated;
            if (canSetEmptyPlaceholder) {
              setAtPointer(targetJson, pointer, "");
              placeholderEmptyCountForFile += 1;
            }
          }

          pending.push({ pointer, value });
        }
      }

      if (!dryRun && (autoCopiedCountForFile > 0 || placeholderEmptyCountForFile > 0)) {
        process.stdout.write(
          `[${lang}] ${fileName}: auto-copied ${autoCopiedCountForFile} non-translatable values, set ${placeholderEmptyCountForFile} missing placeholders\n`,
        );
        await writeJson(targetPath, targetJson);
      }

      if (pending.length === 0) continue;

      const limitedPending = typeof max === "number" ? pending.slice(0, max) : pending;

      if (dryRun) {
        const key = `${lang}:${fileName}`;
        missingByLang.set(key, (missingByLang.get(key) ?? 0) + limitedPending.length);
        if (preview > 0) {
          const existing = missingExamples.get(key) ?? [];
          const remaining = Math.max(0, preview - existing.length);
          if (remaining > 0) {
            missingExamples.set(key, existing.concat(limitedPending.slice(0, remaining)));
          }
        }
        continue;
      }

      const targetLanguage = languageDisplayName(lang);
      const chunks = chunkArray(limitedPending, chunkSize);

      let updatedCountForFile = 0;
      let receivedCountForFile = 0;

      for (const [chunkIndex, chunk] of chunks.entries()) {
        process.stdout.write(
          `[${lang}] ${fileName}: translating chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} items)\n`,
        );

        for (const item of chunk.slice(0, Math.min(5, chunk.length))) {
          process.stdout.write(`  - ${pointerToKey(item.pointer)} => ${previewText(item.value)}\n`);
        }

        const pointerToEnglish = Object.fromEntries(chunk.map((x) => [x.pointer, x.value]));

        let translated = {};
        try {
          translated = await withRetry(
            async (attempt) =>
              translatePointersWithGemini({
                apiKey,
                model: resolvedModel,
                targetLang: lang,
                targetLanguage,
                pointerToEnglish,
                attempt,
              }),
            { maxAttempts: 5 },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/UNTRANSLATED/i.test(message)) {
            process.stdout.write(
              `[${lang}] ${fileName}: WARNING: could not translate this chunk after retries; skipping\n`,
            );
            await writeJson(targetPath, targetJson);
            continue;
          }
          throw err;
        }

        receivedCountForFile += Object.keys(translated).length;
        let skippedUntranslated = 0;
        for (const [pointer, translatedValue] of Object.entries(translated)) {
          if (typeof translatedValue !== "string") continue;

          const src = pointerToEnglish[pointer];
          const sanitizedValue = sanitizeTranslation({ sourceEnglish: src, translatedValue });

          if (looksUntranslated({ sourceEnglish: src, translatedValue: sanitizedValue, targetLang: lang })) {
            skippedUntranslated += 1;
            continue;
          }

          const current = getAtPointer(targetJson, pointer);
          const canWrite =
            force ||
            current == null ||
            (typeof current === "string" && current.trim() === "") ||
            (typeof current === "string" &&
              current.trim() !== "" &&
              looksUntranslated({
                sourceEnglish: pointerToEnglish[pointer],
                translatedValue: current,
                targetLang: lang,
              }));
          if (!canWrite) continue;
          setAtPointer(targetJson, pointer, sanitizedValue);
          updatedCountForFile += 1;
        }

        if (skippedUntranslated > 0) {
          process.stdout.write(
            `[${lang}] ${fileName}: skipped ${skippedUntranslated} untranslated values (model returned English)\n`,
          );
        }

        process.stdout.write(`[${lang}] ${fileName}: chunk ${chunkIndex + 1}/${chunks.length} done\n`);

        await writeJson(targetPath, targetJson);
        process.stdout.write(`[${lang}] ${fileName}: saved progress (${updatedCountForFile} updated so far)\n`);
      }

      if (updatedCountForFile === 0) {
        process.stdout.write(
          `[${lang}] ${fileName}: no keys updated (received ${receivedCountForFile} results). Use --force to overwrite existing values.\n`,
        );
      }

      process.stdout.write(`[${lang}] ${fileName}: written ${targetPath} (${updatedCountForFile} updated)\n`);
    }
  }

  if (dryRun) {
    const entries = [...missingByLang.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
      console.log("No missing translations found.");
      return;
    }
    console.log("Missing translations (dry-run):");
    for (const [k, v] of entries) {
      console.log(`- ${k}: ${v}`);
      const examples = missingExamples.get(k);
      if (examples && examples.length > 0) {
        for (const ex of examples) {
          console.log(`  - ${pointerToKey(ex.pointer)} => ${previewText(ex.value)}`);
        }
      }
    }
  }
}
