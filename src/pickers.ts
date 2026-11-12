/**
 * File pickers of DataLab Web, answered by the showcase: a script cannot
 * drive the native "Open" and "Save as" dialogs, so they are replaced, in
 * the realm of the iframe and only while an action runs, by stand-ins that
 * hand the demo files over and capture the saved ones in memory (nothing
 * is downloaded). The originals are always restored.
 *
 *   * opening: ``HTMLInputElement.prototype.click`` (``<input type=file>``,
 *     what DataLab Web uses) and ``window.showOpenFilePicker`` (File System
 *     Access API);
 *   * saving: ``window.showSaveFilePicker`` and the ``<a download>``
 *     fallback (``HTMLAnchorElement.prototype.click``, the blob being known
 *     from ``URL.createObjectURL``).
 */

import type { AppFrame, FrameWindow } from "./frame";

/** Bytes of a demo file, fetched once per page load. */
export interface DemoFile {
  name: string;
  data: ArrayBuffer;
  type?: string;
}

const cache = new Map<string, Promise<DemoFile>>();

/** Fetch ``url`` (same origin, browser cache) as a demo file. */
export function fetchDemoFile(url: URL | string): Promise<DemoFile> {
  const href = new URL(url, document.baseURI).href;
  let file = cache.get(href);
  if (!file) {
    file = (async () => {
      const response = await fetch(href);
      if (!response.ok) {
        throw new Error(
          `Cannot fetch the demo file ${href}: ${response.status}`,
        );
      }
      const name = new URL(href).pathname.split("/").pop() || "file";
      return { name, data: await response.arrayBuffer() };
    })();
    file.catch(() => cache.delete(href));
    cache.set(href, file);
  }
  return file;
}

/** ``file`` as a ``File`` of the iframe realm (``instanceof File`` holds in
 *  DataLab Web). */
export function toFrameFile(win: FrameWindow, file: DemoFile | File): File {
  if ("data" in file) {
    return new win.File([file.data], file.name, { type: file.type ?? "" });
  }
  if (file instanceof win.File) return file;
  // A file of the host page (e.g. a captured save): copied to the iframe
  // realm.
  const hostFile: File = file;
  return new win.File([hostFile], hostFile.name, { type: hostFile.type });
}

/** Restore a property of ``target`` as it was (own or inherited). */
function patch<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<PropertyKey, unknown>)[key as PropertyKey];
  };
}

export interface PickerOptions {
  /** Wait for the picker to open (default 10 s). */
  timeoutMs?: number;
  /** Polls until the picker opened (the showcase context provides it). */
  waitFor: (
    probe: () => boolean,
    timeoutMs: number,
    what: string,
  ) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Run ``action`` (e.g. a visible File menu walk) and answer the first file
 * picker it opens with ``files``, as if the visitor had picked them.
 */
export async function answerFilePicker(
  frame: AppFrame,
  files: (DemoFile | File)[],
  action: () => Promise<void>,
  opts: PickerOptions,
): Promise<void> {
  const win = frame.win;
  const picked = { done: false };
  const frameFiles = files.map((file) => toFrameFile(win, file));
  const proto = win.HTMLInputElement.prototype;
  const nativeClick = proto.click;
  const restoreClick = patch(
    proto,
    "click",
    function (this: HTMLInputElement): void {
      if (this.type !== "file" || picked.done) {
        nativeClick.call(this);
        return;
      }
      picked.done = true;
      opts.log?.(
        `file picker answered with ${frameFiles.map((f) => f.name).join(", ")}`,
      );
      const transfer = new win.DataTransfer();
      for (const file of this.multiple ? frameFiles : frameFiles.slice(0, 1)) {
        transfer.items.add(file);
      }
      this.files = transfer.files;
      win.setTimeout(() => {
        this.dispatchEvent(new win.Event("input", { bubbles: true }));
        this.dispatchEvent(new win.Event("change", { bubbles: true }));
      }, 0);
    },
  );
  const restoreOpenPicker = patch(
    win as unknown as Record<string, unknown>,
    "showOpenFilePicker",
    async (options?: { multiple?: boolean }) => {
      picked.done = true;
      const chosen = options?.multiple ? frameFiles : frameFiles.slice(0, 1);
      return chosen.map((file) => ({
        kind: "file",
        name: file.name,
        getFile: async () => file,
      }));
    },
  );
  try {
    await action();
    await opts.waitFor(
      () => picked.done,
      opts.timeoutMs ?? 10_000,
      "the file picker to open",
    );
  } finally {
    restoreClick();
    restoreOpenPicker();
  }
}

/** A save captured in memory. */
export interface SavedFile {
  name: string;
  blob: Blob;
  text(): Promise<string>;
}

export interface SaveCapture {
  /** The saved file, once written. */
  readonly saved: SavedFile | null;
  /** Remove the stand-ins (call once the save cannot reach them anymore). */
  restore(): void;
}

/**
 * Replace the save pickers of DataLab Web by in-memory stand-ins until
 * :meth:`SaveCapture.restore`: the first file saved is kept in
 * :attr:`SaveCapture.saved`, and downloads are swallowed.
 */
export function captureSaves(
  frame: AppFrame,
  log?: (message: string) => void,
): SaveCapture {
  const win = frame.win;
  const state: { saved: SavedFile | null } = { saved: null };
  const keep = (name: string, blob: Blob) => {
    if (state.saved) return;
    log?.(`save of ${name} captured (${blob.size} bytes)`);
    state.saved = { name, blob, text: () => blob.text() };
  };
  const restorers: (() => void)[] = [];
  restorers.push(
    patch(
      win as unknown as Record<string, unknown>,
      "showSaveFilePicker",
      async (options?: { suggestedName?: string }) => {
        const name = options?.suggestedName || "document";
        return {
          kind: "file",
          name,
          async createWritable() {
            const parts: BlobPart[] = [];
            return {
              async write(data: BlobPart | { data?: BlobPart }) {
                const part =
                  data && typeof data === "object" && "data" in data
                    ? data.data
                    : data;
                if (part !== undefined) parts.push(part as BlobPart);
              },
              async close() {
                keep(name, new Blob(parts));
              },
              async abort() {},
            };
          },
        };
      },
    ),
  );
  const blobs = new Map<string, Blob>();
  const nativeCreate = win.URL.createObjectURL;
  restorers.push(
    patch(win.URL, "createObjectURL", (object: Blob | MediaSource) => {
      const url = nativeCreate.call(win.URL, object);
      if (object instanceof win.Blob) blobs.set(url, object);
      return url;
    }),
  );
  const anchorProto = win.HTMLAnchorElement.prototype;
  const nativeAnchorClick = anchorProto.click;
  restorers.push(
    patch(anchorProto, "click", function (this: HTMLAnchorElement): void {
      if (!this.hasAttribute("download")) {
        nativeAnchorClick.call(this);
        return;
      }
      const blob = blobs.get(this.href);
      if (blob) keep(this.download || "download", blob);
      else log?.(`download of ${this.download} swallowed`);
    }),
  );
  let restored = false;
  return {
    get saved() {
      return state.saved;
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const restore of restorers.reverse()) restore();
    },
  };
}
