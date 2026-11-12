import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  restoreStorage,
  sameStorage,
  snapshotStorage,
  StoreGuard,
} from "../../src/storage";

const PREFIXES = ["datalab-web.aiassistant", "datalab-web.aiPanel"];

describe("localStorage snapshot", () => {
  beforeEach(() => localStorage.clear());

  it("restores the entries of the prefixes byte for byte", () => {
    localStorage.setItem("datalab-web.aiassistant.settings", '{"a":1}');
    localStorage.setItem("datalab-web.aiPanelVisible", "true");
    localStorage.setItem("datalab-web:theme", "dark");
    const saved = snapshotStorage(localStorage, PREFIXES);
    expect([...saved.keys()].sort()).toEqual([
      "datalab-web.aiPanelVisible",
      "datalab-web.aiassistant.settings",
    ]);

    localStorage.setItem("datalab-web.aiassistant.settings", '{"mock":1}');
    localStorage.setItem("datalab-web.aiassistant.inputHistory", "[]");
    localStorage.removeItem("datalab-web.aiPanelVisible");
    localStorage.setItem("datalab-web:theme", "light");
    expect(sameStorage(localStorage, PREFIXES, saved)).toBe(false);

    restoreStorage(localStorage, PREFIXES, saved);
    expect(sameStorage(localStorage, PREFIXES, saved)).toBe(true);
    expect(localStorage.getItem("datalab-web.aiassistant.settings")).toBe(
      '{"a":1}',
    );
    expect(localStorage.getItem("datalab-web.aiassistant.inputHistory")).toBe(
      null,
    );
    expect(localStorage.getItem("datalab-web.aiPanelVisible")).toBe("true");
    // Other keys are not the snapshot's business.
    expect(localStorage.getItem("datalab-web:theme")).toBe("light");
  });

  it("removes every entry created when there was none", () => {
    const saved = snapshotStorage(localStorage, PREFIXES);
    localStorage.setItem("datalab-web.aiassistant.settings", "{}");
    restoreStorage(localStorage, PREFIXES, saved);
    expect(localStorage.length).toBe(0);
  });
});

function openDb(name: string, store: string, keyPath: string | null) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(
  db: IDBDatabase,
  store: string,
  use: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = use(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

function databases(): Promise<string[]> {
  return indexedDB.databases().then((list) => list.map((db) => db.name ?? ""));
}

describe("IndexedDB store guard", () => {
  it("removes the records of the demo and puts the evicted ones back", async () => {
    const db = await openDb("guard-test", "entries", "id");
    await run(db, "entries", (s) => s.put({ id: "user-1", v: 1 }));
    await run(db, "entries", (s) => s.put({ id: "user-2", v: 2 }));
    const guard = await StoreGuard.capture(indexedDB, "guard-test", "entries");
    expect(guard.size).toBe(2);

    await run(db, "entries", (s) => s.put({ id: "demo", v: 3 }));
    await run(db, "entries", (s) => s.delete("user-1"));
    expect(await guard.newKeys()).toEqual(["demo"]);

    expect(await guard.restore()).toBe(1);
    const all = await run(db, "entries", (s) => s.getAll());
    expect(all).toEqual([
      { id: "user-1", v: 1 },
      { id: "user-2", v: 2 },
    ]);
    db.close();
  });

  it("supports out-of-line keys", async () => {
    const db = await openDb("guard-keys", "kv", null);
    await run(db, "kv", (s) => s.put("value", "key"));
    const guard = await StoreGuard.capture(indexedDB, "guard-keys", "kv");
    await run(db, "kv", (s) => s.put("other", "key"));
    await guard.restore();
    expect(await run(db, "kv", (s) => s.get("key"))).toBe("value");
    db.close();
  });

  it("never creates a missing database", async () => {
    const guard = await StoreGuard.capture(indexedDB, "missing-db", "entries");
    expect(guard.size).toBe(0);
    expect(await guard.restore()).toBe(0);
    expect(await databases()).not.toContain("missing-db");
  });

  it("clears a database created during the demo", async () => {
    const guard = await StoreGuard.capture(indexedDB, "late-db", "entries");
    const db = await openDb("late-db", "entries", "id");
    await run(db, "entries", (s) => s.put({ id: "demo" }));
    expect(await guard.restore()).toBe(1);
    expect(await run(db, "entries", (s) => s.count())).toBe(0);
    db.close();
  });
});
