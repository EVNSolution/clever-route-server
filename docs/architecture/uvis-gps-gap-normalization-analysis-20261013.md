# UVIS 일일 경로 끊김 원인 분석과 GPS 결손 정규화 설계

GPS 고정 구간의 반복 송신을 새 위치 관측으로 취급하는 구조가 핵심 원인이다. 이동시간이 마지막 송신 간격으로 축소된다. 일반 라우팅은 이 구간을 비정상 점프로 분류해 제외한다.

권고 설계는 원본을 보존하는 공통 관측 정규화 함수다. Daily route와 materializer가 같은 결손 구간을 사용해야 한다. 고정 샘플 삭제만으로는 터널 우선순위와 캐시 재사용 문제를 해결할 수 없다.

## 분석 기준과 범위

| 항목 | 기준 |
| --- | --- |
| 분석일 | 2026-10-13, Asia/Seoul |
| 저장소 | `EVNSolution/clever-route-server` |
| 저장소 절대 경로 | `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server` |
| 기준 커밋 | `8c693bda115f4480a4f86346f61dc1bf9b79eace` |
| 포함된 최신 UVIS 수정 | `24d0a1ff02962cd55ede801cbbbc9091f403feb1` |
| 상태 | 분석 완료. 정규화는 `fix/uvis-frozen-fix-gap`에서 구현. 구현은 아래 설계와 다르다: 판정 근거는 속도 255가 아니라 좌표 완전 동일 반복(속도 0 포함)이다. 접기 함수는 `foldFrozenFixRuns`다 |
| 구현 전환 조건 | 사용자의 별도 `go` 이후 구현 시작 |
| 제외 범위 | 운영 호스트 접근, 운영 재처리, 코드 변경, corridor 데이터 변경, `clever-dsv-web` 변경, API 응답 형식 변경 |

이 문서의 코드 줄 번호는 기준 커밋을 따른다. 로컬 파일이 변경되면 마지막 절의 커밋 고정 링크를 사용한다. `S01`부터 `S14`까지는 마지막 절에 절대 경로를 명시한 소스 참조다.

다음 용어를 구분한다.

- **증거**: 코드, 테스트, Git 이력에서 직접 확인한 사실.
- **추론**: 확인한 사실에서 도출한 원인 또는 영향.
- **제안**: 구현하지 않은 설계와 검증 기준.
- **미확인**: 현재 자료로 확정할 수 없는 운영 상태 또는 사례.

UVIS가 GPS 상실 시 마지막 좌표를 속도 255로 반복 송신한다는 설명은 사용자 제공 배경이다. 기존 fixture도 이 패턴을 포함한다. 모든 단말과 펌웨어의 공통 규격으로 확인한 내용은 아니다.

## 원인별 판단

| 순위 | 설명 | 신뢰도 | 근거 |
| --- | --- | --- | --- |
| 1 | 반복 송신을 실제 위치 관측과 구분하지 않아 이동시간을 축소한다. | 높음 | 증거: S01의 `prepareSamples`, S04의 인접점 속도 계산 |
| 2 | 일반 라우팅이 `IMPLAUSIBLE_JUMP`를 제외한다. 복구가 터널 전용 조건에 의존한다. | 높음 | 증거: S01의 `routedGapFor`, S02의 `routeGapBridges` |
| 3 | 기존 회귀 테스트와 집계만으로 새 결손 형태를 검출하기 어렵다. | 중간 | 증거: 특정 사례 테스트는 존재. 해당 materializer에는 reason별 품질 집계가 없음. 운영 전체 검증 체계는 미확인 |
| 별도 확인 | 경기83사7311의 두 끊김도 같은 원인이다. | 미확인 | 두 구간의 원본 샘플과 materializer 결과 미제공 |

기존 fixture 좌표의 직선거리와 관측 시간을 재계산한 결과는 다음과 같다.

| 기존 fixture | 직선거리 | 마지막 송신부터 복구까지 | 고정 시작부터 복구까지 |
| --- | ---: | ---: | ---: |
| 서울86바3800 정릉과 홍지문 서향 통과 | 약 4,274.2m | 60초, 71.24m/s | 240초, 17.81m/s |
| 경기88바9580 서부간선 지하 통과 | 약 8,804.7m | 60초, 146.75m/s | 480초, 18.34m/s |

현재 점프 기준은 `55m/s`다. 두 사례 모두 전체 시간을 사용하면 이 기준 아래로 내려간다. 이 계산은 직선거리 기준이다. 실제 도로 경로의 수용 여부를 검증한 결과는 아니다. 근거: S04, S05의 10~27행 및 140~195행.

첫 번째 fixture의 **서향**은 이동 방향이다. 요청한 **서행** 사례와 같은 통과인지 확인되지 않았다.

## 고정 구간 판정 위치와 기준

현재 고정 구간 탐지 본체는 `findTunnelSignature` 한 곳이다. `inferReviewedTunnelBridge`는 이 함수를 재사용한다. `routeGapBridges`에는 고정 구간 탐지가 없다.

| 위치 | 기준 | 결과와 제한 | 참조 |
| --- | --- | --- | --- |
| `prepareSamples` | 유효 좌표와 시간, 같은 초 중복 제거, 고립 점프 제거 | 속도 255 반복 구간은 유지 | S01 150~175행 |
| `hasImplausibleGpsJump` | 인접 좌표 거리 / 관측 시간 차이 >55m/s | 단말 속도, 고정 횟수, 시동, freshness 미사용 | S04 21~34행 |
| `findTunnelSignature`의 고정 탐지 | 고정 샘플 3개 이상, 마지막 고정 좌표에서 10m 이내, 시작부터 복구까지 180~900초 | 일반 GPS 결손이 아닌 터널 패턴 판정 | S03 204~228행 |
| 같은 함수의 추가 조건 | 첫 고정점 이후 속도 >=200 샘플 2개 이상, 고정 구간과 복구점의 시동 켜짐, 진입 전 관측, 복구 후 이동 증거 | 조건 하나라도 실패하면 signature 생성 안 됨 | S03 222~227행 |
| `freshCadence` | 시간 간격 >=30초, 이전 `staleAfter` >= 다음 관측 시각 | 단일 poll 누락을 허용할 수 있음 | S03 349~355행 |
| `downstreamWitness` | 복구 뒤 최대 3개 관측 확인. 10m 이내 반복은 속도 >=200 필요. 이동 증거는 50m 이상, 점프 아님 | 복구 뒤에도 고정 송신이 계속되거나 증거가 부족하면 탈락 | S03 325~340행 |
| `inferReviewedTunnelBridge` | signature 재사용, 네 road anchor, 매칭선에서 전진, corridor 위치와 방향, 속도 <=35m/s | 검토된 corridor만 수용 | S03 231~320행 |
| `inferRoutedTunnelBridge` | signature 재사용, 시작점과 복구점의 경로 오차 <=60m, 직선거리 >=500m, 경로거리 0.95배 이상 및 1.35배+300m 이하, 속도 <=35m/s | OSRM 후보 geometry 검증 | S03 83~112행 |
| `inferRoutedGapBridge` | 경로 오차 <=60m, 직선거리 >=500m, 경로거리 0.95배 이상 및 1.5배+300m 이하, 양수 시간, 속도 <=55m/s | 고정 여부를 모르는 일반 후보 geometry 검증 | S03 141~168행 |
| `routeGapBridges` | `IMPLAUSIBLE_JUMP` 제외 | 고정 구간 자체는 탐지하지 않음 | S02 947~959행 |

고립 점프 제거는 별개다. Daily의 `isIsolatedGpsJump`와 materializer의 같은 이름 함수가 각각 구현되어 있다. 두 함수는 이전 점과 다음 점으로 우회하면 정상인 단일 이상점을 제거한다. 근거: S01 172~175행, S02 841~869행.

따라서 초기 가설은 다음과 같이 보정해야 한다.

- 고정 뒤 점프가 항상 `IMPLAUSIBLE_JUMP`가 되는 것은 아니다. `staleAfter`를 넘으면 `GPS_GAP`을 먼저 선택한다. 점프 기준 이하이면 `NO_MATCH`가 될 수 있다.
- 고정 탐지 세 개를 합치는 문제가 아니다. 터널 탐지에만 있는 결손 의미를 일반 경로 처리에도 제공해야 한다.
- 샘플을 줄이면 항상 `GPS_GAP`이 되는 것은 아니다. 짧은 고정 구간은 기존 freshness 조건을 넘지 않을 수 있다.
- 이동 없음만으로 결손을 판정하면 정상 정차를 오인한다. 반복 좌표와 확인된 no-fix 근거를 함께 사용해야 한다.

## 현재 일일 경로 생성 흐름

아래 도식의 `jump`는 원본 인접점으로 계산한 속도가 55m/s를 넘는 경우다.

```text
raw samples
    |
    v
prepareSamples
    |
    v
same matched line, forward anchors, and no jump?
    |
    +-- YES --> matched coordinates valid?
    |               |
    |               +-- YES --> use matched road
    |               |
    |               +-- NO ---> raw coordinate + toBridge
    |                            (no fallback retry in this branch)
    |
    +-- NO ---> previous.staleAfter < current.observedAt?
                    |
                    +-- YES --> GPS_GAP ------------------+
                    |                                     |
                    +-- NO ---> jump?                     |
                                    |                     |
                                    +-- NO --> NO_MATCH --+
                                    |                     |
                                    |                     v
                                    |              stored routedGap?
                                    |                     |
                                    |                     +-- YES --> insert route
                                    |                     |           no bridge entry
                                    |                     |
                                    |                     +-- NO ---> raw bridge
                                    |                                 gap-route candidate
                                    |
                                    +-- YES --> IMPLAUSIBLE_JUMP
                                                    |
                                                    v
                                             curated corridor?
                                                    |
                                                    +-- YES --> inferredTunnel
                                                    |
                                                    +-- NO ---> stored tunnel bridge?
                                                                    |
                                                                    +-- YES --> inferredTunnel
                                                                    |
                                                                    +-- NO ---> unresolved bridge
                                                                                no generic routing
```

근거: S01 65~134행, 225~248행.

Materializer는 먼저 이동 구간을 탐지하고 도로 매칭을 수행한다. 다음으로 터널 후보를 계산한다. 그 결과로 daily route를 만든 뒤 일반 gap routing 후보를 수집한다. API 조회에서는 저장된 결과를 사용하며 라우팅 엔진을 호출하지 않는다. 근거: S02 178~243행, 901~987행, S08 1122~1131행.

| Bridge reason | 일반 라우팅 시도 | 터널 처리 | 일반 라우팅 성공 후 |
| --- | --- | --- | --- |
| `GPS_GAP` | 가능. 거리, 캐시, 공급자, 처리 한도 검사 필요 | 현재 daily의 터널 분기 대상이 아님 | 경로 삽입 후 `bridges`에서 제외 |
| `NO_MATCH` | 가능. 같은 검사 적용 | 현재 daily의 터널 분기 대상이 아님 | 경로 삽입 후 `bridges`에서 제외 |
| `IMPLAUSIBLE_JUMP` | 생성과 조회 양쪽에서 제외 | curated 우선, 저장된 OSRM 터널 후보 차선 | 성공해도 reason 유지, `inferredTunnel` 첨부 |

일반 gap routing은 다음 제한도 적용한다.

1. 실제 그릴 endpoint 사이 거리가 500m 미만이면 제외한다.
2. 같은 관측 시각 쌍의 성공 결과를 재사용한다.
3. 이전 miss는 일반 실행에서 건너뛴다. 최종화 실행에서는 이전 miss를 다시 시도한다.
4. 한 실행에서 새 후보 최대 60개를 처리한다. 후보당 두 번 호출할 수 있으므로 HTTP 호출 60회 제한과는 다르다.
5. 방향 조건을 넣은 경로가 반환됐지만 검증에서 거부되면 방향 조건 없이 재시도한다.
6. 엔진이 `null`을 반환하면 방향 조건 없는 재시도 없이 miss로 기록한다.

정규화 이후에도 엔진 실패, 경로 검증 실패, 처리 한도 초과는 남을 수 있다. 현재 document의 `retryable`은 도로 매칭 결과에서 집계된다. 일반 gap의 miss나 처리 보류를 자체적으로 재시도 상태에 반영하지 않는다. 근거: S02 198행, 245~249행, 943~985행.

## 끊김 관련 수정 이력

날짜는 커밋의 Asia/Seoul 기준이다. 다음 커밋은 기준 HEAD에 포함되어 있다. 커밋 존재와 포함 관계는 운영 배포의 증거가 아니다.

| 날짜 | 커밋 | 허용한 범위 또는 기반 변경 | 남은 제한 |
| --- | --- | --- | --- |
| 2026-08-10 | [fd6cbd5a](https://github.com/EVNSolution/clever-route-server/commit/fd6cbd5adb739ffb2a1da94c9895ce6990154642) | 차량별 일일 trail materialization 도입 | 고정 GPS 정규화 없음 |
| 2026-08-10 | [3d18b33b](https://github.com/EVNSolution/clever-route-server/commit/3d18b33bd039dfcd8c4c89683683a181d829a913) | backfill 결정성과 부분 결과 처리 보강 | 입력의 GPS 품질 의미는 그대로 |
| 2026-08-10 | [c641c70f](https://github.com/EVNSolution/clever-route-server/commit/c641c70f2e8e2daac96920e5dd5d6b8e9941ad44) | 일시적 OSRM 실패와 최종화 상태 처리 보강 | 고정 구간 분류는 해결하지 않음 |
| 2026-08-11 | [1cced3e5](https://github.com/EVNSolution/clever-route-server/commit/1cced3e5f5991beec418c0399befd8675fc4887b) | 매칭 도로에 시간 anchor 연결 | 불확실한 위치 구간의 의미는 별도 |
| 2026-08-11 | [03c74f5c](https://github.com/EVNSolution/clever-route-server/commit/03c74f5cf6722d2f440fe87e2ea085427ff55680) | 안정된 이전 구간 재사용과 불완전 결과 복구 | 정규화 변경 시 캐시 재검증 필요 |
| 2026-08-11 | [a41229a5](https://github.com/EVNSolution/clever-route-server/commit/a41229a512f49936f1d23932c4b0d6a88166d555) | 어려운 UVIS 매칭의 처리 시간 경계 보강 | 입력 분류 변경 없음 |
| 2026-08-11 | [954dfbe5](https://github.com/EVNSolution/clever-route-server/commit/954dfbe5d047bc91d7d5cbbeb0bf7099219a5d85) | UVIS 매칭 요청의 샘플 크기 조정 | 고정 반복도 매칭 입력에 남음 |
| 2026-09-21 | [7e859a39](https://github.com/EVNSolution/clever-route-server/commit/7e859a3913c327a21e334a4d99c39c82aadc1704) | UVIS에 `legacy-whole-match` 정책 명시 | Driver 경로 정책과 UVIS 정책을 구분해야 함 |
| 2026-09-29 | [2e0b42b8](https://github.com/EVNSolution/clever-route-server/commit/2e0b42b83b0bdaaaf0fd564fcbd9ecb145373c84) | 매칭 실패 시 trail 연속성 보존 | 긴 raw chord의 도로 복원은 별도 |
| 2026-09-29 | [bfc45cb3](https://github.com/EVNSolution/clever-route-server/commit/bfc45cb3da04c065fcd2977412b1f9596e8a087e) | 매칭 도로가 샘플을 놓치면 raw GPS 표시 | 표시와 경로 추정을 분리 |
| 2026-09-29 | [29ef47c3](https://github.com/EVNSolution/clever-route-server/commit/29ef47c3ff8115ff6cd01d0dc322f7bafcac44e1) | 일일 연속 경로 추가 | 불확실한 연결은 bridge로 유지 |
| 2026-09-30 | [1df4caec](https://github.com/EVNSolution/clever-route-server/commit/1df4caec607ecda435636c6f2f680614409c3d49) | 공통 55m/s 점프 판정과 미검증 연결 차단 | 고정 반복을 결손으로 표현하지 않음 |
| 2026-09-30 | [7b6a298e](https://github.com/EVNSolution/clever-route-server/commit/7b6a298e8ffefe4ec13a1d30c964119b49b76b15) | 검토된 정릉 동행 corridor의 고정 구간 허용 | 해당 corridor와 엄격한 anchor 조건에 한정 |
| 2026-09-30 | [5c6f34e5](https://github.com/EVNSolution/clever-route-server/commit/5c6f34e5353c204ba88226884383d43d445ad06b) | 복수 reviewed corridor와 복구 후 증거 처리 확장 | 일반 GPS 결손 처리는 아님 |
| 2026-10-12 | [a3a5b242](https://github.com/EVNSolution/clever-route-server/commit/a3a5b242763c2b7e26bb1559a2eda41f4b60a57a) | curated corridor 밖의 OSRM 터널 후보 허용 | tunnel signature 통과 필요 |
| 2026-10-13 | [e8caf60a](https://github.com/EVNSolution/clever-route-server/commit/e8caf60aab758e780fe2f74c8b5ed3620f2e4467) | 고정 중 poll 누락 허용. 최소 4개에서 3개, 최대 10분에서 15분으로 확대 | 여전히 터널 패턴 조건에 종속 |
| 2026-10-13 | [35ad2545](https://github.com/EVNSolution/clever-route-server/commit/35ad2545b21103e88c5aafe9be2a107373cc94cc) | 긴 `GPS_GAP`과 `NO_MATCH` 일반 라우팅 | `IMPLAUSIBLE_JUMP` 제외 |
| 2026-10-13 | [2fb3786a](https://github.com/EVNSolution/clever-route-server/commit/2fb3786a125e7f19fd95ab22327f07bcf65e0d68) | 실패 구간의 miss 캐시 | 같은 실패의 무한 반복은 줄지만 재시도 정책 필요 |
| 2026-10-13 | [24d0a1ff](https://github.com/EVNSolution/clever-route-server/commit/24d0a1ff02962cd55ede801cbbbc9091f403feb1) | 그릴 endpoint 사용, 방향 없는 재시도, 최종화 miss 재시도 | 원본 인접점에 의한 점프 분류는 유지 |

전체 UVIS 경로 이력에서 다음 보조 변경도 확인했다.

- 2026-08-05 `5e1d223e`, `4f0d0fd6`, `63bdf2c2`, `eeedd896`: 수집, Node 호환, 중복 저장, poll 정책 기반 변경이다.
- 2026-10-06 `32dda9af`: eligible DSV execution에 대한 geofence 작업 생성이다.
- 2026-10-08 `332e8f7b`: geofence execution의 서비스 일자와 유효 시간 조건 변경이다.
- 마지막 두 변경은 bridge 판정이나 고정 GPS 정규화를 수정하지 않았다.

추론: 후기 이력은 관측된 패턴마다 허용 범위를 확장한 과정이다. 재시도, 재사용, 점프 차단 자체는 필요한 기반이다. 빠진 공통 요소는 GPS 결손의 명시적 표현이다.

## 권고 설계

### 공통 관측 정규화

공통 순수 함수가 원본 샘플에서 유효 관측점과 결손 구간을 만든다. Daily route와 materializer가 이 결과를 사용한다. 저장한 원본 telemetry를 삭제하거나 시각을 조작하지 않는다.

Materializer 입력만 바꾸면 충분하지 않다. API는 DB 원본 샘플을 다시 읽어 daily route를 만든다. 두 경로가 같은 정규화 함수를 사용해야 한다. 근거: S08 1062~1131행.

```text
immutable raw telemetry
          |
          v
shared observation normalization
          |
          +-- valid fixes
          +-- explicit GPS gaps
          +-- source index and timestamp mapping
          |
          +-------------------------+
          |                         |
          v                         v
materializer                    daily route
          |                         |
          v                         |
gap classification                 |
          |                         |
          +-- unresolved/invalid -->+--> preserve unresolved evidence
          |
          +-- reconstructable gap
                    |
                    v
             curated corridor
                    |
                    +-- accepted --> store/use inferred tunnel
                    |
                    +-- rejected
                              |
                              v
                      OSRM tunnel candidate
                              |
                              +-- accepted --> store/use inferred tunnel
                              |
                              +-- rejected
                                        |
                                        v
                                generic routed gap
                                        |
                                        +-- accepted --> store/use route
                                        |
                                        +-- rejected --> unresolved + diagnostics
```

위 도식은 제안 구조다. 현재 구현이 아니다.

1. 좌표와 시간 검증, 중복 제거, 고립 이상점 처리를 일관되게 수행한다.
2. 반복 좌표와 no-fix 근거를 함께 판단한다. 단순한 이동 없음은 충분한 근거로 사용하지 않는다.
3. 결손 시작 anchor는 반복 좌표의 최초 유효 관측이다. 첫 255 송신 시각은 별도 내부 근거로 보존한다.
4. 결손 종료는 다음 유효 복구 관측이다. 전체 결손 시간으로 이동 가능성을 평가한다.
5. 결손 종료나 필요한 증거가 없으면 아직 완성되지 않은 구간으로 둔다. 도로를 임의로 생성하지 않는다.
6. 확인된 결손은 명시적인 `GPS_GAP` 후보가 된다. 기존 `staleAfter` 비교만으로 reason을 결정하지 않는다.
7. 알려진 결손이 matched line 분기에서 먼저 소비되지 않도록 한다.
8. 결손 후보에는 curated corridor를 우선 적용한다. 그다음 OSRM 터널 후보와 일반 routed gap을 검토한다.
9. 터널 함수는 정규화 결과를 받는다. 원본 반복 구간을 다시 탐색하지 않는다. Corridor의 방향, anchor, 복구 후 증거 검사는 유지한다.
10. 전체 결손 시간으로도 불가능한 이동은 연결하지 않는다. 실제 이상 좌표를 차단하는 목적을 유지한다.

반복 횟수, 허용 좌표 오차, no-fix 값의 범위, 최대 결손 길이는 fixture와 단말 근거로 확정해야 한다. 현재 터널의 최소 3개 및 3~15분 조건을 일반 결손의 정의로 그대로 복사하지 않는다.

### 캐시와 API 영향

| 항목 | 영향 | 필요한 처리 |
| --- | --- | --- |
| `routedGaps` 키 형식 | `fromObservedAt\|toObservedAt` 유지 가능 | 생성과 조회가 같은 정규화 endpoint를 사용 |
| 기존 키 값 | 마지막 고정 송신에서 최초 유효 관측으로 시작점 변경 가능 | 해당 성공 캐시와 miss 캐시 재평가 |
| 동일 시각의 좌표 변화 | 시각 쌍만 같아도 실제 그릴 endpoint가 달라질 수 있음 | 정책과 endpoint를 확인한 뒤 재사용 |
| 기존 도로 매칭 캐시 | 성공 geometry는 정책 버전이 달라도 재사용 가능 | 버전 문자열 변경만으로 무효화하지 말고 재사용 조건 수정 |
| 입력 서명 | 현재 `sampleSignature`는 시각, freshness, 좌표를 사용. 속도와 시동은 미포함 | 정규화 판단에 쓰는 필드와 정책을 서명에 반영 |
| `sourceWatermark` | 현재 ID, 관측 시각, freshness만 반영 | 정규화 정책과 입력 동등성을 보증하는 근거로 단독 사용 금지 |
| API 응답 구조 | 기존 필드와 reason enum 유지 가능 | 내부 결손 메타데이터를 외부 필드로 추가할 필요 없음 |
| `sourceSampleCount` | 단순히 접힌 배열 길이를 쓰면 의미 변경 | 기존 정제 기준과 원본 대응 관계를 보존하고 테스트 |
| `anchors`와 고객 경로 | 고객 경로는 인접 anchor의 시각 쌍으로 터널 geometry 삽입 | 정규화 bridge의 endpoint와 출력 anchor 순서 일치 검증 |
| 세션과 일자 경계 | 시작점 또는 복구점이 조회 범위 밖일 수 있음 | 범위 내 증거만으로 추정하지 말고 경계 사례 검증 |

근거: S01 32~46행 및 141~147행, S02 640~683행 및 1015~1022행, S09 744~769행.

API의 JSON 형식을 유지할 수 있다는 판단과 기존 소비자의 동작 검증은 별개다. 서버 조회 테스트에서 시간 범위와 고객 경로를 확인해야 한다. 이 설계는 웹 변경을 전제로 하지 않는다.

### 대안과 기각 이유

대안은 `routeGapBridges`와 `routedGapFor`에서 `IMPLAUSIBLE_JUMP`를 허용하는 방식이다.

이 대안은 이동시간을 수정하지 않는다. 경로를 요청해도 마지막 송신 간격으로 계산한 속도 검증에서 다시 탈락할 수 있다. 속도 검증까지 완화하면 실제 이상 좌표를 연결할 수 있다. 각 함수에 고정 구간 예외를 추가하면 판단 기준도 다시 분산된다.

따라서 공통 관측 정규화를 권고하고, 점프 분기의 단순 개방은 기각한다.

### 영향 파일

| 참조 | 파일 | 구현 시 책임 |
| --- | --- | --- |
| S04 | `uvis-vehicle-trail-evidence.ts` | 공통 정규화와 내부 결손 표현 |
| S01 | `uvis-vehicle-daily-route.ts` | reason, anchor, 우선순위, 결과 조립 |
| S02 | `uvis-vehicle-trail-materializer.ts` | 공통 입력, 라우팅, 재사용 정책, 진단 집계 |
| S03 | `uvis-tunnel-bridge.ts` | 정규화 결과를 받도록 고정 탐지와 경로 수용 검증 분리 |
| S05~S07 | UVIS tunnel, daily, materializer 테스트 | 원본 fixture와 반례 검증 |
| S08~S10 | DSV 조회 서비스, 경로 조립, 조회 테스트 | API 형식과 시간 경계의 회귀 확인. 운영 코드 변경 필요 여부는 구현 시 판단 |

Corridor 데이터 수정과 `clever-dsv-web` 수정은 필수 조건이 아니다. 관련 파일의 절대 경로는 소스 참조 절에 있다.

## 품질 지표와 알림 제안

집계 위치는 materializer의 최종 document 조립 후가 적합하다. 최종 document로 daily route를 평가하면 해결한 구간과 남은 구간을 구분할 수 있다. 구조화된 진단 로그 또는 내부 materialization 요약에 기록한다. `gps-trail-history` 응답 필드는 추가하지 않는다.

현재 성공한 터널 bridge도 `IMPLAUSIBLE_JUMP` reason을 유지한다. 일반 routed gap 성공은 `bridges`에서 사라진다. 따라서 reason별 개수만으로 해결률을 계산하면 안 된다. 근거: S01 101~132행.

| 지표 | 목적 |
| --- | --- |
| 정규화한 결손 수와 시간 | 255 반복과 실제 poll 결측의 규모 확인 |
| reason별 후보 수 | `GPS_GAP`, `IMPLAUSIBLE_JUMP`, `NO_MATCH` 분포 확인 |
| 처리 결과별 수 | corridor 성공, OSRM 성공, 검증 거부, 엔진 실패, 처리 보류 구분 |
| 미해결 결손 수와 시간 및 거리 | 사용자에게 남는 끊김 측정 |
| 마지막 성공 처리 시각과 대기 후보 수 | 처리 지연과 한도 초과 검출 |
| 정책 버전과 입력 식별값 | 같은 자료의 결과 변화 추적 |

차량, 서비스 일자, 정책별 최신 결과만 일일 집계한다. 반복 materialization을 서로 다른 결손으로 중복 계산하지 않는다. 차량 ID, 원본 timestamp, bridge key는 진단 로그에 둔다. 이를 무제한 시계열 label로 사용하지 않는다.

알림 기준은 다음과 같다.

1. 알려진 회귀 fixture에서 대상 미해결 구간이 하나라도 있으면 실패로 처리한다.
2. 운영 중 복구점과 필요한 후속 관측이 확보됐는데 연속 처리 후에도 미해결이면 경고한다.
3. 최종화 이후에도 재구성 대상 결손이 남으면 차량과 일자별 알림을 만든다.
4. 실제 비정상 점프는 별도 데이터 품질 진단으로 분류한다.
5. 복구점이 없는 진행 중 결손은 완료된 미해결 구간과 구분한다.

연속 실행 횟수와 대기시간 수치는 운영 자료로 확정한다. `IMPLAUSIBLE_JUMP > 0`만으로 즉시 경보를 발생시키는 기준은 사용하지 않는다. 공식 계측과 알림 근거는 E02와 E03이다.

## 회귀 테스트 목록

| ID | 대상 | 확인 기준 | 자료 상태 |
| --- | --- | --- | --- |
| T01 | 경기83사7311, 2026-10-13로 지정한 22:22Z 구간 | 전체 결손 시간 사용, 대상 미해결 끊김 0 | 원본 필요 |
| T02 | 같은 차량의 22:38Z 구간 | 다른 고정 길이와 복구 형태도 같은 경로로 처리 | 원본 필요 |
| T03 | 서울86바3800, 2026-10-12 정릉 서행 통과 | 긴 결손과 낮은 이동속도 수용, 정상 정차와 구분 | 기존 서향 통과 fixture와 동일한지 확인 필요 |
| T04 | 경기88바9580 서부간선 지하 poll 누락 | 누락 poll을 포함한 하나의 결손 구간과 올바른 경로 복원 | 실제 관측점 존재. 실제 OSRM 경로 fixture 보강 필요 |
| T05 | 255 반복이 짧은 구간 | 터널 최소 3개 및 3분 조건에 일반 결손이 종속되지 않음 | 경계 fixture 필요 |
| T06 | 고정 없이 결측 후 복구 | `staleAfter` 경계 전, 동일, 초과를 각각 확인 | 경계 fixture 필요 |
| T07 | 정상 정차와 시동 꺼짐 | 결손 오인 0, 임의 이동 경로 생성 0 | 기존 반례 확장 |
| T08 | 실제 순간 점프와 고립 이상점 | 잘못된 연결 0, 기존 이상점 처리 유지 | 기존 반례 확장 |
| T09 | 캐시가 있는 자료 재처리 | 새 endpoint 키, miss 재평가, 두 번째 실행 결과 일치 | 통합 테스트 필요 |
| T10 | 공급자 실패와 한도 초과 | unresolved, retry, deferred 결과 구분 | 통합 테스트 필요 |
| T11 | API와 고객 세션 경계 | JSON 형식, 샘플 수, anchor, 터널 경로 삽입 유지 | 조회 테스트 확장 |
| T12 | 일자 경계와 복구점 없음 | 없는 증거를 만들어 연결하지 않음 | 경계 fixture 필요 |
| T13 | 수용 임계값 | 500m, 55m/s, 터널 35m/s, endpoint 오차와 경로거리 상한의 경계 검증 | 단위 테스트 보강 |

T01과 T02의 사용자 제공 차량 ID는 `ebe9167c-1b3b-412a-85be-cfed78d00306`이다. 운영 원본은 사용자가 제공한다. fixture에는 전체 UTC 시각, 좌표, 속도, 시동, `staleAfter`, 전후 관측과 기존 materializer 결과가 필요하다. 공유할 fixture는 비밀정보와 불필요한 식별정보를 제외한다.

`2026-10-13`이 한국 서비스 일자라면 해당 일자의 `22:22Z`는 `2026-10-12T22:22Z`일 수 있다. 반대로 `2026-10-13T22:22Z`는 한국시간 10월 14일이다. 실제 timestamp를 받기 전에는 어느 날짜로도 확정하지 않는다.

현재 S05에는 정릉 서향 관측점과 실제 OSRM 응답 fixture가 있다. 서부간선 테스트의 경로는 직선 대체 geometry다. 따라서 현재 테스트만으로 실제 지하 도로를 복원했다고 판단할 수 없다. 근거: S05 10~31행, 140~195행, S11.

완료 기준은 **정답이 확인된 fixture의 미해결 끊김 0과 잘못된 연결 0**이다. 모든 운영 데이터의 무조건적인 연결은 완료 기준으로 삼지 않는다.

## 외부 근거와 해석 범위

### E01 OSRM Match와 Route 계약

- 공식 문서: [OSRM v26.5.0 HTTP API](https://github.com/Project-OSRM/osrm-backend/blob/v26.5.0/docs/http.md).
- Match는 GPS trace를 도로망에 매칭한다. 큰 timestamp 차이와 불가능한 전이는 분할을 일으킬 수 있다. 매칭하지 못한 outlier의 tracepoint는 `null`이 된다.
- Route는 주어진 순서의 좌표 사이 경로를 탐색한다. Route 성공은 실제 주행 경로의 증명이 아니다. 이 구분은 두 서비스 계약에 따른 해석이다.
- 현재 provider는 Match에 `gaps=split`, `tidy=true`, timestamps를 보낸다. `routeBetween`은 `/route/v1/driving`을 호출한다. 근거: S12 438~469행, 793~809행.
- 현재 `OSRM_TUNNEL_ROUTE`는 터널 태그를 검증하지 않는다. 관측 패턴과 경로 geometry를 검증한다. 근거: S03 83~112행, S12 462~469행.
- 저장소 runbook은 `v26.5.0` 문서를 참조한다. Compose의 기본 이미지는 `latest`다. 운영 이미지 버전과 digest는 미확인이다. 근거: S13 157행 및 179행, S14 143행.
- OSRM 문서는 UVIS 속도 255의 의미를 정의하지 않는다. 결손 판정 임계값은 단말과 fixture 근거로 결정한다.

### E02 계측 지침

- 공식 문서: [Prometheus Instrumentation](https://prometheus.io/docs/practices/instrumentation/).
- 처리 단계의 입력, 출력, 마지막 처리 시각을 관측한다. 실패 수와 전체 시도 수를 함께 기록한다. Label cardinality를 제한한다.
- 위 원칙을 materializer 품질 집계에 적용한다. 이 문서는 Prometheus 설치를 요구하거나 현재 설치 상태를 확인한 문서가 아니다.

### E03 알림 지침

- 공식 문서: [Prometheus Alerting](https://prometheus.io/docs/practices/alerting/).
- 사용자 영향이 있는 증상에 알림을 연결한다. 짧은 일시적 변동과 지속적인 실패를 구분한다.
- Bridge reason 자체보다 재처리 후 남은 미해결 구간을 알림 대상으로 삼는 근거다.

외부 자료 확인일은 2026-10-13이다. 버전 고정 OSRM 문서는 설계 계약의 근거다. 현재 운영 런타임의 동작 보증은 아니다.

## 검증 상태

- 코드, 관련 Git 이력, 기존 fixture와 테스트 구성을 확인했다.
- 기존 fixture의 직선거리와 시간 기준 속도를 재계산했다.
- 이번 분석에서는 테스트 실행, 실제 OSRM 호출, 운영 데이터 재현, 재배포를 수행하지 않았다.
- 따라서 운영 두 구간의 해결 여부와 제안 구현의 통과 여부는 아직 검증하지 않았다.
- 저장한 결과는 분석 문서다. 구현과 운영 조치는 별도 요청 이후 진행한다.

## 소스 참조 절대 경로

다음 절대 경로는 분석에 사용한 로컬 저장소 기준이다. 다른 checkout에서는 커밋 고정 링크의 저장소 상대 경로를 사용한다. 각 고정 링크는 동일한 기준 커밋 `8c693bda115f4480a4f86346f61dc1bf9b79eace`를 가리킨다.

### S01 일일 경로 조립

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-daily-route.ts`

- 주요 위치: 32~46행 응답 형식, 52~147행 조립, 150~175행 샘플 준비, 225~248행 캐시 조회와 reason.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-daily-route.ts:65)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/uvis/uvis-vehicle-daily-route.ts#L65-L248)

### S02 일일 경로 materializer

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-materializer.ts`

- 주요 위치: 178~249행 실행과 최종화, 640~683행 재사용, 841~869행 샘플 준비, 901~987행 bridge 계산, 1015~1022행 watermark.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-materializer.ts:930)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-materializer.ts#L901-L987)

### S03 터널과 일반 gap 경로 판정

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-tunnel-bridge.ts`

- 주요 위치: 83~112행 OSRM 터널, 141~168행 일반 gap, 204~228행 고정 구간, 231~320행 corridor, 325~355행 후속 관측과 freshness.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-tunnel-bridge.ts:204)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/uvis/uvis-tunnel-bridge.ts#L83-L355)

### S04 공통 GPS 증거 계산

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-evidence.ts`

- 주요 위치: 1행 속도 상한, 21~34행 이동속도와 점프 판정.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-evidence.ts:21)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/uvis/uvis-vehicle-trail-evidence.ts#L1-L34)

### S05 터널과 일반 경로 테스트

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-tunnel-route-bridge.test.ts`

- 주요 위치: 10~31행 정릉 fixture, 140~195행 서부간선 fixture와 직선 대체 경로, 267~332행 일반 gap 재사용과 실패 재시도.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-tunnel-route-bridge.test.ts:10)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/tests/uvis-tunnel-route-bridge.test.ts#L10-L332)

### S06 일일 경로 테스트

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-vehicle-daily-route.test.ts`

- 주요 위치: 62~307행 점프와 터널 반례, 332~361행 일반 gap 결과, 410~424행 정제와 샘플 개수.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-vehicle-daily-route.test.ts:62)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/tests/uvis-vehicle-daily-route.test.ts#L62-L424)

### S07 Materializer 테스트

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-vehicle-trail-materializer.test.ts`

- 용도: 정규화, 재사용, 재시도, 최종화 동작의 회귀 테스트 확장 위치.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/uvis-vehicle-trail-materializer.test.ts)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/tests/uvis-vehicle-trail-materializer.test.ts)

### S08 DSV 조회 서비스

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/dsv/dsv-v1-read-query.service.ts`

- 주요 위치: 1062~1087행 원본 조회, 1122~1137행 daily route와 응답 조립.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/dsv/dsv-v1-read-query.service.ts:1124)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/dsv/dsv-v1-read-query.service.ts#L1062-L1137)

### S09 DSV 조회 라우트와 고객 경로 조립

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/routes/dsv-v1-read.routes.ts`

- 주요 위치: 381~395행 `gps-trail-history`, 744~769행 anchor 시각 쌍을 사용한 고객 경로.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/routes/dsv-v1-read.routes.ts:744)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/routes/dsv-v1-read.routes.ts#L744-L769)

### S10 DSV 조회 테스트

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/dsv-v1-read.routes.test.ts`

- 주요 위치: 1433행과 1485행 주변의 `gps-trail-history` 및 `includeDailyRoute` 조회.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/dsv-v1-read.routes.test.ts:1433)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/tests/dsv-v1-read.routes.test.ts#L1433-L1500)

### S11 정릉 서향 OSRM 응답 fixture

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/fixtures/uvis-jeongneung-westbound-osrm-route.json`

- 용도: S05가 읽는 기존 OSRM geometry fixture.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/tests/fixtures/uvis-jeongneung-westbound-osrm-route.json)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/tests/fixtures/uvis-jeongneung-westbound-osrm-route.json)

### S12 OSRM provider

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/route-tracking/route-tracking.road-match.ts`

- 주요 위치: 438~475행 `routeBetween`, 793~819행 Match 요청 설정.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/apps/delivery-api/src/modules/route-tracking/route-tracking.road-match.ts:438)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/apps/delivery-api/src/modules/route-tracking/route-tracking.road-match.ts#L438-L475)

### S13 OSRM 이미지 기본값

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/infra/compose/docker-compose.prod.yml`

- 주요 위치: 157행과 179행 `OSRM_IMAGE` 기본값.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/infra/compose/docker-compose.prod.yml:157)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/infra/compose/docker-compose.prod.yml#L157-L179)

### S14 OSRM 문서 버전과 경로 정책 경계

절대 경로: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/docs/runbooks/route-tracking-quality-rebuild.md`

- 주요 위치: 15~19행 Driver 경로 정책과 UVIS의 구분, 143행 OSRM 문서 버전.
- [로컬 파일 열기](/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/04_CLEVER_Route/clever-route-server/docs/runbooks/route-tracking-quality-rebuild.md:143)
- [기준 커밋의 파일](https://github.com/EVNSolution/clever-route-server/blob/8c693bda115f4480a4f86346f61dc1bf9b79eace/docs/runbooks/route-tracking-quality-rebuild.md#L143)
