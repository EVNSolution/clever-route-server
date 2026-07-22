import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const shopDomain = process.env.CLEVER_DSV_DEMO_SHOP_DOMAIN?.trim() || 'dsv-demo.local';

try {
  const shop = await prisma.shop.upsert({
    create: {
      appId: 'clever',
      defaultDepotAddress: '경기도 군포시 번영로 82 군포복합물류센터',
      defaultDepotLatitude: 37.330948,
      defaultDepotLongitude: 126.9372235,
      locale: 'ko-KR',
      shopDomain,
    },
    update: {
      defaultDepotAddress: '경기도 군포시 번영로 82 군포복합물류센터',
      defaultDepotLatitude: 37.330948,
      defaultDepotLongitude: 126.9372235,
      locale: 'ko-KR',
    },
    where: { appId_shopDomain: { appId: 'clever', shopDomain } },
  });

  const drivers = [
    { age: 42, career: '냉장 의약품 6년', gender: '남성', name: '김도윤', score: 'A+', traits: ['병원 하역장 숙련', 'POD 누락 0건', '온도기록계 확인 빠름'], zone: '강남 서초' },
    { age: 36, career: '검체 운송 4년', gender: '여성', name: '이서연', score: 'A', traits: ['검체 인수증 꼼꼼', '야간 배송 가능', '주차 동선 메모 우수'], zone: '마포 영등포' },
    { age: 31, career: '백신 배송 3년', gender: '남성', name: '박민재', score: 'A', traits: ['대형병원 보안절차 숙지', '정차시간 준수', '냉장 박스 회수 빠름'], zone: '송파 강동' },
    { age: 45, career: '의약품 물류 8년', gender: '여성', name: '정하린', score: 'S', traits: ['VIP 병원 담당', '분실사고 0건', '거래명세표 확인 강점'], zone: '종로 중구' },
    { age: 29, career: '상온 냉장 복합 2년', gender: '남성', name: '최유준', score: 'B+', traits: ['장거리 루트 적응', '상차 검수 빠름', '긴급 콜 대응'], zone: '수원 동탄' },
    { age: 39, career: '임상시험 검체 5년', gender: '여성', name: '오지민', score: 'A+', traits: ['연구실 직접 인계', '온도 이탈 보고 빠름', '담당자 연락망 풍부'], zone: '강북 서대문' },
    { age: 34, career: '응급 배송 4년', gender: '남성', name: '한태오', score: 'A', traits: ['대체 경로 판단 빠름', '교통 지연 보고', '새벽 배송 가능'], zone: '서울 전역' },
    { age: 33, career: '특장차 운행 5년', gender: '남성', name: '윤서준', score: 'A', traits: ['상차 대기 관리', '냉장칸 봉인 확인', '병원 후문 동선 숙지'], zone: '강남 서초' },
    { age: 37, career: '병원 배송 6년', gender: '여성', name: '문채원', score: 'A+', traits: ['정시 도착률 우수', '인수증 확인 꼼꼼', '검체 라벨 재확인'], zone: '마포 영등포' },
    { age: 40, career: '백신 배송 7년', gender: '남성', name: '서준호', score: 'S', traits: ['대형병원 하차 숙련', '온도 경고 대응 빠름', '야간 보안절차 숙지'], zone: '송파 강동' },
    { age: 32, career: '경기 남부 배송 4년', gender: '여성', name: '강하윤', score: 'A', traits: ['우회 경로 판단', '지연 보고 정확', '긴급 배송 대응'], zone: '수원 동탄' },
    { age: 43, career: '도심 병원 배송 9년', gender: '남성', name: '임태준', score: 'S', traits: ['증빙자료 누락 방지', '거래명세표 확인', '주차 위치 메모'], zone: '종로 중구' },
    { age: 35, career: '냉장 의약품 5년', gender: '여성', name: '배유나', score: 'A+', traits: ['회수품 정리 빠름', 'POD 촬영 정확', '배송 완료 보고 신속'], zone: '송파 강동' },
  ];
  const driverIds = new Map<string, string>();
  for (const driverInput of drivers) {
    const { name, ...profile } = driverInput;
    const current = await prisma.driver.findFirst({ where: { displayName: driverInput.name, shopId: shop.id } });
    const driver = current === null
      ? await prisma.driver.create({ data: { displayName: driverInput.name, shopId: shop.id, status: 'ACTIVE' } })
      : await prisma.driver.update({ data: { status: 'ACTIVE' }, where: { id: current.id } });
    driverIds.set(driverInput.name, driver.id);
    await prisma.dsvDriverProfile.upsert({
      create: { ...profile, driverId: driver.id, lookupName: name, shopId: shop.id },
      update: { ...profile, lookupName: name },
      where: { driverId: driver.id },
    });
  }

  const vehicles = [
    { driver: '윤서준', note: '출발 대기', plate: '11바 1201', type: '냉장탑차' },
    { driver: '이서연', note: '검수 대기', plate: '12바 2302', type: '윙바디' },
    { driver: '박민재', note: '온도기록계 확인', plate: '13사 3403', type: '냉장탑차' },
    { driver: '정하린', note: '출고 지시 대기', plate: '14자 4504', type: '냉장탑차' },
    { driver: '최유준', note: '3분 뒤 출발', plate: '15바 5605', type: '냉장탑차' },
    { driver: '김도윤', note: '군포복합물류센터', plate: '21사 6101', type: '냉장탑차' },
    { driver: '문채원', note: '1번 배송지 이동', plate: '22자 6202', type: '윙바디' },
    { driver: '서준호', note: '10번 배송지 이동', plate: '23바 6303', type: '냉장탑차' },
    { driver: '오지민', note: '12번 배송지 이동', plate: '24사 6404', type: '냉장탑차' },
    { driver: '한태오', note: '상품 하차 중', plate: '31자 7104', type: '냉장탑차' },
    { driver: '강하윤', note: '교통 지연', plate: '32바 7207', type: '냉장탑차' },
    { driver: '임태준', note: '증빙 확인 필요', plate: '33사 7311', type: '냉장탑차' },
    { driver: '배유나', note: '운행 종료', plate: '34자 7412', type: '냉장탑차' },
  ];
  for (const vehicleInput of vehicles) {
    const vehicle = await prisma.vehicle.upsert({
      create: { label: vehicleInput.type, licensePlate: vehicleInput.plate, shopId: shop.id, status: 'ACTIVE', vehicleType: 'TRUCK' },
      update: { label: vehicleInput.type, status: 'ACTIVE' },
      where: { shopId_licensePlate: { licensePlate: vehicleInput.plate, shopId: shop.id } },
    });
    await prisma.dsvVehicleProfile.upsert({
      create: { note: vehicleInput.note, shopId: shop.id, typeLabel: vehicleInput.type, vehicleId: vehicle.id },
      update: { note: vehicleInput.note, typeLabel: vehicleInput.type },
      where: { vehicleId: vehicle.id },
    });
    const driverId = driverIds.get(vehicleInput.driver);
    if (driverId !== undefined) {
      await prisma.dsvVehicleDriverAssignment.upsert({
        create: { createdBy: 'demo-seed', driverId, shopId: shop.id, vehicleId: vehicle.id },
        update: {},
        where: { shopId_vehicleId_driverId: { driverId, shopId: shop.id, vehicleId: vehicle.id } },
      });
    }
  }

  for (const condition of [
    { code: 'Ambient', description: '상온 조건으로 운송합니다.', name: '상온' },
    { code: 'Cold', description: '냉장 상태를 유지하여 운송합니다.', name: '냉장' },
    { code: 'TS03', description: '계약서에 정의된 TS03 운송 조건을 적용합니다.', name: 'TS03' },
  ]) {
    await prisma.dsvTransportCondition.upsert({
      create: { ...condition, createdBy: 'demo-seed', shopId: shop.id },
      update: { description: condition.description, name: condition.name },
      where: { shopId_code: { code: condition.code, shopId: shop.id } },
    });
  }

  process.stdout.write(`DSV dispatch demo ready: ${shopDomain}\n`);
} finally {
  await prisma.$disconnect();
}
