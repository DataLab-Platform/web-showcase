/**
 * The DataLab Web iframe: a full-window, SAME-ORIGIN frame that the
 * showcase drives through ``iframe.contentDocument`` (direct DOM access,
 * events built with the constructors of the iframe realm).
 *
 * Reloading DataLab Web replaces the iframe element: a discarded frame
 * never asks "leave the page?" (``beforeunload``), and its Python workers
 * go with it.
 */

import { ShowcaseAborted, sleep, throwIfAborted } from "./pause";

/** Window of the iframe, with the constructors of its realm. */
export type FrameWindow = Window & typeof globalThis;

export interface Point {
  x: number;
  y: number;
}

/** Python runtime boot: Pyodide and the packages (cold browser cache). */
export const BOOT_TIMEOUT_MS = 300_000;
/** Attempts to start DataLab Web (a download may fail on a busy network). */
export const BOOT_ATTEMPTS = 3;
const BOOT_RETRY_DELAY_MS = 5_000;

export class AppFrame {
  private element: HTMLIFrameElement | null = null;
  private url: URL;
  private loads = 0;
  private readonly listeners = new Set<(win: FrameWindow) => void>();

  constructor(
    private readonly container: HTMLElement,
    url: URL,
  ) {
    this.url = url;
  }

  /** URL of DataLab Web in the iframe. */
  get src(): URL {
    return this.url;
  }

  /** Number of DataLab Web loads so far (a new one invalidates the
   *  elements of the previous document). */
  get generation(): number {
    return this.loads;
  }

  get iframe(): HTMLIFrameElement {
    if (!this.element) throw new Error("DataLab Web is not loaded");
    return this.element;
  }

  /** Window of DataLab Web; throws if the browser denies access to it
   *  (cross-origin document, e.g. an error page). */
  get win(): FrameWindow {
    const win = this.iframe.contentWindow as FrameWindow | null;
    if (!win) throw new Error("DataLab Web has no window");
    try {
      void win.document;
    } catch {
      throw new Error(
        "The showcase cannot access DataLab Web: it must be served from the same origin as the showcase page",
      );
    }
    return win;
  }

  get doc(): Document {
    return this.win.document;
  }

  /** Be told whenever a DataLab Web document loads (e.g. to listen to its
   *  keyboard); returns the unsubscribe function. */
  onLoad(listener: (win: FrameWindow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** (Re)load DataLab Web in a new iframe; resolves when its document has
   *  loaded (not when the Python runtime is ready, see :meth:`waitReady`). */
  async load(url: URL = this.url, signal?: AbortSignal): Promise<void> {
    this.url = url;
    this.unload();
    const iframe = document.createElement("iframe");
    iframe.className = "app-frame";
    iframe.title = "DataLab Web";
    // Clipboard and full screen as in a top-level DataLab Web page.
    iframe.allow = "clipboard-read; clipboard-write; fullscreen";
    const loaded = new Promise<void>((resolve) =>
      iframe.addEventListener("load", () => resolve(), { once: true }),
    );
    iframe.src = url.href;
    this.container.prepend(iframe);
    this.element = iframe;
    this.loads += 1;
    await Promise.race([
      loaded,
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    ]);
    throwIfAborted(signal);
    const win = this.win;
    for (const listener of this.listeners) listener(win);
  }

  /** Discard DataLab Web (its page and workers). */
  unload(): void {
    this.element?.remove();
    this.element = null;
  }

  /**
   * (Re)load DataLab Web and wait for its Python runtime, trying again
   * (up to ``attempts`` times) when it fails to start, e.g. after a failed
   * download on a busy network.
   */
  async start(
    signal?: AbortSignal,
    onStatus?: (text: string) => void,
    onRetry?: (attempt: number, error: unknown) => void,
    attempts = BOOT_ATTEMPTS,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.load(this.url, signal);
        await this.waitReady(signal, onStatus);
        return;
      } catch (error) {
        if (error instanceof ShowcaseAborted || attempt >= attempts) {
          throw error;
        }
        console.warn(
          `[showcase] DataLab Web did not start (attempt ${attempt})`,
          error,
        );
        onRetry?.(attempt, error);
        this.unload();
        await sleep(BOOT_RETRY_DELAY_MS, signal);
      }
    }
  }

  /** ``data-runtime-status`` of DataLab Web (``loading``, ``ready``,
   *  ``error``…), ``null`` before the application renders. */
  runtimeStatus(): string | null {
    try {
      return (
        this.doc.querySelector(".app")?.getAttribute("data-runtime-status") ??
        null
      );
    } catch {
      return null;
    }
  }

  /** Boot status line of DataLab Web (menu bar), for the boot card. */
  statusText(): string {
    try {
      return (
        this.doc.querySelector(".menubar .status")?.textContent ?? ""
      ).trim();
    } catch {
      return "";
    }
  }

  /** Wait until the Python runtime of DataLab Web is ready
   *  (``.app[data-runtime-status="ready"]``). */
  async waitReady(
    signal?: AbortSignal,
    onStatus?: (text: string) => void,
    timeoutMs = BOOT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(signal);
      const status = this.runtimeStatus();
      if (status === "ready") return;
      if (status === "error") {
        throw new Error(
          `DataLab Web failed to start: ${this.statusText() || "runtime error"}`,
        );
      }
      onStatus?.(this.statusText());
      if (Date.now() >= deadline) {
        throw new Error(
          `DataLab Web did not start within ${Math.round(timeoutMs / 1000)} s (${this.url.href})`,
        );
      }
      await sleep(250, signal);
    }
  }

  /** Host viewport position of ``point`` (iframe viewport coordinates). */
  toHost(point: Point): Point {
    const frame = this.iframe;
    const rect = frame.getBoundingClientRect();
    return {
      x: rect.left + frame.clientLeft + point.x,
      y: rect.top + frame.clientTop + point.y,
    };
  }

  /** Iframe viewport size. */
  viewport(): { width: number; height: number } {
    const win = this.win;
    return { width: win.innerWidth, height: win.innerHeight };
  }
}

// ---------------------------------------------------------------------------
// Remote-control bridge (read-only queries)
// ---------------------------------------------------------------------------

/** Object of the workspace, as listed by DataLab Web. */
export interface WorkspaceObject {
  id: string;
  kind: "signal" | "image";
  title: string;
}

interface RpcResponse {
  id: number | string;
  type: "response";
  result?: unknown;
  error?: { code: string; message: string };
}

const RPC_TIMEOUT_MS = 30_000;

/**
 * Client of the remote-control bridge of DataLab Web (``postMessage``
 * JSON-RPC, protocol 1.x, enabled by the ``allowedOrigins`` URL parameter
 * of the iframe). The showcase only reads the workspace content with it:
 * every action goes through the user interface.
 */
export class AppBridge {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly frame: AppFrame) {
    window.addEventListener("message", (event) => this.onMessage(event));
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data as Partial<RpcResponse> | null;
    if (!data || data.type !== "response" || typeof data.id !== "number") {
      return;
    }
    const call = this.pending.get(data.id);
    if (!call) return;
    this.pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error.message));
    else call.resolve(data.result);
  }

  /** Call a bridge method of DataLab Web. */
  call<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    const target = this.frame.win;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DataLab Web did not answer "${method}"`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      target.postMessage(
        { id, type: "request", method, params },
        window.location.origin,
      );
    });
  }

  async listSignals(): Promise<WorkspaceObject[]> {
    const signals =
      await this.call<{ id: string; title: string }[]>("list_signals");
    return signals.map((obj) => ({
      id: obj.id,
      kind: "signal",
      title: obj.title,
    }));
  }

  async listImages(): Promise<WorkspaceObject[]> {
    const images =
      await this.call<{ id: string; title: string }[]>("list_images");
    return images.map((obj) => ({
      id: obj.id,
      kind: "image",
      title: obj.title,
    }));
  }

  /** Every signal and image of the workspace. */
  async listObjects(): Promise<WorkspaceObject[]> {
    const [signals, images] = await Promise.all([
      this.listSignals(),
      this.listImages(),
    ]);
    return [...signals, ...images];
  }
}
