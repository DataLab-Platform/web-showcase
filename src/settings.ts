/**
 * Settings of the welcome menu, remembered in the browser storage
 * (``localStorage``, key :data:`SETTINGS_KEY`), apart from the settings of
 * DataLab Web, which share the same origin and storage.
 *
 * As in DataLab desktop (``showcase.json``), a missing, unreadable or
 * corrupted entry gives the default settings, and an invalid value gives
 * the default value of its setting: the menu always opens.
 */

import {
  DEFAULT_RELOAD_EVERY,
  PACES,
  SUPPORTED_LOCALES,
  type Locale,
  type Pace,
} from "./options";

/** ``localStorage`` key of the settings. */
export const SETTINGS_KEY = "datalab-web-showcase.settings";

/** Largest number of loops between two page reloads offered by the menu. */
export const MAX_RELOAD_EVERY = 99;

export interface MenuSettings {
  /** Ids (lower case) of the demos deselected in the menu, including
   *  demos not listed anymore (e.g. a removed application plugin): a new
   *  demo is selected by default. */
  excluded: string[];
  /** Play the demos in a loop. */
  loop: boolean;
  pace: Pace;
  /** Show the showcase full screen when it starts. */
  fullscreen: boolean;
  /** Reload the page every N loops (0: never). */
  reloadEvery: number;
  /** Language chosen in the menu (``null``: the visitor's preference). */
  lang: Locale | null;
}

export function defaultSettings(): MenuSettings {
  return {
    excluded: [],
    loop: false,
    pace: "normal",
    fullscreen: true,
    reloadEvery: DEFAULT_RELOAD_EVERY,
    lang: null,
  };
}

const VALID: {
  [K in keyof MenuSettings]: (value: unknown) => boolean;
} = {
  excluded: (value) =>
    Array.isArray(value) && value.every((id) => typeof id === "string"),
  loop: (value) => typeof value === "boolean",
  pace: (value) => (PACES as unknown[]).includes(value),
  fullscreen: (value) => typeof value === "boolean",
  reloadEvery: (value) =>
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_RELOAD_EVERY,
  lang: (value) =>
    value === null || (SUPPORTED_LOCALES as unknown[]).includes(value),
};

/** Settings of ``data`` (e.g. parsed from the storage), the missing or
 *  invalid values replaced by their default. */
export function parseSettings(data: unknown): MenuSettings {
  const settings = defaultSettings();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return settings;
  }
  const values = data as Record<string, unknown>;
  for (const name of Object.keys(VALID) as (keyof MenuSettings)[]) {
    if (!(name in values)) continue;
    const value = values[name];
    if (VALID[name](value)) {
      Object.assign(settings, { [name]: value });
    } else {
      console.warn(
        `[showcase] invalid menu setting ignored: ${name}=${JSON.stringify(value)}`,
      );
    }
  }
  settings.excluded = [
    ...new Set(settings.excluded.map((id) => id.trim().toLowerCase())),
  ].filter(Boolean);
  return settings;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(
  storage: Storage | null = browserStorage(),
): MenuSettings {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SETTINGS_KEY) ?? null;
  } catch {
    // Storage denied (privacy settings): defaults.
  }
  if (raw === null) return defaultSettings();
  try {
    return parseSettings(JSON.parse(raw));
  } catch {
    console.warn("[showcase] corrupted menu settings: defaults used");
    return defaultSettings();
  }
}

/** Save the settings; returns ``false`` (logged) when the storage refuses
 *  them. */
export function saveSettings(
  settings: MenuSettings,
  storage: Storage | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn("[showcase] menu settings not saved", error);
    return false;
  }
}
