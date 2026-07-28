/**
 * Persists the loaded VRM in the browser so an OBS browser source can restore it
 * from a URL alone.
 *
 * Without this, a drag-and-dropped model cannot survive into OBS at all: a local
 * `File` has no addressable URL, so the copied browser-source URL would open a
 * blank transparent scene. Storing the bytes under a stable key lets the URL say
 * `?model=idb:last` and mean it.
 *
 * Nothing leaves the machine — this is the browser's own storage, not an upload.
 */
const DB_NAME = 'vrm-stage';
const DB_VERSION = 1;
const STORE = 'models';

export interface StoredModel {
  name: string;
  buffer: ArrayBuffer;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function putModel(key: string, name: string, buffer: ArrayBuffer): Promise<void> {
  const record: StoredModel = { name, buffer, savedAt: Date.now() };
  await transact('readwrite', (store) => store.put(record, key));
}

export async function getModel(key: string): Promise<StoredModel | null> {
  const record = await transact<StoredModel | undefined>('readonly', (store) => store.get(key));
  return record ?? null;
}
