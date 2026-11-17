import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RELOAD_EVERY } from "../../src/options";
import {
  defaultSettings,
  loadSettings,
  parseSettings,
  saveSettings,
  SETTINGS_KEY,
} from "../../src/settings";

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(entries));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe("menu settings", () => {
  it("defaults to every demo once, full screen, as in DataLab desktop", () => {
    expect(loadSettings(memoryStorage())).toEqual({
      excluded: [],
      loop: false,
      pace: "normal",
      fullscreen: true,
      reloadEvery: DEFAULT_RELOAD_EVERY,
      lang: null,
    });
  });

  it("round-trips through the storage", () => {
    const storage = memoryStorage();
    const settings = {
      excluded: ["app:org.example.app", "w4"],
      loop: true,
      pace: "fast" as const,
      fullscreen: false,
      reloadEvery: 0,
      lang: "fr" as const,
    };
    expect(saveSettings(settings, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("replaces invalid values by their default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseSettings({
        excluded: ["W4", " w4 ", 3],
        loop: "yes",
        pace: "turbo",
        fullscreen: false,
        reloadEvery: 1.5,
        lang: "de",
        unknown: 1,
      }),
    ).toEqual({ ...defaultSettings(), fullscreen: false });
    expect(parseSettings({ excluded: ["W4", " w4 ", ""] }).excluded).toEqual([
      "w4",
    ]);
    expect(parseSettings({ reloadEvery: 100 }).reloadEvery).toBe(
      DEFAULT_RELOAD_EVERY,
    );
    expect(parseSettings([1, 2])).toEqual(defaultSettings());
    warn.mockRestore();
  });

  it("opens with the defaults when the storage is corrupted or denied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      loadSettings(memoryStorage({ [SETTINGS_KEY]: "{not json" })),
    ).toEqual(defaultSettings());
    const denied = memoryStorage();
    denied.getItem = () => {
      throw new Error("SecurityError");
    };
    denied.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(loadSettings(denied)).toEqual(defaultSettings());
    expect(saveSettings(defaultSettings(), denied)).toBe(false);
    expect(loadSettings(null)).toEqual(defaultSettings());
    warn.mockRestore();
  });
});
