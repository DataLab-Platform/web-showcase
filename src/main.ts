/**
 * DataLab Web Showcase: a static host page that embeds DataLab Web in a
 * full-window, same-origin iframe and plays automated live demos on top of
 * it (conference booths, kiosks, DataLab desktop "web interlude").
 */

import "./showcase.css";
import { AppFrame } from "./frame";
import { setLocale, t } from "./i18n";
import {
  frameUrl,
  parseShowcaseParams,
  resolveAppUrl,
  resolveLocale,
} from "./options";
import { ShowcaseOverlay } from "./overlay";
import { ShowcasePlayer } from "./player";

function storedAppLanguage(): string | null {
  try {
    return window.localStorage.getItem("datalab-web:lang");
  } catch {
    return null;
  }
}

function start(): void {
  const options = parseShowcaseParams(window.location.search);
  const locale = resolveLocale(
    options.lang,
    storedAppLanguage(),
    navigator.languages ?? [navigator.language],
  );
  setLocale(locale);
  document.title = `DataLab Web · ${t("Showcase")}`;

  const overlay = new ShowcaseOverlay();
  const app = resolveAppUrl(options.app, window.location.href);
  if (!app.ok) {
    const reason =
      app.reason === "cross-origin"
        ? t(
            "DataLab Web must be served from the same origin as this page ({origin}): {url} cannot be driven.",
            { origin: window.location.origin, url: app.url },
          )
        : t("Invalid DataLab Web address: {url}", { url: app.url });
    window.__showcase = {
      state: "error",
      options,
      loop: 0,
      current: null,
      playlist: [],
      results: [],
      typing: { execCommand: 0, editorView: 0, corrections: 0, refused: 0 },
      checks: {},
      error: reason,
    };
    console.error(`[showcase] ${reason}`);
    overlay.mount();
    overlay.setMode("idle");
    overlay.card(
      {
        kicker: t("DataLab Web · live demo"),
        title: t("The showcase cannot start"),
        subtitle: reason,
      },
      "error",
    );
    return;
  }

  const frame = new AppFrame(
    document.body,
    frameUrl(app.url, locale, window.location.origin),
  );
  void new ShowcasePlayer(frame, options, overlay).play();
}

start();
