# DSV 배차 업로드

## 식별 기준

- `driver`는 배송원 이름이다. DSV 배송원 프로필의 `lookupName`과 같은 매장 안에서 정확히 일치하면 해당 배송원 경로로 자동 배정한다.
- `driver`가 비어 있으면 허용하며 기존처럼 미배정 주문으로 가져온다.
- `vehicle`은 선택적인 차량 번호다. 비어 있으면 배송원의 기본 차량을 사용하고, 기본 차량이 없어도 배송원 배정은 유지한다. 차량 번호를 배송원 식별자로 사용하지 않는다.
- 한 파일 안에서 배송원 하나는 차량 하나에만, 차량 하나는 배송원 하나에만 연결한다.
- `SellerOrderKey` 한 행이 배정과 해제의 최소 단위다.

배송원 이름은 장기적인 고유키로 충분하지 않다. WMS가 배송원 코드를 제공하면 `driverExternalCode`를 계약에 추가하고 이름은 표시값으로만 전환해야 한다.

## 10건 예제 시나리오

예제 파일: `docs/examples/dsv-fixed-dispatch-10.csv`

1. 관리자는 `Ambient`, `Cold`, `TS03` 운송조건과 배송원 3명, 차량 3대를 등록한다.
2. 관리자가 10행 CSV를 선택하고 2026-07-23 배차로 사전 검사한다.
3. `COLD`는 `Cold`와 다른 원문이므로 미등록 운송조건으로 차단된다.
4. 관리자가 `COLD`를 별도 조건으로 등록하거나 파일을 `Cold`로 정정한다.
5. 다시 검사하면 배송원과 차량, SellerOrderKey, 수량, 좌표가 검증된다.
6. 업로드 확정 시 10행을 스테이징한 뒤 적용하여 주문, 배송지, 배차 그룹과 배정된 현재 경로 버전의 공개 상태를 원자적으로 저장한다.
7. 같은 배차일의 SellerOrderKey를 다시 올리면 기존 주문과 비교해 변경 없음 또는 수정 후보로 처리한다.

## API

모든 경로는 DSV 관리자 세션을 요구한다. 변경 요청은 `X-CSRF-Token`도 요구한다.

- `GET /api/dsv/conditions`
- `POST /api/dsv/conditions`
- `POST /api/dsv/dispatch-imports/preview`
- `POST /api/dsv/dispatch-imports`
- `GET /api/dsv/dispatch-imports/:importId`
- `POST /api/dsv/dispatch-imports/:importId/apply`

## 로컬 Docker 실행

서버 저장소 루트에서 실행한다.

```bash
npm run dsv:dev:up
curl http://localhost:3001/healthz
npm --prefix apps/delivery-api run dsv:dispatch-demo:smoke
```

로컬 DSV 로그인 값은 `operator`, `local-demo-password-2026`, `dsv-demo.local`이다. 이 값은 개발 compose에만 있으며 운영 설정으로 사용하지 않는다.

프런트는 아래 환경으로 Vite 프록시를 사용한다.

```bash
VITE_DSV_API_MODE=remote \
VITE_DSV_API_PROXY_TARGET=http://localhost:3001 \
VITE_DSV_SHOP_DOMAIN=dsv-demo.local \
npm run dev
```

데이터를 완전히 초기화할 때만 `npm run dsv:dev:reset`을 사용한다.

미리보기와 확정 요청 본문은 동일하다.

```json
{
  "fileName": "dsv-fixed-dispatch-10.csv",
  "planDate": "2026-07-23",
  "rows": [
    {
      "rowNumber": 2,
      "driverName": "김도윤",
      "vehiclePlate": "21사 6101",
      "destinationName": "강남세브란스병원",
      "conditionCode": "Cold",
      "shippedBoxes": 4,
      "address": "서울특별시 강남구 언주로 211",
      "customerCode": "DSV-HEALTH",
      "sellerOrderKey": "DSV-DEMO-20260723-001",
      "notes": "후문 하역장 이용",
      "latitude": 37.49295,
      "longitude": 127.04619
    }
  ]
}
```

## 현재 경계

확정 API는 검증된 업로드를 먼저 스테이징한다. **DSV 파일 적용 성공은 기사 앱 공개까지 포함한다.** 적용 API가 `Order`, `DeliveryStop`, 배차 그룹 및 배정된 현재 경로 버전의 `publishedAt`을 같은 트랜잭션에서 저장한다. 경로는 `READY`를 유지하며 배송 시작·완료 기록을 생성하지 않는다. 경로 최적화는 커밋 이후 예약하고 출발 확정은 별도 운영 단계다.

- 공개 대상은 이번 적용 결과의 주문이 가리키는 `DSV_DISPATCH` / `dsv-import:*` 그룹의 현재 버전이다. 기사와 경로의 배정이 일치하는 `READY` 경로만 공개한다. 미배정, 이전 버전, 진행·완료 경로 및 완료 이벤트가 있는 경로는 변경하지 않는다.
- 공개 저장이나 적용 결과 저장이 실패하면 주문·배차·공개 변경이 함께 롤백된다. 실패 영수증은 별도 트랜잭션으로 보존한다.
- 같은 `commandId`와 입력의 재시도는 저장된 결과를 반환한다. 같은 파일을 새 import로 적용한 `NO_OP`/수정 행도 연결된 대상 경로를 확인하되, 이미 공개된 버전의 공개 시각을 갱신하지 않는다.
- 기존 DSV 파일 적용의 무알림 정책을 유지한다. 푸시 알림 시도와 고객 이메일을 생성하지 않으며, `notificationStatus`도 변경하지 않는다. 공개는 기사 조회 가능 여부이며 알림 수신을 뜻하지 않는다.
- 기사 조회의 계정·고객사·현재 버전 검증은 그대로 적용된다. 계정 미연결·비활성 기사는 공개된 경로라도 조회할 수 없다. K-food의 저장 후 별도 Dispatch 규칙에는 영향을 주지 않는다.

## 기존 APPLIED 배차

이 수정만 배포해도 과거 `APPLIED` 배차가 자동으로 공개되지는 않는다. 기존 성공 명령을 재시도해도 공개 상태를 소급 변경하지 않는다. 기존 미공개 배차는 별도 복구가 필요하며 파일 재업로드를 복구 수단으로 사용하지 않는다.

복구 전 읽기 전용으로 DSV import → 주문 → 현재 child → 담당 기사/계정 연결을 다시 확인하고, 필요한 배송일의 `READY`·미공개·기사 배정 경로만 검토한다. 진행·완료 경로와 완료 이벤트가 있는 경로는 제외한다. 실행 승인 후에는 백업 및 현재 버전/기사/상태/이벤트 조건 검증을 포함한 단일 트랜잭션을 사용하고, 기사 조회와 재실행 시 변경 0건을 확인한다. 푸시·이메일 없이 공개 시각만 복구해야 한다.
