import { PrismaClient } from '@prisma/client';
import { PrismaDsvAdminAccountRepository } from '../modules/dsv/dsv-admin-account.repository.js';

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

  for (const condition of [
    { code: 'AMBIENT', description: '상온 조건으로 운송합니다.', name: '상온 운송' },
    { code: 'COLD', description: '냉장 상태를 유지하여 운송합니다.', name: '냉장 운송' },
    { code: 'TS03', description: '계약서에 정의된 TS03 운송 조건을 적용합니다.', name: '특수 운송 03' },
  ]) {
    const comparisonKey = condition.code.trim().toUpperCase();
    const current = await prisma.dsvTransportCondition.findFirst({
      where: { code: { equals: condition.code, mode: 'insensitive' }, shopId: shop.id },
    });
    if (current === null) {
      await prisma.dsvTransportCondition.create({
        data: {
          ...condition,
          activatedAt: new Date(),
          comparisonKey,
          createdBy: 'demo-seed',
          rawValue: condition.code,
          shopId: shop.id,
          status: 'ACTIVE',
        },
      });
    } else {
      await prisma.dsvTransportCondition.update({
        data: {
          code: condition.code,
          activatedAt: new Date(),
          comparisonKey,
          deactivatedAt: null,
          description: condition.description,
          name: condition.name,
          rawValue: condition.code,
          status: 'ACTIVE',
        },
        where: { id: current.id },
      });
    }
  }

  const bootstrapLoginId = process.env.CLEVER_DSV_BOOTSTRAP_ADMIN_ID?.trim();
  const bootstrapPassword = process.env.CLEVER_DSV_BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (bootstrapLoginId !== undefined && bootstrapLoginId !== '' && bootstrapPassword !== undefined && bootstrapPassword !== '') {
    await new PrismaDsvAdminAccountRepository(prisma).bootstrap({
      displayName: process.env.CLEVER_DSV_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || '운영 관리자',
      loginId: bootstrapLoginId,
      password: bootstrapPassword,
    });
  }

  process.stdout.write(`DSV reference conditions ready: ${shopDomain}\n`);
} finally {
  await prisma.$disconnect();
}
