# DSV 배차 업로드

## 식별 기준

- `driver`는 배송원 이름이다. 현재 데모에서는 DSV 배송원 프로필의 `lookupName`과 같은 매장 안에서 정확히 일치하는 이름으로 조회한다.
- `vehicle`은 차량 번호다. 차량 번호를 배송원 식별자로 사용하지 않는다.
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
6. 업로드 확정 시 정식 주문이 아니라 DSV 배차 스테이징에 10행을 원자적으로 저장한다.
7. 같은 SellerOrderKey를 다시 올리면 중복으로 거부한다.

## API

모든 경로는 DSV 관리자 세션을 요구한다. 변경 요청은 `X-CSRF-Token`도 요구한다.

- `GET /api/dsv/conditions`
- `POST /api/dsv/conditions`
- `POST /api/dsv/dispatch-imports/preview`
- `POST /api/dsv/dispatch-imports`
- `GET /api/dsv/dispatch-imports/:importId`

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

확정 API는 검증된 업로드를 스테이징할 뿐 `Order`, `DeliveryStop`, `RoutePlan`을 생성하지 않는다. 다음 단계에서 고객사 매핑, 주소 확정, 주문 상태 전이, OSRM 경로 생성을 하나의 적용 작업으로 설계해야 한다. 이 경계를 넘겨 미리 주문을 만들면 수정과 재업로드 시 중복 배송 위험이 생긴다.
