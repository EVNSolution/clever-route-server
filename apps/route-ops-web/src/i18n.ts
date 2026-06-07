export type AppLocale = 'en-CA' | 'ko-KR';

export function resolveLocale(value: string | null | undefined): AppLocale {
  return value === 'ko-KR' ? 'ko-KR' : 'en-CA';
}

export const appCopy = {
  'en-CA': {
    brandEyebrow: 'CLEVER Route App',
    bootTitle: 'Loading route operations…',
    bootMessage: 'Checking the WordPress launch session and operator workspace.',
    navigationLabel: 'Operate navigation',
    storeLabel: 'Store',
    selectShop: 'Select shop',
    wordpressSession: 'WordPress launch session',
    internalAdmin: 'CLEVER internal admin',
    notifications: {
      allCaughtUp: 'All caught up',
      loadFailed(error: string): string {
        return `Notifications could not be loaded. Last known alerts are preserved. ${error}`;
      },
      loadFailedShort: 'Load failed',
      noNotifications: 'No notifications yet.',
      notifications: 'Notifications',
      openNotifications: 'Open notifications',
      unreadCount(count: number): string {
        return `${count} unread`;
      },
      wooAssignedRouteAddressChangedBody(orderName: string | null): string {
        return `${orderName ?? 'A routed order'} address changed in WooCommerce after route assignment. Review the route before dispatch.`;
      },
      wooAssignedRouteAddressChangedTitle: 'Assigned route order address changed'
    },
    nav: {
      dashboard: 'Dashboard',
      orders: 'Orders',
      routes: 'Routes',
      drivers: 'Drivers & Vehicles',
      settings: 'Settings'
    },
    pageTitle: {
      dashboard: 'Dashboard',
      orders: 'Orders',
      routeBuilder: 'Route Builder',
      routes: 'Routes',
      drivers: 'Drivers & Vehicles',
      settings: 'Settings'
    }
  },
  'ko-KR': {
    brandEyebrow: 'CLEVER Route App',
    bootTitle: '배송 운영 화면을 불러오는 중…',
    bootMessage: 'WordPress 실행 세션과 운영자 작업 공간을 확인하고 있습니다.',
    navigationLabel: '운영 메뉴',
    storeLabel: '매장',
    selectShop: '매장을 선택하세요',
    wordpressSession: 'WordPress 실행 세션',
    internalAdmin: 'CLEVER 내부 관리자',
    notifications: {
      allCaughtUp: '모두 확인됨',
      loadFailed(error: string): string {
        return `알림을 불러오지 못했습니다. 이전 알림은 유지됩니다. ${error}`;
      },
      loadFailedShort: '불러오기 실패',
      noNotifications: '아직 알림이 없습니다.',
      notifications: '알림',
      openNotifications: '알림 열기',
      unreadCount(count: number): string {
        return `읽지 않은 알림 ${count}개`;
      },
      wooAssignedRouteAddressChangedBody(orderName: string | null): string {
        return `${orderName ?? '경로에 배정된 주문'} 주소가 경로 배정 후 WooCommerce에서 변경되었습니다. 출발 전 경로를 확인하세요.`;
      },
      wooAssignedRouteAddressChangedTitle: '배정된 경로의 주문 주소 변경'
    },
    nav: {
      dashboard: '대시보드',
      orders: '주문',
      routes: '경로',
      drivers: '배송원 및 차량',
      settings: '설정'
    },
    pageTitle: {
      dashboard: '대시보드',
      orders: '주문',
      routeBuilder: '경로 편집',
      routes: '경로',
      drivers: '배송원 및 차량',
      settings: '설정'
    }
  }
} as const;

export const dashboardCopy = {
  'en-CA': {
    today: 'Today',
    title: 'Daily route command center',
    description: 'Open Orders to review WooCommerce stops, create a date route, then manage sequence and drivers in Route Builder.',
    openOrders: 'Open orders',
    viewRoutes: 'View routes',
    session: 'Session',
    noShopSelected: 'No shop selected',
    pluginSession: 'Locked to the WordPress shop that launched this workspace.',
    internalSession: 'Internal admin can select a shop through approved admin surfaces.'
  },
  'ko-KR': {
    today: '오늘',
    title: '일일 배송 경로 운영',
    description: '주문에서 WooCommerce 하차지를 확인하고 날짜별 경로를 만든 뒤, 경로 편집에서 순서와 배송원을 관리합니다.',
    openOrders: '주문 열기',
    viewRoutes: '경로 보기',
    session: '세션',
    noShopSelected: '선택된 매장 없음',
    pluginSession: '이 작업 공간을 실행한 WordPress 매장으로 고정되어 있습니다.',
    internalSession: '내부 관리자는 승인된 관리자 화면에서 매장을 선택할 수 있습니다.'
  }
} as const;

export const driversCopy = {
  'en-CA': {
    eyebrow: 'Drivers',
    title: 'Driver management',
    description: 'Create a driver invite, share the six-character app code, and assign routes before app verification.',
    summaryLabel: 'Driver summary',
    drivers: 'Drivers',
    invitePending: 'Invite pending',
    linked: 'Linked',
    inviteEyebrow: 'Invite',
    createPendingDriver: 'Create pending driver',
    driverName: 'Driver name',
    phone: 'Phone',
    country: 'Country',
    searchCountry: 'Search country',
    noCountryMatch: 'No country match',
    nationalNumber: 'National number',
    invalidPhonePreview: 'Enter a valid number in national format to preview E.164.',
    e164Preview(phone: string): string { return `E.164 preview: ${phone}`; },
    creating: 'Creating…',
    createInvite: 'Create driver invite',
    pendingHelp: 'Pending drivers can be assigned in Route Builder now. They will see route details only after app authentication.',
    createdNotice: 'Driver invite created. Share the app code with the driver, then assign routes any time.',
    regeneratedNotice: 'Driver app code regenerated. Previous app sessions were invalidated by the server.',
    deleteConfirm(name: string): string { return `Delete ${name}? This removes the driver invite/app access from CLEVER Route.`; },
    deletedNotice(name: string): string { return `Driver deleted: ${name}.`; },
    copiedNotice(name: string): string { return `Invite copied for ${name}.`; },
    table: {
      driver: 'Driver',
      phone: 'Phone',
      status: 'Status',
      appAccess: 'App access',
      inviteAction: 'Invite code / action'
    },
    noDrivers: 'No drivers yet. Create the first pending driver invite.',
    canAssignBeforeVerification: 'Can be assigned before app verification',
    noActiveCode: 'No active code',
    noExpiry: 'No expiry',
    expires(date: string): string { return `Expires ${date}`; },
    copy: 'copy',
    reLogin: 're-login',
    reLoginBusy: 're-login…',
    delete: 'delete',
    deleteBusy: 'delete…',
    appLinked: 'App linked',
    authenticationCode: 'Authentication code',
    inviteMessageLink: 'Driver app download link: ask CLEVER admin',
    statusLabel: { pending: 'Pending', active: 'Active' }
  },
  'ko-KR': {
    eyebrow: '배송원',
    title: '배송원 관리',
    description: '배송원 초대를 만들고 6자리 앱 코드를 공유한 뒤, 앱 인증 전에도 경로를 배정할 수 있습니다.',
    summaryLabel: '배송원 요약',
    drivers: '배송원',
    invitePending: '초대 대기',
    linked: '연결됨',
    inviteEyebrow: '초대',
    createPendingDriver: '대기 배송원 생성',
    driverName: '배송원 이름',
    phone: '전화번호',
    country: '국가',
    searchCountry: '국가 검색',
    noCountryMatch: '일치하는 국가 없음',
    nationalNumber: '국내 전화번호',
    invalidPhonePreview: '국내 전화번호 형식으로 유효한 번호를 입력하면 E.164를 미리 볼 수 있습니다.',
    e164Preview(phone: string): string { return `E.164 미리보기: ${phone}`; },
    creating: '생성 중…',
    createInvite: '배송원 초대 생성',
    pendingHelp: '대기 배송원도 지금 경로 편집에서 배정할 수 있습니다. 앱 인증 후에만 경로 상세를 볼 수 있습니다.',
    createdNotice: '배송원 초대를 만들었습니다. 앱 코드를 공유한 뒤 언제든 경로를 배정하세요.',
    regeneratedNotice: '배송원 앱 코드를 다시 만들었습니다. 기존 앱 세션은 서버에서 무효화했습니다.',
    deleteConfirm(name: string): string { return `${name} 배송원을 삭제할까요? CLEVER Route의 배송원 초대/앱 접근 권한이 제거됩니다.`; },
    deletedNotice(name: string): string { return `배송원 삭제 완료: ${name}.`; },
    copiedNotice(name: string): string { return `${name} 배송원 초대 문구를 복사했습니다.`; },
    table: {
      driver: '배송원',
      phone: '전화번호',
      status: '상태',
      appAccess: '앱 접근',
      inviteAction: '초대 코드 / 작업'
    },
    noDrivers: '아직 배송원이 없습니다. 첫 번째 대기 배송원 초대를 만드세요.',
    canAssignBeforeVerification: '앱 인증 전에도 배정 가능',
    noActiveCode: '활성 코드 없음',
    noExpiry: '만료 없음',
    expires(date: string): string { return `${date} 만료`; },
    copy: '복사',
    reLogin: '재로그인',
    reLoginBusy: '재로그인…',
    delete: '삭제',
    deleteBusy: '삭제 중…',
    appLinked: '앱 연결됨',
    authenticationCode: '인증 코드',
    inviteMessageLink: '배송원 앱 다운로드 링크: CLEVER 관리자에게 문의',
    statusLabel: { pending: '대기', active: '활성' }
  }
} as const;

export const routesCopy = {
  'en-CA': {
    routes: 'Routes',
    stops: 'Stops',
    missingCoordinates: 'Missing coordinates',
    recentRoutePlans: 'Recent route plans',
    createRoute: 'Create route',
    table: { name: 'Name', status: 'Status', stops: 'Stops', date: 'Date', driver: 'Driver' },
    open: 'Open',
    delete: 'Delete',
    deleting: 'Deleting…',
    deleteConfirm(name: string): string { return `Delete ${name}? Orders will return to the unplanned list.`; },
    routeBuilder: 'Route Builder',
    loadingRoute: 'Loading route…',
    allRoutes: 'All routes',
    assignedDriver: 'Assigned driver',
    unassigned: 'Unassigned',
    saveDriver: 'save driver',
    savingDriver: 'saving driver…',
    publishRoute: 'Publish route',
    publishing: 'publishing…',
    loadRouteBeforePublishing: 'Load route before publishing.',
    driverAppVisible: 'Driver app visible',
    notVisibleToDriverApp: 'Not visible to driver app yet',
    routeEnd: 'Route end',
    returnToStore: 'Return to store',
    returnToStoreHelp: 'Checked: routing returns to the store after the final stop.',
    endAtLastStopHelp: 'Unchecked: routing ends at the final order stop.',
    saveRouteOptions: 'save route options',
    savingRouteOptions: 'saving route options…',
    save: 'save',
    saving: 'saving…',
    noRecipient: 'No recipient',
    completed: 'Completed',
    attempted: 'Attempted',
    missingCoords: 'Missing coords',
    appLinked: 'App linked',
    invitePending: 'Invite pending',
    routeStatus: {
      ASSIGNED: 'Assigned',
      COMPLETED: 'Completed',
      DRAFT: 'Draft',
      IN_PROGRESS: 'In progress',
      OPTIMIZED: 'Optimized'
    },
    publishNotice: {
      draftAssignDriver: 'Draft route — assign a driver, then publish to make it visible in the driver app.',
      draftAddStops: 'Draft route — add stops before publishing.',
      draftNotVisible: 'Draft route — driver is assigned, but the route is not visible in the driver app until you publish it.',
      publishedLinked: 'Published route — visible to the linked driver after the app refreshes.',
      publishedPending: 'Published route — the assigned driver can see it after app authentication.'
    },
    moveUp(orderName: string): string { return `Move ${orderName} up`; },
    moveDown(orderName: string): string { return `Move ${orderName} down`; }
  },
  'ko-KR': {
    routes: '경로',
    stops: '하차지',
    missingCoordinates: '좌표 누락',
    recentRoutePlans: '최근 경로 계획',
    createRoute: '경로 생성',
    table: { name: '이름', status: '상태', stops: '하차지', date: '날짜', driver: '배송원' },
    open: '열기',
    delete: '삭제',
    deleting: '삭제 중…',
    deleteConfirm(name: string): string { return `${name} 경로를 삭제할까요? 주문은 미배정 목록으로 돌아갑니다.`; },
    routeBuilder: '경로 편집',
    loadingRoute: '경로를 불러오는 중…',
    allRoutes: '전체 경로',
    assignedDriver: '배정 배송원',
    unassigned: '미배정',
    saveDriver: '배송원 저장',
    savingDriver: '배송원 저장 중…',
    publishRoute: '경로 게시',
    publishing: '게시 중…',
    loadRouteBeforePublishing: '게시 전에 경로를 불러오세요.',
    driverAppVisible: '배송원 앱에 표시됨',
    notVisibleToDriverApp: '아직 배송원 앱에 표시되지 않음',
    routeEnd: '경로 종료 방식',
    returnToStore: 'Return to store',
    returnToStoreHelp: '체크: 마지막 하차지 이후 매장으로 돌아오는 경로를 표시합니다.',
    endAtLastStopHelp: '미체크: 마지막 주문지에서 경로 안내를 끝냅니다.',
    saveRouteOptions: '경로 옵션 저장',
    savingRouteOptions: '경로 옵션 저장 중…',
    save: '저장',
    saving: '저장 중…',
    noRecipient: '수령인 없음',
    completed: '완료',
    attempted: '시도',
    missingCoords: '좌표 누락',
    appLinked: '앱 연결됨',
    invitePending: '초대 대기',
    routeStatus: {
      ASSIGNED: '배정됨',
      COMPLETED: '완료됨',
      DRAFT: '초안',
      IN_PROGRESS: '진행 중',
      OPTIMIZED: '최적화됨'
    },
    publishNotice: {
      draftAssignDriver: '초안 경로 — 배송원을 배정한 뒤 게시하면 배송원 앱에 표시됩니다.',
      draftAddStops: '초안 경로 — 게시 전에 하차지를 추가하세요.',
      draftNotVisible: '초안 경로 — 배송원은 배정되었지만 게시하기 전까지 배송원 앱에 표시되지 않습니다.',
      publishedLinked: '게시된 경로 — 앱 새로고침 후 연결된 배송원에게 표시됩니다.',
      publishedPending: '게시된 경로 — 배정된 배송원이 앱 인증 후 볼 수 있습니다.'
    },
    moveUp(orderName: string): string { return `${orderName} 위로 이동`; },
    moveDown(orderName: string): string { return `${orderName} 아래로 이동`; }
  }
} as const;

export const mapCopy = {
  'en-CA': {
    providerRequestFailed: 'Map provider request failed',
    libraryFailed: 'Map library failed to load',
    centerOnStore: 'Center map on store',
    exitRouteMode: 'Back to map orders',
    fitMap: 'Zoom map to fit',
    interactiveMap: 'Interactive CLEVER route map',
    markerPreview: 'Marker-only coordinate preview',
    refreshMap: 'Refresh map',
    routePreview: 'Route coordinate preview',
    routeStart(label: string): string { return `Route start: ${label}`; },
    storeAddress(address: string): string { return `Store address: ${address}`; }
  },
  'ko-KR': {
    providerRequestFailed: '지도 제공자 요청에 실패했습니다',
    libraryFailed: '지도 라이브러리를 불러오지 못했습니다',
    centerOnStore: '매장 위치로 이동',
    exitRouteMode: '주문 지도로 돌아가기',
    fitMap: '지도 맞춤',
    interactiveMap: 'CLEVER 경로 지도',
    markerPreview: '좌표 마커 미리보기',
    refreshMap: '지도 새로고침',
    routePreview: '경로 좌표 미리보기',
    routeStart(label: string): string { return `경로 시작점: ${label}`; },
    storeAddress(address: string): string { return `매장 주소: ${address}`; }
  }
} as const;

export const stateCopy = {
  'en-CA': {
    worksetReasons: {
      already_planned: 'Already planned',
      address_review: 'Address Review',
      completed_or_cancelled: 'Completed/cancelled',
      delivery_date_review: 'Delivery date review',
      different_delivery_date: 'Different delivery date',
      different_route_scope: 'Different delivery session',
      missing_address: 'Missing address',
      missing_coordinates: 'Missing coordinates',
      missing_delivery_date: 'Missing delivery date',
      missing_route_scope: 'Missing route scope',
      needs_review: 'Other metadata review'
    },
    geometry: {
      noRouteSelected: 'No route selected',
      roadGeometry: 'Road path ready',
      noCoordinates: 'Need coordinates for road path',
      routerNotConfigured: 'Stops ready · router not configured',
      roadGeometryUnavailable: 'Stops ready · road path not generated'
    },
    storeAddress: 'Store address',
    store: 'Store'
  },
  'ko-KR': {
    worksetReasons: {
      already_planned: '이미 배정됨',
      address_review: '주소 확인',
      completed_or_cancelled: '완료/취소됨',
      delivery_date_review: '배송 날짜 확인',
      different_delivery_date: '배송 날짜 다름',
      different_route_scope: '배송 세션 다름',
      missing_address: '주소 누락',
      missing_coordinates: '좌표 누락',
      missing_delivery_date: '배송 날짜 누락',
      missing_route_scope: '경로 범위 누락',
      needs_review: '기타 메타데이터 검토'
    },
    geometry: {
      noRouteSelected: '선택된 경로 없음',
      roadGeometry: '도로 경로',
      noCoordinates: '경로 선에 필요한 좌표 부족',
      routerNotConfigured: '정류장 표시됨 · 라우터 미설정',
      roadGeometryUnavailable: '정류장 표시됨 · 경로 선 없음'
    },
    storeAddress: '매장 주소',
    store: '매장'
  }
} as const;

export const ordersCopy = {
  'en-CA': {
    title: 'Orders',
    mapTitle: 'Orders map',
    mapSubtitle: 'Imported WooCommerce stops by current filters',
    modeLabel: 'Orders mode',
    statusTabsLabel: 'Order status tabs',
    planning: 'Planning',
    history: 'History',
    all: 'All',
    unplanned: 'Unplanned',
    planned: 'Planned',
    needsReview: 'Needs Review',
    filtersEyebrow: 'Filters',
    filtersTitle: 'Order filters',
    clearFilters: 'Clear filters',
    deliveryDate: 'Delivery date',
    areaPlaceholder: 'Toronto',
    areaRegion: 'Area / region',
    deliveryStatus: 'Delivery status',
    serviceType: 'Service type',
    deliverySession: 'Delivery session',
    search: 'Search',
    searchPlaceholder: '#1001, email, phone',
    allOption: 'All',
    ready: 'Ready',
    completed: 'Completed',
    normal: 'Normal',
    newRoute: 'New route',
    addPlan: 'Add plan',
    addPlanPanelLabel: 'New route add plan',
    routeDetailPanelLabel: 'Selected route detail',
    orders: 'orders',
    planInstructions: 'Use the map or order list to add ready unplanned orders, then create the route.',
    routeDetailInstructions: 'Planned route selected from the map. Review the stop order here or open Route Builder to edit.',
    editRoute: 'Edit route',
    loadingRoute: 'Loading route…',
    noRouteDetail: 'Route detail is unavailable.',
    routeStatus: 'Route status',
    routeStopsLabel: 'Route stops',
    routeDate: 'Route date',
    routeName: 'Route name',
    defaultRouteName(date: string): string { return `Route ${date}`; },
    createRoute: 'Create route',
    clearPlan: 'Clear plan',
    addPlanOrdersLabel: 'Add plan orders',
    planEmpty: 'Plan is empty.',
    recipientFallback: 'Recipient',
    areaFallback: 'Area',
    dateFallback: 'Date',
    tableEyebrow: 'Orders',
    tableTitle: 'Imported order list',
    diagnosticMetadata: 'Order metadata',
    selectedSummary(selected: number, selectable: number, unavailable: number): string { return `${selected} selected · ${selectable} selectable · ${unavailable} unavailable`; },
    updating: 'Updating…',
    wooSyncing: 'Syncing Woo…',
    wooSync: 'Sync Woo',
    bulkGeocoding: 'Bulk geocoding…',
    bulkGeocode: 'Bulk geocode',
    unavailablePrefix: 'Unavailable:',
    loadingOrders: 'Loading imported WooCommerce orders…',
    noOrders: 'No imported orders match the current filters.',
    selectAllEligible: 'Select all eligible orders in current workset',
    columns: {
      select: 'Select',
      order: 'Order',
      customer: 'Customer',
      method: 'Method',
      day: 'Day',
      area: 'Area',
      route: 'Route',
      status: 'Status',
      actions: 'Actions'
    },
    review: 'Review',
    detail: 'Detail',
    add: 'Add',
    remove: 'Remove',
    selectOrder(label: string): string { return `Select order ${label}`; },
    planOrderAction(action: 'Add' | 'Remove', label: string): string { return `${action} order ${label} ${action === 'Remove' ? 'from' : 'to'} route plan`; },
    detailToggle(expanded: boolean, label: string): string { return `${expanded ? 'Hide' : 'Show'} details for order ${label}`; },
    routeConstraintFallback: 'Review route constraints',
    createRouteReadyOnly: 'Create route uses ready unplanned orders only. Remove unavailable orders from the plan.',
    selectRouteReady: 'Select route-ready orders with a delivery date.',
    orderUnavailable(reasons: string): string { return `Order is not available for this plan: ${reasons}.`; },
    detailEyebrow: 'Detail',
    detailsFor(orderName: string): string { return `Order details for ${orderName}`; },
    editAllFields: 'Edit all fields',
    close: 'Close',
    fieldsToFix: 'Fields to fix',
    orderReadiness: 'Order readiness',
    orderSummary: 'Order summary',
    repairInstruction: 'Update the highlighted field, then save this order.',
    noFixes: 'No required fixes for this order.',
    currentBlockers: 'Current blockers',
    saving: 'Saving…',
    saveFixes: 'Save fixes',
    destination: 'Destination',
    coordinates: 'Coordinates',
    delivery: 'Delivery',
    payment: 'Payment',
    paymentEvidence: 'Woo evidence',
    paymentMethod: 'Method',
    paymentStatus: 'Status',
    paymentReason: 'Reason',
    paymentPaidAt: 'Paid at',
    paymentTransaction: 'Transaction',
    paymentUnavailable: 'Payment unavailable',
    date: 'Date',
    area: 'Area',
    service: 'Service',
    window: 'Window',
    required: 'Required',
    reviewIfRequired: 'Review if required',
    editAllOrderFields: 'Edit all order fields',
    save: 'Save',
    cancel: 'Cancel',
    technicalDiagnostics: 'Technical diagnostics',
    loadingDetail: 'Loading order detail…',
    noDiagnostics: 'No saved detail diagnostics yet.',
    diagnosticsStatus: 'Status',
    matchedMappingPaths: 'Matched mapping paths',
    fieldHelp(label: string): string { return `${label} help`; },
    selectChoice(label: string): string { return `Select ${label.toLowerCase()}`; },
    repairTitles: {
      aggregate: 'Fix required order details',
      addressReview: 'Verify destination address',
      deliveryDate: 'Delivery date required',
      deliveryDateReview: 'Verify delivery date',
      deliveryArea: 'Delivery area required',
      routeScope: 'Route scope required',
      timeWindow: 'Time window needs review',
      address: 'Destination address required',
      fallback: 'Fix required fields'
    },
    addressRequired: 'Address required',
    coordinatesReady: 'Ready for the map',
    coordinatesNeeded: 'Coordinates needed',
    useBulkGeocodeFromList: 'Use Bulk geocode from the order list.',
    enterAddressBeforeGeocoding: 'Enter enough destination detail before geocoding.',
    routeDraft: {
      selectReady: 'Select route-ready orders with a delivery date and route scope.',
      onlySameScope: 'Only orders with the same delivery date and delivery session were added to the plan.',
      dateMustMatch: 'Route date must match the selected orders delivery date.',
      selectedMustShareScope: 'Selected orders must share the same delivery date and delivery session.'
    },
    bulkStatus: {
      matched: 'matched',
      attempted: 'attempted',
      resolved: 'resolved',
      failed: 'failed',
      noAddress: 'no address',
      skippedByPolicy: 'skipped by policy',
      alreadyHadCoordinates: 'already had coordinates',
      policyReached(limit: number | string): string { return ` Public geocoder cap reached (${limit} attempts).`; }
    },
    wooSyncStatus: {
      queued: 'queued',
      running: 'running',
      succeeded: 'completed',
      failed: 'failed',
      summary(status: string, counts: { created: number; needsReview: number; readyToPlan: number; received: number; updated: number }): string {
        return `Last Woo sync ${status}: ${counts.received} received, ${counts.created} created, ${counts.updated} updated, ${counts.readyToPlan} metadata ready, ${counts.needsReview} metadata review.`;
      }
    },
    statusLabels: {
      planned: 'Planned',
      addressReview: 'Address Review',
      deliveryDateReview: 'Delivery date review',
      missingDeliveryDate: 'Missing delivery date',
      missingDeliveryArea: 'Missing delivery area',
      missingRouteScope: 'Missing route scope',
      deliveryDayUnclear: 'Delivery day unclear',
      missingTimeWindow: 'Missing time window',
      deliveryTimeUnclear: 'Delivery time unclear',
      needCoordinates: 'Need coordinates',
      missingAddress: 'Missing address',
      metadataReview: 'Metadata review',
      ready: 'Ready',
      notRouteEligible: 'Not route eligible',
      alreadyPlanned: 'Already planned',
      routeEligible: 'Route eligible',
      needsMetadata: 'Needs metadata',
      needAddress: 'Need address'
    },
    paymentStatusLabels: {
      PAID_CONFIRMED: 'Paid confirmed',
      CASH_COLLECT_REQUIRED: 'Collect cash',
      TRANSFER_CHECK_PENDING: 'Transfer pending',
      ONLINE_PAYMENT_PENDING_OR_FAILED: 'Online pending/failed',
      NOT_DELIVERABLE_OR_EXCEPTION: 'Payment exception',
      UNKNOWN_REVIEW: 'Review payment'
    },
    statusDetails: {
      useBulkGeocode: 'use bulk geocode',
      verifyAddress: 'Verify address',
      verifyDeliveryDate: 'Verify delivery date',
      enterDeliveryDate: 'Enter delivery date',
      enterAddressOrCoordinates: 'Enter address or coordinates',
      reviewRouteConstraints: 'Review route constraints'
    },
    statusMeanings: {
      addressReview: 'Warning meaning: Bulk geocode already tried the available address combinations but no reliable coordinate was found. Verify or correct the destination address manually.',
      deliveryDateReview: 'Warning meaning: A delivery date hint exists, but CLEVER could not safely parse or verify it. Review the order metadata and choose the route date.',
      deliveryDayUnclear: 'Warning meaning: Delivery day metadata exists, but it is ambiguous or does not match the resolved date. Review the date before route planning.',
      deliveryTimeUnclear: 'Warning meaning: Delivery time metadata exists, but the delivery window is ambiguous or unparsed. Review the time window before route planning.',
      metadataReview: 'Warning meaning: Required delivery metadata is incomplete or inconsistent. Open Detail and fix the highlighted fields.',
      missingAddress: 'Warning meaning: The destination address is missing or incomplete. Enter enough address detail before geocoding.',
      missingCoordinates: 'Warning meaning: The address has not been converted to map coordinates yet. Use Bulk geocode while the row is still eligible for automatic geocoding.',
      missingDeliveryDate: 'Warning meaning: No delivery date value was found. Enter the route date manually.',
      missingDeliveryRouteScope: 'Warning meaning: Delivery service/session metadata is missing, so CLEVER cannot choose the route scope.',
      notRouteEligible: 'Warning meaning: The order still has route-planning blockers. Review the order constraints before adding it to a route.'
    },
    geocodeMessages: {
      blankAddress: 'Address is missing or incomplete',
      noResult: 'use bulk geocode',
      rateLimited: 'Geocoder is rate limited; try bulk geocode later',
      timeout: 'Geocoder timed out',
      providerFailed: 'Geocoder provider failed',
      notConfigured: 'Geocoder is not configured',
      invalidResult: 'Geocoder returned an invalid result'
    },
    editableHelp: {
      deliveryDate: 'Enter the route date as YYYY-MM-DD, for example 2026-05-29.',
      serviceType(values: string, example: string): string { return `Allowed values: ${values}. Example: ${example}`; },
      deliverySession(values: string, example: string): string { return `Allowed values: ${values}. Example: ${example}`; },
      timeWindow(help: string, example: string): string { return `${help} Example: ${example}.`; }
    }
  },
  'ko-KR': {
    title: '주문',
    mapTitle: '주문 지도',
    mapSubtitle: '현재 필터 기준으로 가져온 WooCommerce 하차지',
    modeLabel: '주문 모드',
    statusTabsLabel: '주문 상태 탭',
    planning: '계획',
    history: '기록',
    all: '전체',
    unplanned: '미배정',
    planned: '배정됨',
    needsReview: '리뷰 필요',
    filtersEyebrow: '필터',
    filtersTitle: '주문 필터',
    clearFilters: '필터 초기화',
    deliveryDate: '배송 날짜',
    areaPlaceholder: '예: Toronto',
    areaRegion: '지역 / 구역',
    deliveryStatus: '배송 상태',
    serviceType: '서비스 타입',
    deliverySession: '배송 세션',
    search: '검색',
    searchPlaceholder: '#1001, 이메일, 전화번호',
    allOption: '전체',
    ready: '준비됨',
    completed: '완료됨',
    normal: '정상',
    newRoute: '새 경로',
    addPlan: '계획 추가',
    addPlanPanelLabel: '새 경로 계획 추가',
    routeDetailPanelLabel: '선택된 경로 상세',
    orders: '주문',
    planInstructions: '지도나 주문 목록에서 준비된 미배정 주문을 추가한 뒤 경로를 생성하세요.',
    routeDetailInstructions: '지도에서 선택한 배정 완료 경로입니다. 여기서 하차 순서를 확인하거나 Route Builder에서 편집하세요.',
    editRoute: '경로 편집',
    loadingRoute: '경로를 불러오는 중…',
    noRouteDetail: '경로 상세를 사용할 수 없습니다.',
    routeStatus: '경로 상태',
    routeStopsLabel: '경로 하차 순서',
    routeDate: '경로 날짜',
    routeName: '경로 이름',
    defaultRouteName(date: string): string { return `경로 ${date}`; },
    createRoute: '경로 생성',
    clearPlan: '계획 비우기',
    addPlanOrdersLabel: '계획에 추가된 주문',
    planEmpty: '계획이 비어 있습니다.',
    recipientFallback: '수령인',
    areaFallback: '지역',
    dateFallback: '날짜',
    tableEyebrow: '주문',
    tableTitle: '가져온 주문 목록',
    diagnosticMetadata: '주문 메타데이터',
    selectedSummary(selected: number, selectable: number, unavailable: number): string { return `${selected}개 선택 · ${selectable}개 선택 가능 · ${unavailable}개 불가`; },
    updating: '업데이트 중…',
    wooSyncing: 'Woo 동기화 중…',
    wooSync: 'Woo 동기화',
    bulkGeocoding: '일괄 좌표 변환 중…',
    bulkGeocode: '일괄 좌표 변환',
    unavailablePrefix: '사용 불가:',
    loadingOrders: '가져온 WooCommerce 주문을 불러오는 중…',
    noOrders: '현재 필터와 일치하는 주문이 없습니다.',
    selectAllEligible: '현재 작업 목록의 선택 가능한 주문 전체 선택',
    columns: {
      select: '선택',
      order: '주문',
      customer: '고객',
      method: '방식',
      day: '요일',
      area: '지역',
      route: '경로',
      status: '상태',
      actions: '작업'
    },
    review: '리뷰',
    detail: '상세',
    add: '추가',
    remove: '제거',
    selectOrder(label: string): string { return `${label} 주문 선택`; },
    planOrderAction(action: 'Add' | 'Remove', label: string): string { return action === 'Remove' ? `${label} 주문을 경로 계획에서 제거` : `${label} 주문을 경로 계획에 추가`; },
    detailToggle(expanded: boolean, label: string): string { return `${label} 주문 상세 ${expanded ? '숨기기' : '보기'}`; },
    routeConstraintFallback: '경로 조건 확인 필요',
    createRouteReadyOnly: '경로 생성은 준비된 미배정 주문만 사용할 수 있습니다. 사용할 수 없는 주문을 계획에서 제거하세요.',
    selectRouteReady: '배송 날짜가 있는 경로 준비 주문을 선택하세요.',
    orderUnavailable(reasons: string): string { return `이 주문은 현재 계획에 사용할 수 없습니다: ${reasons}.`; },
    detailEyebrow: '상세',
    detailsFor(orderName: string): string { return `${orderName} 주문 상세`; },
    editAllFields: '전체 필드 수정',
    close: '닫기',
    fieldsToFix: '수정할 필드',
    orderReadiness: '주문 준비 상태',
    orderSummary: '주문 요약',
    repairInstruction: '강조된 필드를 수정한 뒤 이 주문을 저장하세요.',
    noFixes: '이 주문에 필요한 수정 사항이 없습니다.',
    currentBlockers: '현재 차단 사유',
    saving: '저장 중…',
    saveFixes: '수정 저장',
    destination: '배송지',
    coordinates: '좌표',
    delivery: '배송',
    payment: '결제',
    paymentEvidence: 'Woo 증거',
    paymentMethod: '방식',
    paymentStatus: '상태',
    paymentReason: '사유',
    paymentPaidAt: '결제 확인',
    paymentTransaction: '거래',
    paymentUnavailable: '결제 정보 없음',
    date: '날짜',
    area: '지역',
    service: '서비스',
    window: '시간대',
    required: '필수',
    reviewIfRequired: '필요 시 확인',
    editAllOrderFields: '주문 필드 전체 수정',
    save: '저장',
    cancel: '취소',
    technicalDiagnostics: '기술 진단',
    loadingDetail: '주문 상세를 불러오는 중…',
    noDiagnostics: '저장된 상세 진단이 아직 없습니다.',
    diagnosticsStatus: '상태',
    matchedMappingPaths: '매칭된 매핑 경로',
    fieldHelp(label: string): string { return `${label} 도움말`; },
    selectChoice(label: string): string { return `${label} 선택`; },
    repairTitles: {
      aggregate: '필수 주문 정보 수정',
      addressReview: '배송지 주소 확인',
      deliveryDate: '배송 날짜 필요',
      deliveryDateReview: '배송 날짜 확인',
      deliveryArea: '배송 지역 필요',
      routeScope: '경로 범위 필요',
      timeWindow: '시간대 확인 필요',
      address: '배송지 주소 필요',
      fallback: '필수 필드 수정'
    },
    addressRequired: '주소 필요',
    coordinatesReady: '지도에 표시 가능',
    coordinatesNeeded: '좌표 필요',
    useBulkGeocodeFromList: '주문 목록의 일괄 좌표 변환을 사용하세요.',
    enterAddressBeforeGeocoding: '좌표 변환 전에 충분한 배송지 정보를 입력하세요.',
    routeDraft: {
      selectReady: '배송 날짜와 경로 범위가 있는 준비 주문을 선택하세요.',
      onlySameScope: '배송 날짜와 배송 세션이 같은 주문만 계획에 추가했습니다.',
      dateMustMatch: '경로 날짜는 선택한 주문의 배송 날짜와 같아야 합니다.',
      selectedMustShareScope: '선택한 주문은 배송 날짜와 배송 세션이 같아야 합니다.'
    },
    bulkStatus: {
      matched: '일치',
      attempted: '시도',
      resolved: '해결',
      failed: '실패',
      noAddress: '주소 없음',
      skippedByPolicy: '정책으로 건너뜀',
      alreadyHadCoordinates: '기존 좌표 있음',
      policyReached(limit: number | string): string { return ` 공개 지오코더 한도에 도달했습니다(${limit}회 시도).`; }
    },
    wooSyncStatus: {
      queued: '대기 중',
      running: '진행 중',
      succeeded: '완료',
      failed: '실패',
      summary(status: string, counts: { created: number; needsReview: number; readyToPlan: number; received: number; updated: number }): string {
        return `최근 Woo 동기화 ${status}: ${counts.received}건 수신, ${counts.created}건 생성, ${counts.updated}건 업데이트, ${counts.readyToPlan}건 메타데이터 준비, ${counts.needsReview}건 메타데이터 검토 필요.`;
      }
    },
    statusLabels: {
      planned: '배정됨',
      addressReview: '주소 확인',
      deliveryDateReview: '배송 날짜 확인',
      missingDeliveryDate: '배송 날짜 누락',
      missingDeliveryArea: '배송 지역 누락',
      missingRouteScope: '경로 범위 누락',
      deliveryDayUnclear: '배송 요일 불명확',
      missingTimeWindow: '시간대 누락',
      deliveryTimeUnclear: '배송 시간 불명확',
      needCoordinates: '좌표 필요',
      missingAddress: '주소 누락',
      metadataReview: '메타데이터 리뷰',
      ready: '준비됨',
      notRouteEligible: '경로 배정 불가',
      alreadyPlanned: '이미 배정됨',
      routeEligible: '경로 배정 가능',
      needsMetadata: '메타데이터 필요',
      needAddress: '주소 필요'
    },
    paymentStatusLabels: {
      PAID_CONFIRMED: '결제 확인됨',
      CASH_COLLECT_REQUIRED: '현금 수금 필요',
      TRANSFER_CHECK_PENDING: '송금 확인 대기',
      ONLINE_PAYMENT_PENDING_OR_FAILED: '온라인 결제 대기/실패',
      NOT_DELIVERABLE_OR_EXCEPTION: '결제 예외',
      UNKNOWN_REVIEW: '결제 확인 필요'
    },
    statusDetails: {
      useBulkGeocode: '일괄 좌표 변환 사용',
      verifyAddress: '주소 확인',
      verifyDeliveryDate: '배송 날짜 확인',
      enterDeliveryDate: '배송 날짜 입력',
      enterAddressOrCoordinates: '주소 또는 좌표 입력',
      reviewRouteConstraints: '경로 조건 확인 필요'
    },
    statusMeanings: {
      addressReview: '경고 의미: 일괄 좌표 변환이 가능한 주소 조합을 이미 시도했지만 신뢰 가능한 좌표를 찾지 못했습니다. 배송지 주소를 수동으로 확인하거나 수정하세요.',
      deliveryDateReview: '경고 의미: 배송 날짜 단서는 있지만 CLEVER가 안전하게 파싱하거나 검증하지 못했습니다. 주문 메타데이터를 확인하고 경로 날짜를 선택하세요.',
      deliveryDayUnclear: '경고 의미: 배송 요일 메타데이터는 있지만 모호하거나 확정된 날짜와 맞지 않습니다. 경로 계획 전에 날짜를 확인하세요.',
      deliveryTimeUnclear: '경고 의미: 배송 시간 메타데이터는 있지만 시간대가 모호하거나 파싱되지 않았습니다. 경로 계획 전에 시간대를 확인하세요.',
      metadataReview: '경고 의미: 필요한 배송 메타데이터가 비어 있거나 일관되지 않습니다. Detail을 열고 강조된 필드를 수정하세요.',
      missingAddress: '경고 의미: 배송지 주소가 없거나 불완전합니다. 좌표 변환 전에 충분한 주소 정보를 입력하세요.',
      missingCoordinates: '경고 의미: 주소가 아직 지도 좌표로 변환되지 않았습니다. 자동 좌표 변환 대상인 동안 Bulk geocode를 사용하세요.',
      missingDeliveryDate: '경고 의미: 배송 날짜 값이 없습니다. 경로 날짜를 수동으로 입력하세요.',
      missingDeliveryRouteScope: '경고 의미: 배송 서비스/세션 메타데이터가 없어 CLEVER가 경로 범위를 선택할 수 없습니다.',
      notRouteEligible: '경고 의미: 경로 계획 차단 사유가 아직 남아 있습니다. 경로에 추가하기 전에 주문 조건을 확인하세요.'
    },
    geocodeMessages: {
      blankAddress: '주소가 없거나 불완전합니다',
      noResult: '일괄 좌표 변환 사용',
      rateLimited: '지오코더 사용량이 제한되었습니다. 나중에 일괄 좌표 변환을 다시 시도하세요',
      timeout: '지오코더 응답 시간이 초과되었습니다',
      providerFailed: '지오코더 제공자 요청에 실패했습니다',
      notConfigured: '지오코더가 설정되지 않았습니다',
      invalidResult: '지오코더가 잘못된 결과를 반환했습니다'
    },
    editableHelp: {
      deliveryDate: '경로 날짜를 YYYY-MM-DD 형식으로 입력하세요. 예: 2026-05-29.',
      serviceType(values: string, example: string): string { return `허용 값: ${values}. 예: ${example}`; },
      deliverySession(values: string, example: string): string { return `허용 값: ${values}. 예: ${example}`; },
      timeWindow(help: string, example: string): string { return `${help} 예: ${example}.`; }
    }
  }
} as const;

export const settingsCopy = {
  'en-CA': {
    settingsEyebrow: 'Settings',
    settingsTitle: 'Store settings',
    storeAddress: 'Store address',
    latitude: 'Latitude',
    longitude: 'Longitude',
    language: 'Language',
    english: 'English',
    korean: '한국어',
    saveSettings: 'Save settings',
    saving: 'Saving…',
    geocodeAndSave: 'Geocode & save coordinates',
    geocoding: 'Geocoding…',
    blankAddress: 'Enter a store address before geocoding.',
    saved: 'Settings saved.',
    remembered: 'Saved coordinates were reused from store settings.',
    geocodeSaved(latitude: number, longitude: number): string {
      return `Coordinates saved: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    },
    depotMapTitle: 'Depot map',
    depotMapSubtitle: 'Click the configured map to update the depot draft; manual fields remain authoritative.',
    providersEyebrow: 'Providers',
    providersTitle: 'Map/router status',
    mapProvider: 'Map provider',
    providerMode: 'Provider mode',
    routeGeometryProvider: 'Route geometry provider',
    noProviderSecrets: 'No provider secrets are displayed in the browser. Unconfigured mode never calls public tile/router hosts.',
    none: 'none',
    configured: 'configured',
    notConfigured: 'not configured',
    publicAllowlisted: 'public allowlisted',
    selfHosted: 'self-hosted',
    depot: 'Depot',
    defaultDepot: 'Default depot',
    routeScopeEyebrow: 'Route scope',
    routeScopeTitle: 'Service and session values',
    routeScopeDescription: 'Configure the values operators can use when repairing delivery metadata.',
    serviceTypes: 'Service types',
    deliverySessions: 'Delivery sessions',
    routeScopeValue: 'Value',
    routeScopeLabel: 'Label',
    routeScopeDescriptionField: 'Description',
    routeScopeExample: 'Example',
    routeScopeEnabled: 'Enabled',
    addServiceType: 'Add service type',
    addDeliverySession: 'Add delivery session',
    customValue: 'Custom value',
    remove: 'Remove',
    builtIn: 'Built-in',
    timeWindowHelp: 'Time-window help',
    startExample: 'Start example',
    endExample: 'End example'
  },
  'ko-KR': {
    settingsEyebrow: '설정',
    settingsTitle: '매장 설정',
    storeAddress: '매장 주소',
    latitude: '위도',
    longitude: '경도',
    language: '언어',
    english: 'English',
    korean: '한국어',
    saveSettings: '설정 저장',
    saving: '저장 중…',
    geocodeAndSave: '주소로 좌표 저장',
    geocoding: '좌표 변환 중…',
    blankAddress: '좌표 변환 전에 매장 주소를 입력하세요.',
    saved: '설정을 저장했습니다.',
    remembered: '매장 설정에 저장된 좌표를 다시 사용했습니다.',
    geocodeSaved(latitude: number, longitude: number): string {
      return `좌표 저장 완료: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    },
    depotMapTitle: '출발지 지도',
    depotMapSubtitle: '지도를 클릭하면 출발지 초안 좌표가 바뀝니다. 직접 입력한 필드가 최종 기준입니다.',
    providersEyebrow: '제공자',
    providersTitle: '지도/경로 상태',
    mapProvider: '지도 제공자',
    providerMode: '제공자 모드',
    routeGeometryProvider: '경로 제공자',
    noProviderSecrets: '브라우저에는 제공자 비밀값을 표시하지 않습니다. 미설정 모드에서는 공개 지도/경로 호스트를 호출하지 않습니다.',
    none: '없음',
    configured: '설정됨',
    notConfigured: '설정 안 됨',
    publicAllowlisted: '허용된 공개 제공자',
    selfHosted: '자체 호스팅',
    depot: '출발지',
    defaultDepot: '기본 출발지',
    routeScopeEyebrow: '배송 범위',
    routeScopeTitle: '서비스/세션 값',
    routeScopeDescription: '배송 메타데이터를 수정할 때 사용할 수 있는 값을 설정합니다.',
    serviceTypes: '서비스 타입',
    deliverySessions: '배송 세션',
    routeScopeValue: '값',
    routeScopeLabel: '라벨',
    routeScopeDescriptionField: '설명',
    routeScopeExample: '예시',
    routeScopeEnabled: '사용',
    addServiceType: '서비스 타입 추가',
    addDeliverySession: '배송 세션 추가',
    customValue: '사용자 값',
    remove: '삭제',
    builtIn: '기본값',
    timeWindowHelp: '시간대 도움말',
    startExample: '시작 예시',
    endExample: '종료 예시'
  }
} as const;

export const orderDetailLabelsByLocale = {
  'en-CA': {
    blockerReasons: {
      ambiguous_delivery_day: 'Delivery day unclear',
      ambiguous_delivery_time_window: 'Delivery time unclear',
      delivery_date_weekday_mismatch: 'Delivery day unclear',
      delivery_date_weekday_unverified: 'Delivery day unclear',
      delivery_day_unparsed: 'Delivery day unclear',
      delivery_time_window_unparsed: 'Delivery time unclear',
      missing_coordinates: 'Need coordinates',
      missing_delivery_area: 'Missing delivery area',
      missing_delivery_date: 'Missing delivery date',
      missing_route_scope: 'Missing route scope',
      missing_time_window: 'Missing time window',
    },
    diagnosticPaths: {
      'line_items[0].name': 'Ordered items',
      'meta_data._tomatono_delivery_day': 'Delivery day',
      'meta_data._tomatono_fulfillment_type': 'Fulfillment type',
      'meta_data._tomatono_order_type': 'Order type',
      'shipping_lines[0].method_title': 'Shipping method',
    },
    geocodeStatus: {
      FAILED: 'Geocode failed',
      NOT_REQUIRED: 'Coordinates not required',
      PENDING: 'Awaiting geocode',
      RESOLVED: 'Coordinates available',
    },
  },
  'ko-KR': {
    blockerReasons: {
      ambiguous_delivery_day: '배송 요일 불명확',
      ambiguous_delivery_time_window: '배송 시간 불명확',
      delivery_date_weekday_mismatch: '배송 요일 불명확',
      delivery_date_weekday_unverified: '배송 요일 불명확',
      delivery_day_unparsed: '배송 요일 불명확',
      delivery_time_window_unparsed: '배송 시간 불명확',
      missing_coordinates: '좌표 필요',
      missing_delivery_area: '배송 지역 누락',
      missing_delivery_date: '배송 날짜 누락',
      missing_route_scope: '경로 범위 누락',
      missing_time_window: '시간대 누락',
    },
    diagnosticPaths: {
      'line_items[0].name': '주문 상품',
      'meta_data._tomatono_delivery_day': '배송 요일',
      'meta_data._tomatono_fulfillment_type': '처리 유형',
      'meta_data._tomatono_order_type': '주문 유형',
      'shipping_lines[0].method_title': '배송 방식',
    },
    geocodeStatus: {
      FAILED: '좌표 변환 실패',
      NOT_REQUIRED: '좌표 필요 없음',
      PENDING: '좌표 변환 대기',
      RESOLVED: '좌표 있음',
    },
  }
} as const;

export const orderDetailLabels = orderDetailLabelsByLocale['en-CA'];
export const orderBlockerLabels = orderDetailLabels.blockerReasons;

export const orderFieldLabelsByLocale = {
  'en-CA': {
    ...orderDetailLabelsByLocale['en-CA'].diagnosticPaths,
    address1: 'Street address',
    address2: 'Address line 2',
    city: 'City',
    countryCode: 'Country',
    deliveryArea: 'Delivery area',
    deliveryDate: 'Delivery date',
    deliverySession: 'Delivery session',
    postalCode: 'Postal code',
    province: 'Province/region',
    serviceType: 'Service type',
    timeWindowEnd: 'Time window end',
    timeWindowStart: 'Time window start',
  },
  'ko-KR': {
    ...orderDetailLabelsByLocale['ko-KR'].diagnosticPaths,
    address1: '도로명 주소',
    address2: '상세 주소',
    city: '도시',
    countryCode: '국가',
    deliveryArea: '배송 지역',
    deliveryDate: '배송 날짜',
    deliverySession: '배송 세션',
    postalCode: '우편번호',
    province: '주/지역',
    serviceType: '서비스 타입',
    timeWindowEnd: '시간대 종료',
    timeWindowStart: '시간대 시작',
  }
} as const;

export const orderFieldLabels = orderFieldLabelsByLocale['en-CA'];

export function getAppCopy(locale: string | null | undefined): (typeof appCopy)[AppLocale] {
  return appCopy[resolveLocale(locale)];
}

export function getDashboardCopy(locale: string | null | undefined): (typeof dashboardCopy)[AppLocale] {
  return dashboardCopy[resolveLocale(locale)];
}

export function getDriversCopy(locale: string | null | undefined): (typeof driversCopy)[AppLocale] {
  return driversCopy[resolveLocale(locale)];
}

export function getRoutesCopy(locale: string | null | undefined): (typeof routesCopy)[AppLocale] {
  return routesCopy[resolveLocale(locale)];
}

export function getMapCopy(locale: string | null | undefined): (typeof mapCopy)[AppLocale] {
  return mapCopy[resolveLocale(locale)];
}

export function getStateCopy(locale: string | null | undefined): (typeof stateCopy)[AppLocale] {
  return stateCopy[resolveLocale(locale)];
}

export function getOrdersCopy(locale: string | null | undefined): (typeof ordersCopy)[AppLocale] {
  return ordersCopy[resolveLocale(locale)];
}

export function getOrderDetailLabels(locale: string | null | undefined): (typeof orderDetailLabelsByLocale)[AppLocale] {
  return orderDetailLabelsByLocale[resolveLocale(locale)];
}

export function getOrderFieldLabels(locale: string | null | undefined): (typeof orderFieldLabelsByLocale)[AppLocale] {
  return orderFieldLabelsByLocale[resolveLocale(locale)];
}

export function getOrderBlockerLabels(locale: string | null | undefined): (typeof orderDetailLabelsByLocale)[AppLocale]['blockerReasons'] {
  return getOrderDetailLabels(locale).blockerReasons;
}
