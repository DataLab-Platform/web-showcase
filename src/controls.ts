/**
 * Control bar of the operator: a discreet bar at the bottom of the host
 * page, above the shield, shown while the operator moves the mouse (real
 * mouse only: the fake pointer of the demos is a mere element, and touches
 * keep showing the "Live demo in progress" badge). It mirrors the hotkeys
 * (pause, next step, next demo, restart, stop, pace) and shows the
 * progress of the playlist.
 */

import { formatNumber, t } from "./i18n";
import type { PauseState } from "./pause";

/** Hidden after this time without mouse movement (unless hovered). */
const HIDE_DELAY_MS = 3000;
/** Refresh period while shown (elapsed time). */
const REFRESH_MS = 500;

/** What the bar shows, read from the player. */
export interface ControlView {
  pause: PauseState;
  /** A stop after the current demo is pending. */
  stopPending: boolean;
  /** Pace factor (delay multiplier) chosen by the operator. */
  pace: number;
  /** Number of the current demo (from 1) and of the playlist's demos. */
  demo: number;
  total: number;
  title: string;
  step: number;
  /** The end card of the playlist is shown. */
  ending: boolean;
  elapsedMs: number;
}

export interface ControlActions {
  pause(): void;
  nextStep(): void;
  nextDemo(): void;
  restart(): void;
  stop(): void;
  cancelStop(): void;
  slower(): void;
  faster(): void;
}

/** Pace shown to the operator: the rate (1 / factor), e.g. "×1.4". */
export function rateLabel(factor: number): string {
  const rate = 1 / factor;
  return `×${formatNumber(rate, rate < 1 ? 2 : 1)}`;
}

/** Elapsed time as ``m:ss``. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function hotkey(label: string, key: string): string {
  return `${label} (${key})`;
}

export class ControlBar {
  private readonly root: HTMLDivElement;
  private readonly buttons: Record<
    | "pause"
    | "nextStep"
    | "nextDemo"
    | "restart"
    | "stop"
    | "cancelStop"
    | "slower"
    | "faster",
    HTMLButtonElement
  >;
  private readonly rate: HTMLSpanElement;
  private readonly progress: HTMLSpanElement;
  private readonly dots: HTMLSpanElement;
  private readonly elapsed: HTMLSpanElement;
  private active = false;
  private hovered = false;
  private hideTimer = 0;
  private refreshTimer = 0;

  constructor(
    actions: ControlActions,
    private readonly view: () => ControlView,
  ) {
    this.root = document.createElement("div");
    this.root.className = "showcase-controls";
    this.root.setAttribute("role", "toolbar");
    this.root.setAttribute("aria-label", t("Showcase controls"));
    const transport = this.group();
    const pause = this.button(transport, "⏸︎", "", () => actions.pause());
    const nextStep = this.button(
      transport,
      "⏩︎",
      hotkey(t("Next step"), "→"),
      () => actions.nextStep(),
    );
    const nextDemo = this.button(
      transport,
      "⏭︎",
      hotkey(t("Next demo"), t("End")),
      () => actions.nextDemo(),
    );
    const restart = this.button(
      transport,
      "⏮︎",
      hotkey(t("Restart the demo"), t("Home")),
      () => actions.restart(),
    );
    const stop = this.button(transport, "", "", () => actions.stop());
    const cancelStop = this.button(
      transport,
      t("Cancel stop"),
      t("Cancel stop"),
      () => actions.cancelStop(),
    );
    const pace = this.group();
    const slower = this.button(pace, "−", hotkey(t("Slower"), "−"), () =>
      actions.slower(),
    );
    this.rate = this.span(pace, "showcase-controls-rate");
    this.rate.title = t("Pace");
    const faster = this.button(pace, "+", hotkey(t("Faster"), "+"), () =>
      actions.faster(),
    );
    this.buttons = {
      pause,
      nextStep,
      nextDemo,
      restart,
      stop,
      cancelStop,
      slower,
      faster,
    };
    const info = this.span(this.root, "showcase-controls-progress");
    this.progress = this.span(info, "showcase-controls-title");
    this.dots = this.span(info, "showcase-controls-dots");
    this.elapsed = this.span(info, "showcase-controls-elapsed");
    this.root.addEventListener("pointerenter", () => {
      this.hovered = true;
      window.clearTimeout(this.hideTimer);
    });
    this.root.addEventListener("pointerleave", () => {
      this.hovered = false;
      this.scheduleHide();
    });
    window.addEventListener("pointermove", this.onPointerMove, true);
  }

  /** Whether the bar may show (a demo or the end card plays). */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.hide();
    else if (this.isVisible) this.refresh();
  }

  get isVisible(): boolean {
    return this.root.classList.contains("showcase-controls--visible");
  }

  /** Show the bar, hidden after a while without mouse movement. */
  show(): void {
    if (!this.active) return;
    if (!this.root.isConnected) document.body.appendChild(this.root);
    if (!this.isVisible) {
      this.root.classList.add("showcase-controls--visible");
      document.documentElement.setAttribute("data-showcase-controls", "");
      this.refresh();
      this.refreshTimer = window.setInterval(() => this.refresh(), REFRESH_MS);
    }
    this.scheduleHide();
  }

  hide(): void {
    window.clearTimeout(this.hideTimer);
    window.clearInterval(this.refreshTimer);
    this.hovered = false;
    this.root.classList.remove("showcase-controls--visible");
    document.documentElement.removeAttribute("data-showcase-controls");
  }

  /** Update the bar from the player's state (if shown). */
  refresh(): void {
    if (!this.isVisible) return;
    const view = this.view();
    const { buttons } = this;
    const [glyph, label] =
      view.pause === "none"
        ? ["⏸︎", t("Pause")]
        : view.pause === "requested"
          ? ["⏸︎", t("Pause now")]
          : ["▶︎", t("Resume")];
    buttons.pause.textContent = glyph;
    this.label(buttons.pause, hotkey(label, "F9"));
    buttons.pause.setAttribute("aria-pressed", String(view.pause !== "none"));
    const stopLabel = view.stopPending
      ? t("Stop now")
      : t("Stop after this demo");
    buttons.stop.textContent = `⏹︎ ${stopLabel}`;
    this.label(buttons.stop, hotkey(stopLabel, `${t("Shift")}+F12`));
    buttons.cancelStop.hidden = !view.stopPending;
    buttons.restart.disabled = view.ending;
    this.rate.textContent = rateLabel(view.pace);
    this.progress.textContent = view.ending
      ? t("End of the playlist")
      : t("Demo {n}/{total} · {title} · Step {step}", {
          n: view.demo,
          total: view.total,
          title: view.title,
          step: view.step,
        });
    this.renderDots(view);
    this.elapsed.textContent = view.ending ? "" : formatElapsed(view.elapsedMs);
  }

  destroy(): void {
    this.hide();
    window.removeEventListener("pointermove", this.onPointerMove, true);
    this.root.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!event.isTrusted || event.pointerType !== "mouse") return;
    this.show();
  };

  private scheduleHide(): void {
    window.clearTimeout(this.hideTimer);
    if (this.hovered) return;
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  private renderDots(view: ControlView): void {
    const { dots } = this;
    while (dots.childElementCount > view.total) dots.lastChild?.remove();
    while (dots.childElementCount < view.total) {
      this.span(dots, "showcase-controls-dot");
    }
    Array.from(dots.children).forEach((dot, index) => {
      dot.classList.toggle(
        "showcase-controls-dot--current",
        !view.ending && index === view.demo - 1,
      );
    });
  }

  private group(): HTMLElement {
    return this.span(this.root, "showcase-controls-group");
  }

  private span(parent: HTMLElement, className: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = className;
    parent.appendChild(el);
    return el;
  }

  private button(
    parent: HTMLElement,
    text: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    if (label) this.label(button, label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
      this.refresh();
    });
    // The keyboard focus stays where it was (e.g. in DataLab Web).
    button.addEventListener("mousedown", (event) => event.preventDefault());
    parent.appendChild(button);
    return button;
  }

  private label(button: HTMLButtonElement, label: string): void {
    button.setAttribute("aria-label", label);
    button.title = label;
  }
}
