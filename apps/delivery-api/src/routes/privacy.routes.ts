import type { FastifyInstance } from 'fastify';

const LAST_UPDATED = '2026-05-22';
const PUBLIC_PRIVACY_URL = 'https://clever-route-api.cleversystem.ai/privacy';
const DRIVER_LAST_UPDATED = '2026-09-01';
const DRIVER_PRIVACY_URL = 'https://clever-route-api.cleversystem.ai/driver-app/privacy';
const DRIVER_SUPPORT_URL = 'https://clever-route-api.cleversystem.ai/driver-app/support';
const ROUTES_APP_LAST_UPDATED = '2026-09-01';
const ROUTES_APP_PRIVACY_URL = 'https://clever-route-api.cleversystem.ai/routes-app/privacy';
const ROUTES_APP_SUPPORT_URL = 'https://clever-route-api.cleversystem.ai/routes-app/support';
const ROUTES_APP_ACCOUNT_DELETION_URL = 'https://clever-route-api.cleversystem.ai/routes-app/account-deletion';
const ROUTES_APP_DEFAULT_PRIVACY_CONTACT_EMAIL = 'chase@evnsolution.com';

export function registerPrivacyRoutes(app: FastifyInstance): void {
  app.get('/privacy', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderPrivacyPolicyPage());
  });

  app.get('/privacy-policy', async (_request, reply) => {
    return reply.redirect('/privacy');
  });

  app.get('/driver-app/privacy', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderDriverPrivacyPage());
  });

  app.get('/driver-app/support', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderDriverSupportPage());
  });

  app.get('/routes-app/privacy', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderRoutesAppPrivacyPage());
  });

  app.get('/routes-app/support', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderRoutesAppSupportPage());
  });

  app.get('/routes-app/account-deletion', async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderRoutesAppAccountDeletionPage());
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

function renderDriverPrivacyPage(): string {
  return renderDriverPage({
    description: 'Privacy policy for the CLEVER Driver iOS and Android delivery app.',
    publicUrl: DRIVER_PRIVACY_URL,
    title: 'CLEVER Driver 개인정보 처리방침',
    body: `
    <section>
      <h2>1. 운영자 / Operator</h2>
      <p>CLEVER Driver는 <strong>이브이앤솔루션 주식회사</strong>(EV&amp;Solution Co., Ltd.)가 운영하는 DSV 배송원 전용 앱입니다.</p>
      <p>서울사무소: 서울특별시 동작구 노량진로 10, 서울창업센터 동작</p>
      <p>개인정보 보호책임자: 장원철 이사<br />이메일: <a href="mailto:chase@evnsolution.com">chase@evnsolution.com</a><br />전화: <a href="tel:070-8028-3180">070-8028-3180</a></p>
    </section>

    <section>
      <h2>2. 처리하는 정보 / Information we process</h2>
      <ul>
        <li><strong>계정 정보:</strong> 이름, 휴대전화 번호, 로그인 아이디, 서버 계정 식별자</li>
        <li><strong>배송 업무 정보:</strong> 배정된 경로와 배송지, 주문·물품 표시 정보, 배송 상태, 시작·완료 이벤트와 타임스탬프</li>
        <li><strong>배송 증빙:</strong> 사용자가 카메라로 촬영하거나 사진 앨범에서 선택해 업로드한 사진과 파일 메타데이터</li>
        <li><strong>보안·운영 정보:</strong> 로그인과 세션 기록, 오류·접근 기록, 계정 삭제 요청 기록</li>
      </ul>
    </section>

    <section>
      <h2>3. 이용 목적 / Purposes</h2>
      <ul>
        <li>배송원 계정 생성, 본인 확인, 로그인과 DSV 배송원 정보 연결</li>
        <li>배정된 배송 업무 표시, 경로 안내, 배송 상태와 증빙 처리</li>
        <li>서비스 보안, 오류 대응, 고객 지원과 운영 기록 확인</li>
        <li>계정 및 개인정보 열람·정정·삭제 요청 처리</li>
      </ul>
    </section>

    <section>
      <h2>4. 위치 정보 / Location</h2>
      <p>사용자가 지도 화면을 열고 위치 권한을 허용한 경우 현재 위치는 배송 지도의 기기 화면에만 표시됩니다. 제출된 iOS 버전은 백그라운드 위치를 수집하거나 서버로 전송하지 않습니다.</p>
      <p>When the user opens the map and grants permission, current location is displayed only on the device. The submitted iOS version does not collect background location or upload the device's current location.</p>
    </section>

    <section>
      <h2>5. 처리 위탁 및 외부 서비스 / Service providers</h2>
      <p>서비스 제공을 위해 승인된 서버·데이터베이스·파일 저장소와 지도·경로 안내 서비스가 사용될 수 있습니다. 해당 제공자는 계약된 서비스 제공과 보안 운영에 필요한 범위에서만 정보를 처리합니다.</p>
      <p>개인정보는 법령상 요구, 이용자 보호 또는 서비스 제공을 위해 필요한 경우를 제외하고 판매하거나 광고·추적 목적으로 제공하지 않습니다.</p>
    </section>

    <section>
      <h2>6. 보관 및 삭제 / Retention and deletion</h2>
      <p>계정 정보는 계정 운영과 배송 업무 제공에 필요한 기간 동안 보관합니다. 배송 이벤트와 증빙은 배송 운영 확인, 분쟁 대응, 계약 또는 법령상 의무에 필요한 기간 동안 보관한 뒤 삭제하거나 식별할 수 없도록 처리합니다.</p>
      <p>사용자는 앱의 <strong>환경설정 → 계정 관리 → 계정 삭제 요청</strong>에서 전체 계정 삭제를 시작할 수 있습니다. 진행 중인 배송이 있으면 배송을 완료하거나 반납한 뒤 요청할 수 있습니다. 요청이 접수되면 법령 또는 계약상 보관 의무가 있는 정보를 제외한 계정과 연결 개인정보를 삭제하거나 비식별 처리합니다.</p>
    </section>

    <section>
      <h2>7. 이용자 권리와 문의 / Your choices and contact</h2>
      <p>개인정보 열람, 정정, 처리 정지 또는 삭제 문의는 <a href="mailto:chase@evnsolution.com">chase@evnsolution.com</a> 또는 <a href="tel:070-8028-3180">070-8028-3180</a>으로 접수할 수 있습니다.</p>
      <p>일반 앱 지원은 <a href="${DRIVER_SUPPORT_URL}">${DRIVER_SUPPORT_URL}</a>에서 확인할 수 있습니다.</p>
    </section>`,
  });
}

function renderDriverSupportPage(): string {
  return renderDriverPage({
    description: 'Support and contact information for the CLEVER Driver app.',
    publicUrl: DRIVER_SUPPORT_URL,
    title: 'CLEVER Driver 지원',
    body: `
    <section>
      <h2>앱 지원 / App support</h2>
      <p>CLEVER Driver는 승인된 DSV 배송원이 배정된 배송 업무, 경로, 배송 상태와 증빙을 처리하는 전용 앱입니다.</p>
      <p>로그인, 계정 연결, 배송 배정, 지도, 사진 증빙 또는 계정 삭제 요청에 문제가 있으면 아래 연락처로 문의해 주세요. 문의 시 비밀번호나 전체 인증 토큰을 보내지 마세요.</p>
    </section>

    <section>
      <h2>연락처 / Contact</h2>
      <p><strong>이브이앤솔루션 주식회사</strong><br />EV&amp;Solution Co., Ltd.</p>
      <p>서울사무소: 서울특별시 동작구 노량진로 10, 서울창업센터 동작</p>
      <p>앱·서비스 문의: <a href="mailto:sumz@evnsolution.com">sumz@evnsolution.com</a><br />전화: <a href="tel:070-7954-4180">070-7954-4180</a></p>
      <p>개인정보 문의: 장원철 이사<br />이메일: <a href="mailto:chase@evnsolution.com">chase@evnsolution.com</a><br />전화: <a href="tel:070-8028-3180">070-8028-3180</a><br />팩스: 0504-011-2955</p>
    </section>

    <section>
      <h2>계정 삭제 요청 / Account deletion</h2>
      <p>로그인 후 <strong>환경설정 → 계정 관리 → 계정 삭제 요청</strong>에서 삭제를 시작할 수 있습니다. 진행 중인 배송이 있으면 배송을 완료하거나 반납한 뒤 다시 요청해 주세요.</p>
      <p>로그인할 수 없는 경우 위 이메일 또는 전화로 계정 확인과 삭제 절차를 문의할 수 있습니다. 개인정보 처리 방식은 <a href="${DRIVER_PRIVACY_URL}">CLEVER Driver 개인정보 처리방침</a>에서 확인할 수 있습니다.</p>
    </section>`,
  });
}

function renderDriverPage(input: {
  body: string;
  description: string;
  publicUrl: string;
  title: string;
}): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${input.title}</title>
  <meta name="description" content="${input.description}" />
  <style>
    :root { color-scheme: light; --ink: #172033; --muted: #5b6475; --line: #dbe3ef; --card: #ffffff; --bg: #f6f8fb; --accent: #0b57d0; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
    main { width: min(100% - 32px, 880px); margin: 0 auto; padding: 40px 0; }
    header, section { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 26px; margin-bottom: 16px; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 5vw, 42px); line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 21px; }
    p { margin: 0 0 12px; }
    p:last-child { margin-bottom: 0; }
    ul { margin: 0; padding-left: 22px; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .eyebrow { color: var(--accent); font-size: 14px; font-weight: 700; }
    .muted { color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">최종 업데이트 / Last updated: ${DRIVER_LAST_UPDATED}</p>
      <h1>${input.title}</h1>
      <p class="muted">공개 URL / Public URL: <a href="${input.publicUrl}">${input.publicUrl}</a></p>
    </header>
    ${input.body}
  </main>
</body>
</html>`;
}

function renderRoutesAppPrivacyPage(): string {
  return renderRoutesAppPage({
    description: 'Privacy policy for the CLEVER Routes delivery application.',
    publicUrl: ROUTES_APP_PRIVACY_URL,
    title: 'CLEVER Routes 개인정보 처리방침',
    body: `
    <section>
      <h2>1. 운영자 / Operator</h2>
      <p><strong>이브이앤솔루션 주식회사</strong> (EV&amp;Solution Co., Ltd.)는 배송 경로와 정차 업무를 수행하는 CLEVER Routes 앱 및 연결 서버를 운영합니다.</p>
      <p>이 방침은 CLEVER Routes 전용이며 CLEVER Driver 또는 DSV 서비스의 별도 방침을 대신하지 않습니다.</p>
    </section>

    <section>
      <h2>2. 처리하는 정보와 목적 / Information and purposes</h2>
      <ul>
        <li><strong>계정 및 인증:</strong> 배송원 이름, 등록 전화번호, 계정 식별자, 로그인·세션 기록. 계정 확인, 접근 통제와 지원에 사용합니다.</li>
        <li><strong>위치:</strong> 활성 배송 경로에서 앱이 전경 및 백그라운드 상태일 때 기기의 정밀 위치, 위치 시각과 정확도 정보를 처리합니다. 현재 위치 표시, 경로 진행, 도착 확인, 운영 안전과 분쟁 대응에 사용합니다.</li>
        <li><strong>배송 증빙:</strong> 증빙 사진, 서명, 수령인 이름, 배송 메모와 제출 시각을 배송 완료 또는 실패 확인에 사용합니다.</li>
        <li><strong>경로 및 정차 활동:</strong> 배정 경로, 정차 순서, 배송 상태, 시작·일시정지·도착·완료 이벤트와 재시도 기록을 업무 진행, 동기화와 운영 감사에 사용합니다.</li>
        <li><strong>알림과 기기:</strong> 푸시 토큰, 제한된 기기 식별자 또는 그 해시, 앱 버전과 플랫폼 정보를 배송 알림, 세션 보호, 중복 기기 감지와 장애 대응에 사용합니다.</li>
      </ul>
      <p>위치 처리는 배송원이 명시적으로 시작한 활성 배송 경로의 수행에 필요한 범위로 제한합니다. 위치 권한은 기기 설정에서 변경할 수 있지만, 권한을 끄면 실시간 경로 기능이 제한될 수 있습니다.</p>
    </section>

    <section>
      <h2>3. 증빙 사진 보호 / Proof-photo safeguards</h2>
      <p>JPEG 증빙 사진은 저장 전에 EXIF APP1 메타데이터를 제거해 사진에 포함될 수 있는 위치·기기 정보를 줄입니다. 파일은 공개 웹 경로가 아닌 접근 통제된 비공개 저장소에 보관하며, 읽기 접근은 짧은 수명의 승인된 경로로 제한합니다.</p>
      <p>증빙 사진과 관련 메타데이터의 기본 보관 기간은 업로드 후 <strong>기본 180일</strong>입니다. 배송 분쟁, 보안 사고, 계약 또는 법적 의무에 따른 보존 조치가 있으면 필요한 범위에서 더 오래 보관할 수 있습니다.</p>
    </section>

    <section>
      <h2>4. 처리 위탁과 외부 전달 / Processors and handoff</h2>
      <ul>
        <li>승인된 서버, 데이터베이스와 비공개 파일 저장 인프라가 계정, 경로, 이벤트와 증빙을 처리합니다.</li>
        <li>Firebase Cloud Messaging(FCM)은 기기에 배송 관련 푸시 알림을 전달하며, 이 과정에서 푸시 토큰과 기기·앱 정보가 처리될 수 있습니다.</li>
        <li>설정된 지도, 지오코딩과 경로 계산 제공자는 주소 또는 좌표를 지도 표시와 경로 계산에 사용할 수 있습니다.</li>
        <li>배송원이 외부 길찾기를 선택하면 Google Maps 또는 Waze 같은 선택된 지도 앱으로 배송지 주소 또는 좌표를 전달합니다.</li>
      </ul>
      <p>개인정보를 광고 목적으로 판매하지 않습니다. 법령, 이용자 보호 또는 서비스 제공에 필요한 경우를 제외하고 제3자에게 제공하지 않습니다.</p>
    </section>

    <section>
      <h2>5. 보관, 삭제와 예외 / Retention and deletion</h2>
      <p>실시간 위치 이벤트의 좌표는 운영 목적이 끝난 뒤 최소화하며, 증빙 사진은 기본 180일 보관 정책에 따라 정리합니다. 경로·정차 상태, 처리 시각과 비식별 운영 기록은 배송 이력, 분쟁, 보안, 계약 또는 법적 의무에 필요한 기간 동안 분리 보관할 수 있습니다.</p>
      <p>해결된 순서 이벤트 재시도 증거는 기본 90일 보관 후 정리합니다. 미해결 또는 조정이 필요한 기록은 해결될 때까지 제한적으로 보관할 수 있습니다.</p>
      <p>계정 및 개인정보 삭제 요청 절차, 처리 범위와 예외는 <a href="${ROUTES_APP_ACCOUNT_DELETION_URL}">${ROUTES_APP_ACCOUNT_DELETION_URL}</a>에서 확인할 수 있습니다.</p>
    </section>

    <section>
      <h2>6. 권리와 문의 / Rights and contact</h2>
      <p>개인정보 열람, 정정, 처리 정지 또는 삭제 문의는 ${renderRoutesAppContactLink('개인정보 문의 이메일')}로 접수할 수 있습니다. 일반 지원은 <a href="${ROUTES_APP_SUPPORT_URL}">${ROUTES_APP_SUPPORT_URL}</a>에서 확인하세요.</p>
    </section>`,
  });
}

function renderRoutesAppSupportPage(): string {
  return renderRoutesAppPage({
    description: 'Support and privacy contact information for CLEVER Routes.',
    publicUrl: ROUTES_APP_SUPPORT_URL,
    title: 'CLEVER Routes 지원',
    body: `
    <section>
      <h2>운영자 / Operator</h2>
      <p><strong>이브이앤솔루션 주식회사</strong><br />EV&amp;Solution Co., Ltd.</p>
      <p>CLEVER Routes는 배정된 배송 경로, 정차, 실시간 진행, 알림과 배송 증빙을 처리하는 배송원용 앱입니다.</p>
    </section>

    <section>
      <h2>지원 요청 / Support request</h2>
      <p>로그인, 계정 확인, 배정 경로, 위치 권한, 알림, 지도 인계 또는 증빙 제출에 문제가 있으면 ${renderRoutesAppContactLink('지원 이메일')}로 문의해 주세요.</p>
      <p>문의에는 문제 발생 시각, 앱 버전과 오류 화면처럼 필요한 최소 정보만 포함하고, <strong>비밀번호, PIN, 인증 토큰 또는 증빙 사진을 보내지 마세요.</strong></p>
    </section>

    <section>
      <h2>개인정보와 계정 삭제 / Privacy and deletion</h2>
      <p>개인정보 처리 내용은 <a href="${ROUTES_APP_PRIVACY_URL}">${ROUTES_APP_PRIVACY_URL}</a>에서 확인할 수 있습니다.</p>
      <p>앱에 로그인할 수 없는 경우를 포함한 계정 및 데이터 삭제 요청은 <a href="${ROUTES_APP_ACCOUNT_DELETION_URL}">${ROUTES_APP_ACCOUNT_DELETION_URL}</a>의 안전한 외부 접수 절차를 이용하세요.</p>
    </section>`,
  });
}

function renderRoutesAppAccountDeletionPage(): string {
  return renderRoutesAppPage({
    description: 'External account and data deletion request instructions for CLEVER Routes.',
    publicUrl: ROUTES_APP_ACCOUNT_DELETION_URL,
    title: 'CLEVER Routes 계정 및 데이터 삭제 요청',
    body: `
    <section>
      <h2>요청 방법 / How to request deletion</h2>
      <ol>
        <li>${renderRoutesAppContactLink('개인정보 문의 이메일')}로 CLEVER Routes 계정 삭제 요청임을 알려 주세요.</li>
        <li>운영자는 저장된 계정 정보를 이메일로 회신하지 않고, 등록된 연락처를 이용한 별도의 일회성 본인 확인 절차를 안내합니다.</li>
        <li>확인이 완료되면 같은 계정에 중복 삭제 작업이 생기지 않도록 하나의 계정 수준 요청으로 접수합니다.</li>
      </ol>
      <p><strong>비밀번호, PIN, 인증 토큰 또는 증빙 사진을 이메일로 보내지 마세요.</strong> 이 공개 페이지는 전화번호만으로 계정을 파괴적으로 삭제하는 기능이나 PIN 입력 양식을 제공하지 않습니다.</p>
    </section>

    <section>
      <h2>처리 시점 / Timing</h2>
      <p>활성 배송 경로가 있으면 배송을 완료하거나 안전하게 반납할 때까지 요청 처리가 보류될 수 있습니다. 본인 확인과 활성 업무 확인이 끝난 유효한 요청은 원칙적으로 <strong>30일 이내</strong> 처리하며, 법적·계약상 확인이 더 필요한 경우 사유와 예상 일정을 안내합니다.</p>
    </section>

    <section>
      <h2>삭제 또는 익명화되는 정보 / Deleted or de-identified data</h2>
      <ul>
        <li>계정의 이름, 전화번호, 로그인 식별자와 인증 자격정보를 삭제하거나 익명화합니다.</li>
        <li>로그인 세션과 푸시 토큰을 무효화 또는 제거해 재로그인을 차단합니다.</li>
        <li>동의 기록의 불필요한 기기 문맥과 삭제 요청에 포함된 자유 입력 개인정보를 최소화합니다.</li>
      </ul>
    </section>

    <section>
      <h2>제한적으로 보관되는 정보 / Limited retention</h2>
      <p>배송, 분쟁, 보안, 계약 또는 법적 의무를 위해 필요한 경로·정차·배송 이벤트, 증빙 및 처리 감사 기록은 계정의 직접 식별정보와 분리해 정책 기간 동안 보관할 수 있습니다. 보존 의무가 끝나면 삭제하거나 추가로 익명화합니다.</p>
      <p>완료된 요청에는 처리 상태와 시각 같은 비식별 감사 정보만 남길 수 있습니다.</p>
    </section>`,
  });
}

function renderRoutesAppContactLink(label: string): string {
  const email = readPrivacyContactEmail() ?? ROUTES_APP_DEFAULT_PRIVACY_CONTACT_EMAIL;
  const escapedEmail = escapeHtml(email);
  return `<a href="mailto:${escapedEmail}">${escapeHtml(label)} (${escapedEmail})</a>`;
}

function renderRoutesAppPage(input: {
  body: string;
  description: string;
  publicUrl: string;
  title: string;
}): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${input.title}</title>
  <meta name="description" content="${input.description}" />
  <style>
    :root { color-scheme: light; --ink: #142033; --muted: #5b6475; --line: #d6e2ea; --card: #ffffff; --bg: #f4f8fa; --accent: #08756c; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
    main { width: min(100% - 32px, 900px); margin: 0 auto; padding: 40px 0; }
    header, section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 26px; margin-bottom: 16px; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 5vw, 42px); line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 21px; }
    p { margin: 0 0 12px; }
    p:last-child { margin-bottom: 0; }
    ul, ol { margin: 0 0 12px; padding-left: 22px; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .eyebrow { color: var(--accent); font-size: 14px; font-weight: 700; }
    .muted { color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">최종 업데이트 / Last updated: ${ROUTES_APP_LAST_UPDATED}</p>
      <h1>${input.title}</h1>
      <p class="muted">공개 URL / Public URL: <a href="${input.publicUrl}">${input.publicUrl}</a></p>
    </header>
    ${input.body}
  </main>
</body>
</html>`;
}
