export type StorageType = 'indexeddb' | 'memory' | 'opfs';

export interface EasySqliteConfig {
  /**
   * 데이터베이스 이름입니다. OPFS 및 IndexedDB의 경우 파일 또는 키의 고유 이름으로 사용됩니다.
   */
  dbName: string;

  /**
   * 데이터베이스를 저장할 스토리지 엔진 유형입니다.
   * - 'indexeddb': DB 파일을 브라우저의 IndexedDB에 유지합니다. 특별한 COOP/COEP HTTP 보안 헤더 설정 없이도 안전하게 영구 저장이 가능합니다. (기본값)
   * - 'memory': 메모리 상에만 존재하는 임시 데이터베이스입니다. 테스트나 일시적인 세션 작업에 적합하며, 페이지 새로고침 시 데이터가 휘발됩니다.
   * - 'opfs': 브라우저의 고성능 파일 시스템인 Origin Private File System(OPFS)에 영구 저장합니다. 대량 데이터 처리에 적합하나, SharedArrayBuffer 보안 규격에 따른 COOP/COEP HTTP 헤더 설정이 필수적입니다.
   * 
   * @default 'indexeddb'
   */
  storageType?: StorageType;

  /**
   * sqlite3.wasm 바이너리 파일의 커스텀 URL 경로입니다 (선택사항).
   * 지정하지 않으면 기본적으로 jsDelivr/unpkg 등의 CDN 경로로 자동 폴백(Fallback)됩니다.
   */
  wasmUri?: string;

  /**
   * sqlite3-opfs-async-proxy.js 워커 파일의 커스텀 URL 경로입니다 (선택사항).
   * WASM 파일을 로컬(self-host)로 서빙하며 OPFS 모드를 활성화할 경우 필수로 요구될 수 있습니다.
   */
  workerUri?: string;

  /**
   * 개발자 콘솔에 디버그 로그를 출력할지 여부입니다.
   * @default false
   */
  debug?: boolean;
}

export interface QueryResult {
  /**
   * 쿼리 실행 결과로 반환된 데이터 행(row) 배열입니다. 각 행은 컬럼명을 키로 하는 키-값 형태의 객체 구조입니다.
   */
  rows: any[];
  
  /**
   * 쿼리 결과에 포함된 전체 컬럼명(열 이름)들의 문자열 배열입니다.
   */
  columns: string[];

  /**
   * 해당 쿼리(예: INSERT, UPDATE, DELETE)로 인해 영향을 받거나 변경된 행의 개수입니다.
   */
  rowsAffected: number;
}

export interface EasySqliteInstance {
  /**
   * 지정한 SELECT SQL 쿼리를 실행하고 결과를 구조화된 객체 배열 형태로 반환합니다. (TypeScript 제네릭 지정 가능)
   */
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;

  /**
   * 데이터를 생성, 수정, 삭제하는 쿼리(INSERT, UPDATE, DELETE, CREATE TABLE 등)를 실행하고 쿼리 실행 세부 정보(영향받은 행의 개수 등)를 반환합니다.
   */
  execute(sql: string, params?: any[]): Promise<QueryResult>;

  /**
   * 여러 개의 데이터베이스 쿼리를 단일 트랜잭션 단위로 묶어서 실행합니다.
   * 콜백 함수 수행 중 에러 발생 시 변경 사항이 자동으로 롤백(Rollback)되며, 성공 시 커밋(Commit)됩니다.
   */
  transaction<T>(cb: (tx: Omit<EasySqliteInstance, 'transaction' | 'close'>) => Promise<T>): Promise<T>;

  /**
   * 활성화되어 있는 데이터베이스 커넥션을 정상적으로 닫습니다.
   * IndexedDB 모드일 경우 대기 중인 모든 미저장 데이터가 IndexedDB로 강제 동기화된 후 종료됩니다.
   */
  close(): Promise<void>;
}
