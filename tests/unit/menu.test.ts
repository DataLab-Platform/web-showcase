import { afterEach, describe, expect, it } from "vitest";
import type { ShowcaseScenario } from "../../src/engine";
import { WelcomeMenu, type WelcomeMenuOptions } from "../../src/menu";
import { defaultSettings, type MenuSettings } from "../../src/settings";

function demo(id: string, title = id.toUpperCase()): ShowcaseScenario {
  return {
    id,
    title: () => title,
    subtitle: () => `About ${id}`,
    run: async () => {},
  };
}

const NATIVE = ["w1", "w2", "w3", "w4"].map((id) => demo(id));
const APP = demo("app:org.example.app", "Example application");
const NEW_APP = demo("app:org.other.app", "Other application");
const ALL = [NATIVE[0], APP, NATIVE[1], NEW_APP, NATIVE[2], NATIVE[3]];
const HOST = "https://datalab-platform.com/web-showcase/";

function openMenu(settings: Partial<MenuSettings> = {}) {
  const calls = {
    saved: [] as MenuSettings[],
    urls: [] as string[],
    fullscreen: 0,
    languages: [] as string[],
  };
  const options: WelcomeMenuOptions = {
    settings: { ...defaultSettings(), ...settings },
    locale: "en",
    demos: NATIVE,
    hostHref: HOST,
    onLanguage: (lang) => calls.languages.push(lang),
    save: (saved) => calls.saved.push(saved),
    replaceUrl: (href) => calls.urls.push(href),
    requestFullscreen: () => calls.fullscreen++,
  };
  return { menu: new WelcomeMenu(options), calls };
}

function $<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

const demoBox = (id: string) => $<HTMLInputElement>(`input[data-demo="${id}"]`);
const startButton = () => $<HTMLButtonElement>(".showcase-menu-start");
const link = () => $<HTMLInputElement>(".showcase-menu-link").value;
const checked = () =>
  [...document.querySelectorAll<HTMLInputElement>("input[data-demo]")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.demo);

function labelled(text: string): HTMLInputElement | HTMLSelectElement {
  const label = [...document.querySelectorAll("label")].find((el) =>
    el.textContent?.startsWith(text),
  );
  const control = label?.querySelector<HTMLInputElement | HTMLSelectElement>(
    "input, select",
  );
  if (!control) throw new Error(`no control labelled ${text}`);
  return control;
}

function change(
  control: HTMLInputElement | HTMLSelectElement,
  value: boolean | string,
): void {
  if (typeof value === "boolean") (control as HTMLInputElement).checked = value;
  else control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
  document.body.textContent = "";
});

describe("welcome menu", () => {
  it("lists the native demos at once, then the application demos", () => {
    const { menu } = openMenu({ excluded: ["w4", "app:org.example.app"] });
    expect(checked()).toEqual(["w1", "w2", "w3"]);
    expect(demoBox("w4").checked).toBe(false);
    expect(document.body.textContent).toContain(
      "Looking for application plugins…",
    );
    change(demoBox("w2"), false);

    menu.setDemos(ALL);
    // Deselected demos stay so, a new demo is selected by default.
    expect(checked()).toEqual(["w1", "app:org.other.app", "w3"]);
    expect(demoBox("app:org.example.app").checked).toBe(false);
    expect(document.body.textContent).not.toContain(
      "Looking for application plugins…",
    );
  });

  it("enables Start while a listed demo is selected", () => {
    const { menu } = openMenu();
    for (const scenario of NATIVE) change(demoBox(scenario.id), false);
    expect(startButton().disabled).toBe(true);
    menu.setDemos(ALL);
    expect(startButton().disabled).toBe(false);
    change(demoBox("app:org.example.app"), false);
    change(demoBox("app:org.other.app"), false);
    expect(startButton().disabled).toBe(true);
  });

  it("starts with the choices, remembered, the kiosk link as page URL", async () => {
    const { menu, calls } = openMenu({ excluded: ["app:gone"] });
    change(demoBox("w2"), false);
    change(labelled("Loop"), true);
    change(labelled("Reload every"), "0");
    change(labelled("Pace"), "fast");
    startButton().click();

    const skip = ["app:gone", "w2"];
    await expect(menu.choice).resolves.toEqual({
      skip,
      loop: true,
      speed: 0.7,
      reloadEvery: 0,
    });
    expect(calls.saved).toEqual([
      {
        excluded: skip,
        loop: true,
        pace: "fast",
        fullscreen: true,
        reloadEvery: 0,
        lang: "en",
      },
    ]);
    expect(calls.urls).toEqual([
      `${HOST}?demos=all&skip=app:gone,w2&loop=1&reload=0&speed=0.7&lang=en`,
    ]);
    expect(calls.fullscreen).toBe(1);
    expect(menu.isOpen).toBe(false);
    expect(document.querySelector(".showcase-menu")).toBeNull();
  });

  it("keeps the kiosk link in step, the reload period for a loop only", () => {
    const { calls } = openMenu({ fullscreen: false });
    expect(link()).toBe(`${HOST}?demos=all&lang=en`);
    const reload = labelled("Reload every");
    expect(reload.disabled).toBe(true);
    change(labelled("Loop"), true);
    expect(reload.disabled).toBe(false);
    expect(link()).toBe(`${HOST}?demos=all&loop=1&lang=en`);
    change(reload, "abc");
    expect(link()).toBe(`${HOST}?demos=all&loop=1&lang=en`);
    startButton().click();
    expect(calls.fullscreen).toBe(0);
  });

  it("opens again in the language chosen, the choices kept", () => {
    const { calls } = openMenu();
    change(demoBox("w3"), false);
    change(labelled("Language"), "fr");
    expect(calls.languages).toEqual(["fr"]);
    expect(calls.saved).toMatchObject([{ excluded: ["w3"], lang: "fr" }]);
  });

  it("asks to copy the link by hand when the clipboard is unavailable", async () => {
    openMenu();
    $<HTMLButtonElement>(".showcase-menu-copy").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect($(".showcase-menu-copied").textContent).toBe(
      "Press Ctrl+C to copy the link.",
    );
    expect(document.activeElement).toBe($(".showcase-menu-link"));
  });
});
