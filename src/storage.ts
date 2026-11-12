/**
 * The visitor's DataLab Web state, kept as it was by the demos.
 *
 * DataLab Web and the host page share the same origin, hence the same
 * ``localStorage`` and IndexedDB. A demo that changes the visitor's state
 * (AI Assistant settings, recent notebooks and macros, capsule revisions,
 * AI conversations) takes a snapshot first and restores it exactly
 * afterwards (entries recorded by the demo removed, entries evicted by it
 * put back).
 *
 * The IndexedDB stores are those of DataLab Web (name, store, key path):
 * a store that is missing or different is left alone, with a warning.
 */

// -- localStorage ---------------------------------------------------------------

/** ``localStorage`` entries whose key starts with one of ``prefixes``. */
export type StorageSnapshot = Map<string, string>;

function storageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function matches(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

export function snapshotStorage(
  storage: Storage,
  prefixes: readonly string[],
): StorageSnapshot {
  const snapshot: StorageSnapshot = new Map();
  for (const key of storageKeys(storage)) {
    if (!matches(key, prefixes)) continue;
    const value = storage.getItem(key);
    if (value !== null) snapshot.set(key, value);
  }
  return snapshot;
}

/** Put the entries of ``snapshot`` back, byte for byte, and remove the
 *  entries of ``prefixes`` created since. */
export function restoreStorage(
  storage: Storage,
  prefixes: readonly string[],
  snapshot: StorageSnapshot,
): void {
  for (const key of storageKeys(storage)) {
    if (matches(key, prefixes) && !snapshot.has(key)) storage.removeItem(key);
  }
  for (const [key, value] of snapshot) {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  }
}

/** Whether the ``prefixes`` entries of ``storage`` are those of
 *  ``snapshot``. */
export function sameStorage(
  storage: Storage,
  prefixes: readonly string[],
  snapshot: StorageSnapshot,
): boolean {
  const now = snapshotStorage(storage, prefixes);
  if (now.size !== snapshot.size) return false;
  for (const [key, value] of snapshot) {
    if (now.get(key) !== value) return false;
  }
  return true;
}

// -- IndexedDB ------------------------------------------------------------------

/** One record of an IndexedDB store. */
interface StoreRecord {
  key: IDBValidKey;
  value: unknown;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Open the database ``name`` if it exists (never create it: that would
 *  prevent DataLab Web from creating its stores). */
function openExisting(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  factory: IDBFactory,
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => Promise<T>,
): Promise<T | null> {
  const db = await openExisting(factory, dbName);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(storeName)) return null;
    const tx = db.transaction(storeName, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await use(tx.objectStore(storeName));
    await done;
    return result;
  } finally {
    db.close();
  }
}

async function readAll(store: IDBObjectStore): Promise<StoreRecord[]> {
  const [keys, values] = await Promise.all([
    request(store.getAllKeys()),
    request(store.getAll()),
  ]);
  return keys.map((key, i) => ({ key, value: values[i] }));
}

function keyId(key: IDBValidKey): string {
  return JSON.stringify(key);
}

/**
 * Snapshot of an IndexedDB store of DataLab Web, restored exactly by
 * :meth:`restore`.
 */
export class StoreGuard {
  private constructor(
    private readonly factory: IDBFactory,
    readonly dbName: string,
    readonly storeName: string,
    private readonly records: StoreRecord[],
  ) {}

  static async capture(
    factory: IDBFactory,
    dbName: string,
    storeName: string,
  ): Promise<StoreGuard> {
    let records: StoreRecord[] = [];
    try {
      records =
        (await withStore(factory, dbName, storeName, "readonly", readAll)) ??
        [];
    } catch (error) {
      console.warn(`[showcase] ${dbName}/${storeName} unavailable`, error);
    }
    return new StoreGuard(factory, dbName, storeName, records);
  }

  /** Number of records at capture time. */
  get size(): number {
    return this.records.length;
  }

  /** Keys recorded since the capture. */
  async newKeys(): Promise<IDBValidKey[]> {
    const known = new Set(this.records.map((record) => keyId(record.key)));
    try {
      const keys =
        (await withStore(
          this.factory,
          this.dbName,
          this.storeName,
          "readonly",
          (store) => request(store.getAllKeys()),
        )) ?? [];
      return keys.filter((key) => !known.has(keyId(key)));
    } catch {
      return [];
    }
  }

  /** Delete the records created since the capture and put the captured
   *  ones back. Returns the number of records deleted. */
  async restore(): Promise<number> {
    const known = new Map(
      this.records.map((record) => [keyId(record.key), record]),
    );
    try {
      return (
        (await withStore(
          this.factory,
          this.dbName,
          this.storeName,
          "readwrite",
          async (store) => {
            let deleted = 0;
            for (const key of await request(store.getAllKeys())) {
              if (!known.has(keyId(key))) {
                await request(store.delete(key));
                deleted += 1;
              }
            }
            for (const record of this.records) {
              if (store.keyPath === null) {
                await request(store.put(record.value, record.key));
              } else {
                await request(store.put(record.value));
              }
            }
            return deleted;
          },
        )) ?? 0
      );
    } catch (error) {
      console.warn(
        `[showcase] ${this.dbName}/${this.storeName} not restored`,
        error,
      );
      return 0;
    }
  }
}

/** IndexedDB stores of DataLab Web touched by the demos. */
export const RECENT_STORE = { db: "datalab-web.recent", store: "entries" };
export const REVISIONS_STORE = {
  db: "datalab-web.capsules",
  store: "revisions",
};
export const CONVERSATIONS_STORE = {
  db: "datalab-web.aiassistant",
  store: "conversations",
};
