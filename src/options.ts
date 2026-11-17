/**
 * URL parameters of the host page (pure functions, unit-tested).
 *
 *   ``demos=all`` (default) or ``demos=w1,w3,app:<plugin id>``: demos to play;
 *   ``skip=w4,app:<plugin id>``: demos left out of them;
 *   ``loop=1``: play them again and again;
 *   ``speed=0.7``: pace multiplier (``speed=0`` or ``check=1``: check mode,
 *   a fast functional test without overlays);
 *   ``lang=en|fr``: language of the captions, also passed to DataLab Web;
 *   ``reload=N``: reload the page every N loops (default 5, 0 = never);
 *   ``close=1``: one pass, then close the window (DataLab desktop interlude);
 *   ``app=<url>``: DataLab Web to drive (same origin only, default
 *   ``../web/``).
 *
 * Without any playing parameter (:data:`PLAY_PARAMETERS`), the page opens
 * the welcome menu instead (see ``./menu``).
 */

export type Locale = "en" | "fr";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr"];

/** Parameters starting the demos at once, without the welcome menu
 *  (``lang`` and ``app`` also apply to the menu). */
export const PLAY_PARAMETERS = [
  "demos",
  "skip",
  "loop",
  "speed",
  "check",
  "close",
  "reload",
] as const;

/** Paces of the welcome menu and their ``speed``, as in DataLab desktop. */
export const PACE_SPEEDS = { slow: 1.5, normal: 1, fast: 0.7 } as const;

export type Pace = keyof typeof PACE_SPEEDS;

export const PACES = Object.keys(PACE_SPEEDS) as Pace[];

/** Default number of loops between two page reloads (loop only). */
export const DEFAULT_RELOAD_EVERY = 5;

/** DataLab Web next to the host page (``/web-showcase/`` → ``/web/``). */
export const DEFAULT_APP_URL = "../web/";

/** First DataLab Web release with the automation hooks of the showcase
 *  (``data-action-id`` on menu entries, ``data-plugin-id`` in the
 *  Applications window). */
export const MIN_DATALAB_WEB_VERSION = "0.11.1";

export interface ShowcaseOptions {
  /** Ids of the demos to play, in playlist order; ``null`` plays all. */
  ids: string[] | null;
  /** Ids of the demos left out of ``ids`` (unknown ones are ignored). */
  skip: string[];
  /** Play the selection again and again. */
  loop: boolean;
  /** Pace multiplier of every pause and pointer motion (1 = normal). */
  speed: number;
  /** Check mode: no pauses, no overlays, a single pass, results published
   *  in ``window.__showcase`` (``check=1`` or ``speed=0``). */
  check: boolean;
  /** Reload the page every N loops to start afresh (loop only; 0 = never). */
  reloadEvery: number;
  /** Close the window after one pass (``close=1``): a "web interlude" opened
   *  by DataLab desktop in a dedicated app window. Implies a single pass. */
  close: boolean;
  /** Language requested by the URL (``null``: the visitor's preference). */
  lang: Locale | null;
  /** DataLab Web URL requested by the URL (``null``: the default one). */
  app: string | null;
}

function isTrue(value: string | null): boolean {
  return (
    value !== null &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}

/** Supported locale of a BCP-47/POSIX tag (``fr-FR`` → ``fr``), if any. */
export function normalizeLocale(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_.]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as Locale)
    : null;
}

/** Demo ids of a comma-separated list, in lower case, without duplicates. */
function parseIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .toLowerCase()
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/** Whether the page opens the welcome menu: no playing parameter. */
export function isMenuRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  return !PLAY_PARAMETERS.some((name) => params.has(name));
}

/** Parse the URL parameters of the host page (``location.search``). */
export function parseShowcaseParams(search: string): ShowcaseOptions {
  const params = new URLSearchParams(search);
  const raw = (params.get("demos") ?? "").trim().toLowerCase();
  const ids = ["", "all", "1", "true", "yes", "on"].includes(raw)
    ? null
    : parseIds(raw);
  const speedValue = Number(params.get("speed"));
  const speed =
    params.has("speed") && Number.isFinite(speedValue) && speedValue >= 0
      ? speedValue
      : 1;
  const check = isTrue(params.get("check")) || speed === 0;
  const close = !check && isTrue(params.get("close"));
  const reloadValue = Number(params.get("reload"));
  const app = params.get("app")?.trim() || null;
  return {
    ids: ids && ids.length > 0 ? ids : null,
    skip: parseIds(params.get("skip") ?? ""),
    loop: !check && !close && isTrue(params.get("loop")),
    speed: check ? 0 : speed,
    check,
    reloadEvery:
      params.has("reload") && Number.isInteger(reloadValue) && reloadValue >= 0
        ? reloadValue
        : DEFAULT_RELOAD_EVERY,
    close,
    lang: normalizeLocale(params.get("lang")),
    app,
  };
}

/**
 * Language of the showcase: the ``lang`` parameter, else the language the
 * visitor chose in DataLab Web (same origin, same ``localStorage``), else
 * the browser preferences, else English.
 */
export function resolveLocale(
  requested: Locale | null,
  stored: string | null,
  languages: readonly string[],
): Locale {
  if (requested) return requested;
  const fromStore = normalizeLocale(stored);
  if (fromStore) return fromStore;
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

export type AppUrlResult =
  | { ok: true; url: URL }
  | { ok: false; url: string; reason: "invalid" | "cross-origin" };

/**
 * DataLab Web URL (``app`` parameter, resolved against the host page): the
 * host page drives DataLab Web through ``iframe.contentDocument``, which
 * the browser only allows for a document of the same origin.
 */
export function resolveAppUrl(
  app: string | null,
  hostHref: string,
): AppUrlResult {
  const raw = app ?? DEFAULT_APP_URL;
  let url: URL;
  try {
    url = new URL(raw, hostHref);
  } catch {
    return { ok: false, url: raw, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, url: url.href, reason: "invalid" };
  }
  if (url.origin !== new URL(hostHref).origin) {
    return { ok: false, url: url.href, reason: "cross-origin" };
  }
  url.hash = "";
  return { ok: true, url };
}

/**
 * URL loaded in the iframe: DataLab Web with the showcase language
 * (``lang``) and the host origin allowed to use its remote-control bridge
 * (``allowedOrigins``, read-only queries of the workspace content).
 */
export function frameUrl(app: URL, locale: Locale, hostOrigin: string): URL {
  const url = new URL(app.href);
  url.searchParams.set("lang", locale);
  url.searchParams.set("allowedOrigins", hostOrigin);
  return url;
}

/** Choices of the welcome menu, as URL parameters (see :func:`playUrl`). */
export interface PlayChoice {
  skip: readonly string[];
  loop: boolean;
  speed: number;
  reloadEvery: number;
  lang: Locale;
}

/** URL-encode ``value``, keeping the demo ids and paths readable. */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/%(2C|3A|2F)/gi, (escape) =>
    decodeURIComponent(escape),
  );
}

/**
 * Kiosk link of the welcome menu choices: the host page URL (``app`` and
 * other parameters kept) playing them at once, without the menu.
 */
export function playUrl(hostHref: string, choice: PlayChoice): string {
  const url = new URL(hostHref);
  const kept = new URLSearchParams(url.search);
  for (const name of [...PLAY_PARAMETERS, "lang"]) kept.delete(name);
  const params: [string, string][] = [["demos", "all"]];
  if (choice.skip.length > 0) params.push(["skip", choice.skip.join(",")]);
  if (choice.loop) {
    params.push(["loop", "1"]);
    if (choice.reloadEvery !== DEFAULT_RELOAD_EVERY) {
      params.push(["reload", String(choice.reloadEvery)]);
    }
  }
  if (choice.speed !== 1) params.push(["speed", String(choice.speed)]);
  params.push(["lang", choice.lang], ...kept);
  url.search = params
    .map(([name, value]) => `${encodeParam(name)}=${encodeParam(value)}`)
    .join("&");
  url.hash = "";
  return url.href;
}
