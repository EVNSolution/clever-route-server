# Driver delivery Space API

배송원이 배송지 묶음을 공용 Space에 반납하고 선착순으로 확보하는 계약이다.
변경 단위는 같은 `destinationId`의 모든 SellerOrder이며 일부 주문만 이동하지 않는다.

- `GET /driver/delivery-space`: `mine`, `available`, 낙관적 잠금용 `version` 조회
- `POST /driver/delivery-space/{destinationId}/release`: 내 배송지 전체 반납
- `POST /driver/delivery-space/{destinationId}/acquire`: 공용 배송지 전체 확보

배송지가 아직 하나도 없는 `READY` 배차도 등록 차량이 있으면 route access와
Space 조회가 가능하다. 등록 차량이 없는 배차는 route access 단계에서
`VEHICLE_REQUIRED`, Space 조회 단계에서
`DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED`로 차단한다.
등록 차량은 있지만 당일 배차가 없는 배송원은 `Asia/Seoul` 기준 당일 공용
배송 그룹에 빈 `READY` 배차를 한 번만 만들고 동일한 route-scoped 계약으로
진입한다. 과거 `READY` 배차가 남아 있어도 당일 빈 배차 생성을 막지 않는다.

`mine`과 `available`은 `Asia/Seoul` 기준 당일 그룹에서만 반환한다. 과거 또는
미래 그룹은 두 목록을 비워 반환하며 `acquire`와 `release`는
`DESTINATION_BUNDLE_TRANSFER_CLOSED`로 차단한다.

명령 본문은 `{ "expectedVersion": "..." }`이다. 서버는 묶음 전체를 한 번의
route grouping draft 저장으로 이동한다. 확보 대상 경로가 `READY` 또는
`IN_PROGRESS`이고 차량이 있을 때 허용한다. 따라서 배송원이 이미 배송을 시작한
뒤에도 새 공용 배송지를 선택할 수 있다. 단, `IN_PROGRESS` 경로에서 기존 배송지를
반납하는 작업은 계속 차단한다. 동시 확보 시 첫 저장만 성공하고 후속 요청은
`DESTINATION_BUNDLE_ALREADY_ACQUIRED` 또는 `DESTINATION_BUNDLE_ASSIGNMENT_CHANGED`를 받는다.
