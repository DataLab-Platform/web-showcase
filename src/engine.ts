/**
 * Engine of the showcase: drives DataLab Web, in its same-origin iframe,
 * the way a visitor would. A fake pointer (drawn by the host page above the
 * iframe) glides to each target, which then receives realistic
 * pointer/mouse/keyboard events built with the constructors of the iframe
 * realm (so React handlers, the hover-driven menus and CodeMirror editors
 * react as with a real user), with readable pauses, captions, title cards
 * and spotlighting.
 *
 * Authoring conventions:
 *
 *   * interact through the context (``ctx.click``, ``ctx.clickMenuPath``,
 *     ``ctx.type``…) so that the audience sees what happens;
 *   * name menus, menu items and tabs so that they work in any UI language:
 *     top menus by their ``data-menu-top`` key, menu actions by their
 *     ``data-action-id`` (e.g. ``"file.capsule"``), tabs and buttons by
 *     their English label (see ``appLabels``);
 *   * every caption goes through ``t()`` (English is the key; add the French
 *     translation to ``src/locales/fr.json``);
 *   * verify progress with ``ctx.checkpoint(cond, message)`` (throws);
 *   * throw :class:`ScenarioSkipped` when a prerequisite is missing.
 *
 * In check mode (``speed === 0``) there are no pauses, no overlays and no
 * pointer animation: the same code then runs as a fast functional test
 * (``npm run showcase:check``).
 */

import { CodeMirrorTyper, editorElement } from "./codemirror";
import { AppBridge, AppFrame, type FrameWindow, type Point } from "./frame";
import { appLabels, isAppLabel, t } from "./i18n";
import type { ShowcaseOverlay } from "./overlay";
import {
  PauseController,
  ShowcaseAborted,
  sleep,
  throwIfAborted,
} from "./pause";

export { ShowcaseAborted };
export type { Point };

/** Throw from a scenario to skip it gracefully (missing prerequisite). */
export class ScenarioSkipped extends Error {
  constructor(reason = "scenario skipped") {
    super(reason);
    this.name = "ScenarioSkipped";
  }
}

/** Raised by :meth:`ShowcaseContext.checkpoint`. */
export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

/** One showcase demo. Texts are functions so that they follow the current
 *  language. */
export interface ShowcaseScenario {
  /** Stable identifier, used by ``?demos=<id>,…`` (e.g. ``"w1"``). */
  id: string;
  title(): string;
  subtitle?(): string;
  /** Optional warm-up, run once before the first demo (e.g. wait for the
   *  notebook kernel). */
  prewarm?(ctx: ShowcaseContext): Promise<void>;
  /** Play the demo. The workspace is empty and the Signals panel shown. */
  run(ctx: ShowcaseContext): Promise<void>;
}

/** Element, CSS selector (first visible match) or element getter. */
export type Target = Element | string | (() => Element | null | undefined);

export interface SayOptions {
  /** Caption position (default ``"bottom"``). */
  position?: "top" | "bottom";
}

export interface PointerOptions {
  /** Jump instead of gliding (no animation). */
  instant?: boolean;
}

export interface ShowcaseContextOptions {
  /** Pace multiplier (1 = normal); 0 selects the check mode. */
  speed: number;
  check?: boolean;
  /** Overlays (caption, cards, pointer); none in check mode. */
  overlay?: ShowcaseOverlay | null;
  pause?: PauseController;
  /** Aborts every wait when the showcase is quit. */
  signal?: AbortSignal;
}

/** Public deployment of DataLab Web and DataLab desktop website. */
export const PUBLIC_WEB_URL = "datalab-platform.com/web";
export const DESKTOP_URL = "datalab-platform.com";

/** Action of DataLab Web starting a new, empty and untitled workspace
 *  (File > New workspace), used between demos when available. */
export const NEW_WORKSPACE_ACTION = "file.new_workspace";

const DEFAULT_TIMEOUT_MS = 15_000;
const ELLIPSIS = /\s*(?:…|\.\.\.)$/;

// ---------------------------------------------------------------------------
// DOM helpers (realm-independent: the elements belong to the iframe)
// ---------------------------------------------------------------------------

/** Window of the document of ``node``. */
export function windowOf(node: Node): FrameWindow {
  const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
  const win = doc?.defaultView;
  if (!win) throw new Error("The element has no window (detached document)");
  return win as FrameWindow;
}

export function isElement(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Node).nodeType === 1 &&
    typeof (value as Element).getBoundingClientRect === "function"
  );
}

export function isHTMLElement(value: unknown): value is HTMLElement {
  return (
    isElement(value) && value.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
}

/** Rendered and not hidden (zero-size elements count as hidden). */
export function isVisible(el: unknown): el is HTMLElement {
  if (!isHTMLElement(el) || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  return windowOf(el).getComputedStyle(el).visibility !== "hidden";
}

function isDisabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true"
  );
}

/** Element text, whitespace collapsed. */
export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function describeElement(el: Element): string {
  const content = text(el).slice(0, 40);
  const cls = el.classList.length ? `.${[...el.classList].join(".")}` : "";
  return `<${el.tagName.toLowerCase()}${cls}>${content ? ` "${content}"` : ""}`;
}

function describeTarget(target: unknown): string {
  if (typeof target === "string") return `"${target}"`;
  if (isElement(target)) return describeElement(target);
  return "a condition";
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Centre of ``el`` (iframe viewport coordinates). */
export function center(el: Element): Point {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function isPoint(target: unknown): target is Point {
  return (
    typeof target === "object" &&
    target !== null &&
    !isElement(target) &&
    typeof (target as Partial<Point>).x === "number"
  );
}

function normalizeLabel(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().replace(ELLIPSIS, "");
}

/**
 * Whether a menu item (``li.menu-item``) matches ``name``: a string matches
 * the action id of leaf actions (``data-action-id``, e.g.
 * ``"file.capsule"``), their menu path (``title`` ending with
 * ``/<name>``) or the displayed label, in English or French (trailing
 * ellipsis ignored); a RegExp is tested against the displayed label.
 */
export function menuItemMatches(item: Element, name: string | RegExp): boolean {
  const label = normalizeLabel(
    item.querySelector(":scope > .menu-label")?.textContent,
  );
  if (typeof name !== "string") return name.test(label);
  if (item.getAttribute("data-action-id") === name.trim()) return true;
  const base = normalizeLabel(name);
  const path = item.getAttribute("title");
  if (path) {
    const full = normalizeLabel(path);
    if (full === base || full.endsWith(`/${base}`)) return true;
  }
  return appLabels(base).map(normalizeLabel).includes(label);
}

/** Parse a key combination such as ``"Control+k"`` or ``"Shift+Enter"``. */
export function parseKeys(keys: string): KeyboardEventInit {
  const parts = keys === "+" ? ["+"] : keys.split("+");
  const key = parts.pop() || keys;
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  let code = key;
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  else if (key === " ") code = "Space";
  return {
    key,
    code,
    ctrlKey: mods.has("control") || mods.has("ctrl"),
    shiftKey: mods.has("shift"),
    altKey: mods.has("alt"),
    metaKey: mods.has("meta"),
  };
}

/** Dispatch a pointer or mouse event of the iframe realm on ``el``. */
export function fire(
  el: Element,
  type: string,
  point: Point,
  init: MouseEventInit = {},
): void {
  const win = windowOf(el);
  const options: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: 0,
    ...init,
  };
  if (type.startsWith("pointer")) {
    if (typeof win.PointerEvent === "function") {
      el.dispatchEvent(
        new win.PointerEvent(type, {
          ...options,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    }
  } else {
    el.dispatchEvent(new win.MouseEvent(type, options));
  }
}

/** ``el`` and its ancestors, up to (excluding) the first one containing
 *  ``stop``. */
function ancestorsOutside(el: Element, stop: Element | null): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (stop && node.contains(stop)) break;
    chain.push(node);
  }
  return chain;
}

/**
 * Dispatch the events of a real pointer moving from ``from`` to ``to``
 * (out/leave then over/enter). React derives ``onMouseEnter`` and
 * ``onMouseLeave`` from ``mouseout``/``mouseover`` and their
 * ``relatedTarget``, so hover-driven menus open as with a real mouse.
 */
export function dispatchHoverTransition(
  from: Element | null,
  to: Element | null,
  point: Point,
): void {
  const prev = from && from.isConnected ? from : null;
  const leave = { bubbles: false, cancelable: false, relatedTarget: to };
  const enter = { bubbles: false, cancelable: false, relatedTarget: prev };
  if (prev) {
    fire(prev, "pointerout", point, { relatedTarget: to });
    fire(prev, "mouseout", point, { relatedTarget: to });
    for (const el of ancestorsOutside(prev, to)) {
      fire(el, "pointerleave", point, leave);
      fire(el, "mouseleave", point, leave);
    }
  }
  if (to) {
    fire(to, "pointerover", point, { relatedTarget: prev });
    fire(to, "mouseover", point, { relatedTarget: prev });
    for (const el of ancestorsOutside(to, prev).reverse()) {
      fire(el, "pointerenter", point, enter);
      fire(el, "mouseenter", point, enter);
    }
  }
}

/**
 * Insert ``value`` at the caret of an input or textarea the way typing does:
 * native value setter of the iframe realm (so React notices the change)
 * and an ``input`` event.
 */
export function insertIntoField(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const win = windowOf(field);
  let start = field.value.length;
  let end = start;
  try {
    start = field.selectionStart ?? start;
    end = field.selectionEnd ?? start;
  } catch {
    // Some input types (number, email) have no selection API.
  }
  const next = field.value.slice(0, start) + value + field.value.slice(end);
  setFieldValue(field, next);
  try {
    field.setSelectionRange(start + value.length, start + value.length);
  } catch {
    // No selection API: the caret stays at the end.
  }
  field.dispatchEvent(
    new win.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }),
  );
}

/** Set the value of a form field with the native setter (React-friendly). */
export function setFieldValue(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const win = windowOf(field);
  const proto =
    field.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : field.tagName === "SELECT"
        ? win.HTMLSelectElement.prototype
        : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
}

/** Empty an input the way select-all + delete does. */
export function clearField(field: HTMLInputElement): void {
  setFieldValue(field, "");
  field.dispatchEvent(
    new (windowOf(field).InputEvent)("input", {
      bubbles: true,
      inputType: "deleteContent",
    }),
  );
}

function isTextField(
  el: Element,
): el is HTMLInputElement | HTMLTextAreaElement {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

/** Keystrokes of ``value``: its characters, a run of line breaks being one
 *  keystroke (CodeMirror drops a line break typed on an empty line with
 *  ``execCommand("insertText")``, not a run of them typed at once). */
export function typingChunks(value: string): string[] {
  const chunks: string[] = [];
  for (const char of Array.from(value)) {
    const last = chunks.length - 1;
    if (char === "\n" && last >= 0 && /^\n+$/.test(chunks[last])) {
      chunks[last] += char;
    } else {
      chunks.push(char);
    }
  }
  return chunks;
}

/** Next animation frame of the host page, or ~16 ms when it does not paint
 *  (hidden or occluded window, where ``requestAnimationFrame`` stalls). */
function nextFrame(signal?: AbortSignal): Promise<void> {
  if (document.hidden || typeof requestAnimationFrame !== "function") {
    return sleep(16, signal);
  }
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 40);
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve();
    });
  }).then(() => throwIfAborted(signal));
}

/** Top-level menus searched first for an action id, by id prefix. */
const ACTION_MENU_HINTS: [RegExp, string][] = [
  [/^file\./, "File"],
  [/^edit\./, "Edit"],
  [/^view\./, "View"],
  [/^(image_)?roi\./, "ROI"],
  [/^analysis\./, "Analysis"],
  [/^create\./, "Create"],
  [/^help\./, "Help"],
  [/^plugins\./, "Plugins"],
];

// ---------------------------------------------------------------------------
// Showcase context
// ---------------------------------------------------------------------------

/** Everything a scenario needs to play a readable live demo. */
export class ShowcaseContext {
  readonly frame: AppFrame;
  /** Read-only queries of the workspace (remote-control bridge). */
  readonly bridge: AppBridge;
  /** Pace multiplier (0 in check mode). */
  readonly speed: number;
  /** Check mode: no pauses, no overlays, no pointer animation. */
  readonly check: boolean;
  readonly pause: PauseController;
  readonly signal: AbortSignal | undefined;
  /** Scenario being played (set by the player). */
  scenario: ShowcaseScenario | null = null;
  /** Checks of the visitor's state, published in ``window.__showcase``. */
  checks: Record<string, boolean> = {};

  private readonly overlay: ShowcaseOverlay | null;
  private stepCount = 0;
  private pointer: Point | null = null;
  private hovered: Element | null = null;
  /** Mouse buttons held during a :meth:`drag` (``buttons`` of the moves). */
  private buttons = 0;
  /** Menu path of the actions searched in the menus (top key, submenus),
   *  ``null`` for the actions no menu holds. */
  private readonly actionPaths = new Map<string, string[] | null>();
  /** DataLab Web was just (re)loaded: nothing to reset. */
  private fresh = false;
  /** Deferred reload of DataLab Web under way (see :meth:`reloadApp`). */
  private pendingReload: Promise<void> | null = null;

  constructor(
    frame: AppFrame,
    bridge: AppBridge,
    opts: ShowcaseContextOptions,
  ) {
    this.frame = frame;
    this.bridge = bridge;
    this.check = opts.check === true || opts.speed === 0;
    this.speed = this.check ? 0 : Math.max(0.05, opts.speed);
    this.overlay = this.check ? null : (opts.overlay ?? null);
    this.pause = opts.pause ?? new PauseController();
    this.signal = opts.signal;
  }

  /** Document of DataLab Web (the iframe). */
  get doc(): Document {
    return this.frame.doc;
  }

  /** Window of DataLab Web, with the constructors of its realm. */
  get win(): FrameWindow {
    return this.frame.win;
  }

  log(message: string): void {
    const tag = this.scenario ? `showcase:${this.scenario.id}` : "showcase";
    console.info(`[${tag}] ${message}`);
  }

  // -- Timing ----------------------------------------------------------------

  /** Readable pause of ``ms`` (scaled by the pace; none in check mode).
   *  Frozen while the operator has paused the showcase (F9). */
  async hold(ms = 750): Promise<void> {
    if (this.check) {
      throwIfAborted(this.signal);
      return;
    }
    await this.pause.hold(ms * this.speed, this.signal);
  }

  /** Short real delay letting React re-render after an event. */
  settle(): Promise<void> {
    return sleep(this.check ? 30 : 60, this.signal);
  }

  /** Real delay of ``ms`` (not scaled by the pace, also in check mode),
   *  e.g. for a debounced save of DataLab Web. */
  delay(ms: number): Promise<void> {
    return sleep(ms, this.signal);
  }

  /**
   * Wait until ``target`` is satisfied: a CSS selector resolves to its first
   * visible match in DataLab Web, a function to its first truthy result
   * (polled every 50 ms). Throws after ``timeoutMs``.
   */
  async waitFor(
    target: string,
    timeoutMs?: number,
    description?: string,
  ): Promise<HTMLElement>;
  async waitFor<T>(
    target: () => T | null | undefined | false,
    timeoutMs?: number,
    description?: string,
  ): Promise<T>;
  async waitFor<T>(
    target: string | (() => T | null | undefined | false),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    description?: string,
  ): Promise<T | HTMLElement> {
    const probe =
      typeof target === "string" ? () => this.visible(target) : target;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(this.signal);
      let value: T | HTMLElement | null | undefined | false = null;
      try {
        value = probe();
      } catch (error) {
        // The document may be replaced while it loads.
        if (error instanceof ShowcaseAborted) throw error;
      }
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for ` +
            (description ?? describeTarget(target)),
        );
      }
      await sleep(50, this.signal);
    }
  }

  /**
   * Fail the demo with ``message`` unless ``condition`` holds (a function
   * may be async; with ``timeoutMs``, it is polled until then).
   */
  async checkpoint(
    condition: boolean | (() => unknown),
    message: string,
    timeoutMs = 0,
  ): Promise<void> {
    const probe = typeof condition === "function" ? condition : () => condition;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(this.signal);
      let ok: boolean;
      try {
        ok = Boolean(await probe());
      } catch {
        ok = false;
      }
      if (ok) return;
      if (Date.now() >= deadline) throw new CheckpointError(message);
      await sleep(100, this.signal);
    }
  }

  // -- Captions, cards, spotlight ----------------------------------------------

  /** Show (or update) the caption banner, then hold ``holdMs``. */
  async say(text: string, holdMs = 2500, opts: SayOptions = {}): Promise<void> {
    this.stepCount += 1;
    this.log(text);
    if (this.overlay) {
      this.followTheme();
      const head = this.scenario
        ? `${this.scenario.title()}  ·  ${t("Step {n}", { n: this.stepCount })}`
        : "";
      this.overlay.caption(head, text, { position: opts.position });
    }
    await this.hold(holdMs);
  }

  /** Discreet caption (e.g. a demo failed and the showcase moves on). */
  async notice(text: string, holdMs = 2500): Promise<void> {
    this.log(text);
    this.overlay?.caption("", text, { position: "top", notice: true });
    await this.hold(holdMs);
    this.overlay?.clearCaption();
  }

  clearCaption(): void {
    this.overlay?.clearCaption();
  }

  /** Persistent label for the rest of the current demo (e.g. to flag a
   *  simulated session), kept across captions and removed when the demo
   *  ends; ``null`` removes it earlier. */
  label(value: string | null): void {
    if (value) this.log(`label: ${value}`);
    this.overlay?.sticker(value);
  }

  /** Full-screen title card for ``holdMs``; ``during`` runs while it is
   *  shown (the player resets the workspace behind it). */
  async titleCard(
    title: string,
    subtitle?: string,
    holdMs = 3000,
    during?: () => Promise<void>,
  ): Promise<void> {
    this.log(`title card: ${title}`);
    if (!this.overlay) {
      if (during) await during();
      return;
    }
    this.overlay.clearCaption();
    this.overlay.clearSpotlight();
    this.overlay.card({
      kicker: t("DataLab Web · live demo"),
      title,
      subtitle,
    });
    try {
      const started = Date.now();
      if (during) await during();
      const elapsed = (Date.now() - started) / this.speed;
      await this.hold(Math.max(0, holdMs - elapsed));
    } finally {
      await this.overlay.clearCard(450);
    }
  }

  /** Closing card of a loop: where to try DataLab Web and DataLab desktop
   *  (``keep`` leaves it on screen, e.g. while the window closes). */
  async endCard(holdMs = 5000, opts: { keep?: boolean } = {}): Promise<void> {
    this.log(`end card: ${PUBLIC_WEB_URL} • ${DESKTOP_URL}`);
    if (!this.overlay) return;
    this.overlay.clearAll();
    this.overlay.card({
      kicker: "DataLab",
      title: t("Try DataLab Web now"),
      subtitle: PUBLIC_WEB_URL,
      note: t("DataLab desktop: {url}", { url: DESKTOP_URL }),
    });
    let kept = false;
    try {
      await this.hold(holdMs);
      kept = opts.keep === true;
    } finally {
      if (!kept) await this.overlay.clearCard(450);
    }
  }

  /** Dim everything but ``target`` (its bounding box at call time). */
  async spotlight(target: Target, padding = 8): Promise<void> {
    const el = await this.find(target);
    if (!this.overlay) return;
    const rect = el.getBoundingClientRect();
    const origin = this.frame.toHost({ x: rect.left, y: rect.top });
    this.overlay.spotlight({
      x: origin.x - padding,
      y: origin.y - padding,
      width: rect.width + 2 * padding,
      height: rect.height + 2 * padding,
    });
  }

  clearSpotlight(): void {
    this.overlay?.clearSpotlight();
  }

  // -- DOM queries -------------------------------------------------------------

  $<E extends Element = HTMLElement>(
    selector: string,
    root: ParentNode = this.doc,
  ): E | null {
    return root.querySelector<E>(selector);
  }

  $$<E extends Element = HTMLElement>(
    selector: string,
    root: ParentNode = this.doc,
  ): E[] {
    return [...root.querySelectorAll<E>(selector)];
  }

  /** First visible element matching ``selector``. */
  visible(selector: string, root?: ParentNode): HTMLElement | null {
    return this.$$(selector, root ?? this.doc).find(isVisible) ?? null;
  }

  /** Resolve ``target`` to a visible element, waiting up to ``timeoutMs``. */
  async find(
    target: Target,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<HTMLElement> {
    if (typeof target === "string") return this.waitFor(target, timeoutMs);
    const get = isElement(target) ? () => target : target;
    return this.waitFor(
      () => {
        const el = get();
        return isVisible(el) ? el : null;
      },
      timeoutMs,
      describeTarget(target),
    );
  }

  // -- Pointer and keyboard -------------------------------------------------

  /** Glide the fake pointer to the centre of ``target`` (hovering what it
   *  crosses, like a real mouse). Points are in iframe coordinates. */
  async moveTo(
    target: Target | Point,
    opts: PointerOptions = {},
  ): Promise<void> {
    let to: Point;
    if (isPoint(target)) {
      to = target;
    } else {
      const el = await this.find(target);
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      to = center(el);
    }
    if (!this.overlay || opts.instant) {
      this.pointerAt(to);
      return;
    }
    await this.glide(to);
  }

  /** Move onto ``target`` (opens hover-driven submenus). */
  async hover(target: Target, opts: PointerOptions = {}): Promise<void> {
    await this.moveTo(target, opts);
    await this.settle();
  }

  /** Move to ``target`` visibly and click it: pointer and mouse events with
   *  real coordinates, then ``click`` (a ripple marks it on screen). */
  async click(target: Target, opts: PointerOptions = {}): Promise<void> {
    const el = await this.find(target);
    if (isDisabled(el)) {
      throw new Error(
        `Cannot click a disabled element: ${describeElement(el)}`,
      );
    }
    await this.moveTo(el, opts);
    if (this.overlay && !opts.instant) await this.hold(140);
    const point = this.pointer ?? center(el);
    this.ripple(point);
    fire(el, "pointerdown", point, { buttons: 1 });
    fire(el, "mousedown", point, { buttons: 1, detail: 1 });
    el.closest<HTMLElement>(
      "input, textarea, select, button, a[href], [tabindex], [contenteditable='true']",
    )?.focus({ preventScroll: true });
    fire(el, "pointerup", point);
    fire(el, "mouseup", point, { detail: 1 });
    fire(el, "click", point, { detail: 1 });
    await this.settle();
  }

  /**
   * Click at ``point`` (iframe coordinates) like a real mouse, for plots and
   * canvases where the position matters: the press and the release go to
   * the topmost element under the pointer at that time (a drag layer added
   * on press, as Plotly does, receives the release) and ``click`` to their
   * nearest common ancestor.
   */
  async clickAt(point: Point, opts: PointerOptions = {}): Promise<void> {
    await this.moveTo(point, opts);
    if (this.overlay && !opts.instant) await this.hold(140);
    this.ripple(point);
    const down = this.buttonDown(point);
    this.buttonUp(point, down);
    await this.settle();
  }

  /**
   * Drag like a real mouse: press at ``from``, glide to ``to`` (through
   * each point of a path) with the button held, release. Draws a shape on
   * a plot or moves a handle; targets resolve to their centre.
   */
  async drag(
    from: Target | Point,
    to: Target | Point | Point[],
    opts: PointerOptions = {},
  ): Promise<void> {
    const start = isPoint(from) ? from : center(await this.find(from));
    await this.moveTo(start, opts);
    if (this.overlay && !opts.instant) await this.hold(200);
    const path = Array.isArray(to) ? to : [to];
    const down = this.buttonDown(start);
    let end = start;
    try {
      await this.settle();
      for (const step of path) {
        end = isPoint(step) ? step : center(await this.find(step));
        await this.moveTo(end, opts);
      }
      if (this.overlay && !opts.instant) await this.hold(150);
    } finally {
      this.buttonUp(end, down);
    }
    await this.settle();
  }

  /**
   * Click ``target`` and type ``value`` at ``cps`` characters per second
   * (scaled by the pace; at once in check mode). CodeMirror editors (macros,
   * notebook cells) are typed into through ``execCommand("insertText")``,
   * checked against the expected text (see ``./codemirror``).
   */
  async type(target: Target, value: string, cps = 18): Promise<void> {
    const el = await this.find(target);
    await this.click(el);
    const editor = editorElement(el);
    if (editor) {
      // The editor may be re-rendered by the click (e.g. a notebook cell
      // becoming active): type once DataLab Web has settled.
      await this.frameIdle();
      const typer = new CodeMirrorTyper(editor, (message) => this.log(message));
      // DataLab Web keeps its editors in sync with its state: let it render
      // each keystroke before the next one (a render lagging behind the
      // editor would put an older text back).
      await this.typeChars(
        value,
        cps,
        (chunk) => typer.insert(chunk),
        () => this.frameIdle(),
      );
      await this.settle();
      typer.finish();
      await this.settle();
      return;
    }
    let insert: (chunk: string) => void;
    if (isTextField(el)) {
      el.focus();
      insert = (chunk) => insertIntoField(el, chunk);
    } else if (el.isContentEditable) {
      el.focus();
      insert = (chunk) => {
        this.doc.execCommand("insertText", false, chunk);
      };
    } else {
      throw new Error(`Cannot type into ${describeElement(el)}`);
    }
    await this.typeChars(value, cps, insert);
    // Let React re-render before the next action reads the new text.
    await this.settle();
  }

  private async typeChars(
    value: string,
    cps: number,
    insert: (chunk: string) => void,
    afterEach?: () => Promise<void>,
  ): Promise<void> {
    if (this.check) {
      insert(value);
      await afterEach?.();
      return;
    }
    const delay = (1000 / Math.max(1, cps)) * this.speed;
    for (const chunk of typingChunks(value)) {
      const started = Date.now();
      insert(chunk);
      await afterEach?.();
      await this.pause.hold(delay - (Date.now() - started), this.signal);
    }
  }

  /** Two animation frames of DataLab Web, then a task: React has rendered
   *  and run its effects (at most ~100 ms when the frame does not paint). */
  private async frameIdle(): Promise<void> {
    let win: FrameWindow;
    try {
      win = this.win;
    } catch {
      return;
    }
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 50);
        win.requestAnimationFrame(() => {
          window.clearTimeout(timer);
          resolve();
        });
      });
    }
    await sleep(0, this.signal);
  }

  /** Press a key combination (e.g. ``"Escape"``, ``"Control+k"``,
   *  ``"Shift+Enter"``) on ``target`` or the focused element. */
  async press(keys: string, target?: Target): Promise<void> {
    let el: Element = target
      ? await this.find(target)
      : (this.doc.activeElement ?? this.doc.body);
    const editor = el.closest(".cm-editor");
    if (editor) el = editor.querySelector(".cm-content") ?? el;
    const win = windowOf(el);
    const init: KeyboardEventInit = {
      ...parseKeys(keys),
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
    };
    el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    el.dispatchEvent(new win.KeyboardEvent("keyup", init));
    await this.settle();
  }

  /** Choose ``value`` in a ``<select>`` element. */
  async select(target: Target, value: string): Promise<void> {
    const el = await this.find(target);
    if (el.tagName !== "SELECT") {
      throw new Error(`Not a <select>: ${describeElement(el)}`);
    }
    await this.click(el);
    const win = windowOf(el);
    setFieldValue(el as HTMLSelectElement, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    await this.settle();
  }

  // -- Menus, dialogs, tabs, actions ------------------------------------------

  /** Top-level menu by its canonical (English) key, e.g. ``"Processing"``. */
  topMenu(key: string): HTMLElement | null {
    return this.doc.querySelector<HTMLElement>(
      `[data-menu-top="${cssString(key)}"]`,
    );
  }

  /** Keys of the top-level menus, in menu bar order. */
  topMenuKeys(): string[] {
    return this.$$("[data-menu-top]")
      .filter(isVisible)
      .map((el) => el.getAttribute("data-menu-top") ?? "")
      .filter(Boolean);
  }

  /** Open a top-level menu (hover first, click only if it did not open). */
  async openTopMenu(key: string, opts: PointerOptions = {}): Promise<void> {
    const top = await this.find(() => this.topMenu(key));
    await this.moveTo(top, opts);
    await this.settle();
    if (top.getAttribute("aria-expanded") !== "true") {
      await this.click(top, { instant: true });
    }
    if (top.getAttribute("aria-haspopup") === "true") {
      await this.waitFor(
        () => top.querySelector(":scope > .menu-dropdown"),
        5_000,
        `the ${key} menu to open`,
      );
    }
  }

  /** First visible item of the open menus matching ``name`` (see
   *  :func:`menuItemMatches`), searched in the submenu of ``parent`` (a
   *  top-level menu or a submenu item) or in every open menu. */
  menuItem(name: string | RegExp, parent?: Element): HTMLElement | null {
    const items = parent
      ? this.$$(":scope > .menu-dropdown > li.menu-item", parent)
      : this.$$(".menu-dropdown > li.menu-item");
    return (
      items.find((item) => isVisible(item) && menuItemMatches(item, name)) ??
      null
    );
  }

  /**
   * Open the ``topKey`` menu, hover the intermediate submenus and click the
   * last item, e.g. ``clickMenuPath("File", "file.capsule")``. Without
   * items, clicks the top-level entry itself.
   */
  async clickMenuPath(
    topKey: string,
    ...items: (string | RegExp)[]
  ): Promise<void> {
    await this.walkMenuPath(topKey, items, {});
  }

  private async walkMenuPath(
    topKey: string,
    items: (string | RegExp)[],
    opts: PointerOptions,
  ): Promise<void> {
    if (items.length === 0) {
      await this.click(() => this.topMenu(topKey), opts);
      return;
    }
    await this.openTopMenu(topKey, opts);
    if (!opts.instant) await this.hold(350);
    let parent: HTMLElement = await this.find(() => this.topMenu(topKey));
    for (let level = 0; level < items.length; level++) {
      const scope = parent;
      const item = await this.find(
        () => this.menuItem(items[level], scope),
        5_000,
      );
      if (this.overlay && !opts.instant) {
        await this.approachMenuItem(item, level);
      }
      if (level === items.length - 1) {
        await this.click(item, opts);
      } else {
        await this.hover(item, { instant: true });
        await this.waitFor(
          () => item.getAttribute("aria-expanded") === "true",
          3_000,
          `the "${String(items[level])}" submenu to open`,
        );
        if (!opts.instant) await this.hold(450);
        parent = item;
      }
    }
  }

  /**
   * Menu path (top-level key, then submenu labels) of the action
   * ``actionId`` (``data-action-id`` of the menu items), found by opening
   * the menus (cached); ``null`` when no menu holds it.
   */
  async findActionPath(
    actionId: string,
    maxDepth = 2,
  ): Promise<string[] | null> {
    const cached = this.actionPaths.get(actionId);
    if (cached !== undefined) return cached;
    const hint = ACTION_MENU_HINTS.find(([pattern]) =>
      pattern.test(actionId),
    )?.[1];
    const keys = this.topMenuKeys();
    const order =
      hint && keys.includes(hint)
        ? [hint, ...keys.filter((key) => key !== hint)]
        : keys;
    try {
      for (const key of order) {
        const top = this.topMenu(key);
        if (!top || top.getAttribute("aria-haspopup") !== "true") continue;
        await this.openTopMenu(key, { instant: true });
        const found = await this.searchMenu(top, actionId, maxDepth);
        if (found) {
          const path = [key, ...found];
          this.actionPaths.set(actionId, path);
          return path;
        }
      }
      this.actionPaths.set(actionId, null);
      return null;
    } finally {
      await this.closeMenus();
    }
  }

  /** Submenu labels leading to ``actionId`` under ``parent``. */
  private async searchMenu(
    parent: Element,
    actionId: string,
    depth: number,
  ): Promise<string[] | null> {
    const items = this.$$(":scope > .menu-dropdown > li.menu-item", parent);
    if (
      items.some((item) => item.getAttribute("data-action-id") === actionId)
    ) {
      return [];
    }
    if (depth <= 1) return null;
    for (const item of items) {
      if (item.getAttribute("aria-haspopup") !== "true") continue;
      await this.hover(item, { instant: true });
      try {
        await this.waitFor(
          () => item.getAttribute("aria-expanded") === "true",
          1_500,
        );
      } catch (error) {
        if (error instanceof ShowcaseAborted) throw error;
        continue;
      }
      const label = normalizeLabel(
        item.querySelector(":scope > .menu-label")?.textContent,
      );
      const found = await this.searchMenu(item, actionId, depth - 1);
      if (found) return [label, ...found];
    }
    return null;
  }

  /** Whether a menu holds the action ``actionId``. */
  async hasAction(actionId: string): Promise<boolean> {
    return (await this.findActionPath(actionId)) !== null;
  }

  /** Whether DataLab Web has the automation hooks of the showcase: the
   *  ``data-action-id`` of its menu entries. */
  async hasAutomationHooks(): Promise<boolean> {
    const top = this.topMenu("File");
    if (!top) return false;
    try {
      await this.openTopMenu("File", { instant: true });
      return (
        this.$$(":scope > .menu-dropdown [data-action-id]", top).length > 0
      );
    } finally {
      await this.closeMenus();
    }
  }

  /** Run an action of DataLab Web by its ``data-action-id``: the menus are
   *  opened and the entry clicked, as a visitor would. */
  async runAction(actionId: string, opts: PointerOptions = {}): Promise<void> {
    const path = await this.findActionPath(actionId);
    if (!path) throw new Error(`No menu entry for the action "${actionId}"`);
    this.log(`action ${actionId}`);
    const [top, ...submenus] = path;
    await this.walkMenuPath(top, [...submenus, actionId], opts);
  }

  /** Close the open menus. */
  async closeMenus(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.$$(".menu-dropdown").some(isVisible)) return;
      await this.press("Escape");
    }
    if (this.$$(".menu-dropdown").some(isVisible)) {
      // Leave the menu bar like a pointer would.
      const main = this.visible("main") ?? this.doc.body;
      await this.moveTo(center(main), { instant: true });
      await this.settle();
    }
  }

  /** Confirm the parameter dialog (DataSet or processing dialog) if one
   *  opens within ``timeoutMs``. Returns whether a dialog was confirmed. */
  async confirmDialogIfAny(timeoutMs = 4_000): Promise<boolean> {
    const selector = ".dataset-dialog, .processing-dataset-dialog";
    let dialog: HTMLElement;
    try {
      dialog = await this.waitFor(selector, timeoutMs);
    } catch (error) {
      if (error instanceof ShowcaseAborted) throw error;
      return false;
    }
    await this.hold(600);
    const ok = this.$$("button", dialog).find((button) =>
      isAppLabel(button.textContent, "OK"),
    );
    if (!ok) throw new Error("The parameter dialog has no OK button");
    await this.click(ok);
    await this.waitFor(() => !isVisible(dialog), 15_000, "the dialog to close");
    return true;
  }

  /** Tab by its English label, in English or French: panels
   *  (``"Signals"``, ``"Images"``), central views (``"Plot"``,
   *  ``"Macros"``, ``"Notebooks"``) and side panels (``"Properties"``…). */
  tab(name: string): HTMLElement | null {
    const labels = appLabels(name);
    return (
      this.$$('[role="tab"]').find(
        (tab) => isVisible(tab) && labels.includes(text(tab)),
      ) ?? null
    );
  }

  async clickTab(name: string, opts: PointerOptions = {}): Promise<void> {
    await this.click(() => this.tab(name), opts);
  }

  // -- Workspace ---------------------------------------------------------------

  /**
   * Bring DataLab Web back to a clean state, as a visitor would: close
   * menus, the command palette and dialogs, then start a new workspace
   * (File > New workspace, confirmed) — and show the plot view of the
   * Signals panel.
   *
   * DataLab Web has no File > New workspace action (yet): it is then
   * reloaded, which is what a visitor starting afresh gets (empty and
   * untitled workspace, unmodified, panels and Python workers new), the
   * boot status being shown on the title card. A freshly loaded DataLab
   * Web is left as it is.
   */
  async resetWorkspace(): Promise<void> {
    // Keep the title card: the player resets the workspace behind it.
    this.overlay?.clearCaption();
    this.overlay?.clearSpotlight();
    await this.settleReload();
    await this.closeTransientUi();
    if (this.fresh) {
      this.log("DataLab Web was just loaded: nothing to reset");
    } else if (await this.hasAction(NEW_WORKSPACE_ACTION)) {
      await this.runAction(NEW_WORKSPACE_ACTION, { instant: true });
      await this.acceptConfirmation(3_000);
    } else {
      this.log("no File > New workspace action: reloading DataLab Web");
      await this.reloadApp();
    }
    this.fresh = false;
    await this.closeTransientUi();
    for (const name of ["Plot", "Images", "Signals"]) {
      const tab = this.tab(name);
      if (tab && !(tab as HTMLButtonElement).disabled) {
        await this.click(tab, { instant: true });
      }
    }
    await this.waitFor(
      () => this.doc.querySelectorAll(".object-tree-item").length === 0,
      15_000,
      "an empty object tree",
    );
  }

  /** DataLab Web was just loaded: its workspace is empty and untitled. */
  markFresh(): void {
    this.fresh = true;
  }

  /**
   * Reload DataLab Web (a new iframe) and wait for its Python runtime;
   * ``between`` runs while no DataLab Web is loaded (e.g. to restore the
   * visitor's storage, which nothing can overwrite meanwhile). A boot
   * status line is shown on the title card, or on a boot card outside a
   * title card.
   *
   * With ``defer``, the reload goes on in the background once ``between``
   * has run (e.g. behind the end card): the next workspace reset waits for
   * it (:meth:`settleReload`), and ``onReady`` runs once DataLab Web is
   * ready. A deferred reload is never aborted: the visitors always get
   * DataLab Web back.
   */
  async reloadApp(
    between?: () => Promise<void>,
    opts: { defer?: boolean; onReady?: () => void } = {},
  ): Promise<void> {
    await this.settleReload().catch(() => undefined);
    this.hovered = null;
    this.pointer = null;
    this.buttons = 0;
    this.fresh = false;
    if (opts.defer) {
      this.frame.unload();
      if (between) await between();
      const reload = (async () => {
        await this.frame.start();
        this.fresh = true;
        opts.onReady?.();
      })();
      // Failures surface in settleReload().
      reload.catch(() => undefined);
      this.pendingReload = reload;
      return;
    }
    const overlay = this.overlay;
    const titled = !!overlay?.hasCard("card");
    const cardId = titled ? "card" : "boot";
    if (overlay && titled) {
      overlay.addCardStatus("card");
    } else if (overlay) {
      overlay.clearCaption();
      overlay.clearSpotlight();
      overlay.card(
        {
          kicker: t("DataLab Web · live demo"),
          title: t("Full DataLab in your browser"),
          subtitle: t(
            "Python, NumPy, SciPy, Sigima in WebAssembly — no install, no server",
          ),
          note: PUBLIC_WEB_URL,
          spinner: true,
        },
        "boot",
      );
    }
    try {
      this.frame.unload();
      if (between) await between();
      await this.frame.start(
        this.signal,
        (status) =>
          overlay?.cardStatus(
            status || t("Please wait until the Python runtime is ready."),
            cardId,
          ),
        () =>
          overlay?.cardStatus(
            t("DataLab Web did not start, trying again…"),
            cardId,
          ),
      );
      this.fresh = true;
    } finally {
      if (overlay && titled) overlay.removeCardStatus("card");
      else if (overlay) await overlay.clearCard(450, "boot");
    }
  }

  /** Wait for a deferred reload of DataLab Web, if any (with a boot status
   *  line on the title card shown meanwhile). */
  async settleReload(): Promise<void> {
    const pending = this.pendingReload;
    if (!pending) return;
    const overlay = this.overlay?.hasCard("card") ? this.overlay : null;
    overlay?.addCardStatus("card");
    const timer = window.setInterval(
      () =>
        overlay?.cardStatus(
          this.frame.statusText() ||
            t("Please wait until the Python runtime is ready."),
          "card",
        ),
      250,
    );
    try {
      await pending;
    } finally {
      window.clearInterval(timer);
      overlay?.removeCardStatus("card");
      if (this.pendingReload === pending) this.pendingReload = null;
    }
  }

  /** Accept the confirmation dialog (its last button) if one opens within
   *  ``timeoutMs``. Returns whether one was accepted. */
  async acceptConfirmation(timeoutMs = 3_000): Promise<boolean> {
    let button: HTMLElement;
    try {
      button = await this.waitFor(
        () => {
          const dialog = this.visible('.overlay[role="dialog"]');
          const buttons = dialog
            ? this.$$<HTMLButtonElement>(".actions button", dialog)
            : [];
          const last = buttons[buttons.length - 1];
          return last && !last.disabled ? last : null;
        },
        timeoutMs,
        "a confirmation dialog",
      );
    } catch (error) {
      if (error instanceof ShowcaseAborted) throw error;
      return false;
    }
    await this.hold(500);
    await this.click(button, { instant: this.check });
    return true;
  }

  // -- Player hooks --------------------------------------------------------------

  beginScenario(scenario: ShowcaseScenario): void {
    this.scenario = scenario;
    this.stepCount = 0;
  }

  endScenario(): void {
    this.overlay?.clearAll();
    this.scenario = null;
  }

  // -- Internals -------------------------------------------------------------------

  private followTheme(): void {
    try {
      this.overlay?.setTheme(
        this.doc.documentElement.getAttribute("data-theme"),
      );
    } catch {
      // DataLab Web is reloading.
    }
  }

  private ripple(point: Point): void {
    if (!this.overlay) return;
    const at = this.frame.toHost(point);
    this.overlay.ripple(at.x, at.y);
  }

  private pointerAt(point: Point): void {
    this.pointer = point;
    if (this.overlay) {
      const at = this.frame.toHost(point);
      this.overlay.cursor(at.x, at.y);
    }
    const el = this.elementAt(point);
    if (el !== this.hovered) {
      dispatchHoverTransition(this.hovered, el, point);
      this.hovered = el;
    }
    if (el) {
      fire(el, "pointermove", point, { buttons: this.buttons });
      fire(el, "mousemove", point, { buttons: this.buttons });
    }
  }

  /** Topmost element of DataLab Web under ``point`` (the overlays live in
   *  the host page, never in the way). */
  private elementAt(point: Point): Element | null {
    const doc = this.doc;
    if (typeof doc.elementsFromPoint !== "function") return null;
    return doc.elementsFromPoint(point.x, point.y)[0] ?? null;
  }

  /** Press the left button at ``point``; returns the pressed element. */
  private buttonDown(point: Point): Element {
    const el = this.elementAt(point) ?? this.doc.body;
    fire(el, "pointerdown", point, { buttons: 1 });
    fire(el, "mousedown", point, { buttons: 1, detail: 1 });
    this.buttons = 1;
    return el;
  }

  /** Release the button at ``point`` on the element now under it, then
   *  ``click`` the nearest common ancestor of ``down`` and that element
   *  (as browsers do). */
  private buttonUp(point: Point, down: Element): void {
    this.buttons = 0;
    const up = this.elementAt(point) ?? down;
    fire(up, "pointerup", point);
    fire(up, "mouseup", point, { detail: 1 });
    let common: Element | null = down.isConnected ? down : null;
    while (common && !common.contains(up)) common = common.parentElement;
    if (common) fire(common, "click", point, { detail: 1 });
  }

  /** Ease-in-out pointer motion, one step per animation frame. */
  private async glide(to: Point): Promise<void> {
    const viewport = this.frame.viewport();
    const from = this.pointer ?? {
      x: viewport.width / 2,
      y: viewport.height * 0.62,
    };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = Math.min(900, Math.max(220, distance * 0.9)) * this.speed;
    const started = performance.now();
    for (;;) {
      await nextFrame(this.signal);
      await this.pause.waitWhilePaused(this.signal);
      const progress = Math.min(1, (performance.now() - started) / duration);
      const eased =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - (-2 * progress + 2) ** 2 / 2;
      this.pointerAt({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });
      if (progress >= 1) return;
    }
  }

  /** Menu-friendly path: a straight line would cross sibling rows and close
   *  the submenu being entered, so go down the dropdown first (top level),
   *  or across into the submenu first (nested levels). */
  private async approachMenuItem(
    item: HTMLElement,
    level: number,
  ): Promise<void> {
    const target = center(item);
    const from = this.pointer ?? target;
    if (level === 0) {
      await this.glide({ x: from.x, y: target.y });
    } else {
      const box = item.getBoundingClientRect();
      const inset = Math.min(18, box.width / 4);
      const entryX = box.left > from.x ? box.left + inset : box.right - inset;
      await this.glide({ x: entryX, y: from.y });
      await this.glide({ x: entryX, y: target.y });
    }
    await this.glide(target);
  }

  private transientUi(): HTMLElement[] {
    return this.$$(
      '.menu-dropdown, [role="dialog"], .command-palette-input',
    ).filter(isVisible);
  }

  /** Close menus, the command palette and dialogs (Escape, then their
   *  Cancel or Close button). */
  async closeTransientUi(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.transientUi().length === 0) return;
      await this.press("Escape");
      await sleep(150, this.signal);
    }
    for (const dialog of this.$$('[role="dialog"]').filter(isVisible)) {
      const close =
        this.$$("button", dialog).find(
          (button) =>
            isAppLabel(button.textContent, "Cancel") ||
            isAppLabel(button.textContent, "Close"),
        ) ?? this.$(".dialog-close-button", dialog);
      if (close && isVisible(close) && !isDisabled(close)) {
        await this.click(close, { instant: true });
      }
    }
    if (this.transientUi().length > 0) {
      this.log("some dialog did not close; continuing anyway");
    }
  }
}
