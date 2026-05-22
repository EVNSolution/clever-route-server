import type { FastifyInstance } from 'fastify';

const LAST_UPDATED = '2026-05-22';
const PUBLIC_PRIVACY_URL = 'https://clever-route.cleversystem.ai/privacy';

export function registerPrivacyRoutes(app: FastifyInstance): void {
  app.get('/privacy', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderPrivacyPolicyPage());
  });

  app.get('/privacy-policy', async (_request, reply) => {
    return reply.redirect('/privacy');
  });
}

function renderPrivacyPolicyPage(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clever Route Privacy Policy</title>
  <meta name="description" content="Privacy policy for Clever Route, the delivery route planning and WooCommerce integration service." />
  <style>
    :root { color-scheme: light; --ink: #172033; --muted: #5b6475; --line: #dbe3ef; --card: #ffffff; --bg: #f6f8fb; --accent: #3157d5; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
    main { width: min(100% - 32px, 1040px); margin: 0 auto; padding: 48px 0; }
    header, section { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 28px; margin-bottom: 18px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.05); }
    .eyebrow { color: var(--accent); font-size: 14px; font-weight: 700; margin: 0 0 8px; }
    h1 { font-size: clamp(30px, 4vw, 44px); line-height: 1.14; margin: 0 0 14px; letter-spacing: -0.03em; }
    h2 { margin: 0 0 12px; font-size: 22px; }
    h3 { margin: 14px 0 8px; font-size: 16px; }
    p { margin: 0 0 12px; }
    ul { margin: 0; padding-left: 20px; }
    a { color: var(--accent); }
    .lead { color: var(--muted); font-size: 18px; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .muted { color: var(--muted); font-size: 14px; }
    .notice { border-left: 4px solid var(--accent); padding-left: 14px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">최종 업데이트 / Last updated: ${LAST_UPDATED}</p>
      <h1>Clever Route 개인정보 처리방침</h1>
      <p class="lead">Clever Route는 WordPress/WooCommerce 주문을 배송 경로 계획, 배송원 배정, 배송 이벤트, 증빙 자료 처리로 연결하는 서비스입니다.</p>
      <p class="lead">Clever Route helps merchants connect WordPress/WooCommerce orders to delivery route planning, driver assignment, delivery events, and proof-of-delivery workflows.</p>
      <p class="muted notice">공개 URL / Public URL: <a href="${PUBLIC_PRIVACY_URL}">${PUBLIC_PRIVACY_URL}</a>. This notice is served from the route server domain; there is no separate admin web privacy host in the current plan.</p>
    </header>

    <section>
      <h2>1. 처리하는 정보 / Information we process</h2>
      <div class="grid">
        <div>
          <h3>한국어</h3>
          <ul>
            <li>WordPress/WooCommerce 사이트 URL, 스토어/회사 식별자, 연결 상태, webhook 메타데이터</li>
            <li>WooCommerce REST API Consumer Key, Consumer Secret, webhook secret은 서버에서 암호화 저장되며 원문은 저장 후 다시 표시하지 않습니다.</li>
            <li>배송 경로 계획에 필요한 주문 번호, 주문 식별자, 상품명과 수량, 주문 상태, 배송일, 배송 지역</li>
            <li>수령자 이름, 배송 주소, 배송 전화번호, 가능한 경우 배송 좌표</li>
            <li>출발지 주소와 좌표, 경로 계획, 정차 순서, 배송원 이름/전화번호, 배정 상태, 배송 이벤트, proof media 메타데이터</li>
            <li>서비스 보안과 운영에 필요한 로그, 타임스탬프, 인증 기록, 동의 기록</li>
          </ul>
        </div>
        <div>
          <h3>English</h3>
          <ul>
            <li>WordPress/WooCommerce site URLs, store/company identifiers, connection status, and webhook metadata</li>
            <li>WooCommerce REST API Consumer Key, Consumer Secret, and webhook secret are encrypted on the server and are not displayed again after storage.</li>
            <li>Order numbers, order identifiers, line item names and quantities, order status, delivery dates, and delivery areas needed for route planning</li>
            <li>Recipient name, shipping address, shipping phone number, and shipping coordinates when available</li>
            <li>Departure addresses and coordinates, route plans, stop sequences, driver names/phone numbers, assignment status, delivery events, and proof-media metadata</li>
            <li>Logs, timestamps, authentication records, and consent records needed to operate and secure the service</li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>2. 이용 목적 / How we use information</h2>
      <div class="grid">
        <div>
          <h3>한국어</h3>
          <ul>
            <li>WooCommerce 주문을 배송 경로 계획 및 운영 화면에 표시합니다.</li>
            <li>주문을 배송일/지역별 경로 초안으로 만들고 정차 순서를 관리합니다.</li>
            <li>배송원을 경로에 배정하고 배송 이벤트와 proof-of-delivery를 기록합니다.</li>
            <li>WooCommerce webhook을 검증하고 REST API로 누락 주문 또는 상세 정보를 보정합니다.</li>
            <li>보안 유지, 장애 대응, 접근 통제, 법령 및 계약상 요구사항 준수를 위해 사용합니다.</li>
          </ul>
        </div>
        <div>
          <h3>English</h3>
          <ul>
            <li>To display WooCommerce orders for delivery route planning and operations</li>
            <li>To create route drafts by delivery date/area and manage stop sequences</li>
            <li>To assign drivers and record delivery events and proof-of-delivery evidence</li>
            <li>To verify WooCommerce webhooks and use the REST API to reconcile missed or detailed order data</li>
            <li>To maintain security, troubleshoot issues, enforce access controls, and meet legal or contractual obligations</li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>3. 처리 위탁 및 외부 서비스 / Processors and external services</h2>
      <div class="grid">
        <div>
          <h3>한국어</h3>
          <ul>
            <li>WordPress/WooCommerce REST API와 webhook은 주문 동기화와 검증에 사용됩니다.</li>
            <li>서비스와 데이터베이스는 승인된 서버/클라우드 인프라에서 운영됩니다.</li>
            <li>지도, geocoding, routing, proof-media scan/storage 제공자가 설정된 경우 배송 운영을 위해 사용될 수 있습니다.</li>
          </ul>
        </div>
        <div>
          <h3>English</h3>
          <ul>
            <li>WordPress/WooCommerce REST APIs and webhooks are used for order synchronization and verification.</li>
            <li>The service and database run on approved server/cloud infrastructure.</li>
            <li>Configured map, geocoding, routing, and proof-media scan/storage providers may be used for delivery operations.</li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>4. 보관 기간 / Retention</h2>
      <p>운영자는 서비스 제공, 배송 운영, 보안, 장애 대응, 운영 검증, 법령상 보관 의무에 필요한 기간 동안 정보를 보관합니다. 목적이 종료되거나 삭제 요청을 처리할 수 있는 경우에는 관련 데이터를 삭제하거나 식별할 수 없도록 처리합니다.</p>
      <p>The operator retains order, route, driver, proof, and operational records only for as long as needed to provide the service, support delivery operations, maintain security, troubleshoot issues, verify operations, or meet legal obligations. When the purpose ends or a deletion request can be fulfilled, related data is deleted or de-identified.</p>
    </section>

    <section>
      <h2>5. 데이터 권리 및 삭제 요청 / Data rights and deletion</h2>
      <p>고객사, 판매자, 배송원 또는 관련 당사자는 운영자에게 개인정보 열람, 정정, 삭제, 처리 정지를 요청할 수 있습니다. 요청 시 확인 가능한 회사/스토어/배송원 식별 정보와 요청 내용을 함께 제공하면 처리에 도움이 됩니다.</p>
      <p>Customers, merchants, drivers, and related parties may request access, correction, deletion, or restriction of personal data by contacting the operator. Include verifiable company/store/driver identifiers and a description of the request so the operator can process it.</p>
    </section>

    <section>
      <h2>6. 위치 및 배송 증빙 / Location and proof of delivery</h2>
      <p>Clever Route는 배송 경로 계획과 배송 완료 증빙을 위해 출발지, 배송지, 배송원 이벤트 위치, 사진/서명/바코드 같은 proof-of-delivery 자료를 처리할 수 있습니다. 모바일 앱과 서버의 실제 배포 범위에 따라 별도 동의와 store/privacy disclosure가 필요할 수 있습니다.</p>
      <p>Clever Route may process departure locations, delivery destinations, driver event locations, and proof-of-delivery materials such as photos, signatures, or barcodes. Depending on the deployed mobile app and server scope, separate consent and store/privacy disclosures may be required.</p>
    </section>

    <section>
      <h2>7. 보안 / Security</h2>
      <p>운영자는 HTTPS, 서버 측 접근 통제, WooCommerce webhook HMAC 검증, 민감 credential 암호화 저장, 로그/응답 secret 비노출 원칙, 최소 권한 운영 절차를 사용해 서비스를 보호합니다.</p>
      <p>The operator protects the service using HTTPS, server-side access controls, WooCommerce webhook HMAC verification, encrypted storage for sensitive credentials, no-secret logging/response rules, and least-privilege operating procedures.</p>
    </section>

    <section>
      <h2>8. 문의 / Contact</h2>
      <p>개인정보 문의, 지원 요청, 계정 또는 데이터 삭제 요청은 운영자가 확정한 개인정보 문의 채널로 접수합니다. 운영/법무 확인 전까지 이 공개 초안은 연락처를 확정 값으로 표시하지 않습니다.</p>
      <p>Privacy, support, account, or data deletion requests will be handled through the operator-confirmed privacy contact channel. Until operator/legal confirmation is complete, this public draft does not display a finalized contact value.</p>
      ${renderContactBlock()}
    </section>
  </main>
</body>
</html>`;
}


function renderContactBlock(): string {
  const contactEmail = readPrivacyContactEmail();
  if (contactEmail === undefined) {
    return '<p class="muted notice">Contact: pending operator/legal confirmation before production publication.</p>';
  }

  const escapedEmail = escapeHtml(contactEmail);
  return `<p>Email: <a href="mailto:${escapedEmail}">${escapedEmail}</a></p>`;
}

function readPrivacyContactEmail(): string | undefined {
  const email = process.env.PRIVACY_CONTACT_EMAIL?.trim();
  if (email === undefined || email === '') return undefined;
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu.test(email)) return undefined;
  return email;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
