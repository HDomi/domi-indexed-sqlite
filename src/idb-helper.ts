const DB_NAME = 'domi_sqlite_store';
const STORE_NAME = 'databases';

/**
 * 로컬 IndexedDB 인스턴스를 오픈합니다.
 */
function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      // 데이터베이스 백업들을 저장할 Object Store가 없다면 새로 생성합니다.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * IndexedDB로부터 저장된 SQLite 데이터베이스 파일(바이너리 데이터)을 Uint8Array 형태로 가져옵니다.
 */
export async function getDatabaseFromIndexedDB(dbName: string): Promise<Uint8Array | null> {
  try {
    const db = await openIDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const getReq = store.get(dbName);

      getReq.onsuccess = () => {
        resolve(getReq.result || null);
      };

      getReq.onerror = () => {
        reject(getReq.error);
      };
    });
  } catch (error) {
    console.error('[domi-sqlite] IndexedDB에서 DB를 로드하는데 실패했습니다:', error);
    return null;
  }
}

/**
 * SQLite 데이터베이스 파일(Uint8Array 바이너리)을 IndexedDB에 영구 보존합니다.
 */
export async function saveDatabaseToIndexedDB(dbName: string, data: Uint8Array): Promise<void> {
  try {
    const db = await openIDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const putReq = store.put(data, dbName);

      putReq.onsuccess = () => {
        resolve();
      };

      putReq.onerror = () => {
        reject(putReq.error);
      };
    });
  } catch (error) {
    console.error('[domi-sqlite] IndexedDB에 DB를 백업하는데 실패했습니다:', error);
    throw error;
  }
}
