# Driver delivery Space API

배송원이 배송지 묶음을 공용 Space에 반납하고 선착순으로 확보하는 계약이다.
변경 단위는 같은 `destinationId`의 모든 SellerOrder이며 일부 주문만 이동하지 않는다.

- `GET /driver/delivery-space`: `mine`, `available`, 낙관적 잠금용 `version` 조회
- `POST /driver/delivery-space/{destinationId}/release`: 내 배송지 전체 반납
- `POST /driver/delivery-space/{destinationId}/acquire`: 공용 배송지 전체 확보

명령 본문은 `{ "expectedVersion": "..." }`이다. 서버는 묶음 전체를 한 번의
route grouping draft 저장으로 이동한다. 경로가 `READY`이고 확보 경로에 차량이
있을 때만 허용한다. 동시 확보 시 첫 저장만 성공하고 후속 요청은
`DESTINATION_BUNDLE_ALREADY_ACQUIRED` 또는 `DESTINATION_BUNDLE_ASSIGNMENT_CHANGED`를 받는다.
