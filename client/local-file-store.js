const DB_NAME = "syncinema-local-files";
const STORE_NAME = "handles";
const LATEST_KEY = "latest-local-video";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const result = callback(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function latestRecord() {
  if (!("indexedDB" in window)) return null;
  return withStore("readonly", (store) => requestToPromise(store.get(LATEST_KEY)));
}

function recordMatchesMeta(record, meta) {
  return Boolean(
    record?.handle &&
      meta?.id &&
      record.meta?.name === meta.name &&
      Number(record.meta?.size || 0) === Number(meta.size || 0)
  );
}

export function supportsFileHandles() {
  return "showOpenFilePicker" in window && "indexedDB" in window;
}

export async function pickVideoFileWithHandle() {
  if (!supportsFileHandles()) return null;
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: "Video",
        accept: {
          "video/*": [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]
        }
      }
    ],
    excludeAcceptAllOption: false
  });
  if (!handle) return null;
  const file = await handle.getFile();
  return { file, handle };
}

export async function saveLocalVideoHandle(meta, handle) {
  if (!meta?.id || !handle || !("indexedDB" in window)) return false;
  try {
    await withStore("readwrite", (store) =>
      requestToPromise(
        store.put(
          {
            meta: {
              id: meta.id,
              switchId: meta.switchId || "",
              name: meta.name || "",
              size: meta.size || 0,
              type: meta.type || "",
              chunkSize: meta.chunkSize || 0,
              totalChunks: meta.totalChunks || 0,
              savedAt: Date.now()
            },
            handle
          },
          LATEST_KEY
        )
      )
    );
    return true;
  } catch (error) {
    console.warn("Local file handle save failed", error);
    return false;
  }
}

export async function hasStoredLocalVideo(meta) {
  if (!meta?.id || !("indexedDB" in window)) return false;
  try {
    return recordMatchesMeta(await latestRecord(), meta);
  } catch {
    return false;
  }
}

export async function restoreLocalVideoFile(meta, { requestPermission = false } = {}) {
  if (!meta?.id || !("indexedDB" in window)) return null;
  try {
    const record = await latestRecord();
    if (!recordMatchesMeta(record, meta)) return null;

    const options = { mode: "read" };
    let permission = "granted";
    if (record.handle.queryPermission) {
      permission = await record.handle.queryPermission(options);
    }
    if (permission !== "granted" && requestPermission && record.handle.requestPermission) {
      permission = await record.handle.requestPermission(options);
    }
    if (permission !== "granted") {
      return { needsPermission: true };
    }

    const file = await record.handle.getFile();
    if (file.name !== meta.name || file.size !== meta.size) return null;
    return { file, handle: record.handle };
  } catch (error) {
    console.warn("Local file handle restore failed", error);
    return null;
  }
}
