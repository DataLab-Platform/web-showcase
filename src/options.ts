/**
 * URL parameters of the host page (pure functions, unit-tested).
 *
 *   ``demos=all`` (default) or ``demos=w1,w3,app:<plugin id>``: demos to play;
 *   ``loop=1``: play them again and again;
 *   ``speed=0.7``: pace multiplier (``speed=0`` or ``check=1``: check mode,
 *   a fast functional test without overlays);
 *   ``lang=en|fr``: language of the captions, also passed to DataLab Web;
 *   ``reload=N``: reload the page every N loops (default 5, 0 = never);
 *   ``close=1``: one pass, then close the window (DataLab desktop interlude);
 *   ``app=<url>``: DataLab Web to drive (same origin only, default
 *   ``../web/``).
 */

export type Locale = "en" | "fr";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr"];

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

/** Parse the URL parameters of the host page (``location.search``). */
export function parseShowcaseParams(search: string): ShowcaseOptions {
  const params = new URLSearchParams(search);
  const raw = (params.get("demos") ?? "").trim().toLowerCase();
  const ids = ["", "all", "1", "true", "yes", "on"].includes(raw)
    ? null
    : [
        ...new Set(
          raw
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
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
