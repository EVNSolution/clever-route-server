const fs = require('fs');
const path = require('path');
const {
  AlignmentType,
  BorderStyle,
  CharacterSet,
  Document,
  Footer,
  Header,
  HeadingLevel,
  HeightRule,
  ImageRun,
  NumberFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} = require('docx');
const { imageSize } = require('image-size');

const ROOT = __dirname;
const CAPTURE = path.join(ROOT, 'captures');
const LEGACY = path.join(CAPTURE, 'legacy');
const OUTPUT = path.join(ROOT, 'CLEVER_DSV_관제_운영자_사용자_가이드_Rev1.2.docx');
const LOGO = path.join(ROOT, 'evs-logo.png');

const PRODUCT_NAME = 'CLEVER DSV';
const DOC_TYPE = '사용자 가이드 / User Guide';
const DOC_NO = 'EVN-UG-2026-1.0-0001';
const REVISION = '1.2';
const WRITTEN_DATE = '2026. 09. 03.';

const BLACK = '000000';
const RED = 'C62828';
const LIGHT_GRAY = 'F3F4F6';
const MID_GRAY = 'D1D1D1';
const BORDER = 'B8B8B8';
const FONT_NAME = 'Pretendard';
const FONT_SPEC = { ascii: FONT_NAME, hAnsi: FONT_NAME, eastAsia: FONT_NAME, cs: FONT_NAME, hint: 'eastAsia' };
const LANGUAGE = { value: 'ko-KR', eastAsia: 'ko-KR' };
const FONT_DATA = fs.readFileSync(process.env.PRETENDARD_FONT_PATH || '/Users/jiin/Library/Fonts/Pretendard-Regular.ttf');

// EVS 기본 A4 규격을 유지하되, 16:10 운영 화면의 가독성을 위해 문서 전체를 가로 방향으로 사용한다.
const PAGE = {
  // docx swaps width/height when landscape is selected, so provide portrait A4 dimensions here.
  size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
  margin: { top: 720, right: 720, bottom: 720, left: 720, header: 500, footer: 500, gutter: 0 },
};
const CONTENT_WIDTH = 15398;
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const NONE_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const THIN = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
const TABLE_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN, insideHorizontal: THIN, insideVertical: THIN };

function run(text, options = {}) {
  return new TextRun({
    text,
    font: FONT_SPEC,
    language: LANGUAGE,
    size: options.size ?? 22,
    bold: options.bold ?? false,
    color: options.color ?? BLACK,
    break: options.break,
  });
}

function bodyParagraph(text, options = {}) {
  return new Paragraph({
    alignment: options.alignment ?? AlignmentType.LEFT,
    spacing: { before: options.before ?? 0, after: options.after ?? 100, line: options.line ?? 276 },
    keepNext: options.keepNext ?? false,
    children: [run(text, { size: options.size ?? 22, bold: options.bold, color: options.color })],
  });
}

function cell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: options.borders ?? TABLE_BORDERS,
    shading: options.shading ? { fill: options.shading, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment: options.alignment ?? AlignmentType.LEFT,
        spacing: { before: 0, after: 0 },
        children: [run(text, { size: 20, bold: options.bold, color: options.color })],
      }),
    ],
  });
}

function coverRow(height, children) {
  return new TableRow({
    height: { value: height, rule: HeightRule.EXACT },
    children: [new TableCell({
      borders: NONE_BORDERS,
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      children,
    })],
  });
}

const logoData = fs.readFileSync(LOGO);

const coverInfo = new Table({
  width: { size: 6000, type: WidthType.DXA },
  columnWidths: [2200, 3800],
  alignment: AlignmentType.CENTER,
  borders: TABLE_BORDERS,
  rows: [
    new TableRow({ children: [cell('문서 번호', 2200, { bold: true, shading: MID_GRAY }), cell(DOC_NO, 3800)] }),
    new TableRow({ children: [cell('개정 번호', 2200, { bold: true, shading: MID_GRAY }), cell(`Rev. ${REVISION}`, 3800)] }),
    new TableRow({ children: [cell('작성일', 2200, { bold: true, shading: MID_GRAY }), cell(WRITTEN_DATE, 3800)] }),
  ],
});

const coverTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [CONTENT_WIDTH],
  borders: NONE_BORDERS,
  rows: [
    coverRow(1000, [new Paragraph({ children: [] })]),
    coverRow(2300, [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [run(PRODUCT_NAME, { size: 64, bold: true })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [run(`[${DOC_TYPE}]`, { size: 44, bold: true })] }),
    ]),
    coverRow(900, [new Paragraph({ children: [] })]),
    coverRow(1800, [coverInfo]),
    coverRow(700, [new Paragraph({ children: [] })]),
    coverRow(900, [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({
      data: logoData,
      transformation: { width: 161, height: 60 },
      type: 'png',
      altText: { name: 'EV&Solution 로고', title: 'EV&Solution 로고', description: '이브이앤솔루션 회사 로고' },
    })] })]),
    coverRow(1200, [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [run('이브이앤솔루션 주식회사', { size: 28 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [run('EV&Solution Co., Ltd.', { size: 24 })] }),
    ]),
  ],
});

function title(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(text, { size: 32, bold: true })] });
}

function subtitle(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(text, { size: 26, bold: true })] });
}

const releaseTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [1600, 1800, 2200, 9798],
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell('개정', 1600, { bold: true, shading: MID_GRAY, alignment: AlignmentType.CENTER }),
      cell('작성일', 1800, { bold: true, shading: MID_GRAY, alignment: AlignmentType.CENTER }),
      cell('작성자', 2200, { bold: true, shading: MID_GRAY, alignment: AlignmentType.CENTER }),
      cell('변경 내용', 9798, { bold: true, shading: MID_GRAY }),
    ] }),
    new TableRow({ children: [cell('1.0', 1600, { alignment: AlignmentType.CENTER }), cell('2026. 08. 11.', 1800, { alignment: AlignmentType.CENTER }), cell('EV&Solution', 2200, { alignment: AlignmentType.CENTER }), cell('CLEVER DSV 관제 운영자 사용자 가이드 최초 발행', 9798)] }),
    new TableRow({ children: [cell('1.1', 1600, { alignment: AlignmentType.CENTER }), cell(WRITTEN_DATE, 1800, { alignment: AlignmentType.CENTER }), cell('EV&Solution', 2200, { alignment: AlignmentType.CENTER }), cell('배송원 앱 설치를 공개 설치 페이지와 직접 회원가입 절차로 갱신', 9798)] }),
    new TableRow({ children: [cell('1.2', 1600, { alignment: AlignmentType.CENTER }), cell(WRITTEN_DATE, 1800, { alignment: AlignmentType.CENTER }), cell('EV&Solution', 2200, { alignment: AlignmentType.CENTER }), cell('단일 온도, 차량 자취, 배차 삭제와 현재 설정 화면을 반영', 9798)] }),
    ...Array.from({ length: 2 }, () => new TableRow({ children: [cell('', 1600), cell('', 1800), cell('', 2200), cell('', 9798)] })),
  ],
});

const copyrightNotice = [
  title('저작권 고지 / Copyright Notice'),
  bodyParagraph('본 문서의 저작권 및 모든 권리는 이브이앤솔루션 주식회사에 있으며, 사전 동의 없이 문서의 내용 전체 또는 일부를 수정, 복제, 배포, 또는 기타 목적으로 사용하는 것을 금지합니다. 본 문서는 협력사 내부 용도로만 사용 가능하며, 기타 용도로의 사용은 별도의 서면 동의가 필요합니다.', { size: 24, after: 260, line: 320 }),
  bodyParagraph('Copyright and all rights to this document are owned by EV&Solution Co., Ltd. No part of this document may be modified, reproduced, distributed, or used for any other purpose without prior written consent. This document is intended solely for internal use by authorized partners.', { size: 22, line: 300 }),
];

const chapters = [
  ['1', '계정 시작', '계정 초대, 계정 활성화, 관리자 로그인', '1-3'],
  ['2', '관제', '기준일, 차량, 자취, 배송지, 온도, 상태 알림', '4-11'],
  ['3', '배차', '조회, 선택, 배정, 삭제, 검색, 파일 업로드, 0박스 주의', '12-23'],
  ['4', '이력', '배송 이력, 날짜, 상세, 이벤트', '24-27'],
  ['5', '운송자원', '배송원, 앱 설치, 회원가입, 차량', '28-33'],
  ['6', '고객사', '고객사, 배송지, 고객 계정, 초대 이메일', '34-39'],
  ['7', '운송조건', '운송조건 조회와 편집', '40-41'],
  ['8', '설정', '출발 위치, 운영 기준, 이메일, 계정', '42-47'],
  ['9', '고객 배송조회', '위치, 검색, 상세, 로그인, 초대 오류', '48-52'],
];

const chapterTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [900, 2500, 9998, 2000],
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell('번호', 900, { bold: true, shading: MID_GRAY, alignment: AlignmentType.CENTER }),
      cell('구분', 2500, { bold: true, shading: MID_GRAY }),
      cell('주요 기능', 9998, { bold: true, shading: MID_GRAY }),
      cell('본문', 2000, { bold: true, shading: MID_GRAY, alignment: AlignmentType.CENTER }),
    ] }),
    ...chapters.map(([no, name, features, pages]) => new TableRow({ children: [
      cell(no, 900, { alignment: AlignmentType.CENTER }), cell(name, 2500, { bold: true }), cell(features, 9998), cell(pages, 2000, { alignment: AlignmentType.CENTER }),
    ] })),
  ],
});

const tocTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [13000, 2398],
  borders: NONE_BORDERS,
  rows: chapters.map(([no, name, , bodyPages]) => new TableRow({ children: [
    cell(`${no}. ${name}`, 13000, { bold: true, borders: NONE_BORDERS }),
    cell(bodyPages, 2398, { alignment: AlignmentType.RIGHT, borders: NONE_BORDERS }),
  ] })),
});

const pages = [
  { chapter: 1, section: '계정 시작', title: '계정 초대 확인', image: 'legacy/legacy-03.png', steps: ['메일 제목과 발신 도메인이 CLEVER DSV 공식 안내와 일치하는지 확인합니다.', '수신자 본인이 요청한 초대인지 확인합니다.', '48시간 이내에 일회용 링크를 엽니다.', '링크는 한 번만 사용할 수 있으므로 설정을 완료할 준비가 된 상태에서 접속합니다.'], warning: '의심스러운 발신자, 예상하지 못한 첨부파일 또는 다른 도메인의 링크는 열지 않습니다.' },
  { chapter: 1, section: '계정 시작', title: '계정 활성화', image: 'legacy/legacy-04.png', steps: ['표시된 계정 범위가 DSV 관제 운영 계정인지 확인합니다.', '본인이 사용할 로그인 ID를 입력합니다.', '영문 대문자, 소문자, 숫자, 특수문자를 포함한 새 비밀번호를 입력합니다.', '비밀번호 확인 후 계정 설정을 완료합니다.'], warning: '초대 링크가 만료되었거나 이미 사용되었다면 개발 관리자에게 재발급을 요청합니다.' },
  { chapter: 1, section: '계정 시작', title: '관제 운영 계정 로그인', image: 'legacy/legacy-05.png', steps: ['브라우저에서 dsv.cleversystem.ai/login에 접속합니다.', '설정한 로그인 ID와 비밀번호를 입력합니다.', '로그인 버튼을 눌러 관제 화면으로 이동합니다.', '공용 PC에서는 브라우저의 비밀번호 저장 기능을 사용하지 않습니다.'], warning: '아이디와 비밀번호를 공유하지 말고, 최초 로그인 후 본인만 아는 값으로 관리합니다.' },

  { chapter: 2, section: '관제', title: '관제 화면', image: '02-control-actual-assigned-overview.png', steps: ['관제 기준일과 전체 주문 수를 확인합니다.', '차량 리스트에서 배정 주문 수와 차량 상태를 확인합니다.', '지도에서 차량 위치와 이동 경로를 확인합니다.', '고객사별 주문 영역에서 고객사 조회 화면으로 이동할 수 있습니다.'] },
  { chapter: 2, section: '관제', title: '관제 조회 기준일', image: '02-control-date-picker.png', steps: ['관제 기준일 영역을 눌러 달력을 엽니다.', '확인할 날짜를 선택합니다.', '선택한 날짜의 차량과 주문 정보가 다시 조회되는지 확인합니다.', '오늘 화면으로 돌아올 때는 현재 날짜를 다시 선택합니다.'] },
  { chapter: 2, section: '관제', title: '관제 차량 목록', image: '02-control-actual-overview.png', steps: ['전체와 배정 필터로 차량 표시 범위를 바꿉니다.', '차량별 주문 건수와 색상 표식을 확인합니다.', '차량을 선택하면 지도와 상세 정보가 해당 차량 기준으로 바뀝니다.', '온도 버튼을 누르면 차량 온도 기록을 조회합니다.'] },
  { chapter: 2, section: '관제', title: '관제 차량 상세', image: '02-control-actual-vehicle-detail.png', steps: ['선택한 차량 번호와 운전자 정보를 확인합니다.', '최근 위치와 위치 지연 시간을 확인합니다.', '운송 정보 영역에서 필요한 연락처와 운영 정보를 확인합니다.', '자세히 보기로 등록된 차량 상세 화면으로 이동합니다.'] },
  { chapter: 2, section: '관제', title: '차량 자취 보기', image: '02-control-trace-mode.png', steps: ['차량 상세에서 자취 보기를 눌러 해당 날짜의 이동 기록을 엽니다.', '타임라인은 00:00부터 24:00까지 해당 날짜에 수집된 모든 위치를 표시합니다.', '재생 버튼과 시점 막대로 차량 이동을 시간 순서대로 확인합니다.', '필요하면 차량 따라가기를 사용하고, 확인 후 자취 닫기를 누릅니다.'], warning: '자취 보기에는 운행 중 위치뿐 아니라 sleep 상태에서 수집된 위치도 함께 표시됩니다.' },
  { chapter: 2, section: '관제', title: '관제 배송지 목록', image: '02-control-current-vehicle-destination-expanded.png', steps: ['선택 차량의 배송지를 예상 도착 순서로 확인합니다.', '배송지 행의 주문 건수와 총 박스 수를 함께 확인합니다.', '배송지 행을 누르면 주소와 주문번호별 운송 상태, 박스 수가 펼쳐집니다.', '같은 배송지 행을 다시 누르면 상세 정보가 접힙니다.', '0박스 주문도 주문번호별 상세에 그대로 표시됩니다.'] },
  { chapter: 2, section: '관제', title: '관제 온도 조회', image: '02-control-temperature-single.png', steps: ['차량의 온도 버튼을 눌러 온도 팝업을 엽니다.', '조회 기간과 냉동 배송 위치의 현재 온도를 확인합니다.', '온도 그래프의 시간대별 변화와 선택한 운송조건의 허용 범위를 확인합니다.', '온도 누락이나 기준 이탈이 있으면 운영 절차에 따라 확인합니다.'], warning: '온도 기준 이탈은 의약품 운송 품질에 영향을 줄 수 있으므로 즉시 확인합니다.' },
  { chapter: 2, section: '관제', title: '관제 상태 알림', image: '02-control-notifications.png', steps: ['알림 버튼을 눌러 최신 관제 알림을 엽니다.', '지연, GPS 미수신, 증빙 누락 등 알림 유형을 확인합니다.', '알림의 발생 시각과 관련 차량을 확인합니다.', '처리가 필요한 항목은 운영 담당자에게 전달합니다.'] },

  { chapter: 3, section: '배차', title: '배차 화면', image: '03-dispatch-actual-map.png', steps: ['배차일과 전체, 배정, 미배정 주문 수를 확인합니다.', '지도, 목록, 고객사 보기 중 작업에 맞는 보기를 선택합니다.', '상태 필터로 표시할 주문 범위를 좁힙니다.', '오른쪽 배송원 목록에서 차량과 배정 건수를 확인합니다.'] },
  { chapter: 3, section: '배차', title: '배차 조회 도구', image: '03-dispatch-actual-list.png', steps: ['배차일을 선택해 해당 날짜의 주문을 조회합니다.', '전체, 미배정, 배정, 활성, 취소, 완료 상태를 선택합니다.', '오더번호 또는 배송처를 입력해 검색합니다.', '초기화 버튼으로 검색 조건을 해제합니다.'] },
  { chapter: 3, section: '배차', title: '배차 지도 선택', image: '03-dispatch-actual-assigned-map.png', steps: ['영역 선택을 눌러 지도 선택 모드로 전환합니다.', '지도에서 배정할 배송지를 선택합니다.', '선택 집계의 배송지 수와 주문 수를 확인합니다.', '배송원을 선택한 후 선택 배정을 실행합니다.'] },
  { chapter: 3, section: '배차', title: '배차 주문 목록', image: '03-dispatch-actual-assigned-list.png', steps: ['목록 보기를 선택해 주문을 행 단위로 확인합니다.', '체크박스로 배정 또는 해제할 주문을 선택합니다.', '주문번호, 배송처, 주소, 고객사, 상태를 확인합니다.', '목록 선택 결과가 지도와 배송원 집계에 반영되는지 확인합니다.'] },
  { chapter: 3, section: '배차', title: '배차 배송원 목록', image: '03-dispatch-actual-assigned-customer.png', steps: ['배송원, 차량, 배정 건수를 확인합니다.', '열 제목을 눌러 배송원, 차량, 배정 건수 기준으로 정렬합니다.', '배송원을 선택하면 해당 배송원의 배정 주문을 확인합니다.', '차량 미등록 배송원은 배정 전에 차량 등록 상태를 확인합니다.'] },
  { chapter: 3, section: '배차', title: '배차 처리', image: '03-dispatch-selection-actions.png', steps: ['처리할 주문과 필요한 경우 배송원을 선택합니다.', '선택 집계에서 배송지와 주문 건수를 확인합니다.', '선택 배정으로 주문을 배송원에게 연결합니다.', '배정 해제로 배송원 연결만 취소하거나 배송 삭제로 선택 주문을 배차일에서 제거합니다.', '처리 후 배정 건수와 주문 상태가 갱신되었는지 확인합니다.'], warning: '배송 삭제는 선택 주문을 배차에서 제거하는 작업이므로 대상과 건수를 확인한 뒤 실행합니다.' },
  { chapter: 3, section: '배차', title: '배차 주문 검색', image: '03-dispatch-actual-list.png', steps: ['오더번호 검색란에 전체 또는 일부 번호를 입력합니다.', '배송처 검색란에 배송처 이름을 입력합니다.', '검색을 눌러 조건에 맞는 주문만 표시합니다.', '0박스 주문도 일반 주문과 동일하게 주문번호와 배송처로 검색됩니다.'] },
  { chapter: 3, section: '배차', title: '배차 파일 업로드', image: '03-dispatch-upload-panel.png', steps: ['주문 업로드를 눌러 업로드 영역을 엽니다.', 'CSV 또는 XLSX 배차 파일을 선택하거나 끌어 놓습니다.', '예제 업로드로 요구되는 열 구성을 확인할 수 있습니다.', '파일을 선택한 뒤 배차일과 미리보기 내용을 확인합니다.'] },
  { chapter: 3, section: '배차', title: '배차 업로드 편집', image: '03-dispatch-upload-preview.png', steps: ['미리보기 표에서 열 이름과 데이터 형식을 확인합니다.', '수정할 셀을 더블클릭해 값을 편집합니다.', '주소 확인 결과와 특이사항을 확인합니다.', '정상, 변경, 주의, 오류 집계를 확인합니다.', '오류가 0건일 때만 업로드 확정 가능 여부를 확인합니다.'] },
  { chapter: 3, section: '배차', title: '배차 업로드 오류', image: '03-dispatch-actual-errors.png', steps: ['주의 및 오류 영역을 펼쳐 행별 검증 결과를 확인합니다.', '행 번호와 열 이름으로 원본 데이터 위치를 찾습니다.', '주소 추천이 제공되면 기본 주소와 상세 주소를 확인한 뒤 적용합니다.', '오류 항목을 모두 수정한 후 다시 검증합니다.'], warning: '오류가 남아 있으면 업로드를 확정하지 않습니다.' },
  { chapter: 3, section: '배차', title: '0박스 주문 주의', image: '03-dispatch-current-zero-box-warning.png', steps: ['shippedbox 값이 0인 주문은 오류가 아니라 주의로 분류됩니다.', '같은 배송지의 다른 주문으로 박스가 합산된 경우인지 확인합니다.', '주문번호는 각각 유지하고 배송지 총 박스 수는 모든 주문의 합계로 표시합니다.', '업로드 후에도 주문번호 또는 배송처로 해당 주문을 검색할 수 있습니다.', '업무상 정상 합산 건임을 확인한 경우 그대로 업로드할 수 있습니다.'], warning: '0박스는 자동 오류가 아니지만, 실제 누락인지 합산 배송인지 반드시 확인합니다.' },
  { chapter: 3, section: '배차', title: '배차 업로드 후 등록', image: '03-dispatch-actual-ready.png', steps: ['업로드 확정 후 주문이 해당 배차일에 등록되었는지 확인합니다.', '전체 주문 수와 배정 진행 집계를 확인합니다.', '지도 또는 목록에서 새 주문을 검색합니다.', '주의로 등록한 0박스 주문의 주문번호와 배송지 표시를 확인합니다.'] },

  { chapter: 4, section: '이력', title: '배송 이력 조회', image: 'legacy/legacy-24.png', steps: ['이력 목록에서 배송 이력을 선택합니다.', '주문번호, 배송처, 운송자원, 상태를 확인합니다.', '선택한 이력의 상세 정보와 이벤트가 아래 영역에 표시됩니다.', '페이지 이동으로 이전 배송 이력을 조회합니다.'] },
  { chapter: 4, section: '이력', title: '배송 이력 날짜', image: '04-records-date-picker.png', steps: ['이력 기준일을 눌러 달력을 엽니다.', '조회할 날짜를 선택합니다.', '선택 날짜의 이력 목록이 갱신되는지 확인합니다.', '오늘 기준으로 돌아오려면 현재 날짜를 다시 선택합니다.'] },
  { chapter: 4, section: '이력', title: '배송 상세', image: 'legacy/legacy-26.png', steps: ['선택한 주문의 주문번호와 배송처를 확인합니다.', '운송 상태와 배정 차량, 배송원을 확인합니다.', '예정 시각과 실제 처리 시각을 비교합니다.', '온도 또는 증빙 정보가 연결된 경우 함께 확인합니다.'] },
  { chapter: 4, section: '이력', title: '배송 이벤트', image: 'legacy/legacy-27.png', steps: ['배송 이벤트를 발생 순서대로 확인합니다.', '각 이벤트의 상태와 발생 시각을 확인합니다.', '지연 또는 예외 이벤트가 있는지 확인합니다.', '필요한 경우 운영 담당자와 이력 정보를 공유합니다.'] },

  { chapter: 5, section: '운송자원', title: '운송자원 화면', image: '05-resources-current-overview.png', steps: ['관리에서 운송자원 영역을 선택합니다.', '배송원 리스트와 선택 배송원 상세를 확인합니다.', '차량 리스트와 선택 차량 상세를 확인합니다.', '등록, 수정, 삭제와 앱 설치 안내는 선택 대상과 권한을 확인한 뒤 사용합니다.'] },
  { chapter: 5, section: '운송자원', title: '배송원 관리', image: 'legacy/legacy-29.png', steps: ['배송원 목록에서 관리할 배송원을 선택합니다.', '이름, 연락처와 앱 연결 상태를 확인합니다.', '등록 또는 수정으로 배송원 정보를 관리합니다.', '차량 연결 여부를 확인합니다.'], warning: '배송원 정보 변경은 현재 배차와 앱 로그인에 영향을 줄 수 있습니다.' },
  { chapter: 5, section: '운송자원', title: '배송원 앱 설치', image: '05-resources-driver-install.png', steps: ['앱 설치 안내 팝업을 엽니다.', '배송원에게 https://dsv.cleversystem.ai/driver-app 주소를 전달합니다.', '지원되는 기기에서는 운영체제 공유 시트를 사용하고, 지원하지 않거나 공유가 취소되면 복사된 주소를 전달합니다.', '배송원은 설치 페이지에서 운영체제별 배포 상태를 확인하고 현장 교육 가이드 PDF도 내려받을 수 있습니다.'], warning: '배송원 설치는 공개 설치 페이지에서 안내하는 운영체제별 경로만 사용합니다.' },
  { chapter: 5, section: '운송자원', title: '배송원 회원가입', image: 'legacy/legacy-31.png', steps: ['설치 후 CLEVER Driver 로그인 화면에서 회원가입을 누릅니다.', '배송원이 DSV에 등록된 본인 이름과 휴대전화 번호를 정확히 입력합니다.', '로그인 ID와 비밀번호를 설정해 회원가입을 완료합니다.', '이름과 연락처가 일치하면 배송 업무가 자동 연결되는지 확인합니다.'], warning: '연결 대기 상태가 표시되면 새 계정을 반복 생성하지 말고 DSV 등록 이름과 연락처를 확인합니다.' },
  { chapter: 5, section: '운송자원', title: '차량 상세', image: 'legacy/legacy-32.png', steps: ['차량 목록에서 차량을 선택합니다.', '차량 번호와 연결 배송원을 확인합니다.', '차량 종류와 온도 센서 정보를 확인합니다.', '운영 상태와 최근 사용 정보를 확인합니다.'] },
  { chapter: 5, section: '운송자원', title: '차량 관리', image: 'legacy/legacy-33.png', steps: ['등록 또는 수정으로 차량 정보를 입력합니다.', '차량 번호와 차량 종류를 확인합니다.', '배송원 연결 정보를 확인합니다.', '센서 또는 연동 식별자가 있는 경우 정확히 입력합니다.'], warning: '차량 정보 변경은 배차와 관제 표시 범위에 영향을 줄 수 있습니다.' },

  { chapter: 6, section: '고객사', title: '고객사 목록', image: 'legacy/legacy-34.png', steps: ['고객사 목록에서 고객사를 선택합니다.', '고객 코드와 주문 수를 확인합니다.', '배송조회 링크로 고객사 조회 화면을 열 수 있습니다.', '선택 고객사의 상세, 배송지, 계정 정보를 함께 확인합니다.'] },
  { chapter: 6, section: '고객사', title: '고객사 상세', image: 'legacy/legacy-35.png', steps: ['고객사 이름과 고객 코드를 확인합니다.', '이메일 알림 사용 여부와 대표 수신자를 확인합니다.', '등록 배송지 수와 주문 수를 확인합니다.', '수정 기능으로 고객사 정보를 변경합니다.'], warning: '고객사 정보 변경 전 배송지, 계정, 배송조회 연결 범위를 확인합니다.' },
  { chapter: 6, section: '고객사', title: '고객사 배송지 목록', image: 'legacy/legacy-36.png', steps: ['선택 고객사의 배송지 목록을 확인합니다.', '배송지를 선택해 주소와 통합 주소 정보를 확인합니다.', '등록 또는 수정으로 배송지 정보를 관리합니다.', '배송지 삭제 전 연결 주문이 없는지 확인합니다.'], warning: '배송지 변경은 주문 검색과 고객 배송조회 결과에 영향을 줄 수 있습니다.' },
  { chapter: 6, section: '고객사', title: '고객사 계정 목록', image: 'legacy/legacy-37.png', steps: ['고객 계정의 로그인 ID와 상태를 확인합니다.', '초대 상태와 최근 인증 시각을 확인합니다.', '고객 계정은 선택 고객사의 배송만 조회하는지 확인합니다.', '필요한 경우 계정 초대를 다시 발급합니다.'] },
  { chapter: 6, section: '고객사', title: '고객 계정 발급', image: 'legacy/legacy-38.png', steps: ['수신자 이메일을 입력합니다.', '표시 이름을 입력합니다.', '로그인 ID를 자동 생성하거나 직접 지정합니다.', '상시 로그인 주소와 고객의 비밀번호 직접 설정 방식을 확인합니다.', '발급 이메일 미리보기를 확인한 뒤 전송합니다.'] },
  { chapter: 6, section: '고객사', title: '고객 초대 이메일', image: 'legacy/legacy-39.png', steps: ['수신자 이메일과 표시 이름을 확인합니다.', '안내 문장을 고객 상황에 맞게 작성합니다.', '보내는 계정, 제목, 본문 전체를 미리보기에서 확인합니다.', '예시 링크와 실제 수신자 전용 일회성 링크의 차이를 확인합니다.', '내용 확인 후 초대 이메일을 전송합니다.'], warning: '초대 이메일은 고객사 담당자에게만 발송하고, 일회용 링크를 제3자에게 전달하지 않습니다.' },

  { chapter: 7, section: '운송조건', title: '운송조건 목록', image: 'legacy/legacy-40.png', steps: ['운송조건 목록에서 조건을 선택합니다.', '조건 코드와 표시 이름을 확인합니다.', '온도 범위와 운영 기준을 확인합니다.', '연결된 주문이 사용하는 조건과 일치하는지 확인합니다.'] },
  { chapter: 7, section: '운송조건', title: '운송조건 편집', image: 'legacy/legacy-41.png', steps: ['조건 코드와 표시 이름을 입력합니다.', '최저 및 최고 온도 범위를 입력합니다.', '알림 또는 운영 관련 값을 확인합니다.', '저장 후 관제와 이력 화면의 표시를 확인합니다.'], warning: '운송조건 변경은 온도 판단과 경고 기준에 영향을 줄 수 있습니다.' },

  { chapter: 8, section: '설정', title: '출발 위치 설정', image: 'legacy/legacy-42.png', steps: ['출발지 주소를 입력하거나 주소 검색을 사용합니다.', '지도에서 위치를 클릭하거나 마커를 이동합니다.', '위도와 경도 값을 확인합니다.', '저장 후 관제와 배차 지도의 출발 위치를 확인합니다.'] },
  { chapter: 8, section: '설정', title: '운영 기준 설정', image: 'legacy/legacy-43.png', steps: ['준비 시작과 출발 예정 시간을 입력합니다.', 'ETA 지연 알림 기준을 입력합니다.', 'GPS 미수신과 도착 후 대기시간 기준을 입력합니다.', '알림 수신 항목을 선택합니다.', '저장 후 설정값이 유지되는지 확인합니다.'] },
  { chapter: 8, section: '설정', title: '이메일 테스트', image: 'legacy/legacy-44.png', steps: ['인증된 발신자 이메일을 확인합니다.', '수신자를 쉼표로 구분해 최대 10명까지 입력합니다.', '제목과 본문에 고객사 배송조회 주소와 안내를 작성합니다.', '수신자와 발송 내용 확인 항목을 선택합니다.', '1회 발송 결과를 확인합니다.'], warning: '테스트 발송도 실제 이메일을 전송합니다. 수신자와 본문을 확인하기 전에는 확인 항목을 선택하지 않습니다.' },
  { chapter: 8, section: '설정', title: '내 계정 설정', image: 'legacy/legacy-45.png', steps: ['현재 비밀번호를 입력해 본인 계정임을 확인합니다.', '필요한 경우 새 로그인 ID를 입력합니다.', '새 비밀번호와 비밀번호 확인을 같은 값으로 입력합니다.', '변경 전 확인 사항을 읽고 저장합니다.'], warning: '직전에 사용한 비밀번호는 다시 사용할 수 없으며, 변경 후 다른 로그인 세션은 종료됩니다.' },
  { chapter: 8, section: '설정', title: '관리자 계정', image: '06-settings-current-accounts.png', steps: ['계정 탭에서 CLEVER 개발 관리자와 DSV 관제 운영 계정을 구분합니다.', '권한 열을 눌러 개발 관리 또는 관제 운영 순서로 정렬합니다.', '계정별 상태와 마지막 로그인 시각을 확인합니다.', '현재 로그인한 개발 관리자 계정은 비활성화할 수 없습니다.', '다른 운영 계정은 해당 행의 비활성화 또는 활성화 버튼으로 관리합니다.'], warning: '개발 관리 권한과 고객사 관제 운영 권한을 혼동하지 않습니다.' },
  { chapter: 8, section: '설정', title: '운영 계정 초대 이메일', image: '06-settings-current-account-invite.png', steps: ['수신자 이메일, 표시 이름, 안내 문장을 왼쪽 입력 영역에 작성합니다.', '오른쪽 미리보기에서 보내는 계정과 제목을 확인합니다.', '본문 전체와 48시간 일회성 링크 예시를 확인합니다.', '실제 이메일에는 수신자 전용 일회성 링크가 포함되는 점을 확인합니다.', '내용 확인 후 초대 이메일을 전송합니다.'], warning: '개발 관리자만 DSV 관제 운영 계정을 초대하며 개발 관리 권한은 부여하지 않습니다.' },

  { chapter: 9, section: '고객 배송조회', title: '고객 배송 위치', image: 'legacy/legacy-46.png', steps: ['고객 배송조회 화면에서 고객사 범위를 확인합니다.', '검색 조건을 입력해 주문을 조회합니다.', '지도에서 배송 차량 또는 배송 위치를 확인합니다.', '배송 상세 영역에서 선택 주문 정보를 확인합니다.'] },
  { chapter: 9, section: '고객 배송조회', title: '고객 배송 조회', image: 'legacy/legacy-47.png', steps: ['배송처 또는 주문번호를 입력합니다.', '조회 버튼을 눌러 결과를 확인합니다.', '검색 결과에서 주문을 선택합니다.', '현재 상태와 예상 도착 정보를 확인합니다.'] },
  { chapter: 9, section: '고객 배송조회', title: '고객 배송 조회 상세', image: 'legacy/legacy-48.png', steps: ['선택 주문의 배송처와 주문번호를 확인합니다.', '현재 배송 상태와 예상 도착 시각을 확인합니다.', '지도에서 현재 위치와 이동 경로를 확인합니다.', '상세 정보는 해당 고객사 주문 범위에서만 표시됩니다.'] },
  { chapter: 9, section: '고객 배송조회', title: '고객 배송조회 로그인', image: 'legacy/legacy-49.png', steps: ['고객 전용 로그인 주소에 접속합니다.', '고객이 설정한 로그인 ID와 비밀번호를 입력합니다.', '로그인 버튼을 눌러 배송조회 화면으로 이동합니다.', '로그인 문제가 있으면 초대 상태와 계정 활성 상태를 확인합니다.'], warning: '고객 계정은 해당 고객사의 배송만 조회하며 관제 운영 권한을 갖지 않습니다.' },
  { chapter: 9, section: '고객 배송조회', title: '초대 링크 오류 대응', image: 'legacy/legacy-50.png', steps: ['계정 설정 화면의 오류 메시지를 확인합니다.', '초대 링크의 48시간 만료 여부를 확인합니다.', '이미 한 번 사용된 링크인지 확인합니다.', '개발 관리자에게 새 초대 링크 재발급을 요청합니다.', '새 링크를 받은 뒤 브라우저에서 다시 계정 설정을 진행합니다.'], warning: '만료되거나 사용된 링크를 반복해서 사용하지 말고 새 링크를 발급받습니다.' },
];

function resolveImage(file) {
  return path.isAbsolute(file) ? file : path.join(CAPTURE, file);
}

function fittedImage(file, altText) {
  const fullPath = resolveImage(file);
  if (!fs.existsSync(fullPath)) throw new Error(`Missing image: ${fullPath}`);
  const data = fs.readFileSync(fullPath);
  const size = imageSize(data);
  const maxWidth = 930;
  const maxHeight = 425;
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height);
  return new ImageRun({
    data,
    transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
    type: path.extname(fullPath).toLowerCase().includes('jpg') ? 'jpg' : 'png',
    altText: { name: altText, title: altText, description: `${altText} 화면` },
  });
}

function featurePage(item, index, firstInChapter) {
  const featureNo = `${item.chapter}.${pages.filter((p, i) => i <= index && p.chapter === item.chapter).length}`;
  const children = [];
  if (firstInChapter) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 20 },
      children: [run(`${item.chapter}. ${item.section}`, { size: 20, bold: true })],
    }));
  }
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 0, after: 90 },
    children: [run(`${featureNo} ${item.title}`, { size: 30, bold: true })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 110 },
    keepNext: true,
    children: [fittedImage(item.image, `${featureNo} ${item.title}`)],
  }));
  for (const [stepIndex, step] of item.steps.entries()) {
    children.push(new Paragraph({
      indent: { left: 520, hanging: 300 },
      spacing: { before: 0, after: 48, line: 252 },
      children: [
        run(`${stepIndex + 1}.`, { size: 20, bold: true }),
        run(`  ${step}`, { size: 20 }),
      ],
    }));
  }
  if (item.warning) {
    children.push(new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D7D7D7', space: 6 } },
      spacing: { before: 50, after: 0, line: 252 },
      children: [run(item.warning, { size: 20, bold: true, color: RED })],
    }));
  }
  return children;
}

const bodyChildren = [];
let previousChapter = null;
pages.forEach((item, index) => {
  if (index > 0) bodyChildren.push(new Paragraph({ children: [new PageBreak()] }));
  const firstInChapter = item.chapter !== previousChapter;
  bodyChildren.push(...featurePage(item, index, firstInChapter));
  previousChapter = item.chapter;
});

const header = new Header({
  children: [new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 0 },
    children: [run('CLEVER DSV | 관제 운영자 사용자 가이드', { size: 18, bold: true })],
  })],
});

const tocFooter = new Footer({ children: [new Paragraph({ children: [] })] });
const bodyFooter = new Footer({
  children: [
    new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 20, after: 0 },
      children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT_SPEC, language: LANGUAGE, size: 20, color: BLACK })],
    }),
  ],
});

const doc = new Document({
  features: { updateFields: true },
  fonts: [{ name: FONT_NAME, data: FONT_DATA, characterSet: CharacterSet.HANGUL }],
  styles: {
    default: {
      document: { run: { font: FONT_SPEC, language: LANGUAGE, size: 22, color: BLACK }, paragraph: { alignment: AlignmentType.LEFT } },
    },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT_SPEC, language: LANGUAGE, size: 32, bold: true, color: BLACK }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT_SPEC, language: LANGUAGE, size: 24, bold: true, color: BLACK }, paragraph: { spacing: { before: 180, after: 100 }, keepNext: true, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT_SPEC, language: LANGUAGE, size: 20, bold: true, color: BLACK }, paragraph: { spacing: { before: 120, after: 80 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  sections: [
    {
      properties: { type: SectionType.NEXT_PAGE, page: PAGE },
      children: [
        coverTable,
        new Paragraph({ children: [new PageBreak()] }),
        title('Release Note'),
        releaseTable,
        new Paragraph({ children: [new PageBreak()] }),
        ...copyrightNotice,
      ],
    },
    {
      properties: { type: SectionType.NEXT_PAGE, page: PAGE },
      headers: { default: header },
      footers: { default: tocFooter },
      children: [
        title('목차 / Table of Contents'),
        tocTable,
        new Paragraph({ children: [new PageBreak()] }),
        title('기능 구성'),
        chapterTable,
      ],
    },
    {
      properties: { type: SectionType.NEXT_PAGE, page: { ...PAGE, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } },
      headers: { default: header },
      footers: { default: bodyFooter },
      children: bodyChildren,
    },
  ],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(OUTPUT, buffer);
  console.log(OUTPUT);
  console.log(`body-pages=${pages.length}`);
});
