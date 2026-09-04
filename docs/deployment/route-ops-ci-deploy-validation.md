# Route Ops Actions runbook

GitHub Actions에는 두 개의 진입점만 사용한다.

| Workflow | 용도 | 자동 실행 |
| --- | --- | --- |
| `CI` | 코드·배포 계약 검증 | `main` push, 문서 전용을 제외한 PR, 수동 full profile |
| `Route Ops operations` | 배포와 운영 조작 | 없음. 승인된 운영자가 수동 실행 |

## CI

`CI`는 한 runner에서 checkout과 Node setup을 한 번만 수행한다. 변경 분류 후 필요한
앱만 설치하고, Delivery API와 Route Ops Web도 각각 최대 한 번만 설치·빌드한다.
배포 workflow는 같은 SHA의 성공한 main CI를 확인하고 lint·typecheck·test를 다시
실행하지 않는다.

| Profile | 실행 조건 | 목표 wall time |
| --- | --- | ---: |
| hygiene | 문서 또는 비핵심 변경 | 2분 이내 |
| route geometry | OSRM geometry 전용 변경 | 6분 이내 |
| delivery API | API 변경 전체 테스트 | 12분 이내 |
| full | workflow, lockfile, 수동 full verify | 15분 이내 |

CI hard timeout은 20분이다. 목표 시간을 넘기면 같은 run을 반복하지 말고 해당 step의
install, test, disposable DB 시간을 확인한다.

수동 full profile:

```bash
gh workflow run CI --repo EVNSolution/clever-route-server --ref main
```

## Operations

`Route Ops operations`는 `route` 관문 뒤에 operation별 job branch가 있는 단일 흐름이다.
실행 화면에서 `route → deploy` 또는 `route → edge_caddy`처럼 선택된 경로가 보이며,
선택되지 않은 branch는 skipped로 종료된다. operation을 늘릴 때는 새 workflow를
만들지 말고 이 job graph에 branch를 추가한다.

GitHub의 `Route Ops operations`에서 `operation`을 먼저 선택한다. 다른 operation용
입력값은 기본값 그대로 둔다.

| operation | 목적 | 필수 입력 | 일반 실행 |
| --- | --- | --- | --- |
| `deploy` | 변경 image 배포 | `source_ref=main` | `publish_images=true`, `dry_run=false` |
| `edge_caddy` | Caddy 설정 검증·reload | 없음 | 먼저 `dry_run=true` |
| `backup_setup` | backup timer 설치·검증 | 없음 | 먼저 `dry_run=true` |
| `docker_cleanup` | 안전한 dangling image/cache 정리 | 없음 | 먼저 `dry_run=true` |
| `completion_evidence` | API runtime SHA의 read-only invariant 증거 | `source_ref`, `source_sha` | 배포 직후 |
| `alarm_canary` | 두 alarm의 실제 subscriber receipt 검증 | `source_sha` | mode 승격 전 |
| `invariant_mode` | OBSERVE/GUARDED/FULL 전환 | `source_sha`, 승격 시 artifact ID 2개 | evidence와 canary 이후 |

모든 operation은 main history, actor allowlist, AWS OIDC를 공통으로 한 번 검증한다.
동시에 두 operation을 실행하지 않으며, production lock을 사용하는 기존 스크립트의
fail-closed·rollback 계약은 그대로 유지한다.

### 일반 무마이그레이션 배포

```bash
gh workflow run "Route Ops operations" \
  --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=deploy \
  -f source_ref=main \
  -f channel_tag=prod \
  -f publish_images=true \
  -f dry_run=false \
  -f run_migrations=false \
  -f approve_dsv_migration=false \
  -f approve_production_baseline=false
```

Prisma 입력이 배포된 API revision 이후 변경되지 않았다면 이것이 Shopify/K-food를
포함한 기본 경로다. DSV 승인값이나 migration image를 요구하지 않는다.

Prisma 입력이 변경됐을 때만 `run_migrations=true`를 사용한다. 실제 배포에서는
`approve_dsv_migration=true`와 검토한 `restore_rehearsal_sha256`가 없으면
fail closed한다.

### 운영 dry-run

```bash
gh workflow run "Route Ops operations" \
  --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=docker_cleanup \
  -f dry_run=true
```

`operation`만 `edge_caddy` 또는 `backup_setup`으로 바꾸면 같은 방식으로
비파괴 검증을 실행한다.

### Route completion mode 승격

1. `operation=completion_evidence`, `source_ref=<API runtime SHA>`, `source_sha=<API runtime SHA>`
2. `operation=alarm_canary`, 같은 `source_sha`
3. 두 run의 artifact ID를 확인한다.
4. `operation=invariant_mode`, `target_mode=GUARDED` 또는 `FULL`,
   `evidence_artifact_id`, `alarm_receipt_artifact_id`를 입력한다.

`OBSERVE` 긴급 복귀는 별도 emergency actor allowlist를 계속 요구한다.

`source_ref`는 checkout할 main history ref이며 `source_sha`와 동일해야 한다. 배포에서
`publish_images=false`로 기존 image를 재사용했다면 `current-image.env`의
`API_RUNTIME_REVISION`을 두 입력에 사용한다. workflow-only coordinator SHA와 실제
컨테이너 revision이 다를 때는 runtime revision을 증거 기준으로 삼는다.

## 시간 기준

| Operation | 목표 wall time | hard timeout |
| --- | ---: | ---: |
| dry-run maintenance | 5분 이내 | 35분 |
| API-only deploy | 10분 이내 | 35분 |
| API + Web image deploy | 20분 이내 | 35분 |
| migration 포함 deploy | 30분 이내 | 35분 |

목표 시간을 넘겼다고 새 run을 중복 실행하지 않는다. 현재 run의 image build, SSM
command, health/rollback step을 확인하고 종료 상태를 확정한다.
