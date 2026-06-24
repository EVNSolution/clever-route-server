# Shopify CLEVER / Dev 앱별 데이터 스코프 분리 요청

GitHub Issue: https://github.com/EVNSolution/clever-route-server/issues/106

## 현재 상황

2026-06-24 기준 Shopify 웹앱 2개가 같은 EC2와 같은 `clever-route-server` delivery-api를 바라보도록 배포되어 있다.

| 구분 | Shopify 앱 | Client ID | 웹앱 URL | Caddy upstream |
| --- | --- | --- | --- | --- |
| 메인 | `CLEVER` | `6994f8bd771cebdac03a800f20e1de86` | `https://clever-admin.cleversystem.ai` | `shopify-app:3000` |
| 개발 | `CleverRoute Dev` | `9be6895e1de376bf056787803e863a4d` | `https://clever-route-app.cleversystem.ai` | `shopify-app-clever-route:3000` |
| 백엔드 | `clever-route-server` | n/a | `https://clever-route.cleversystem.ai` | `delivery-api:3000` |

확인된 배포 상태:

- `clever-route-server`의 Caddy는 위 두 Shopify host를 같은 EC2에서 reverse proxy한다.
- Shopify 앱 컨테이너는 2개가 동시에 떠 있다.
  - `shopify-clever-main-shopify-app-1`
  - `shopify-clever-dev-shopify-app-clever-route-1`
- 기존 백엔드 컨테이너는 유지했다.
  - `clever-route-delivery-api-1`
- `/healthz`는 정상이다.
- 두 Shopify 앱의 OAuth 진입은 각각 다른 `client_id`로 Shopify Admin에 redirect된다.


## 2026-06-24 AWS 운영 확인 결과

현재 AWS 운영 `delivery-api` 컨테이너는 Shopify admin route가 등록되지 않은 상태로 보인다. 무인증 요청이라면 route가 등록되어 있을 때 `401`이 기대되지만, 실제 응답은 `404 Route not found`였다.

확인 결과:

```text
GET https://clever-route.cleversystem.ai/admin/orders      -> 404
GET https://clever-route.cleversystem.ai/admin/route-plans -> 404
GET https://clever-route.cleversystem.ai/admin/drivers     -> 404
```

동일 시점 운영 `clever-route-delivery-api-1` env도 Shopify admin route 활성화에 필요한 credential이 비어 있었다. Secret 값은 출력하지 않았고, 존재 여부만 확인했다.

```text
SHOPIFY_API_KEY=empty
SHOPIFY_API_SECRET=empty
SHOPIFY_DEV_API_KEY=unset
SHOPIFY_DEV_API_SECRET=unset
SHOPIFY_APP_CLIENT_IDS=unset
SHOPIFY_APP_CREDENTIALS=unset
SHOPIFY_APP_URL=empty
```

반면 Shopify app 컨테이너 2개는 이미 같은 Docker network에서 `http://delivery-api:3000`을 바라본다. 따라서 다음 구현/배포에서는 delivery-api 컨테이너에도 main/dev 앱 credential 매핑을 주입해야 한다. 그렇지 않으면 Shopify app은 delivery-api를 호출하더라도 서버 route 자체가 등록되지 않거나 session token 검증이 실패한다.

```text
shopify-clever-main-shopify-app-1: CLEVER_DELIVERY_API_URL=http://delivery-api:3000
shopify-clever-dev-shopify-app-clever-route-1: CLEVER_DELIVERY_API_URL=http://delivery-api:3000
```

## 문제

현재 delivery-api는 대부분 `shopDomain` 기준으로 tenant scope를 잡는다. 그런데 같은 스토어(`clever-test-syhae28n.myshopify.com`)에 `CLEVER`와 `CleverRoute Dev`를 둘 다 설치하면 `shopDomain`이 동일하다.

따라서 지금 구조 그대로면 아래 데이터가 메인 앱과 Dev 앱 사이에서 섞일 수 있다.

- 주문 동기화 결과
- route plans / route stops
- drivers
- settings / depot / route scope config
- driver proof media / driver events
- Shopify token / webhook event

특히 Prisma `Shop` 모델이 현재 `shopDomain`을 전역 unique로 둔다. 같은 shop에 앱 2개를 설치해도 Shop row가 하나로 합쳐질 가능성이 있다.

참고 위치:

- `apps/delivery-api/prisma/schema.prisma`
  - `Shop.shopDomain`
  - `@@unique([shopDomain])`
  - `RoutePlan.shopId`
  - `Driver.shopId`
  - `DriverProofMedia.shopId`
- `apps/delivery-api/src/routes/admin-orders.routes.ts`
- `apps/delivery-api/src/routes/admin-route-plans.routes.ts`
- `apps/delivery-api/src/routes/admin-drivers.routes.ts`
- `apps/delivery-api/src/routes/admin-session-auth.ts`
- `apps/delivery-api/src/modules/shopify/session-token-verifier.ts`

## 요구사항

### 1. 앱 식별자를 delivery-api tenant scope에 포함

`shopDomain`만으로 구분하지 말고, 서버 내부 tenant scope를 다음처럼 잡는다.

```ts
type AdminTenantScope = {
  appId: "clever" | "clever-route-dev";
  shopDomain: string;
};
```

권장 mapping:

| Shopify client_id | server appId |
| --- | --- |
| `6994f8bd771cebdac03a800f20e1de86` | `clever` |
| `9be6895e1de376bf056787803e863a4d` | `clever-route-dev` |

### 2. `Shop` uniqueness를 `appId + shopDomain`으로 변경

권장 Prisma 변경 방향:

```prisma
model Shop {
  id         String @id @default(uuid()) @db.Uuid
  appId      String @default("clever") @db.Text
  shopDomain String @db.Text

  @@unique([appId, shopDomain])
  @@index([shopDomain])
  @@map("shops")
}
```

기존 `@@unique([shopDomain])`는 제거한다.

기존 rows migration 기본값은 우선 `clever`로 두면 된다. Dev 앱은 새 설치/새 토큰 교환 시 `appId = "clever-route-dev"` row를 따로 만들면 된다.

### 3. 모든 admin route/service/repository 입력에 appId를 전달

현재 route들은 session token 검증 결과에서 `shopDomain`만 받아 service에 넘긴다.

예:

```ts
routePlanService.listRoutePlans({ shopDomain })
adminDriverService.listDrivers({ shopDomain })
orderSyncService.listCanonicalOrders({ shopDomain })
```

요구 변경:

```ts
routePlanService.listRoutePlans({ appId, shopDomain })
adminDriverService.listDrivers({ appId, shopDomain })
orderSyncService.listCanonicalOrders({ appId, shopDomain })
```

Repository에서는 `Shop` 조회/생성 기준도 `appId + shopDomain`이어야 한다.

### 4. Shopify session token verifier가 두 앱 client_id + secret 매핑을 모두 허용

현재 verifier가 단일 `SHOPIFY_API_KEY` 기준으로 `aud`를 검증하면 Dev 앱의 session token은 `audience_mismatch`가 날 수 있다.

요구 변경:

- main/dev client id와 secret 매핑을 모두 설정으로 받는다.
- session token `aud`에 맞는 app credential을 선택해 검증한다.
- 검증된 `aud`를 `appId`로 변환해 반환한다.
- `AdminSessionTokenVerifier.verify()` 반환값에 `appId`를 포함한다.

예:

```ts
verify(sessionToken): {
  appId: "clever" | "clever-route-dev";
  shopDomain: string;
  subject: string;
}
```

환경변수는 최소 변경으로 다음 중 하나를 선택한다.

```env
SHOPIFY_APP_CLIENT_IDS=clever:6994f8bd771cebdac03a800f20e1de86,clever-route-dev:9be6895e1de376bf056787803e863a4d
```

또는 기존 main 값을 유지하고 dev만 추가한다.

```env
SHOPIFY_API_KEY=6994f8bd771cebdac03a800f20e1de86
SHOPIFY_DEV_API_KEY=9be6895e1de376bf056787803e863a4d
```

### 5. Shopify 앱은 app identity를 전달만 한다

Shopify 웹앱 쪽에서는 delivery-api 호출 공통 함수 하나만 바꾸면 된다.

현재 공통 호출 위치:

- `shopify-clever/apps/shopify-app/app/features/delivery/route-plans.server.js`
  - `deliveryApiRequest()`
  - `executeDeliveryApiRequest()`

요구 변경:

- env에 앱 식별자를 둔다. 현재 운영 컨테이너에는 아직 `CLEVER_APP_ID`가 없다.

```env
CLEVER_APP_ID=clever
# dev runtime
CLEVER_APP_ID=clever-route-dev
```

- 공통 delivery API request 함수에서 delivery-api 요청 header에 추가한다.

```http
x-clever-app-id: clever
```

단, 최종 권한 판단은 클라이언트 header를 그대로 믿지 말고 delivery-api가 session token `aud`로 검증해야 한다. `x-clever-app-id`는 로깅/명시성/전환 보조용으로만 쓰고, 보안 기준은 검증된 `aud -> appId` mapping이어야 한다.


## 구현 전에 반드시 확인할 추가 결합 지점

### 1. `shopifyShopGid` unique도 app scope를 고려해야 함

`Shop` 모델은 현재 `@@unique([shopDomain])`뿐 아니라 `@@unique([shopifyShopGid])`도 가진다. 같은 Shopify store를 main/dev 두 앱에서 각각 설치하면 `shopifyShopGid`도 같을 가능성이 높다.

따라서 `shopDomain`만 `appId + shopDomain`으로 바꾸면 충분하지 않을 수 있다. 구현 시 아래 중 하나를 결정해야 한다.

- `shopifyShopGid`도 `@@unique([appId, shopifyShopGid])`로 변경
- 또는 앱별 Shop row를 만들지 않고 별도 AppInstallation 모델로 token/scope를 분리

현재 요구사항의 기본 방향은 가장 단순한 `Shop.appId + shopDomain` 분리이지만, `shopifyShopGid` unique도 함께 해소해야 실제로 두 앱 row가 공존할 수 있다.

### 2. 토큰/secret 선택도 app scope를 가져야 함

현재 Shopify verifier/auth/token 경로는 단일 `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` 전제를 가진다. main/dev 앱을 동시에 받으려면 서버가 다음을 명시적으로 처리해야 한다.

- session token `aud`에 맞는 appId 산출
- appId에 맞는 client secret 선택
- token 저장/조회 시 `appId + shopDomain` 기준 적용
- webhook 검증도 topic/shopDomain만이 아니라 어떤 앱 secret으로 검증할지 결정

즉 데이터 row 분리만으로는 부족하고, auth artifact도 앱별로 분리되어야 한다.

## 수용 기준

- 같은 shopDomain에 `CLEVER`와 `CleverRoute Dev`를 둘 다 설치해도 DB row가 분리된다.
- 메인 앱에서 만든 route plan이 Dev 앱 route list에 보이지 않는다.
- Dev 앱에서 만든 driver가 메인 앱 drivers list에 보이지 않는다.
- 기존 운영 데이터는 `appId = "clever"`로 유지된다.
- Dev session token이 `audience_mismatch`로 거절되지 않는다.
- session token의 `aud`와 요청 app id가 불일치하면 401 또는 403으로 거절한다.
- `clever-route.cleversystem.ai/healthz`와 기존 route ops 기능은 유지된다.

## 권장 테스트

서버 레포:

```bash
cd apps/delivery-api
npm test
npm run typecheck
```

추가해야 할 최소 테스트:

1. `Shop` lookup/create가 같은 `shopDomain`이라도 appId별로 다른 Shop row를 만든다.
2. `admin-orders` list/sync가 `appId + shopDomain`으로 scope된다.
3. `admin-route-plans` list/detail/create/delete가 `appId + shopDomain`으로 scope된다.
4. `admin-drivers` list/create/delete가 `appId + shopDomain`으로 scope된다.
5. session token verifier가 main/dev client id를 모두 허용하고 appId를 반환한다.
6. `x-clever-app-id`와 verified appId가 다르면 거절된다.

## 하지 말 것

- 앱별로 `drivers_clever`, `drivers_dev` 같은 별도 테이블을 만들지 않는다.
- Shopify 앱 repo에서 delivery-api DB를 직접 만지지 않는다.
- `docker-compose.prod.yml`로 delivery-api/postgres를 Shopify repo에서 다시 띄우지 않는다.
- 임시 `sslip.io` URL로 되돌리지 않는다.

## 요약

현재 인프라/웹앱 배포는 끝났다. 남은 핵심은 delivery-api의 tenant key를 `shopDomain` 단독에서 `appId + shopDomain`으로 확장하는 것이다. Shopify 앱은 식별자를 전달만 하고, 데이터 분리/권한 판단/DB row 분리는 `clever-route-server`가 소유해야 한다.
