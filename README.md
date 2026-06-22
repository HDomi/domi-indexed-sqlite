# domi-indexed-sqlite

Nuxt 3 및 Vue 3 환경에서 `@sqlite.org/sqlite-wasm`을 더 쉽고 간편하게 사용할 수 있도록 만들어진 TypeScript 기반 SQLite 래퍼 패키지입니다.

이 라이브러리는 브라우저 보안 헤더(COOP/COEP) 설정이 없어도 브라우저 새로고침 시 데이터가 유지될 수 있도록 **IndexedDB를 기본 백엔드로 탑재**하고 있으며, 고성능 최적화가 필요할 시 손쉽게 **OPFS(Origin Private File System)**나 **Memory 모드**로 스위칭할 수 있습니다.

---

## 주요 특징

- **IndexedDB 기반 영구 저장 (기본값)**: 브라우저 보안 헤더 설정 없이 설치 후 즉시 사용 가능합니다. 내부적으로 인메모리 SQLite를 가동하고 변경 사항을 IndexedDB로 자동 디바운싱 백업합니다.
- **OPFS 지원 (선택사항)**: 대용량 데이터베이스나 높은 읽기/쓰기 성능이 필요한 경우 브라우저 파일 시스템(OPFS)을 활용합니다.
- **Promise 기반 심플 API**: C 스타일의 투박한 API 대신 `db.query()` 및 `db.execute()` 형식의 단순화된 Promises API를 제공합니다.
- **TypeScript 완벽 지원**: 결과 행(Rows)에 대한 제네릭 타입 캐스팅을 완벽히 지원합니다.
- **CDN 폴백 탑재**: 복잡한 WASM 자산(Assets) 번들러 설정 없이 작동하도록 CDN 폴백 경로가 기본 내장되어 있습니다.

---

## 설치 방법

```bash
npm install @h_domi/domi-indexed-sqlite
# 또는
yarn add @h_domi/domi-indexed-sqlite
# 또는
pnpm add @h_domi/domi-indexed-sqlite
```

---

## 스토리지 타입 옵션 (`storageType`)

| 모드                 | 설정값        | 영구저장 여부 | 보안헤더 요구 | 특징                                                                    |
| :------------------- | :------------ | :-----------: | :-----------: | :---------------------------------------------------------------------- |
| **IndexedDB (기본)** | `'indexeddb'` |     **O**     |     **X**     | 일반 호스팅(Github Pages, Netlify 등)에서 바로 영구 저장을 할 때 최적.  |
| **인메모리**         | `'memory'`    |     **X**     |     **X**     | 새로고침 시 초기화됨. 임시 세션이나 유닛 테스트용으로 적합.             |
| **OPFS**             | `'opfs'`      |     **O**     |     **O**     | 대용량 DB(10MB 이상) 처리 시 가장 빠른 속도 보장. (보안 헤더 설정 필요) |

---

## 사용 방법

### 1. 데이터베이스 초기화 및 기본 쿼리

```typescript
import { initEasySqlite } from "domi-indexed-sqlite";

// DB 초기화 (기본적으로 IndexedDB 스토리지 활성화)
const db = await initEasySqlite({
  dbName: "my_app_database",
  debug: true, // 디버그 로그 활성화
});

// 테이블 생성
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 데이터 추가 (바인딩 파라미터 지원)
const insertResult = await db.execute(
  "INSERT INTO users (name, email) VALUES (?, ?)",
  ["홍길동", "gildong@example.com"],
);
console.log("추가된 행 개수:", insertResult.rowsAffected);

// 데이터 조회 (TypeScript 제네릭 지원)
interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

const users = await db.query<User>("SELECT * FROM users ORDER BY id DESC");
console.log("사용자 목록:", users);

// 트랜잭션 처리
await db.transaction(async (tx) => {
  await tx.execute("INSERT INTO users (name, email) VALUES (?, ?)", [
    "김철수",
    "chulsoo@example.com",
  ]);
  await tx.execute("INSERT INTO users (name, email) VALUES (?, ?)", [
    "이영희",
    "younghee@example.com",
  ]);
});
```

---

### 2. Vue 3 및 Nuxt 3 연동 가이드

#### A. Composable 패턴 구현 예시 (`composables/useSQLite.ts`)

Vue 3 환경에서는 애플리케이션 전역에서 싱글톤으로 DB 인스턴스를 유지하고, UI 반응형 연동을 쉽게 하기 위해 컴포저블 형태로 감싸서 제공하는 것이 좋습니다.

```typescript
// composables/useSQLite.ts
import { ref } from "vue";
import { initEasySqlite, EasySqlite } from "domi-indexed-sqlite";

const dbInstance = ref<EasySqlite | null>(null);
const isReady = ref(false);

export function useSQLite() {
  const initDb = async () => {
    if (dbInstance.value) return dbInstance.value;

    const db = await initEasySqlite({
      dbName: "user_local_db",
      storageType: "indexeddb", // 필요 시 'opfs'로 변경 가능
    });

    dbInstance.value = db;
    isReady.value = true;
    return db;
  };

  // 실시간 반응형 데이터 구독 헬퍼 (Live Query)
  const useLiveQuery = <T = any>(sql: string, params: any[] = []) => {
    const data = ref<T[]>([]);
    const error = ref<any>(null);
    const loading = ref(true);

    const refresh = async () => {
      if (!dbInstance.value) return;
      loading.value = true;
      try {
        data.value = await dbInstance.value.query<T>(sql, params);
      } catch (err) {
        error.value = err;
      } finally {
        loading.value = false;
      }
    };

    // 초기 로딩
    initDb().then(refresh);

    return { data, error, loading, refresh };
  };

  return {
    initDb,
    isReady,
    useLiveQuery,
    db: dbInstance,
  };
}
```

#### B. Vue 컴포넌트에서 사용 (`components/UserList.vue`)

```vue
<template>
  <div>
    <h2>로컬 사용자 목록</h2>
    <div v-if="loading">DB 로딩 중...</div>
    <ul v-else>
      <li v-for="user in users" :key="user.id">
        {{ user.name }} ({{ user.email }})
      </li>
    </ul>

    <input v-model="newName" placeholder="이름 입력" />
    <input v-model="newEmail" placeholder="이메일 입력" />
    <button @click="addUser">추가</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useSQLite } from "@/composables/useSQLite";

const { useLiveQuery, db } = useSQLite();
const { data: users, loading, refresh } = useLiveQuery("SELECT * FROM users");

const newName = ref("");
const newEmail = ref("");

const addUser = async () => {
  if (!db.value) return;
  await db.value.execute("INSERT INTO users (name, email) VALUES (?, ?)", [
    newName.value,
    newEmail.value,
  ]);
  newName.value = "";
  newEmail.value = "";
  // 데이터 추가 후 리프레시하여 화면 갱신
  refresh();
};
</script>
```

---

### 3. Vite / Nuxt 빌드 시 주의 사항

`@sqlite.org/sqlite-wasm`은 번들링 시 WASM 파일 및 Worker 의존성 처리가 필요합니다.
Vite 환경에서 원활한 빌드를 위해 라이브러리 사용자의 `vite.config.ts` 혹은 `nuxt.config.ts`에 아래 설정을 추가하는 것이 좋습니다.

```typescript
// vite.config.ts 예시
export default defineConfig({
  optimizeDeps: {
    // Vite가 라이브러리 로드를 제대로 스캔하도록 종속성 최적화에서 예외 처리
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
```

---

## 라이센스

MIT
