# DSV 운송자원 관리

## 현재 범위

DSV 관리 화면에서 사용하는 배송원, 차량, 기본 배정 관계를 서버가 소유한다.

- 공통 식별자와 운영 상태는 기존 `Driver`, `Vehicle`에 저장한다.
- DSV 화면 전용 속성은 `DsvDriverProfile`, `DsvVehicleProfile`에 저장한다.
- 차량에 배송원을 연결하는 관리 관계는 `DsvVehicleDriverAssignment`에 저장한다.
- 이 관계는 기본 운송자원 관계다. 특정 SellerOrder나 현재 운행 경로의 배정을 뜻하지 않는다.

## API

조회는 DSV 관리자 세션을 요구한다. 변경 요청은 세션과 `X-CSRF-Token`을 모두 요구한다.

| Method | Path | 역할 |
| --- | --- | --- |
| `GET` | `/api/dsv/resources` | 배송원, 차량, 기본 배정 전체 조회 |
| `POST` | `/api/dsv/drivers` | 배송원 등록 |
| `PATCH` | `/api/dsv/drivers/:driverId` | 배송원 수정 |
| `DELETE` | `/api/dsv/drivers/:driverId` | 배송원 삭제 |
| `POST` | `/api/dsv/vehicles` | 차량 등록 |
| `PATCH` | `/api/dsv/vehicles/:vehicleId` | 차량 수정 |
| `DELETE` | `/api/dsv/vehicles/:vehicleId` | 차량 삭제 |
| `POST` | `/api/dsv/vehicles/:vehicleId/drivers` | 차량에 기본 배송원 배정 |
| `DELETE` | `/api/dsv/vehicles/:vehicleId/drivers/:assignmentId` | 기본 배정 해제 |

## 업로드 식별 규칙

현재 WMS 예제 파일에는 안정적인 배송원 코드가 없다. 따라서 DSV에 등록된 `lookupName`을 매장 안에서 유일하게 유지하고 업로드의 `driver` 값과 정확히 비교한다. 일반 `Driver.displayName` 전체를 검색하지 않으므로 DSV 관리 화면 밖의 배송원과 혼동하지 않는다.

이름은 장기 고유키가 아니다. WMS가 배송원 코드를 제공하면 별도 외부 코드를 추가하고 `lookupName`은 표시 및 보조 검색 값으로 낮춰야 한다.

차량은 현재 차량 번호를 업로드 식별값으로 사용한다. 차량 번호 외에 안정적인 WMS 차량 코드가 제공되면 같은 방식으로 외부 코드를 추가한다.

## 삭제와 배정 경계

- 현재 데모 단계의 삭제는 영구 삭제다.
- 배송원이나 차량을 삭제하면 DSV 프로필과 기본 배정은 함께 삭제된다.
- 배정 해제는 배송원이나 차량 삭제가 아니다.
- 이미 생성된 주문 또는 경로의 운영 배정은 이 관리 관계와 별도다.
- 운영 전환 시에는 삭제를 비활성화로 바꾸는 시점과 참조 중인 자원에 대한 삭제 제한을 별도로 확정해야 한다.

## 이번 범위가 아닌 것

- 배차 스테이징을 정식 주문과 경로로 적용하는 작업
- 운행 중 배송원 교체와 SellerOrder 습득 또는 해제
- 고객사와 배송처의 기준정보
- 배송 이력, 증빙, 알림, 고객사 계정
- 단말기 위치와 온도 데이터
