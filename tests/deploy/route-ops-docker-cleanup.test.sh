#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

python3 - <<'PY'
import re
from pathlib import Path

worker = Path('scripts/route-ops-docker-cleanup.sh').read_text()
wrapper = Path('scripts/ssm-route-ops-docker-cleanup.sh').read_text()
deploy = Path('scripts/ssm-simple-route-ops-deploy.sh').read_text()
workflow = Path('.github/workflows/route-ops-operations.yml').read_text()
compose = Path('infra/compose/docker-compose.prod.yml').read_text()


def service_block(name):
    block, inside = [], False
    for line in compose.splitlines():
        if line == f'  {name}:':
            inside = True
        elif inside and re.match(r'^ {0,2}\S', line):
            break
        if inside:
            block.append(line)
    return '\n'.join(block)


anchor = re.search(r'^x-route-ops-logging: &route-ops-logging\n((?:[ \t]+.*\n|\n)+)', compose, re.M)
anchor_text = anchor.group(1) if anchor else ''


def bounded_log(name):
    block = service_block(name)
    return 'max-size:' in block or ('logging: *route-ops-logging' in block and 'max-size:' in anchor_text)


checks = {
    'worker_is_dangling_only': 'docker image prune --force --filter "until=$IMAGE_MAX_AGE"' in worker,
    'worker_prunes_old_build_cache': 'docker builder prune --force --filter "until=$BUILD_CACHE_MAX_AGE" --reserved-space "$BUILD_CACHE_RESERVED_SPACE"' in worker,
    'worker_has_20gb_and_20pct_guard': 'MIN_FREE_MB="${ROUTE_OPS_DOCKER_MIN_FREE_MB:-20480}"' in worker and 'MIN_FREE_PERCENT="${ROUTE_OPS_DOCKER_MIN_FREE_PERCENT:-20}"' in worker,
    'worker_cleans_before_enforcing_actual_capacity': 'check_capacity before "$DRY_RUN"' in worker and 'check_capacity after 1' in worker,
    'worker_supports_dry_run': '--dry-run' in worker and 'cleanup dry-run complete; no Docker data was removed' in worker,
    'worker_checks_running_set': 'running-containers.before' in worker and 'running-containers.after' in worker and 'diff -u' in worker,
    'worker_never_prunes_unsafe_objects': all(snippet not in worker for snippet in [
        'docker system prune', 'docker container prune', 'docker volume prune', 'docker network prune',
        'docker image prune -a', 'docker image prune --all',
    ]),
    'worker_removes_release_images_by_id_without_force': 'docker image rm "$id"' in worker and all(
        snippet not in worker for snippet in ['image rm -f', 'image rm --force', 'rmi -f', 'rmi --force']
    ),
    'worker_documents_release_retention_knobs': all(name in worker for name in [
        'ROUTE_OPS_DOCKER_RELEASE_REPOS', 'ROUTE_OPS_DOCKER_PIN_FILES',
        'ROUTE_OPS_DOCKER_RELEASE_KEEP', 'ROUTE_OPS_DOCKER_RELEASE_MIN_AGE',
    ]),
    'wrapper_uses_ssm': 'aws ssm send-command' in wrapper and 'AWS-RunShellScript' in wrapper,
    'wrapper_embeds_worker': 'DOCKER_CLEANUP_SCRIPT_B64' in wrapper and 'route-ops-docker-cleanup.sh' in wrapper,
    'deploy_runs_cleanup_before_pull': deploy.index('route-ops-docker-cleanup.sh --enforce') < deploy.index('pull clever-route-api vroom vroom-korea'),
    'deploy_runs_cleanup_after_promotion': deploy.rindex('route-ops-docker-cleanup.sh --enforce') > deploy.index('cp .deploy/simple-candidate-image.env .deploy/current-image.env'),
    'deploy_dry_run_is_non_mutating': 'route-ops-docker-cleanup.sh --dry-run --enforce' in deploy,
    'workflow_has_dry_run_default': 'default: true' in workflow and 'scripts/ssm-route-ops-docker-cleanup.sh --dry-run' in workflow and "needs.route.outputs.operation == 'docker_cleanup'" in workflow,
    'workflow_uses_oidc': 'id-token: write' in workflow and 'aws-actions/configure-aws-credentials@' in workflow,
    'workflow_requires_main_history': 'git merge-base --is-ancestor HEAD origin/main' in workflow,
    'compose_defines_bounded_json_file_log_anchor': 'driver: json-file' in anchor_text and 'max-size:' in anchor_text and 'max-file:' in anchor_text,
    'compose_bounds_osrm_ontario_log': bounded_log('osrm-ontario'),
    'compose_bounds_osrm_korea_log': bounded_log('osrm-korea'),
    'compose_keeps_api_awslogs_block': 'driver: awslogs' in service_block('clever-route-api') and 'route-ops-logging' not in service_block('clever-route-api'),
}

missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected Docker cleanup guard(s): {missing}')
print('{"ok":true,"worker":"scripts/route-ops-docker-cleanup.sh"}')
PY

# ---------------------------------------------------------------------------
# Behaviour: run the real worker against a stub docker. No Docker daemon is used.
# ---------------------------------------------------------------------------
worker="$ROOT/scripts/route-ops-docker-cleanup.sh"
bash -n "$worker"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-docker-cleanup-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

fail() {
  echo "route-ops-docker-cleanup.test: $*" >&2
  exit 1
}

# The stub keeps its state in $FAKE_DOCKER_DIR:
#   images.db       id|created|size|tags|digests   (the worker's `image inspect` format)
#   containers.tsv  container id <TAB> image id <TAB> state
#   running.tsv     container id <TAB> image ref   (running containers only)
#   rm-fail.txt     image ids whose `image rm` must fail
#   calls.log       every docker call, rm.log every `image rm`
cat > "$tmp/bin/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
dir="${FAKE_DOCKER_DIR:?FAKE_DOCKER_DIR is required}"
printf '%s\n' "$*" >> "$dir/calls.log"
image_format='{{.Id}}|{{.Created}}|{{.Size}}|{{range .RepoTags}}{{.}} {{end}}|{{range .RepoDigests}}{{.}} {{end}}'
case "${1:-} ${2:-}" in
  'info ') ;;
  'info --format') printf '%s\n' "$dir/root" ;;
  'ps --no-trunc') cat "$dir/running.tsv" ;;
  'ps -a') cut -f1 "$dir/containers.tsv" ;;
  'inspect --type')
    if [ "${FAKE_DOCKER_FAIL:-}" = inspect ]; then echo 'Error: daemon unavailable' >&2; exit 1; fi
    if [ "${3:-}" != container ] || [ "${4:-}" != --format ] || [ "${5:-}" != '{{.Image}}' ]; then
      echo "unexpected docker inspect: $*" >&2; exit 1
    fi
    shift 5
    for id in "$@"; do
      awk -F'\t' -v id="$id" '$1 == id { print $2; found = 1 } END { exit found ? 0 : 1 }' "$dir/containers.tsv" \
        || { echo "Error: No such object: $id" >&2; exit 1; }
    done
    ;;
  'image ls')
    case "$*" in
      *dangling=true*) awk -F'|' '$4 ~ /^ *$/ && $5 ~ /^ *$/ { print $1 }' "$dir/images.db" ;;
      *) awk -F'|' '{ n = split($4, t, " "); if (n < 1) n = 1; for (i = 0; i < n; i++) print $1 }' "$dir/images.db" ;;
    esac
    ;;
  'image inspect')
    if [ "${3:-}" != --format ] || [ "${4:-}" != "$image_format" ]; then
      echo "unexpected docker image inspect: $*" >&2; exit 1
    fi
    shift 4
    for id in "$@"; do
      awk -F'|' -v id="$id" '$1 == id { print; found = 1 } END { exit found ? 0 : 1 }' "$dir/images.db" \
        || { echo "Error: No such image: $id" >&2; exit 1; }
    done
    ;;
  'image prune'|'builder prune') echo 'Total reclaimed space: 0B' ;;
  'system df') printf 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE\nImages 1 1 1GB 0B\n' ;;
  'image rm')
    printf '%s\n' "$*" >> "$dir/rm.log"
    if [ "$#" -ne 3 ]; then echo "unexpected docker image rm: $*" >&2; exit 1; fi
    if [ -f "$dir/rm-fail.txt" ] && grep -Fxq "$3" "$dir/rm-fail.txt"; then
      echo "Error response from daemon: conflict: unable to delete $3 (must be forced)" >&2
      exit 1
    fi
    awk -F'|' -v id="$3" '$1 != id' "$dir/images.db" > "$dir/images.db.new"
    mv "$dir/images.db.new" "$dir/images.db"
    printf 'Deleted: %s\n' "$3"
    ;;
  *) echo "unexpected docker command: $*" >&2; exit 1 ;;
esac
EOF_DOCKER
chmod +x "$tmp/bin/docker"

api_repo=ghcr.io/evnsolution/clever-route-server-delivery-api
migration_repo=ghcr.io/evnsolution/clever-route-server-delivery-api-migration
static_repo=ghcr.io/evnsolution/clever-route-server-route-ops-web-static

image_id() { printf 'sha256:%064x' "$1"; }
digest_of() { printf 'sha256:%064x' "$(($1 + 5000))"; }
iso_ago() {
  date -u -d "-$1 hours" '+%Y-%m-%dT%H:%M:%S.123456789Z' 2>/dev/null \
    || date -u -v-"$1"H '+%Y-%m-%dT%H:%M:%S.123456789Z'
}

# The containerd image store (Docker 29 on the production host) also lists repo@sha256:... references in
# RepoTags; the classic store does not. Every behaviour case runs in both modes (STORE_MODE).
STORE_MODE=classic

new_case() {
  local dir="$tmp/$STORE_MODE-$1"
  mkdir -p "$dir/root" "$dir/.deploy"
  : > "$dir/images.db"
  : > "$dir/containers.tsv"
  : > "$dir/running.tsv"
  : > "$dir/calls.log"
  # Production layout: the worker runs from .deploy, next to the pin files.
  cp "$worker" "$dir/.deploy/route-ops-docker-cleanup.sh"
  chmod 0750 "$dir/.deploy/route-ops-docker-cleanup.sh"
  printf '%s\n' "$dir"
}

# add_image DIR N HOURS_OLD REPO [TAG...]: a digest-only image when no TAG is given.
add_image() {
  local dir="$1" n="$2" hours="$3" repo="$4" tags="" tag
  shift 4
  for tag in "$@"; do tags="$tags$repo:$tag "; done
  if [ "$STORE_MODE" = containerd ]; then tags="$tags$repo@$(digest_of "$n") "; fi
  printf '%s|%s|838860800|%s|%s@%s \n' \
    "$(image_id "$n")" "$(iso_ago "$hours")" "$tags" "$repo" "$(digest_of "$n")" >> "$dir/images.db"
}

add_dangling() {
  printf '%s|%s|1048576||\n' "$(image_id "$2")" "$(iso_ago "$3")" >> "$1/images.db"
}

# add_container DIR N IMAGE_N running|exited
add_container() {
  local dir="$1" n="$2" image_n="$3" state="$4" cid
  cid="$(printf '%064x' "$((n + 9000))")"
  printf '%s\t%s\t%s\n' "$cid" "$(image_id "$image_n")" "$state" >> "$dir/containers.tsv"
  if [ "$state" = running ]; then
    printf '%s\t%s\n' "$cid" "image-ref-$image_n" >> "$dir/running.tsv"
  fi
}

# run_worker DIR [WORKER ARGS...]: output in DIR/out.txt, exit status in DIR/status.
run_worker() {
  local dir="$1"
  shift
  set +e
  env PATH="$tmp/bin:$PATH" FAKE_DOCKER_DIR="$dir" \
    ROUTE_OPS_DOCKER_MIN_FREE_MB="${ROUTE_OPS_DOCKER_MIN_FREE_MB:-0}" \
    ROUTE_OPS_DOCKER_MIN_FREE_PERCENT="${ROUTE_OPS_DOCKER_MIN_FREE_PERCENT:-0}" \
    "$dir/.deploy/route-ops-docker-cleanup.sh" "$@" > "$dir/out.txt" 2>&1
  echo "$?" > "$dir/status"
  set -e
}

expect_status() {
  [ "$(cat "$1/status")" = "$2" ] || fail "$3: expected exit $2, got $(cat "$1/status")$(printf '\n---\n'; cat "$1/out.txt")"
}

expect_out() {
  grep -Fq -- "$2" "$1/out.txt" || fail "$3: output is missing: $2$(printf '\n---\n'; cat "$1/out.txt")"
}

expect_no_out() {
  if grep -Fq -- "$2" "$1/out.txt"; then fail "$3: output must not contain: $2"; fi
}

# expect_rm_calls DIR N...: `image rm` was called for exactly these images, by id.
expect_rm_calls() {
  local dir="$1" expected actual
  shift
  expected="$(for n in "$@"; do printf '%s\n' "$(image_id "$n")"; done | sort)"
  actual=''
  if [ -f "$dir/rm.log" ]; then actual="$(sed -n 's/^image rm //p' "$dir/rm.log" | sort)"; fi
  [ "$actual" = "$expected" ] || fail "removed image mismatch in $(basename "$dir")
expected:
$expected
actual:
$actual
$(cat "$dir/out.txt")"
}

# Every case must keep these Docker call invariants.
expect_safe_calls() {
  local dir="$1"
  if grep -Eq '^image rm .*(-f|--force)' "$dir/calls.log"; then fail "$(basename "$dir"): image rm used force"; fi
  if grep -Eq '^image prune .*(-a|--all)( |$)' "$dir/calls.log"; then fail "$(basename "$dir"): image prune used --all"; fi
  if grep -Eq '^(system|container|volume|network) prune' "$dir/calls.log"; then fail "$(basename "$dir"): unsafe prune"; fi
  if [ -f "$dir/rm.log" ] && grep -Ev '^image rm sha256:[0-9a-f]{64}$' "$dir/rm.log" | grep -q .; then
    fail "$(basename "$dir"): image rm must take exactly one full image id"
  fi
}

build_main_case() {
  local dir
  dir="$(new_case "$1")"
  # delivery-api (oldest first); ages in hours
  add_image "$dir" 1 1680 "$api_repo"              # A: digest only, unused        -> removed
  add_image "$dir" 2 1320 "$api_repo" sha-b        # B: one tag, unused            -> removed
  add_image "$dir" 3 1080 "$api_repo"              # C: running container          -> kept
  add_image "$dir" 4 960 "$api_repo"               # D: stopped container          -> kept
  add_image "$dir" 5 840 "$api_repo"               # E: repo digest in pin file    -> kept
  add_image "$dir" 6 792 "$api_repo"               # E2: image id in pin file      -> kept
  add_image "$dir" 7 240 "$api_repo"               # F: 4th newest, unused         -> removed
  add_image "$dir" 8 144 "$api_repo"               # G: 3rd newest                 -> kept
  add_image "$dir" 9 96 "$api_repo"                # H: 2nd newest                 -> kept
  add_image "$dir" 10 24 "$api_repo"               # I: newest, also under 48h     -> kept
  # migration
  add_image "$dir" 11 720 "$migration_repo"        # M1: 4th newest, unused        -> removed
  add_image "$dir" 12 480 "$migration_repo"
  add_image "$dir" 13 240 "$migration_repo"
  add_image "$dir" 14 120 "$migration_repo"
  # route-ops-web-static
  add_image "$dir" 15 480 "$static_repo"           # S1: stopped one-shot container -> kept
  add_image "$dir" 16 120 "$static_repo"
  # other repositories and a dangling image are never touched here
  add_image "$dir" 17 4800 postgres 17-bookworm
  add_image "$dir" 18 2400 ghcr.io/project-osrm/osrm-backend latest
  add_dangling "$dir" 19 2400
  add_container "$dir" 1 3 running
  add_container "$dir" 2 4 exited
  add_container "$dir" 3 15 exited
  add_container "$dir" 4 17 running
  printf 'IMAGE_TAG=prod\nDELIVERY_API_IMAGE=%s@%s\nROUTE_OPS_WEB_STATIC_IMAGE=%s@%s\n' \
    "$api_repo" "$(digest_of 3)" "$static_repo" "$(digest_of 16)" > "$dir/.deploy/current-image.env"
  printf 'IMAGE_TAG=prod\nDELIVERY_API_IMAGE=%s@%s\n' "$api_repo" "$(digest_of 5)" > "$dir/.deploy/simple-rollback-image.env"
  printf 'PREVIOUS_DELIVERY_API_IMAGE_ID=%s\n' "$(image_id 6)" > "$dir/.deploy/previous-image.env"
  printf 'DELIVERY_API_IMAGE=%s@%s\n' "$api_repo" "$(digest_of 999)" > "$dir/.deploy/simple-candidate-image.env"
  printf '%s\n' "$dir"
}

for STORE_MODE in classic containerd; do
# 1. Real run: removes only unused, unpinned, old, not-newest-3 release images, by id, without force.
case_dir="$(build_main_case main)"
run_worker "$case_dir" --enforce
expect_status "$case_dir" 0 'real run'
expect_rm_calls "$case_dir" 1 2 7 11
expect_safe_calls "$case_dir"
expect_out "$case_dir" "release image removed: $(image_id 1) $api_repo" 'real run'
expect_out "$case_dir" 'release image prune: removed=4 kept=12 skipped=0' 'real run'
expect_out "$case_dir" 'docker cleanup complete; running containers unchanged' 'real run'
grep -Fxq 'image prune --force --filter until=168h' "$case_dir/calls.log" || fail 'real run: dangling image prune is missing'
grep -Eq '^builder prune --force --filter until=168h --reserved-space 4GB$' "$case_dir/calls.log" || fail 'real run: builder prune is missing'

# 2. --dry-run: lists the same candidates and deletes nothing.
case_dir="$(build_main_case dry-run)"
run_worker "$case_dir" --dry-run --enforce
expect_status "$case_dir" 0 'dry run'
[ ! -f "$case_dir/rm.log" ] || fail 'dry run: removed an image'
expect_safe_calls "$case_dir"
if grep -Eq '^(image|builder) prune' "$case_dir/calls.log"; then fail 'dry run: ran a prune'; fi
for n in 1 2 7 11; do
  grep -Eq "^release image prune candidate: $(image_id "$n") [^ ]+ [0-9T:.Z-]+ [0-9]+MB$" "$case_dir/out.txt" \
    || fail "dry run: candidate line is missing for image $n$(printf '\n---\n'; cat "$case_dir/out.txt")"
done
[ "$(grep -c '^release image prune candidate:' "$case_dir/out.txt")" = 4 ] || fail 'dry run: expected exactly 4 candidates'
expect_out "$case_dir" 'cleanup dry-run complete; no Docker data was removed' 'dry run'

# 3. Other repositories are never touched, even when old, unused and not newest.
case_dir="$(new_case foreign)"
add_image "$case_dir" 1 4800 postgres 17-bookworm
add_image "$case_dir" 2 2400 ghcr.io/project-osrm/osrm-backend latest
add_image "$case_dir" 3 2400 ghcr.io/vroom-project/vroom-docker
add_image "$case_dir" 4 2400 caddy 2-alpine
add_image "$case_dir" 5 2400 "$api_repo-debug" old          # name prefix of a release repository only
shared_digest_tag=''
if [ "$STORE_MODE" = containerd ]; then shared_digest_tag="$api_repo@$(digest_of 6) "; fi
printf '%s|%s|838860800|%s:shared registry.example.test/other:shared %s|%s@%s \n' \
  "$(image_id 6)" "$(iso_ago 2400)" "$api_repo" "$shared_digest_tag" "$api_repo" "$(digest_of 6)" >> "$case_dir/images.db"   # shared by two repositories
printf 'x\n' > "$case_dir/.deploy/current-image.env"
run_worker "$case_dir"
expect_status "$case_dir" 0 'foreign repositories'
expect_rm_calls "$case_dir"
expect_safe_calls "$case_dir"
expect_out "$case_dir" 'release image prune: removed=0 kept=0 skipped=1' 'foreign repositories'

# 4. An image with several tags cannot be removed without force: skip it, keep going.
case_dir="$(new_case multi-tag)"
add_image "$case_dir" 1 720 "$api_repo" one two                # unused, old, two tags -> skipped
add_image "$case_dir" 2 744 "$api_repo"                        # unused, old, digest only -> removed
add_image "$case_dir" 3 144 "$api_repo"
add_image "$case_dir" 4 120 "$api_repo"
add_image "$case_dir" 5 96 "$api_repo"
printf 'x\n' > "$case_dir/.deploy/current-image.env"
run_worker "$case_dir"
expect_status "$case_dir" 0 'multi-tag'
expect_rm_calls "$case_dir" 2
expect_safe_calls "$case_dir"
expect_out "$case_dir" "release image skipped: $(image_id 1) $api_repo" 'multi-tag'
expect_out "$case_dir" 'release image prune: removed=1 kept=3 skipped=1' 'multi-tag'

# 5. A failing image rm is logged and counted, and does not abort the run.
case_dir="$(new_case rm-fails)"
add_image "$case_dir" 1 720 "$api_repo"
add_image "$case_dir" 2 744 "$api_repo"
add_image "$case_dir" 3 144 "$api_repo"
add_image "$case_dir" 4 120 "$api_repo"
add_image "$case_dir" 5 96 "$api_repo"
printf 'x\n' > "$case_dir/.deploy/current-image.env"
image_id 2 > "$case_dir/rm-fail.txt"
run_worker "$case_dir" --enforce
expect_status "$case_dir" 0 'failing rm'
expect_rm_calls "$case_dir" 1 2
expect_safe_calls "$case_dir"
expect_out "$case_dir" "release image remove failed: $(image_id 2) $api_repo" 'failing rm'
expect_out "$case_dir" "release image removed: $(image_id 1) $api_repo" 'failing rm'
expect_out "$case_dir" 'release image prune: removed=1 kept=3 skipped=1' 'failing rm'
expect_out "$case_dir" 'docker cleanup complete; running containers unchanged' 'failing rm'

# 6. The minimum age protects a young image even when nothing else does; the d suffix works.
case_dir="$(new_case min-age)"
add_image "$case_dir" 1 3 "$api_repo"       # 3 hours old
add_image "$case_dir" 2 72 "$api_repo"      # 3 days old
printf 'x\n' > "$case_dir/.deploy/current-image.env"
ROUTE_OPS_DOCKER_RELEASE_KEEP=0 run_worker "$case_dir"
expect_status "$case_dir" 0 'min age 48h'
expect_rm_calls "$case_dir" 2
expect_out "$case_dir" "release image kept: $(image_id 1) $api_repo" 'min age 48h'
case_dir="$(new_case min-age-days)"
add_image "$case_dir" 1 3 "$api_repo"
add_image "$case_dir" 2 72 "$api_repo"
printf 'x\n' > "$case_dir/.deploy/current-image.env"
ROUTE_OPS_DOCKER_RELEASE_KEEP=0 ROUTE_OPS_DOCKER_RELEASE_MIN_AGE=4d run_worker "$case_dir"
expect_status "$case_dir" 0 'min age 4d'
expect_rm_calls "$case_dir"

# 7. The newest N are counted over all images of the repository, so a pinned image
#    takes one of the N slots and does not extend the window.
case_dir="$(new_case keep-two)"
add_image "$case_dir" 1 50 "$api_repo"      # newest, pinned
add_image "$case_dir" 2 60 "$api_repo"      # 2nd newest -> kept
add_image "$case_dir" 3 70 "$api_repo"      # unused, outside the newest 2 -> removed
add_image "$case_dir" 4 80 "$api_repo"      # unused, outside the newest 2 -> removed
printf 'DELIVERY_API_IMAGE=%s@%s\n' "$api_repo" "$(digest_of 1)" > "$case_dir/.deploy/current-image.env"
ROUTE_OPS_DOCKER_RELEASE_KEEP=2 run_worker "$case_dir"
expect_status "$case_dir" 0 'keep two'
expect_rm_calls "$case_dir" 3 4

# 8. Nothing is removed when Docker cannot list container images or no pin file exists.
case_dir="$(build_main_case inspect-fails)"
FAKE_DOCKER_FAIL=inspect run_worker "$case_dir"
expect_status "$case_dir" 0 'container inspect failure'
expect_rm_calls "$case_dir"
expect_out "$case_dir" 'release image prune skipped' 'container inspect failure'
case_dir="$(build_main_case no-pins)"
rm -f "$case_dir"/.deploy/*.env
run_worker "$case_dir"
expect_status "$case_dir" 0 'no pin files'
expect_rm_calls "$case_dir"
expect_out "$case_dir" 'release image prune skipped' 'no pin files'

# 9. Pin files and repositories can be overridden by environment. The override replaces
#    the default pin files, so E and E2 lose their pins; A is pinned by the custom file.
case_dir="$(build_main_case env-override)"
printf 'DELIVERY_API_IMAGE=%s@%s\n' "$api_repo" "$(digest_of 1)" > "$case_dir/custom-pins.env"
ROUTE_OPS_DOCKER_PIN_FILES="$case_dir/custom-pins.env $case_dir/missing.env" \
  ROUTE_OPS_DOCKER_RELEASE_REPOS="$api_repo" run_worker "$case_dir"
expect_status "$case_dir" 0 'env override'
expect_rm_calls "$case_dir" 2 5 6 7    # migration and static repositories are out of scope

# 10. Invalid knobs fail before Docker is used; capacity is still enforced after cleanup.
case_dir="$(build_main_case bad-age)"
ROUTE_OPS_DOCKER_RELEASE_MIN_AGE=48 run_worker "$case_dir"
expect_status "$case_dir" 65 'invalid min age'
[ ! -f "$case_dir/rm.log" ] || fail 'invalid min age: removed an image'
case_dir="$(build_main_case bad-keep)"
ROUTE_OPS_DOCKER_RELEASE_KEEP=three run_worker "$case_dir"
expect_status "$case_dir" 65 'invalid keep'
case_dir="$(build_main_case capacity)"
ROUTE_OPS_DOCKER_MIN_FREE_MB=999999999 run_worker "$case_dir" --enforce
expect_status "$case_dir" 65 'capacity after cleanup'
expect_out "$case_dir" 'insufficient Docker disk capacity' 'capacity after cleanup'
expect_rm_calls "$case_dir" 1 2 7 11
done

printf '{"ok":true,"worker":"%s","behaviour":"stub-docker"}\n' scripts/route-ops-docker-cleanup.sh
