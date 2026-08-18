# Driver delivery Space API

배송원이 배송지 묶음을 공용 Space에 반납·확보하거나 같은 배차의 다른 배송원에게
전달 요청을 보내는 계약이다.
변경 단위는 같은 `destinationId`의 모든 SellerOrder이며 일부 주문만 이동하지 않는다.

- `GET /driver/delivery-space`: `mine`, `available`, 전달 가능한 `recipients`, `incomingHandoffs`, `outgoingHandoffs`, 낙관적 잠금용 `version` 조회
- `POST /driver/delivery-space/{destinationId}/release`: 내 배송지 전체 반납
- `POST /driver/delivery-space/{destinationId}/acquire`: 공용 배송지 전체 확보
- `POST /driver/delivery-space/{destinationId}/handoff-requests`: 내 배송지 전체 전달 요청 생성
- `POST /driver/delivery-space/handoff-requests/{requestId}/accept`: 받은 전달 요청 수락 및 배정 변경
- `POST /driver/delivery-space/handoff-requests/{requestId}/reject`: 받은 전달 요청 거절
- `POST /driver/delivery-space/handoff-requests/{requestId}/cancel`: 보낸 전달 요청 취소

배송지가 아직 하나도 없는 `READY` 배차도 등록 차량이 있으면 route access와
Space 조회가 가능하다. 등록 차량이 없는 배차는 route access 단계에서
`VEHICLE_REQUIRED`, Space 조회 단계에서
`DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED`로 차단한다.
등록 차량은 있지만 당일 배차가 없는 배송원은 `Asia/Seoul` 기준 당일 공용
배송 그룹에 빈 `READY` 배차를 한 번만 만들고 동일한 route-scoped 계약으로
진입한다. 과거 `READY` 배차가 남아 있어도 당일 빈 배차 생성을 막지 않는다.

`mine`, `available`, `recipients`, `incomingHandoffs`, `outgoingHandoffs`는 `Asia/Seoul` 기준 당일 그룹에서만 반환한다.
전달 대상은 같은 그룹에 다른 배송원 명의의 `READY` 경로가 있는 경우만 노출한다.
과거 또는 미래 그룹은 목록을 비워 반환하며 `acquire`, `release`, 전달 요청 생성/결정은
`DESTINATION_BUNDLE_TRANSFER_CLOSED`로 차단한다.

반납·확보 명령 본문은 `{ "expectedVersion": "..." }`, 전달 요청 본문은
`{ "expectedVersion": "...", "targetDriverId": "..." }`이다. 서버는 토큰의
현재 그룹에서 대상 배송원의 경로를 다시 검증하며 클라이언트가 대상 경로를 지정하지 않는다.
전달 요청은 10분 뒤 만료된다. 생성은 배정을 변경하지 않고, 대상 배송원이 수락할 때 서버가 묶음 전체를
한 번의 route grouping draft 저장으로 이동한다. 확보 대상 경로가 `READY` 또는
`IN_PROGRESS`이고 차량이 있을 때 허용한다. 따라서 배송원이 이미 배송을 시작한
뒤에도 새 공용 배송지를 선택할 수 있다. 단, `IN_PROGRESS` 경로에서 기존 배송지를
반납하는 작업은 계속 차단한다. 동시 확보 시 첫 저장만 성공하고 후속 요청은
`DESTINATION_BUNDLE_ALREADY_ACQUIRED` 또는 `DESTINATION_BUNDLE_ASSIGNMENT_CHANGED`를 받는다.
