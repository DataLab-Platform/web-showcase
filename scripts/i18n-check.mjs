#!/usr/bin/env node
/**
 * Check the French catalog of the showcase captions: every ``t("…")`` key
 * of ``src/`` must be translated in ``src/locales/fr.json`` (error); keys
 * no longer used are reported (warning).
 *
 * Usage: node scripts/i18n-check.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "src";
const CATALOG = join(SOURCE, "locales", "fr.json");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** String literal arguments of ``t(…)`` calls (first argument). */
function usedKeys(source) {
  const keys = new Set();
  const pattern = /\bt\(\s*("(?:[^"\\]|\\.)*")/g;
  for (const match of source.matchAll(pattern)) {
    keys.add(JSON.parse(match[1]));
  }
  return keys;
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const used = new Set();
for (const file of sourceFiles(SOURCE)) {
  for (const key of usedKeys(readFileSync(file, "utf8"))) used.add(key);
}

const missing = [...used].filter((key) => !(key in catalog)).sort();
const unused = Object.keys(catalog)
  .filter((key) => !used.has(key))
  .sort();

for (const key of unused) console.warn(`unused French translation: ${key}`);
for (const key of missing) console.error(`missing French translation: ${key}`);
console.log(
  `${used.size} captions, ${Object.keys(catalog).length} French translations, ` +
    `${missing.length} missing, ${unused.length} unused`,
);
process.exit(missing.length > 0 ? 1 : 0);
