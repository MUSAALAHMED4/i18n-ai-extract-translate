import { readFile } from "node:fs/promises";
import path from "node:path";
import { runExtract } from "./extract.mjs";
import { runTranslate } from "./translate.mjs";

function collectLeafStrings(obj, prefix = "") {
  if (typeof obj === "string") return [{ key: prefix, value: obj }];
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(...collectLeafStrings(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

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

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

export async function runAll(config) {
  const { projectRoot, localesDir, defaultLng, defaultNs } = config;
  const defaultLocalePath = path.join(projectRoot, localesDir, defaultLng, `${defaultNs}.json`);

  const before = await readJson(defaultLocalePath);

  console.log("Running extract...");
  await runExtract(config);

  const after = await readJson(defaultLocalePath);

  const beforeKeys = new Set(collectLeafStrings(before).map((x) => x.key));
  const extracted = collectLeafStrings(after)
    .filter((x) => !beforeKeys.has(x.key))
    .sort((a, b) => a.key.localeCompare(b.key));

  console.log("\nExtraction complete.");
  if (extracted.length === 0) {
    console.log("No new strings were extracted.");
  } else {
    console.log(`Extracted ${extracted.length} new strings:`);
    for (const item of extracted) {
      console.log(`- ${item.key} => ${previewText(item.value)}`);
    }
  }

  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.log("\nNo AI_KEY detected. Skipping AI translation.");
    return;
  }

  console.log("\nAI key detected. Running AI translation...");
  await runTranslate(config);

  console.log("\nThe texts were extracted and the translations were added.");
}
