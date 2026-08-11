#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { runExtract } from "../src/extract.mjs";
import { runTranslate } from "../src/translate.mjs";
import { runAll } from "../src/all.mjs";

function printUsage() {
  console.log(`i18n-ai-extract-translate <command> [options]

Commands:
  extract [--backend-only] [--frontend-only]
      Scan source files for t("...") / <Trans> usages and write new keys
      into the locale JSON files. With a backend.enabled config, also mines
      a Python backend for hard-coded error strings.

  translate [--provider gemini|vertex] [--langs ar,ch] [--source eng]
            [--model auto] [--chunk 40] [--max N] [--preview N]
            [--dry-run] [--force] [--project <gcp-project>] [--location us-central1]
      Fills in missing/empty locale entries using AI.
        --provider gemini (default): needs AI_KEY in the environment.
        --provider vertex: needs translate.vertex.project (or --project) and
          Google Cloud credentials (VERTEX_ACCESS_TOKEN, or
          GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key,
          or gcloud auth application-default login).
      Neither is required with --dry-run.

  all
      Runs extract, then translate (only if AI_KEY is set).

Config:
  Reads i18n-ai-extract-translate.config.{mjs,js,cjs,json} from the current
  working directory. See README.md for the full schema.
`);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const config = await loadConfig({ cwd: process.cwd() });

  if (command === "extract") {
    await runExtract(config, {
      backendOnly: Boolean(flags["backend-only"]),
      frontendOnly: Boolean(flags["frontend-only"]),
    });
    return;
  }

  if (command === "translate") {
    await runTranslate(config, {
      provider: typeof flags.provider === "string" ? flags.provider : undefined,
      langs: typeof flags.langs === "string" ? flags.langs.split(",").map((s) => s.trim()) : undefined,
      sourceLang: typeof flags.source === "string" ? flags.source : undefined,
      model: typeof flags.model === "string" ? flags.model : undefined,
      chunkSize: typeof flags.chunk === "string" ? Number(flags.chunk) : undefined,
      max: typeof flags.max === "string" ? Number(flags.max) : undefined,
      preview: typeof flags.preview === "string" ? Number(flags.preview) : undefined,
      dryRun: Boolean(flags["dry-run"]),
      force: Boolean(flags.force),
      project: typeof flags.project === "string" ? flags.project : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
    });
    return;
  }

  if (command === "all") {
    await runAll(config);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
