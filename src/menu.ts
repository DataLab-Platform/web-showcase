/**
 * Welcome menu of the showcase, opened when the page has no playing
 * parameter (see :func:`isMenuRequested`): the operator chooses the demos
 * and the playing options, as in the Showcase mode dialog of DataLab
 * desktop, then presses Start.
 *
 * The menu opens at once: DataLab Web boots behind it (its status is
 * shown), the native demos are listed immediately and the demos of the
 * application plugins once DataLab Web lists them (:meth:`setDemos`).
 * The choices are remembered (``./settings``); deselected demos are
 * remembered as such, so that a new demo is selected by default.
 *
 * On Start, the page URL becomes the kiosk link of the choices: any reload
 * (every N loops, after an error, by the browser) plays them again without
 * the menu.
 */

import type { ShowcaseScenario } from "./engine";
import { t } from "./i18n";
import { MAX_RELOAD_EVERY, saveSettings, type MenuSettings } from "./settings";
import {
  PACE_SPEEDS,
  PACES,
  playUrl,
  SUPPORTED_LOCALES,
  type Locale,
  type Pace,
} from "./options";
import type { SetupChoice, ShowcaseSetup } from "./player";

/** Logo of the menu (``public/DataLab.svg``, next to the host page). */
const LOGO_URL = `${import.meta.env.BASE_URL}DataLab.svg`;

/** Language names, in their own language. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "Français",
};

const PACE_LABELS: Record<Pace, () => string> = {
  slow: () => t("Slow"),
  normal: () => t("Normal"),
  fast: () => t("Fast"),
};

export interface WelcomeMenuOptions {
  /** Remembered settings. */
  settings: MenuSettings;
  /** Language of the showcase. */
  locale: Locale;
  /** Demos listed at once (the native ones). */
  demos: readonly ShowcaseScenario[];
  /** Host page URL, the base of the kiosk link (``app`` kept). */
  hostHref: string;
  /** Open the menu again in another language (the language of DataLab Web
   *  is set when it loads). */
  onLanguage(locale: Locale): void;
  save?(settings: MenuSettings): void;
  /** Replace the page URL (default ``history.replaceState``). */
  replaceUrl?(href: string): void;
  /** Show the page full screen (default ``requestFullscreen``, which needs
   *  the click on Start). */
  requestFullscreen?(): void;
}

interface DemoEntry {
  id: string;
  title: string;
  subtitle: string;
}

function entry(scenario: ShowcaseScenario): DemoEntry {
  return {
    id: scenario.id.toLowerCase(),
    title: scenario.title(),
    subtitle: scenario.subtitle?.() ?? "",
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function checkbox(label: string, checked: boolean): HTMLLabelElement {
  const row = element("label", "showcase-menu-check");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  row.append(input, element("span", "", label));
  return row;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const row = element("label", "showcase-menu-field");
  row.append(element("span", "showcase-menu-label", label), control);
  return row;
}

function select<T extends string>(
  values: readonly T[],
  label: (value: T) => string,
  current: T,
): HTMLSelectElement {
  const el = document.createElement("select");
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label(value);
    el.appendChild(option);
  }
  el.value = current;
  return el;
}

export class WelcomeMenu implements ShowcaseSetup {
  readonly choice: Promise<SetupChoice>;
  private resolveChoice!: (choice: SetupChoice) => void;
  private readonly root: HTMLDivElement;
  private readonly demoList: HTMLUListElement;
  private readonly demoNote: HTMLDivElement;
  private readonly loop: HTMLInputElement;
  private readonly reload: HTMLInputElement;
  private readonly pace: HTMLSelectElement;
  private readonly fullscreen: HTMLInputElement;
  private readonly controls: HTMLInputElement;
  private readonly language: HTMLSelectElement;
  private readonly link: HTMLInputElement;
  private readonly copyNote: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly start: HTMLButtonElement;
  /** Ids of the deselected demos, listed or not (see ``./settings``). */
  private readonly excluded: Set<string>;
  private demos: DemoEntry[];
  private lastFocus: HTMLElement | null = null;
  private closed = false;
  private readonly onBlur = () => this.keepFocus();

  constructor(private readonly opts: WelcomeMenuOptions) {
    this.choice = new Promise((resolve) => (this.resolveChoice = resolve));
    const settings = opts.settings;
    this.excluded = new Set(settings.excluded);
    this.demos = opts.demos.map(entry);

    this.root = element("div", "showcase-menu");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "showcase-menu-title");
    const form = element("form", "showcase-menu-panel");
    form.noValidate = true;
    this.root.appendChild(form);

    const header = element("header", "showcase-menu-header");
    const logo = element("img", "showcase-menu-logo");
    logo.src = LOGO_URL;
    logo.alt = "";
    const heading = element("div", "");
    const title = element("h1", "showcase-menu-title", t("Showcase mode"));
    title.id = "showcase-menu-title";
    heading.append(
      element("div", "showcase-menu-kicker", t("DataLab Web · live demo")),
      title,
    );
    header.append(logo, heading);
    form.append(
      header,
      element(
        "p",
        "showcase-menu-intro",
        t(
          "Play automated live demos of DataLab Web, for example on a conference booth screen.",
        ),
      ),
      element(
        "p",
        "showcase-menu-hotkeys",
        t(
          "While the demos play: F9 pauses (twice: at once), Shift+F12 stops after the demo (twice: at once), → next step, End next demo, Home restart, + / − pace, Esc quits once stopped.",
        ),
      ),
    );

    const body = element("div", "showcase-menu-body");
    const demos = element("fieldset", "showcase-menu-demos");
    demos.appendChild(element("legend", "", t("Demos")));
    this.demoList = element("ul", "showcase-menu-demo-list");
    this.demoNote = element(
      "div",
      "showcase-menu-note",
      t("Looking for application plugins…"),
    );
    demos.append(this.demoList, this.demoNote);

    const options = element("fieldset", "showcase-menu-options");
    options.appendChild(element("legend", "", t("Options")));
    const loopRow = checkbox(t("Loop"), settings.loop);
    this.loop = loopRow.querySelector("input")!;
    this.reload = document.createElement("input");
    this.reload.type = "number";
    this.reload.min = "0";
    this.reload.max = String(MAX_RELOAD_EVERY);
    this.reload.step = "1";
    this.reload.value = String(settings.reloadEvery);
    const reloadRow = field(t("Reload every N loops (0: never)"), this.reload);
    reloadRow.classList.add("showcase-menu-sub");
    this.pace = select(PACES, (pace) => PACE_LABELS[pace](), settings.pace);
    const fullscreenRow = checkbox(t("Full screen"), settings.fullscreen);
    fullscreenRow.title = t(
      "The browser leaves full screen when the page reloads: on an unattended booth, prefer the kiosk link.",
    );
    this.fullscreen = fullscreenRow.querySelector("input")!;
    const controlsRow = checkbox(t("Control bar"), settings.controls);
    controlsRow.title = t(
      "Shows the operator's controls when the mouse moves while the demos play.",
    );
    this.controls = controlsRow.querySelector("input")!;
    this.language = select(
      SUPPORTED_LOCALES,
      (locale) => LANGUAGE_NAMES[locale],
      opts.locale,
    );
    options.append(
      loopRow,
      reloadRow,
      field(t("Pace"), this.pace),
      fullscreenRow,
      controlsRow,
      field(t("Language"), this.language),
    );
    body.append(demos, options);
    form.appendChild(body);

    const kiosk = element("div", "showcase-menu-kiosk");
    this.link = element("input", "showcase-menu-link");
    this.link.type = "text";
    this.link.readOnly = true;
    this.link.spellcheck = false;
    const copy = element("button", "showcase-menu-copy", t("Copy"));
    copy.type = "button";
    this.copyNote = element("span", "showcase-menu-copied");
    this.copyNote.setAttribute("aria-live", "polite");
    const linkRow = element("div", "showcase-menu-link-row");
    linkRow.append(this.link, copy);
    kiosk.append(
      field(t("Kiosk link"), linkRow),
      element(
        "div",
        "showcase-menu-note",
        t(
          "Plays these choices without this menu, e.g. on an unattended booth with chrome --kiosk.",
        ),
      ),
      this.copyNote,
    );
    form.appendChild(kiosk);

    const footer = element("footer", "showcase-menu-footer");
    this.status = element("div", "showcase-menu-status");
    this.status.setAttribute("aria-live", "polite");
    this.status.textContent = t("DataLab Web is starting…");
    this.start = element("button", "showcase-menu-start", t("Start"));
    this.start.type = "submit";
    footer.append(this.status, this.start);
    form.appendChild(footer);

    this.renderDemos();
    this.update();
    form.addEventListener("change", (event) => this.onChange(event));
    form.addEventListener("input", () => this.update());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.onStart();
    });
    copy.addEventListener("click", () => void this.copyLink());
    form.addEventListener("focusin", (event) => {
      this.lastFocus = event.target as HTMLElement;
    });
    window.addEventListener("blur", this.onBlur);
    document.body.appendChild(this.root);
    this.start.focus({ preventScroll: true });
  }

  /** Whether the menu is shown. */
  get isOpen(): boolean {
    return !this.closed;
  }

  setStatus(text: string, ready = false): void {
    if (this.closed) return;
    this.status.textContent = text;
    this.status.classList.toggle("showcase-menu-status--ready", ready);
  }

  setDemos(scenarios: readonly ShowcaseScenario[]): void {
    if (this.closed) return;
    this.demos = scenarios.map(entry);
    this.demoNote.remove();
    this.renderDemos();
    this.update();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("blur", this.onBlur);
    this.root.remove();
  }

  /** Settings of the current choices. */
  settings(): MenuSettings {
    const text = this.reload.value.trim();
    const reload = text === "" ? Number.NaN : Number(text);
    return {
      excluded: [...this.excluded].sort(),
      loop: this.loop.checked,
      pace: this.pace.value as Pace,
      fullscreen: this.fullscreen.checked,
      reloadEvery:
        Number.isInteger(reload) && reload >= 0 && reload <= MAX_RELOAD_EVERY
          ? reload
          : this.opts.settings.reloadEvery,
      controls: this.controls.checked,
      lang: this.language.value as Locale,
    };
  }

  /** Kiosk link of the current choices. */
  kioskLink(): string {
    const settings = this.settings();
    return playUrl(this.opts.hostHref, {
      skip: settings.excluded,
      loop: settings.loop,
      speed: PACE_SPEEDS[settings.pace],
      reloadEvery: settings.reloadEvery,
      controls: settings.controls,
      lang: this.opts.locale,
    });
  }

  private renderDemos(): void {
    this.demoList.textContent = "";
    for (const demo of this.demos) {
      const item = element("li", "");
      const row = checkbox(demo.title, !this.excluded.has(demo.id));
      row.querySelector("input")!.dataset.demo = demo.id;
      if (demo.subtitle) {
        row.appendChild(element("small", "", demo.subtitle));
      }
      item.appendChild(row);
      this.demoList.appendChild(item);
    }
  }

  private onChange(event: Event): void {
    const target = event.target;
    if (target === this.language) {
      this.save();
      this.opts.onLanguage(this.language.value as Locale);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.demo) {
      if (target.checked) this.excluded.delete(target.dataset.demo);
      else this.excluded.add(target.dataset.demo);
    }
    this.update();
  }

  /** Start, the kiosk link and the reload period follow the choices. */
  private update(): void {
    this.start.disabled = !this.demos.some(
      (demo) => !this.excluded.has(demo.id),
    );
    this.reload.disabled = !this.loop.checked;
    this.link.value = this.kioskLink();
    this.copyNote.textContent = "";
  }

  private save(): MenuSettings {
    const settings = this.settings();
    (this.opts.save ?? saveSettings)(settings);
    return settings;
  }

  private onStart(): void {
    if (this.closed || this.start.disabled) return;
    // Full screen needs the operator's click: requested before anything
    // else.
    if (this.fullscreen.checked) {
      if (this.opts.requestFullscreen) this.opts.requestFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => {});
    }
    const settings = this.save();
    const link = this.kioskLink();
    if (this.opts.replaceUrl) this.opts.replaceUrl(link);
    else window.history.replaceState(window.history.state, "", link);
    this.close();
    this.resolveChoice({
      skip: settings.excluded,
      loop: settings.loop,
      speed: PACE_SPEEDS[settings.pace],
      reloadEvery: settings.reloadEvery,
      controls: settings.controls,
    });
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link.value);
      this.copyNote.textContent = t("Link copied.");
    } catch {
      this.link.focus();
      this.link.select();
      this.copyNote.textContent = t("Press Ctrl+C to copy the link.");
    }
  }

  /** The demos are listed by clicks in DataLab Web, behind the menu: the
   *  keyboard focus comes back to the menu. */
  private keepFocus(): void {
    window.setTimeout(() => {
      if (
        this.closed ||
        !(document.activeElement instanceof HTMLIFrameElement)
      ) {
        return;
      }
      (this.lastFocus ?? this.start).focus({ preventScroll: true });
    }, 0);
  }
}
