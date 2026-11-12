import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fr from "../../src/locales/fr.json";
import {
  appLabels,
  formatNumber,
  getLocale,
  isAppLabel,
  setLocale,
  t,
} from "../../src/i18n";

afterEach(() => setLocale("en"));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("captions", () => {
  it("are English keys, translated to French", () => {
    expect(t("Try DataLab Web now")).toBe("Try DataLab Web now");
    setLocale("fr");
    expect(getLocale()).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(t("Try DataLab Web now")).not.toBe("Try DataLab Web now");
    expect(t("Not a caption")).toBe("Not a caption");
  });

  it("interpolate their placeholders", () => {
    expect(t("Step {n}", { n: 3 })).toBe("Step 3");
    expect(t("Example: {title}", { other: 1 })).toBe("Example: {title}");
    setLocale("fr");
    expect(t("Step {n}", { n: 3 })).toContain("3");
  });

  it("format numbers in the active language", () => {
    expect(formatNumber(14.54)).toBe("14.5");
    setLocale("fr");
    expect(formatNumber(14.54)).toBe("14,5");
  });

  it("are all translated to French", () => {
    const missing: string[] = [];
    const pattern = /\bt\(\s*("(?:[^"\\]|\\.)*")/g;
    for (const file of sourceFiles("src")) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        const key = JSON.parse(match[1]) as string;
        if (!(key in fr)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keep their placeholders in French", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(fr)) {
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});

describe("DataLab Web labels", () => {
  it("match in English and in French", () => {
    expect(appLabels("Close")).toEqual(["Close", "Fermer"]);
    expect(appLabels("OK")).toEqual(["OK"]);
    expect(appLabels("Unknown label")).toEqual(["Unknown label"]);
    expect(appLabels("Created {count} objects", { count: 4 })).toEqual([
      "Created 4 objects",
      "4 objets créés",
    ]);
    expect(isAppLabel("  Fermer ", "Close")).toBe(true);
    expect(isAppLabel("Close", "Cancel")).toBe(false);
    expect(isAppLabel(null, "Close")).toBe(false);
  });
});
