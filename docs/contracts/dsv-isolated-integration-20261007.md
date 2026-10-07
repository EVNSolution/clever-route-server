# DSV 격리 통합 검증 — 2026-10-07

## 범위

서버 PR483, Driver PR64, 관제 웹 PR85를 운영과 분리해 검증한다.
합성 사업장·기사·주문·GPS, 실제 PostgreSQL 17.10, fake push provider를 사용한다.
이 기록은 격리 검증 증거다. 운영 활성화 승인이 아니다.

기준 후보:

| 저장소 | PR | 입력 SHA |
|---|---|---|
| clever-route-server | 483 | `af9b4b43b40a5c6c5cba7bc83587217b2bbe25ab` |
| clever-driver-app | 64 | `d5094bf80936799bbeaf6d3a0cb614a2acea6f46` |
| clever-dsv-web | 85 | `171494846835cd3eaec0cdac47e869e1631dc480` |

세 기본 checkout은 clean이었다. 서버 main은 로컬 remote ref보다 한 커밋 뒤였다.
기본 checkout을 갱신하거나 변경하지 않았다.
서버·앱 후보 브랜치를 새 격리 worktree에 복구했다. 웹 후보의 clean worktree는 재사용했다.
Driver PR61 `a7959e5a84393d7dc57e2caa654ea2f8edad202c`와 다른 worktree는 보존했다.
최종 head와 검증 결과는 각 PR의 격리 검증 갱신 기록에 연결한다.

## 실제 DB 검증

`scripts/test-dsv-operational-local-postgres.sh`는 Docker disposable profile의 native PostgreSQL 대안이다.
이 스크립트는 PostgreSQL 17과 명시적 opt-in을 요구한다.
매 실행에서 새 data directory를 만든다. 기존 DB URL과 data directory를 재사용하지 않는다.
고정 loopback 포트를 확보하지 못하면 중단한다. 해당 실행이 만든 클러스터만 종료한다.
각 DB에 migration 113개를 적용했다. 기존 합성 Prisma 검사와 별도로 집계한다.

최종 로컬 실제 DB 검사 결과는 총 109건 통과다.
알림·회차와 실제 HTTP·Driver 코드 검사 65건, G003 배차 검사 37건, G002 이벤트 검사 7건이다.
첫 통합 실행에서 Driver 소스 환경값이 없는 1건은 skip이었다.
최종 회차·HTTP 실행은 실제 Driver 소스를 연결해 65/65 통과했다. skip은 0건이다.
추가한 worker 경쟁·OFF/SHADOW 검사 4건도 이 최종 실행에 포함됐다.
같은 사업장 재배정 검사는 실제 계정 등록으로 `accountId`와 `authSubject`를 연결했다.
그 후 실제 Driver route-access와 assigned-route parser가 두 배송지를 읽는지 검사했다.
제품 권한 검사는 완화하지 않았다.
최종 테스트 실행 입력 서버 SHA는 `3de7a884a8592fe6442e33abe7d543b051e1f41f`다.
실행 로그는 `/tmp/dsv-android-flow-20261007/final-postgres-regressions.log`에 보관했다.
PostgreSQL data와 로그는
`/var/folders/yw/0twpwfws0n148ltvr45g9l540000gn/T/dsv-isolated-postgres.K4nD6I`에 보관했다.

실행 profile:

```sh
CLEVER_RUN_DISPOSABLE_DB_TESTS=1 \
DSV_OPERATIONAL_INCLUDE_G002=1 DSV_OPERATIONAL_INCLUDE_G003=1 \
DSV_DRIVER_SOURCE=/absolute/path/to/driver-candidate \
bash scripts/test-dsv-operational-local-postgres.sh
```

| DB | 주소 | 검사 |
|---|---|---|
| dsv_operational | 127.0.0.1:55496 | 알림·회차·명령·worker·HTTP |
| clever_g003 | 127.0.0.1:55433 | 배차 적용·공개·rollback |
| clever_g002 | 127.0.0.1:55488 | 구형 기사 이벤트 계약 |

알림·회차 DB 검사에는 다음 항목이 포함된다.

- 공개·변경·해제 intent와 transaction rollback, 동일 command receipt의 중복 방지.
- 실제 샘플·영속 작업·상태를 사용하는 창고 진입·이탈과 worker 재시작.
- T+300초 이전 0건, 이후 최소 300초 간격, 시작 승인 후 N05 종료.
- 같은 샘플과 due timer의 두 worker 경쟁, fake provider의 중복 claim 방지.
- lease 회수와 늦은 worker 완료 거부, 기술 재시도와 업무 ordinal 분리.
- 재배정, 계정 연결, 다른 사업장·기사의 조회와 쓰기 거부.
- 미배송 보고·N07의 원자성, 관제 확인·처리 상태와 주문·배송 결과의 분리.
- OFF·SHADOW·기본 send policy에서 provider 호출 0건.

최종 실행은 dsv_operational, clever_g002, clever_g003에 migration 113개를 각각 새로 적용했다.
세 클러스터는 검사 종료 후 해당 실행의 cleanup으로 종료됐다.
이 109건은 이전 64건 실행과 합산하지 않는다.

정책 숫자와 사유 코드는 합성 fixture 주입값이다.
운영 정책 D01/D02/D04/D05/D07과 반복 최대 6회를 승인하지 않는다.

## 실제 HTTP와 클라이언트

`tests/support/dsv-isolated-http-harness.ts`는 실제 Fastify route, Prisma service, PostgreSQL을 사용한다.
Driver bearer token과 관제 signed cookie·CSRF 검사를 수행한다.
loopback fixture bootstrap은 테스트 전용이다. 운영 로그인·배포 환경의 증거로 계산하지 않는다.
실제 Driver 소스 연결 검사는 `DSV_DRIVER_SOURCE`가 필요하다.
이 값이 없는 guarded skip은 클라이언트 검증 통과로 계산하지 않는다.

관제 웹의 기존 source HTTP harness는 합성 Prisma 저장소를 사용한다.
새 PostgreSQL browser lane과 이전 합성 source lane은 별도로 집계한다.

W1은 조회한 정확한 회차의 상태를 해석할 수 없으면 새 SAME_EXECUTION/select를 차단한다.
UUID의 대소문자는 동일 대상으로 처리한다. 차단 시 새 POST는 0건이다.
NEW_EXECUTION과 기존 불확실 명령의 동일 commandId 재시도는 별도로 허용한다.
미조회 ID의 존재·사업장·최종 업무 권한은 서버가 검증한다.

실제 PostgreSQL 브라우저 검사는 2/2 통과했다. 브라우저 route mock을 사용하지 않았다.
N07 열기·확인·처리 완료 후 주문·배송지 상태를 유지했다.
N05는 서버 시작 승인 후 30초 polling으로 갱신됐다.
1440×900·375×812 화면을 검사했다. 모바일 가로 넘침과 겹침은 없었다.
화면 증거는 `/tmp/dsv-operations-postgres-browser/`에 보관했다.

## 실제 Android UI와 HTTP·DB 경계

실제 Android 검사는 별도 suffix package와 SM-N981N에서 수행했다.
앱은 loopback reverse를 통해 `127.0.0.1:4908`의 테스트 전용 Fastify runtime에 연결했다.
runtime은 실제 Prisma 저장소와 PostgreSQL을 사용했다.
push provider는 `dsv-isolated-fake`만 구성했다.
실제 FCM과 운영 provider는 사용하지 않았다.

기기 흐름에서 다음 항목을 확인했다.

- 실제 기사 로그인, 로그인 복구, 배송일 선택, 배차 선택, 두 배송지 표시.
- N01 공개와 N02 내용 변경 표시.
- 실제 GPS sample·job·geofence service의 창고 도착, 출발, 첫 N05, 5분 이상 뒤 반복 N05.
- 실제 UI 시작 승인 후 N05 종료. 시작 후 1시간 tick은 0건이며 N05 수는 증가하지 않았다.
- 두 배송지 중 지정한 배송지의 실제 N06 이동.
- 오프라인 입력 보존, 앱 재시작, 응답 유실 후 동일 commandId 재시도.
- 첫 보고 응답 201, 동일 commandId 재시도 200, 보고·N07·command receipt 각 1건.
- 관제 웹의 N07 열기, 확인, 처리 완료. 주문과 배송지 상태는 별도로 유지.
- 만료 access token의 401 후 refresh 200과 동일 N02 처리 복구.
- 다른 계정의 N02 처리 404.
- 같은 사업장 재배정 후 이전 기사의 처리 404와 새 기사의 두 배송지 조회.
- 취소 후 열린 N03 사실 알림과 stale N02 처리 404.

최종 실제 DB 상태는 보고 `RESOLVED`, N07 `RESOLVED`, 대상 배송지 `PENDING`이다.
해당 경로의 `STOP_FAILED`는 0건이다.
경로는 마지막 취소 검사 때문에 `CANCELLED`다.
provider attempt는 0건이며 non-fake provider message도 0건이다.

원본 증거는 다음 경로에 있다.

- 전체 fixture 상태: `/tmp/dsv-android-flow-20261007/final-fixture-state.json`
- 축약 상태와 HTTP trace: `/tmp/dsv-android-flow-20261007/final-fixture-summary.json`
- 직접 SQL 결과: `/tmp/dsv-android-flow-20261007/final-db-evidence.json`
- 시작 후 reminder tick: `/tmp/dsv-android-flow-20261007/post-start-tick.json`
- native HTTP trace: `/tmp/dsv-android-flow-20261007/native-http.jsonl`

실기기 runtime health SHA는 `55a8979d476df4e07e3c3ac0b2dd1ca0094e4217`이었다.
후속 fixture 보완 SHA `0d800475d0b504ad4eb69b3ffdf265964c6c1f23`은
두 배송지 metadata와 실제 Driver parser 회귀를 추가했다.
최종 SHA `3de7a884a8592fe6442e33abe7d543b051e1f41f`은
재배정 계정 연결과 production Driver route-access 회귀를 추가했다.
두 후속 SHA는 최종 새 PostgreSQL 109건으로 검증했다.
실기기 runtime SHA와 최종 테스트 SHA를 같은 실행으로 표현하지 않는다.

## 코드 검사와 독립 검토

서버 Prisma generate와 변경 파일의 whitespace·shell 문법 검사는 통과했다.
독립 검토에서 W1, 실제 DB HTTP harness, native 격리 설정의 코드 결함은 남지 않았다.
전체 타입 인지 ESLint는 4GiB 명령 한도에서 600초 timeout으로 종료됐다.
OOM이나 lint 오류는 출력되지 않았다. 메모리 압력 아래에서 로컬 전체 검사를 반복하지 않았다.
서버 소스 `96317ac35ffda99a1699b5b3ad19d3a2e0e33363`의
[CI 37570355537](https://github.com/EVNSolution/clever-route-server/actions/runs/37570355537)는 통과했다.
전체 lint·typecheck·단위 검사 3,267건·build·compose 검사가 통과했다.
단위 단계의 guarded/optional skip 312건은 통과로 계산하지 않았다.
실제 disposable DB profile 301건과 별도 원본 관측 5건도 통과했다.
CI의 Driver 소스 환경값이 없는 1건은 skip이다. 해당 클라이언트 검사는 위 로컬 최종 4/4로 증명한다.
초기 CI가 찾은 테스트 CORS 옵션 타입 오류는 `false`로 수정했다. 운영 옵션 계약을 넓히지 않았다.

전체 검증 실행은 기존 `@fastify/busboy` 3.2.0의 production audit 차단도 발견했다.
firebase-admin과 @fastify/multipart의 기존 `^3.0.0` 범위에서 lock entry 하나만 3.2.2로 갱신했다.
기준 축소나 audit 제외는 없다. 일반 PR 검사에서 dependency 변경이 없었던 이전 실행은 이 audit를 실행하지 않았다.
공식 수정 근거는 [3.2.1 DoS 수정](https://github.com/advisories/GHSA-x8mw-p69m-v3mx)과
[3.2.2 CRLF 수정](https://github.com/advisories/GHSA-gxm5-99cw-xjw9)이다.
수정 후 production audit와 전체 후보 CI 결과는 PR 갱신 기록에 연결한다.

## Driver audit와 native 증거 경계

Driver Issue62의 기존 audit gate를 유지한다.
bundle export, native APK 생성, suffix package 설치, 실제 FCM 수신은 각각 다른 증거다.
업무용 package와 데이터를 덮어쓰지 않는다.
격리 native 후보는 별도 package와 loopback API를 사용한다. 실제 Firebase 발송 설정을 사용하지 않는다.
audit·APK·설치의 최종 결과는 Driver의 격리 검증 기록과 각 PR 갱신 기록에 연결한다.

Driver 소스 `ac1e688da250de9611dc2de0fde89f01ce41620e`의
[CI 37570524933](https://github.com/EVNSolution/clever-driver-app/actions/runs/37570524933)는
workspace 320/320, lint, Android/iOS export를 통과했다. audit 단계는 기존 20 high로 실패했다.
Expo 정합성·whitespace 후속 단계는 CI에서 skip이었다. 해당 로컬 검사 결과는 Driver 기록에 남긴다.
공식 advisory와 지원되는 Expo 의존성 조합에서 수정 버전을 확인하지 못했다. Issue62 차단을 유지한다.

격리 arm64 APK는 생성됐다. 첫 실행은 1,200초 timeout이었다. 오류·OOM은 없고 마지막 lint 단계까지 진행했다.
유효한 Gradle/NDK 산출물을 재사용한 한 번의 제한된 후속 실행은 57.31초에 성공했다.
첫 APK는 일반 cleartext 옵션이 release manifest에 반영되지 않아 격리 HTTP 접근을 차단했다.
격리 모드 전용 Android manifest plugin으로 수정했다. 기본 업무용 설정은 유지했다.
최종 재빌드는 30.1초에 성공했다. APK는 45,577,823 bytes다.
최종 SHA256은 `9fff45386f9384f0207ca496dbf0147a10ba956c78f1113290fc03ec8d3825f5`다.
별도 package를 SM-N981N에 설치했다. 실제 테스트 DB의 합성 기사 로그인·홈 화면과 재실행 로그인 복구를 확인했다.
업무용 package는 0.1.15/26을 유지했다. 실제 FCM 수신은 미검증이다.
세 후보의 최종 SHA와 기기 화면·로그 경로는 PR의 최종 검증 갱신 기록에 남긴다.

## 남은 범위

- 실차 GPS 정답 표본과 D04의 반경·체류·공백·지연 기준은 미검증이다.
- 실제 FCM 수신, Galaxy의 Doze·잠금·강제 종료·권한·다기기 조합은 별도 검증이 필요하다.
- 운영 runtime 이미지·웹 artifact·서명된 업무용 설치·운영 provider 연결은 검증하지 않는다.
- D01/D02/D04/D05/D07의 운영 승인과 보관·삭제 정책은 남아 있다.
- P7 업무 자취는 별도 범위다.

PR 병합, 운영 배포, AWS 변경, 운영 DB 변경과 실제 알림 발송은 수행하지 않는다.
