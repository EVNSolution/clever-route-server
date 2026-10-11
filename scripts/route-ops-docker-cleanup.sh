#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
ENFORCE=0
IMAGE_MAX_AGE="${ROUTE_OPS_DOCKER_IMAGE_MAX_AGE:-168h}"
BUILD_CACHE_MAX_AGE="${ROUTE_OPS_DOCKER_BUILD_CACHE_MAX_AGE:-168h}"
BUILD_CACHE_RESERVED_SPACE="${ROUTE_OPS_DOCKER_BUILD_CACHE_RESERVED_SPACE:-4GB}"
MIN_FREE_MB="${ROUTE_OPS_DOCKER_MIN_FREE_MB:-20480}"
MIN_FREE_PERCENT="${ROUTE_OPS_DOCKER_MIN_FREE_PERCENT:-20}"
RELEASE_REPOS="${ROUTE_OPS_DOCKER_RELEASE_REPOS:-ghcr.io/evnsolution/clever-route-server-delivery-api ghcr.io/evnsolution/clever-route-server-delivery-api-migration ghcr.io/evnsolution/clever-route-server-route-ops-web-static}"
RELEASE_KEEP="${ROUTE_OPS_DOCKER_RELEASE_KEEP:-3}"
RELEASE_MIN_AGE="${ROUTE_OPS_DOCKER_RELEASE_MIN_AGE:-48h}"

usage() {
  cat <<'USAGE'
Usage: route-ops-docker-cleanup.sh [--dry-run] [--enforce]

Removes dangling images older than seven days, old Docker build cache, and
unused old Route Ops release images. It never removes containers, volumes, or
networks. It never forces an image removal.

A release image is removed by image ID only when every rule holds:
  - Its repository is in ROUTE_OPS_DOCKER_RELEASE_REPOS (space separated;
    default: the delivery-api, delivery-api-migration and route-ops-web-static
    repositories under ghcr.io/evnsolution/clever-route-server-*).
  - No container, running or stopped, uses it.
  - No pin file contains its image ID or one of its repo digests.
    ROUTE_OPS_DOCKER_PIN_FILES (space separated) replaces the default files
    current-image.env, simple-rollback-image.env, simple-candidate-image.env
    and previous-image.env in the directory of this script.
  - It is not among the newest ROUTE_OPS_DOCKER_RELEASE_KEEP images of its
    repository by creation time (default 3).
  - It is older than ROUTE_OPS_DOCKER_RELEASE_MIN_AGE (default 48h; use h or d).
  - It has at most one tag and one repository.
Images of other repositories are never touched.

  --dry-run  Report candidates and disk state without deleting anything.
  --enforce  Fail unless Docker storage has at least 20 GiB and 20% free.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --enforce) ENFORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "route-ops-docker-cleanup: $*" >&2; exit 65; }
[[ "$MIN_FREE_MB" =~ ^[0-9]+$ ]] || fail "ROUTE_OPS_DOCKER_MIN_FREE_MB must be an integer"
[[ "$MIN_FREE_PERCENT" =~ ^[0-9]+$ ]] || fail "ROUTE_OPS_DOCKER_MIN_FREE_PERCENT must be an integer"
[[ "$RELEASE_KEEP" =~ ^[0-9]+$ ]] || fail "ROUTE_OPS_DOCKER_RELEASE_KEEP must be an integer"
[[ "$RELEASE_MIN_AGE" =~ ^[0-9]+[hd]$ ]] || fail "ROUTE_OPS_DOCKER_RELEASE_MIN_AGE must be a number with an h or d suffix, for example 48h"
command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null || fail "Docker daemon is unavailable"

work_dir="$(mktemp -d /tmp/route-ops-docker-cleanup.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[ -d "$docker_root" ] || fail "Docker root directory does not exist: $docker_root"

disk_stats() {
  df -Pk "$docker_root" | awk 'NR == 2 {printf "%s %s %s\n", int($4 / 1024), int(($4 * 100) / $2), $5}'
}

check_capacity() {
  local phase="$1" enforce_now="$2" free_mb free_percent used_percent
  read -r free_mb free_percent used_percent <<EOF_STATS
$(disk_stats)
EOF_STATS
  printf 'docker cleanup capacity: phase=%s root=%s free_mb=%s free_percent=%s used=%s minimum_mb=%s minimum_percent=%s\n' \
    "$phase" "$docker_root" "$free_mb" "$free_percent" "$used_percent" "$MIN_FREE_MB" "$MIN_FREE_PERCENT"
  if [ "$ENFORCE" = "1" ] && [ "$enforce_now" = "1" ] && { [ "$free_mb" -lt "$MIN_FREE_MB" ] || [ "$free_percent" -lt "$MIN_FREE_PERCENT" ]; }; then
    fail "insufficient Docker disk capacity after ${phase}: ${free_mb}MB/${free_percent}% free"
  fi
}

# Prints the UTC time that is $1 ago (digits and an h or d suffix) as YYYY-MM-DDTHH:MM:SSZ.
# GNU date takes -d; BSD date takes -v.
cutoff_iso() {
  local amount="${1%[hd]}" unit="${1: -1}" hours
  hours=$((10#$amount))
  if [ "$unit" = d ]; then hours=$((hours * 24)); fi
  date -u -d "-${hours} hours" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -v-"${hours}"H '+%Y-%m-%dT%H:%M:%SZ'
}

# Writes release.used (image IDs of all containers, any state) and release.images (one
# id|created|size|tags|digests line per image) into $work_dir. Fails when Docker cannot answer.
release_inventory() {
  local ids
  ids="$(docker ps -a --no-trunc -q)" || return 1
  : > "$work_dir/release.used"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # container IDs are plain hex words
    docker inspect --type container --format '{{.Image}}' $ids > "$work_dir/release.used" || return 1
  fi
  ids="$(docker image ls -q --no-trunc | sort -u)" || return 1
  : > "$work_dir/release.images"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # image IDs are plain sha256 words
    docker image inspect --format '{{.Id}}|{{.Created}}|{{.Size}}|{{range .RepoTags}}{{.}} {{end}}|{{range .RepoDigests}}{{.}} {{end}}' $ids > "$work_dir/release.images" || return 1
  fi
}

# Writes release.plan.sorted: one ACTION|id|repositories|created|size|reason line per release
# image. Repositories are matched by exact name; "newest N" is ranked over all local images of
# a repository, whatever protects them. $1 is the age cutoff as YYYY-MM-DDTHH:MM:SSZ.
release_plan() {
  awk -F'|' -v repos="$RELEASE_REPOS" -v keep="$RELEASE_KEEP" -v cutoff="$(printf '%s' "$1" | tr -cd '0-9')" '
    function repo_of_tag(ref,   p) {
      # The containerd image store also lists digest references (repo@sha256:...) as tags.
      p = index(ref, "@")
      if (p > 0) return substr(ref, 1, p - 1)
      p = match(ref, ":[^/:]*$")
      return p > 0 ? substr(ref, 1, p - 1) : ref
    }
    function add_repo(i, r) {
      if (r == "" || ((i, r) in hasrepo)) return
      hasrepo[i, r] = 1
      nrepo[i]++
      repolist[i] = (nrepo[i] == 1) ? r : repolist[i] "," r
      if (r in allowed) nallowed[i]++
      else foreign[i] = 1
    }
    BEGIN {
      n = split(repos, list, " ")
      for (k = 1; k <= n; k++) allowed[list[k]] = 1
    }
    FILENAME == ARGV[1] { if ($1 != "") used[$1] = 1; next }
    FILENAME == ARGV[2] { if ($1 != "") pinned[$1] = 1; next }
    {
      i = ++count
      id[i] = $1; created[i] = $2; size[i] = $3
      nt = split($4, tags, " ")
      for (k = 1; k <= nt; k++) {
        if (index(tags[k], "<none>") == 1) continue
        add_repo(i, repo_of_tag(tags[k]))
        if (index(tags[k], "@") == 0) ntags[i]++   # a digest reference is not a tag
      }
      nd = split($5, digs, " ")
      for (k = 1; k <= nd; k++) {
        p = index(digs[k], "@")
        if (p == 0 || index(digs[k], "<none>") == 1) continue
        add_repo(i, substr(digs[k], 1, p - 1))
        ndig[i]++
        dig[i, ndig[i]] = substr(digs[k], p + 1)
      }
      if (created[i] ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9](\.[0-9]+)?Z$/) {
        s = substr(created[i], 1, 4) substr(created[i], 6, 2) substr(created[i], 9, 2)
        s = s substr(created[i], 12, 2) substr(created[i], 15, 2) substr(created[i], 18, 2)
        stamp[i] = s
      }
    }
    END {
      for (i = 1; i <= count; i++) {
        if (nallowed[i] == 0) continue
        base = id[i] "|" repolist[i] "|" created[i] "|" int((size[i] + 0) / 1048576) "MB|"
        if (foreign[i]) { print "SKIP|" base "also in a repository outside the release list"; continue }
        if (id[i] in used) { print "KEEP|" base "in use by a container"; continue }
        pin = (id[i] in pinned)
        for (k = 1; k <= ndig[i]; k++) if (dig[i, k] in pinned) pin = 1
        if (pin) { print "KEEP|" base "named in a pin file"; continue }
        if (stamp[i] == "") { print "SKIP|" base "created time is not a UTC timestamp"; continue }
        newest = 0
        nr = split(repolist[i], rl, ",")
        for (a = 1; a <= nr; a++) {
          newer = 0
          for (j = 1; j <= count; j++) {
            if (j == i || stamp[j] == "" || !((j, rl[a]) in hasrepo)) continue
            if (stamp[j] > stamp[i] || (stamp[j] == stamp[i] && id[j] < id[i])) newer++
          }
          if (newer < keep + 0) newest = 1
        }
        if (newest) { print "KEEP|" base "one of the newest " keep " of its repository"; continue }
        if ((stamp[i] "") >= (cutoff "")) { print "KEEP|" base "younger than the minimum age"; continue }
        if (ntags[i] > 1 || nrepo[i] > 1) { print "SKIP|" base "several tags or repositories; removal would need force"; continue }
        print "REMOVE|" base "unused, unpinned and old"
      }
    }
  ' "$work_dir/release.used" "$work_dir/release.pins" "$work_dir/release.images" > "$work_dir/release.plan" \
  && LC_ALL=C sort -t'|' -k3,3 -k4,4r "$work_dir/release.plan" > "$work_dir/release.plan.sorted"
}

# Release images are pulled by digest, so they show up as repo:<none>. They are not dangling and
# the image prune below never removes them. Remove the unused old ones, by image ID, never forced.
prune_release_images() {
  local cutoff pin_dir pin_name pin_file pin_files_read=0 pin_digests
  local action id repo created size reason out
  local removed=0 kept=0 skipped=0 candidates=0

  if ! cutoff="$(cutoff_iso "$RELEASE_MIN_AGE")"; then
    echo "release image prune skipped: cannot compute the age cutoff for ${RELEASE_MIN_AGE}"
    return 0
  fi

  # Pin files: any sha256 digest in them pins the image with that ID or repo digest.
  if [ -n "${ROUTE_OPS_DOCKER_PIN_FILES:-}" ]; then
    printf '%s\n' "$ROUTE_OPS_DOCKER_PIN_FILES" | tr -s '[:space:]' '\n' > "$work_dir/release.pinfiles"
  else
    pin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    : > "$work_dir/release.pinfiles"
    for pin_name in current-image.env simple-rollback-image.env simple-candidate-image.env previous-image.env; do
      printf '%s\n' "$pin_dir/$pin_name" >> "$work_dir/release.pinfiles"
    done
  fi
  : > "$work_dir/release.pins"
  while IFS= read -r pin_file; do
    if [ -n "$pin_file" ] && [ -f "$pin_file" ] && [ -r "$pin_file" ]; then
      pin_files_read=$((pin_files_read + 1))
      grep -Eo 'sha256:[0-9a-f]{64}' "$pin_file" >> "$work_dir/release.pins" || true
    fi
  done < "$work_dir/release.pinfiles"
  pin_digests="$(sort -u "$work_dir/release.pins" | wc -l | tr -d ' ')"
  printf 'release image prune policy: repos=%s keep_newest=%s min_age=%s created_before=%s pin_files_read=%s pinned_digests=%s\n' \
    "$RELEASE_REPOS" "$RELEASE_KEEP" "$RELEASE_MIN_AGE" "$cutoff" "$pin_files_read" "$pin_digests"
  if [ "$pin_files_read" = "0" ]; then
    echo 'release image prune skipped: no pin file could be read, so rollback images cannot be protected'
    return 0
  fi

  if ! release_inventory; then
    echo 'release image prune skipped: Docker could not list containers and images'
    return 0
  fi

  if ! release_plan "$cutoff"; then
    echo 'release image prune skipped: could not evaluate the images'
    return 0
  fi

  while IFS='|' read -r action id repo created size reason; do
    case "$action" in
      KEEP)
        kept=$((kept + 1))
        printf 'release image kept: %s %s %s %s (%s)\n' "$id" "$repo" "$created" "$size" "$reason"
        ;;
      SKIP)
        skipped=$((skipped + 1))
        printf 'release image skipped: %s %s %s %s (%s)\n' "$id" "$repo" "$created" "$size" "$reason"
        ;;
      REMOVE)
        if ! [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
          skipped=$((skipped + 1))
          printf 'release image skipped: %s %s (not a full image ID)\n' "$id" "$repo"
        elif [ "$DRY_RUN" = "1" ]; then
          candidates=$((candidates + 1))
          printf 'release image prune candidate: %s %s %s %s\n' "$id" "$repo" "$created" "$size"
        elif out="$(docker image rm "$id" </dev/null 2>&1)"; then
          removed=$((removed + 1))
          printf 'release image removed: %s %s %s %s\n' "$id" "$repo" "$created" "$size"
        else
          skipped=$((skipped + 1))
          printf 'release image remove failed: %s %s: %s\n' "$id" "$repo" "${out%%$'\n'*}"
        fi
        ;;
    esac
  done < "$work_dir/release.plan.sorted"

  if [ "$DRY_RUN" = "1" ]; then
    printf 'release image prune dry-run: candidates=%s kept=%s skipped=%s\n' "$candidates" "$kept" "$skipped"
  else
    printf 'release image prune: removed=%s kept=%s skipped=%s\n' "$removed" "$kept" "$skipped"
  fi
}

docker ps --no-trunc --format '{{.ID}}\t{{.Image}}' | sort > "$work_dir/running-containers.before"
dangling_count="$(docker image ls -q --filter dangling=true | sort -u | wc -l | tr -d ' ')"
printf 'docker cleanup policy: dangling_images_older_than=%s build_cache_older_than=%s build_cache_reserved=%s dangling_total=%s\n' \
  "$IMAGE_MAX_AGE" "$BUILD_CACHE_MAX_AGE" "$BUILD_CACHE_RESERVED_SPACE" "$dangling_count"
docker system df
if [ "$DRY_RUN" = "1" ]; then
  prune_release_images
fi
check_capacity before "$DRY_RUN"

if [ "$DRY_RUN" = "1" ]; then
  echo 'cleanup dry-run complete; no Docker data was removed'
  exit 0
fi

# Intentionally no --all: Docker's image prune default is dangling images only.
docker image prune --force --filter "until=$IMAGE_MAX_AGE"
docker builder prune --force --filter "until=$BUILD_CACHE_MAX_AGE" --reserved-space "$BUILD_CACHE_RESERVED_SPACE"
prune_release_images

docker ps --no-trunc --format '{{.ID}}\t{{.Image}}' | sort > "$work_dir/running-containers.after"
if ! diff -u "$work_dir/running-containers.before" "$work_dir/running-containers.after"; then
  fail "running container set changed during cleanup"
fi
check_capacity after 1
docker system df
echo 'docker cleanup complete; running containers unchanged'
