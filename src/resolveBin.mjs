import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the executable script for a dependency's CLI without relying on
 * PATH or node_modules/.bin hoisting — works whether this package is used
 * directly or installed as a dependency of another project.
 */
export function resolveBin(pkgName, { cwd = process.cwd() } = {}) {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`, {
    paths: [cwd, process.cwd(), thisDir],
  });
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = require(pkgJsonPath);

  const binField = pkgJson.bin;
  if (!binField) {
    throw new Error(`Package "${pkgName}" does not expose a bin entry`);
  }

  const binRelPath =
    typeof binField === "string" ? binField : Object.values(binField)[0];

  return path.join(pkgDir, binRelPath);
}
