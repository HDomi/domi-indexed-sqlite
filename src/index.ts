import { getDatabaseFromIndexedDB, saveDatabaseToIndexedDB } from './idb-helper.js';
import { EasySqliteConfig, EasySqliteInstance, QueryResult, StorageType } from './types.js';

// 번들러 구성 없이도 간편하게 연동할 수 있도록 제공하는 기본 CDN(unpkg) 경로 설정
const DEFAULT_WASM_URI = 'https://unpkg.com/@sqlite.org/sqlite-wasm@3.46.1-build5/sqlite-wasm/jswasm/sqlite3.wasm';
const DEFAULT_WORKER_URI = 'https://unpkg.com/@sqlite.org/sqlite-wasm@3.46.1-build5/sqlite-wasm/jswasm/sqlite3-worker1.js';

/**
 * 로컬 메인 스레드 데이터베이스(IndexedDB / Memory 모드) 및
 * 백그라운드 워커 스레드 데이터베이스(OPFS 모드)를 관리하는 EasySqlite 구현체입니다.
 */
export class EasySqlite implements EasySqliteInstance {
  private config: Required<EasySqliteConfig>;
  private storageType: StorageType;
  private db: any = null; // 메모리/IndexedDB 모드용 (oo1.DB 인스턴스)
  private sqlite3: any = null; // 메모리/IndexedDB 모드용 모듈 캐시
  private promiser: any = null; // OPFS 모드용 Worker Promiser
  private opfsDbId: string | null = null; // OPFS 모드용 DB 고유 식별자
  private saveDebounced: () => void;

  constructor(config: EasySqliteConfig) {
    this.config = {
      dbName: config.dbName,
      storageType: config.storageType || 'indexeddb',
      wasmUri: config.wasmUri || DEFAULT_WASM_URI,
      workerUri: config.workerUri || DEFAULT_WORKER_URI,
      debug: config.debug || false,
    };
    this.storageType = this.config.storageType;

    // 연속적인 쿼리 요청이 올 때 IndexedDB에 과도하게 디스크 쓰기가 발생하는 것을 방지하기 위해 디바운싱 처리 (250ms)
    this.saveDebounced = this.debounce(this.saveToIDB.bind(this), 250);
  }

  private log(...args: any[]) {
    if (this.config.debug) {
      console.log('[domi-sqlite]', ...args);
    }
  }

  private debounce(func: (...args: any[]) => void, wait: number) {
    let timeout: any;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  /**
   * 설정된 스토리지 타입에 기반하여 SQLite WASM 연동을 초기화합니다.
   */
  async init(): Promise<this> {
    // 서버 사이드 렌더링(SSR) 환경인 경우 초기화를 수행하지 않고 즉시 스킵합니다.
    if (typeof window === 'undefined') {
      this.log('서버 사이드 환경 감지: init() 실행을 건너뜁니다.');
      return this;
    }

    if (this.storageType === 'opfs') {
      await this.initOpfs();
    } else {
      await this.initLocal();
    }
    return this;
  }

  /**
   * 로컬 메인 스레드 기반의 SQLite 인스턴스(Memory 또는 IndexedDB)를 초기화합니다.
   */
  private async initLocal() {
    if (typeof window === 'undefined') return;
    this.log(`로컬 SQLite 초기화 중 (모드: ${this.storageType})...`);

    const wasmUrl = this.config.wasmUri;

    // 서버 사이드 컴파일 크래시를 방지하기 위해 클라이언트 런타임에 동적으로 모듈을 로드합니다.
    const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm');

    this.sqlite3 = await sqlite3InitModule({
      locateFile: (file: string) => {
        if (file === 'sqlite3.wasm') {
          return wasmUrl;
        }
        return file;
      },
    });

    const oo1 = this.sqlite3.oo1;
    this.db = new oo1.DB();

    if (this.storageType === 'indexeddb') {
      const savedData = await getDatabaseFromIndexedDB(this.config.dbName);
      if (savedData && savedData.byteLength > 0) {
        this.log(`IndexedDB에서 기존 데이터베이스 발견 (${savedData.byteLength} 바이트). 복원(Deserializing)을 시작합니다...`);
        try {
          const capi = this.sqlite3.capi;
          const wasm = this.sqlite3.wasm;

          // SQLite의 sqlite3_realloc과 완벽히 호환되도록 capi.sqlite3_malloc을 통해 메모리를 명시적으로 할당합니다.
          const p = capi.sqlite3_malloc(savedData.byteLength);
          if (!p) {
            throw new Error('WebAssembly 메모리 할당에 실패했습니다 (sqlite3_malloc).');
          }

          // 할당된 WASM 메모리 영역에 기존 데이터베이스 바이너리를 복사합니다.
          wasm.heap8u().set(savedData, p);
          
          // 메모리 내 데이터베이스로 바이너리 값을 Deserialize(복원)합니다.
          // SQLITE_DESERIALIZE_FREEONCLOSE와 RESIZEABLE 조합은 버퍼가 sqlite3_malloc으로 할당된 경우에만 안전하게 동작합니다.
          const deserializeFlags = 
            capi.SQLITE_DESERIALIZE_FREEONCLOSE | 
            capi.SQLITE_DESERIALIZE_RESIZEABLE;

          const rc = capi.sqlite3_deserialize(
            this.db.pointer,
            'main',
            p,
            savedData.byteLength,
            savedData.byteLength,
            deserializeFlags
          );

          this.db.checkRc(rc);
          this.log('데이터베이스 복원 성공.');
        } catch (err) {
          console.error('[domi-sqlite] 데이터베이스 복원 실패. 새 빈 데이터베이스로 시작합니다.', err);
        }
      } else {
        this.log('IndexedDB에 저장된 데이터베이스가 없습니다. 새로 초기화합니다.');
      }
    }
  }

  /**
   * Web Worker 및 Promiser API를 사용하여 OPFS 기반 SQLite 인스턴스를 초기화합니다.
   */
  private async initOpfs() {
    this.log('Web Worker를 사용하여 OPFS SQLite 초기화 중...');

    // 빌드 타임에 OPFS Worker와 메인 스레드 간 프로토콜을 설정하는 모듈을 다이내믹 임포트합니다.
    const { sqlite3Worker1Promiser } = await import('@sqlite.org/sqlite-wasm');

    return new Promise<void>((resolve, reject) => {
      try {
        const workerUrl = this.config.workerUri;
        // CDN 호스팅 시 발생할 수 있는 동일출처정책(Same-Origin Policy) 우회를 위한 Blob 프록시 워커 처리
        const blobCode = `importScripts(${JSON.stringify(workerUrl)});`;
        const blob = new Blob([blobCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));

        const promiserInstance = sqlite3Worker1Promiser({
          worker: () => worker,
          onready: async () => {
            this.promiser = promiserInstance;
            try {
              this.log(`OPFS를 통해 데이터베이스 파일 "${this.config.dbName}"을(를) 여는 중...`);
              const openResult = await this.promiser('open', {
                filename: this.config.dbName,
                vfs: 'opfs',
              });
              this.opfsDbId = openResult.dbId;
              this.log('OPFS 데이터베이스 오픈 성공. DB ID:', this.opfsDbId);
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          onerror: (err: any) => {
            reject(err);
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 현재 백그라운드 메모리의 SQLite 상태를 IndexedDB에 비동기로 백업(저장)합니다.
   */
  private saveToIDB() {
    if (this.storageType !== 'indexeddb' || !this.db || !this.sqlite3) return;

    try {
      this.log('데이터베이스를 IndexedDB에 백업하는 중...');
      // 메모리에 로드된 SQLite 인스턴스 전체를 Uint8Array 바이너리로 내보냅니다.
      const exported = this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
      if (exported) {
        saveDatabaseToIndexedDB(this.config.dbName, exported)
          .then(() => this.log('IndexedDB 데이터베이스 백업 완료.'))
          .catch((err) => console.error('[domi-sqlite] IndexedDB 백업 중 에러 발생:', err));
      }
    } catch (err) {
      console.error('[domi-sqlite] 백업용 데이터베이스 엑스포트 실패:', err);
    }
  }

  /**
   * SQL 쿼리를 실행하여 결과 데이터 행(Row) 객체 배열을 반환합니다.
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const res = await this.execute(sql, params);
    return res.rows as T[];
  }

  /**
   * SQL 문을 실행하고 결과 행(rows), 열 정의(columns), 영향받은 행 개수(rowsAffected) 등의 상세 상세 정보를 반환합니다.
   */
  async execute(sql: string, params: any[] = []): Promise<QueryResult> {
    // SSR 환경인 경우 쿼리 실행을 방지하고 빈 결과를 안전하게 반환합니다.
    if (typeof window === 'undefined') {
      return { rows: [], columns: [], rowsAffected: 0 };
    }

    if (this.storageType === 'opfs') {
      if (!this.promiser || !this.opfsDbId) {
        throw new Error('데이터베이스가 초기화되지 않았거나 이미 닫혀있습니다.');
      }

      this.log('OPFS 쿼리 실행:', sql, params);
      const res = await this.promiser('exec', {
        dbId: this.opfsDbId,
        sql,
        bind: params,
      });

      // Promiser API 출력 구조에 맞춰 결과를 재구성합니다.
      const rows: any[] = [];
      const columns = res.result.columnNames || [];

      if (res.result.row) {
        // 결과값을 순회하며 컬럼명과 매핑되는 행 객체 구조로 뱐환합니다.
        const valuesList = res.result.values || [];
        for (const vals of valuesList) {
          const rowObj: any = {};
          columns.forEach((col: string, idx: number) => {
            rowObj[col] = vals[idx];
          });
          rows.push(rowObj);
        }
      }

      return {
        rows,
        columns,
        rowsAffected: res.result.changeCount || 0,
      };
    } else {
      if (!this.db) {
        throw new Error('데이터베이스가 초기화되지 않았거나 이미 닫혀있습니다.');
      }

      this.log('로컬 SQLite 쿼리 실행:', sql, params);
      const columns: string[] = [];
      const rows: any[] = [];

      this.db.exec({
        sql,
        bind: params,
        rowMode: 'object',
        columnNames: columns,
        callback: (row: any) => {
          rows.push(row);
        },
      });

      // 데이터가 수정되거나 추가되는 쓰기 작업 쿼리(INSERT, UPDATE 등)가 발생한 경우 백업을 수행합니다.
      const isWriteQuery = /^\s*(insert|update|delete|create|drop|alter|replace)/i.test(sql);
      if (this.storageType === 'indexeddb' && isWriteQuery) {
        this.saveDebounced();
      }

      return {
        rows,
        columns,
        rowsAffected: this.db.changes(),
      };
    }
  }

  /**
   * 단일 트랜잭션 내부에서 여러 데이터베이스 작업을 처리합니다.
   */
  async transaction<T>(cb: (tx: Omit<EasySqliteInstance, 'transaction' | 'close'>) => Promise<T>): Promise<T> {
    await this.execute('BEGIN TRANSACTION');
    try {
      const result = await cb(this);
      await this.execute('COMMIT');
      return result;
    } catch (err) {
      await this.execute('ROLLBACK');
      throw err;
    }
  }

  /**
   * 활성화된 데이터베이스 커넥션을 안전하게 닫습니다.
   */
  async close() {
    if (this.storageType === 'opfs') {
      if (this.promiser && this.opfsDbId) {
        this.log('OPFS 데이터베이스 커넥션 종료 중...');
        await this.promiser('close', { dbId: this.opfsDbId });
        this.opfsDbId = null;
        this.promiser = null;
      }
    } else {
      if (this.db) {
        this.log('로컬 데이터베이스 커넥션 종료 중...');
        // 남아있는 저장을 즉시 강제 수행합니다.
        if (this.storageType === 'indexeddb') {
          this.saveToIDB();
        }
        this.db.close();
        this.db = null;
        this.sqlite3 = null;
      }
    }
  }
}

// 동일한 데이터베이스의 중복 비동기 초기화를 방지하기 위한 전역 프로미스 캐시 맵
const initCache = new Map<string, Promise<EasySqlite>>();

/**
 * EasySqlite 데이터베이스 인스턴스를 즉시 생성하고 연동 초기화하는 편리한 팩토리 헬퍼 함수입니다.
 * 중복 호출 시 이미 진행 중이거나 완료된 초기화 프로미스를 캐시하여 반환함으로써 중복 인스턴스 생성을 차단합니다.
 */
export function initEasySqlite(config: EasySqliteConfig): Promise<EasySqlite> {
  const cacheKey = `${config.storageType || 'indexeddb'}:${config.dbName}`;
  
  if (initCache.has(cacheKey)) {
    return initCache.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const instance = new EasySqlite(config);
      return await instance.init();
    } catch (err) {
      // 초기화 실패 시 다음 호출이 재시도할 수 있도록 캐시에서 삭제합니다.
      initCache.delete(cacheKey);
      throw err;
    }
  })();

  initCache.set(cacheKey, promise);
  return promise;
}
