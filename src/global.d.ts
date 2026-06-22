/**
 * 공식 @sqlite.org/sqlite-wasm 패키지에 대한 TypeScript 타입 정의 선언 파일입니다.
 * 라이브러리 빌드 시 타입 오류를 방지하기 위해 앰비언트 모듈로 구조를 선언합니다.
 */
declare module '@sqlite.org/sqlite-wasm' {
  // SQLite WASM 모듈을 초기화하는 기본 진입점 함수
  const sqlite3InitModule: (options?: any) => Promise<any>;
  
  // 메인 스레드와 Web Worker 간 비동기 Promise 통신을 가능하게 해주는 Promiser 인스턴스 팩토리
  export const sqlite3Worker1Promiser: any;
  
  export default sqlite3InitModule;
}
