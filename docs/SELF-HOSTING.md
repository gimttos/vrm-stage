# 셀프호스팅

VRM Stage는 정적 사이트다. 빌드 결과 `dist/`를 아무 정적 호스트에 올리면 된다.
**런타임에 외부 CDN을 타지 않는다** — MediaPipe의 WASM과 모델은 빌드에 포함된다.

## 빌드

```bash
npm install
npm run build     # prebuild가 모델을 받고, tsc 2개, vite build
```

`dist/` 구성:

```
dist/
├── index.html
├── _headers                       캐시·보안 헤더 (Cloudflare Pages / Netlify)
├── assets/                        앱 번들
└── mediapipe/
    ├── wasm/                      4개 파일, ~22MB  (vite 플러그인이 내보냄)
    └── models/                    2개 파일, ~11MB  (fetch-models.mjs가 받음)
```

전체 ~39MB. 파일당 최대 11MB로, Cloudflare Pages의 파일당 25MiB 제한 안이다.

## 애셋이 어디서 오는가

| 애셋 | 출처 | 주체 |
|---|---|---|
| WASM | `node_modules/@mediapipe/tasks-vision/wasm/` | `vite.config.ts`의 `vrm-stage:mediapipe-assets` 플러그인 |
| 모델 `.task` | `storage.googleapis.com`에서 1회 다운로드 | `scripts/fetch-models.mjs` (`predev`/`prebuild`) |

**WASM을 `public/`에 손복사하지 않는 이유:** 복사본은 다음 `npm update`에서 조용히
드리프트하고, 실패 모드가 랜드마커 내부의 WASM/JS ABI 불일치다. 방송 중에 터지면
원인 파악이 지옥이다. 플러그인은 노드의 해석을 거치므로 `package.json`의 버전과
어긋날 수 없다.

**모델을 커밋하지 않는 이유:** 11MB짜리 바이너리다. 대신 `fetch-models.mjs`에
**SHA-256으로 핀**을 박아 재현성을 보장하고, 업스트림이 파일을 바꾸면 조용히
배포되는 대신 빌드가 실패한다. 핀을 갱신할 때는 파일을 직접 확인한 뒤 해시를 고친다.

WASM은 `vision_wasm_internal`(SIMD)과 `vision_wasm_nosimd_internal` 두 쌍만 넣는다.
`FilesetResolver.forVisionTasks`의 경로 규칙이
`vision_wasm{_module?}{_nosimd?}_internal`이고 `_module` 플래그를 쓰지 않기 때문이다.
nosimd 쌍은 현재 모든 브라우저와 OBS CEF가 SIMD를 지원하더라도 **넣는다** — 없으면
구형 기기에서 랜드마커 내부에서 404가 나고 "트래킹이 그냥 안 되는" 것처럼 보인다.

## 서브패스 호스팅

루트가 아닌 경로에 올릴 때:

```bash
VITE_BASE=/vrm/ npm run build
```

`import.meta.env.BASE_URL`을 거치는 것들이 전부 따라온다 — 앱 번들, MediaPipe 경로
(`src/tracking/mediapipeAssets.ts`), 씬 이미지의 루트 상대 경로
(`sanitizeUrl` → `withBase`), `?model=/models/foo.vrm`, 개발용 픽스처 버튼.

> Git Bash에서는 `MSYS_NO_PATHCONV=1 VITE_BASE=/vrm/ npm run build`로 실행한다.
> 그렇지 않으면 MSYS가 `/vrm/`를 윈도우 경로로 변환해 `base` 경고가 뜬다.

## 헤더

`public/_headers`가 Cloudflare Pages와 Netlify에서 자동 적용된다. 다른 호스트라면
같은 규칙을 직접 옮겨야 한다.

**COOP/COEP는 의도적으로 넣지 않았다.** tasks-vision은 GPU delegate에서 단일 스레드
WASM으로 돌아 `SharedArrayBuffer`가 필요 없고, COEP는 `?mp=cdn` 탈출구와 앞으로 넣을
서드파티 오버레이 iframe을 모두 깨뜨린다. 교차 출처 격리는 여기서 이득 없는 비용이다.

`Permissions-Policy`는 **금지가 아니라 허용** 규칙이다 — 트래킹에 카메라가 필요하고,
`display-capture`/`microphone`은 이후 녹화 작업이 쓴다.

## VMC 브리지 (선택)

VSeeFace 등의 트래킹을 쓰려면 브리지를 로컬에서 돌린다. 정적 사이트와 별개이며,
**사용자 자신의 기계에서** 실행된다 (OSC/UDP는 로컬 전용이다).

```bash
npm run bridge          # udp://0.0.0.0:39539 → ws://127.0.0.1:39541
npm run bridge:verbose  # 2초마다 통계
npm run bridge:test     # 카메라 없이 합성 송신기로 시험
```

`ws`는 `dependencies`에 있다 — `npm ci --omit=dev`로 설치해도 브리지가 동작한다.
앱은 정적 빌드라 `ws`가 브라우저 번들에 들어가지 않는다.

## 배포

방송 룸이 들어오면서 **Cloudflare Pages에서 Workers + static assets로 바뀌었다.**
정적 파일과 API가 한 Worker로 나가고, `wrangler.jsonc`의 `run_worker_first`가 `/api/*`만
스크립트로 보낸다.

R2 버킷은 최초 1회 만들어야 한다:

```bash
npx wrangler r2 bucket create vrm-stage-models
```

그 다음:

```bash
npx wrangler login      # 최초 1회
npm run deploy          # typecheck ×3 → vite build → wrangler deploy
```

첫 배포에서 Durable Object 마이그레이션(`new_sqlite_classes: ["Room"]`)이 적용된다.

정적 파일만 필요하고 방송 룸을 쓰지 않을 거면 `dist/`를 아무 호스트에 올려도 된다.
SPA 리라이트는 필요 없다 — 라우팅이 전부 쿼리 파라미터와 URL 해시로 되어 있어 실제
경로는 `/` 하나다.

## 무료 한도

현재 설계는 Cloudflare 무료 플랜 안에서 돌아간다.

| | 무료 한도 | 이 앱 |
|---|---|---|
| R2 저장 | 10 GB-month (만료 없음) | 모델 1개 0.015 GB, 방송 끝나면 삭제 |
| R2 쓰기 / 읽기 | 100만 / 1000만 per month | 방송당 1건 / 시청자당 1건 |
| R2 이그레스 | 항상 무료 | — |
| DO 요청 | 100,000/일 | 10 msg/s → 20:1 과금 → 시간당 1,800건 |
| DO duration | 13,000 GB-s/일 | Hibernation API라 실행 시간만 과금 |
| DO 저장 | 5 GB, 쓰기 100,000/일 | 방당 스칼라 5개 |

Durable Objects는 무료 플랜에서 **SQLite 백엔드로만** 동작하고, 그게 이 프로젝트의
설정이다. 수신 WebSocket 메시지가 20:1로 과금되는 덕에 요청 한도는 사실상 문제가 되지
않는다 — 하루 50시간 넘게 방송해도 닿지 않는다.

R2를 활성화할 때 무료 한도만 쓸 예정이어도 계정에 카드 등록을 요구할 수 있다.

## 모델 파일에 관한 주의

`fixtures/`의 VRM 두 개는 **저자 전용 · 비상업 · 개변 금지**다. `public/` 밖에 있고
gitignore되며, 개발 중에만 `vrm-stage:dev-fixtures` 플러그인이 서브한다. 추가로
`vrm-stage:assert-no-models` 플러그인이 `dist`에서 `.vrm`을 찾으면 빌드를 실패시킨다.

예전에는 `postbuild`의 `rm -rf`가 이 의무를 지키는 유일한 장치였는데, 조용한
no-op이라 디렉터리 이름이 바뀌거나 `npx vite build`를 직접 돌리면 아무 경고 없이
배포됐다. 지금은 배포가 **구조적으로 불가능**하다.

## 장애 대응

**트래킹이 시작되지 않는다** — DevTools 네트워크에서 `mediapipe/wasm/*`와
`mediapipe/models/*`가 200인지 본다. 404면 빌드에 애셋이 빠진 것이다:
`npm run models`를 돌리고 다시 빌드한다.

**사내 프록시가 모델 다운로드를 막는다** — `scripts/fetch-models.mjs`가 SHA-256과 함께
실패한다. 두 `.task` 파일을 수동으로 받아 `public/mediapipe/models/`에 넣으면
캐시로 인식한다(해시가 맞아야 한다).

**벤더링된 애셋을 우회해 원인을 좁히고 싶다** — `?mp=cdn`을 붙이면 CDN에서 받는다.
디버깅 전용이다. 방송에 쓰면 CDN 장애가 방송 장애가 된다.

**빌드가 `EPERM ... dist\...` 로 실패한다 (Windows)** — `npm run serve`(wrangler)가
`dist/`를 assets 바인딩으로 열어둔 상태다. Vite가 출력 디렉터리를 비우는 단계에서 나면
**wrangler를 먼저 멈추고 빌드한다.** `workerd` 프로세스가 남아 있으면 그것까지 정리한다:

```powershell
Get-Process workerd -ErrorAction SilentlyContinue | Stop-Process -Force
```

> 라이선스 가드(`vrm-stage:assert-no-models`)는 이 잠금 때문에 빌드를 실패시키지
> **않는다.** 예전에는 스캔이 EPERM으로 죽으면서 이미 성공한 빌드를 마지막에
> 무너뜨렸는데, 파일 잠금은 라이선스 위반이 아니다. 지금은 읽지 못한 경로를 경고로
> 알리고 넘어가며, 실제로 `.vrm`을 발견했을 때만 빌드를 중단한다.

**`base` 옵션 경고가 뜬다 (Git Bash)** — MSYS가 `/vrm/`를 윈도우 경로로 변환한다.
`MSYS_NO_PATHCONV=1`을 앞에 붙인다.
