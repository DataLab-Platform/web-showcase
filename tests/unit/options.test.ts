import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELOAD_EVERY,
  frameUrl,
  isMenuRequested,
  normalizeLocale,
  parseShowcaseParams,
  playUrl,
  resolveAppUrl,
  resolveLocale,
} from "../../src/options";

describe("URL parameters", () => {
  it("plays every demo once at normal pace by default", () => {
    expect(parseShowcaseParams("")).toEqual({
      ids: null,
      skip: [],
      loop: false,
      speed: 1,
      check: false,
      reloadEvery: DEFAULT_RELOAD_EVERY,
      close: false,
      lang: null,
      app: null,
    });
    expect(parseShowcaseParams("?demos=all").ids).toBeNull();
  });

  it("selects demos, without duplicates, case-insensitively", () => {
    expect(
      parseShowcaseParams("?demos=W1,app:org.example.App, w3,w1").ids,
    ).toEqual(["w1", "app:org.example.app", "w3"]);
    expect(parseShowcaseParams("?demos=,").ids).toBeNull();
  });

  it("leaves demos out with skip", () => {
    expect(
      parseShowcaseParams("?skip=W4, app:org.example.App,w4").skip,
    ).toEqual(["w4", "app:org.example.app"]);
    expect(parseShowcaseParams("?skip=").skip).toEqual([]);
  });

  it("opens the welcome menu without any playing parameter", () => {
    for (const search of ["", "?lang=fr", "?app=%2Fweb-dev%2F&lang=en"]) {
      expect(isMenuRequested(search)).toBe(true);
    }
    for (const search of [
      "?demos=all",
      "?skip=w4",
      "?loop=1&lang=fr",
      "?speed=0.7",
      "?check=1",
      "?close=1",
      "?reload=0",
      "?demos=",
    ]) {
      expect(isMenuRequested(search)).toBe(false);
    }
  });

  it("loops, paces and reloads", () => {
    const options = parseShowcaseParams("?loop=1&speed=0.5&reload=3");
    expect(options).toMatchObject({ loop: true, speed: 0.5, reloadEvery: 3 });
    expect(parseShowcaseParams("?loop=yes").loop).toBe(true);
    expect(parseShowcaseParams("?loop=0").loop).toBe(false);
    expect(parseShowcaseParams("?reload=0").reloadEvery).toBe(0);
    expect(parseShowcaseParams("?reload=-2").reloadEvery).toBe(
      DEFAULT_RELOAD_EVERY,
    );
    expect(parseShowcaseParams("?reload=1.5").reloadEvery).toBe(
      DEFAULT_RELOAD_EVERY,
    );
    expect(parseShowcaseParams("?speed=fast").speed).toBe(1);
    expect(parseShowcaseParams("?speed=-1").speed).toBe(1);
  });

  it("selects the check mode with speed=0 or check=1 (single pass)", () => {
    for (const search of ["?speed=0", "?check=1", "?check=true&speed=2"]) {
      const options = parseShowcaseParams(`${search}&loop=1&close=1`);
      expect(options).toMatchObject({
        check: true,
        speed: 0,
        loop: false,
        close: false,
      });
    }
  });

  it("closes the window after a single pass with close=1", () => {
    expect(parseShowcaseParams("?close=1&loop=1")).toMatchObject({
      close: true,
      loop: false,
    });
  });

  it("reads the language and the DataLab Web address", () => {
    expect(parseShowcaseParams("?lang=fr-FR").lang).toBe("fr");
    expect(parseShowcaseParams("?lang=de").lang).toBeNull();
    expect(parseShowcaseParams("?app=%2Fweb-dev%2F").app).toBe("/web-dev/");
    expect(parseShowcaseParams("?app=").app).toBeNull();
  });
});

describe("language", () => {
  it("normalizes tags", () => {
    expect(normalizeLocale("fr_FR.UTF-8")).toBe("fr");
    expect(normalizeLocale("EN-us")).toBe("en");
    expect(normalizeLocale("es")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });

  it("prefers the URL, then DataLab Web, then the browser", () => {
    expect(resolveLocale("en", "fr", ["fr-FR"])).toBe("en");
    expect(resolveLocale(null, "fr", ["en-US"])).toBe("fr");
    expect(resolveLocale(null, null, ["de-DE", "fr-FR", "en"])).toBe("fr");
    expect(resolveLocale(null, "xx", ["de"])).toBe("en");
  });
});

describe("DataLab Web address", () => {
  const host = "https://datalab-platform.com/web-showcase/?loop=1";

  it("defaults to DataLab Web next to the host page", () => {
    const result = resolveAppUrl(null, host);
    expect(result.ok && result.url.href).toBe(
      "https://datalab-platform.com/web/",
    );
  });

  it("accepts another DataLab Web of the same origin", () => {
    const result = resolveAppUrl("/web-preview/index.html#x", host);
    expect(result.ok && result.url.href).toBe(
      "https://datalab-platform.com/web-preview/index.html",
    );
  });

  it("refuses another origin and other protocols", () => {
    expect(resolveAppUrl("https://example.com/web/", host)).toEqual({
      ok: false,
      url: "https://example.com/web/",
      reason: "cross-origin",
    });
    expect(
      resolveAppUrl("http://datalab-platform.com/web/", host),
    ).toMatchObject({ ok: false, reason: "cross-origin" });
    expect(resolveAppUrl("javascript:alert(1)", host)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("passes the language and the host origin to DataLab Web", () => {
    const url = frameUrl(
      new URL("https://datalab-platform.com/web/?runtime=worker"),
      "fr",
      "https://datalab-platform.com",
    );
    expect(url.searchParams.get("runtime")).toBe("worker");
    expect(url.searchParams.get("lang")).toBe("fr");
    expect(url.searchParams.get("allowedOrigins")).toBe(
      "https://datalab-platform.com",
    );
  });
});

describe("kiosk link", () => {
  const choice = {
    skip: [] as string[],
    loop: false,
    speed: 1,
    reloadEvery: DEFAULT_RELOAD_EVERY,
    lang: "en" as const,
  };

  it("plays the choices at once, the defaults left out", () => {
    const href = playUrl("https://datalab-platform.com/web-showcase/", choice);
    expect(href).toBe(
      "https://datalab-platform.com/web-showcase/?demos=all&lang=en",
    );
    expect(isMenuRequested(new URL(href).search)).toBe(false);
  });

  it("gives every option back, readable", () => {
    const href = playUrl(
      "https://datalab-platform.com/web-showcase/?lang=en&app=%2Fweb-dev%2F#x",
      {
        skip: ["w2", "app:org.example.app"],
        loop: true,
        speed: 0.7,
        reloadEvery: 0,
        lang: "fr",
      },
    );
    expect(href).toBe(
      "https://datalab-platform.com/web-showcase/?demos=all&skip=w2,app:org.example.app&loop=1&reload=0&speed=0.7&lang=fr&app=/web-dev/",
    );
    expect(parseShowcaseParams(new URL(href).search)).toMatchObject({
      ids: null,
      skip: ["w2", "app:org.example.app"],
      loop: true,
      speed: 0.7,
      reloadEvery: 0,
      lang: "fr",
      app: "/web-dev/",
    });
  });

  it("keeps the reload period for a loop only", () => {
    const href = playUrl("http://localhost/web-showcase/", {
      ...choice,
      reloadEvery: 3,
    });
    expect(new URL(href).searchParams.has("reload")).toBe(false);
  });
});
