#!/usr/bin/env bash
# Server-side half of the 9router deploy (invoked by scripts/deploy-omni.sh, or by hand).
#
#   1. build the image while production keeps serving
#   2. smoke-test that exact image on a throwaway loopback port with its own volume
#   3. create the production container, then stop/rename/start it into place
#   4. verify production and roll back automatically when the new one does not come up
#   5. keep exactly one rollback generation and drop images nothing references any more
#
# Why this order: an image cannot be removed while a stopped container still references it, so
# the old scheme (`docker rename` the previous container and never delete it) pinned one 1.3 GB
# image per deploy forever. Retention is bounded here on purpose — one rollback, never more.
#
# Usage: bash /root/deploy-9router.sh <tag>    (log marker: DEPLOY_OK / DEPLOY_FAILED)
set -Eeuo pipefail

APP=9router
ROLLBACK=9router-rollback
SRC=${SRC:-/root/9router-fork-src}
ENV_FILE=${ENV_FILE:-/root/9router-env.txt}
VOLUME=${VOLUME:-9router-data}
PORT=${PORT:-20128}
IMAGE_REPO=${IMAGE_REPO:-9router-local}
MIN_FREE_GIB=${MIN_FREE_GIB:-8}
SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-90}
READY_TIMEOUT=${READY_TIMEOUT:-60}
STOP_GRACE=${STOP_GRACE:-30}

TAG=${1:?usage: deploy-9router.sh <tag>}
[[ $TAG =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$ ]] || { echo "bad tag: $TAG" >&2; exit 2; }

IMAGE="$IMAGE_REPO:$TAG"
RUN="$TAG-$$"
NEXT="$APP-next-$RUN"
PREV="$APP-before-$RUN"
SMOKE="$APP-smoke-$RUN"
SMOKE_VOL="$APP-smoke-$RUN"
NEW_ID=""
IMAGE_ID=""
switching=0
old_moved=0

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Readiness = the process is alive, it has not restarted, /api/health answers, and the app has
# opened its database. /api/health alone is a static {"ok":true}: it says nothing about the DB.
ready() {
  local name=$1 base=$2 limit=$3 deadline ok=0
  deadline=$((SECONDS + limit))
  while (( SECONDS < deadline )); do
    if [[ $(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null) == true ]] &&
       [[ $(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null) == 0 ]] &&
       curl -fsS --noproxy '*' --connect-timeout 2 --max-time 4 "$base/api/health" >/dev/null 2>&1 &&
       docker logs "$name" 2>&1 | grep -q '\[DB\] Driver:'; then
      ok=$((ok + 1))
      (( ok >= 2 )) && return 0
    else
      ok=0
    fi
    sleep 2
  done
  return 1
}

# Put the previous container back in place. Only ever called while `switching` is set, i.e. the
# old container is stopped but still exists and the new one has not been accepted yet.
restore() {
  log "rolling back to the previous container"
  if [[ $(docker inspect -f '{{.State.Running}}' "$NEXT" 2>/dev/null) == true ]]; then
    docker stop -t 10 "$NEXT" >/dev/null || return 1
  fi
  # Only after the old container was actually moved behind "$PREV" does the name "$APP" belong
  # to the new container. Renaming in the other case would move the OLD container to "$NEXT".
  if (( old_moved == 1 )); then
    if docker inspect "$APP" >/dev/null 2>&1; then
      docker rename "$APP" "$NEXT" || return 1
    fi
    docker rename "$PREV" "$APP" || return 1
  fi
  docker start "$APP" >/dev/null || return 1
  ready "$APP" "http://127.0.0.1:$PORT" "$READY_TIMEOUT"
}

finish() {
  local rc=$?
  trap - EXIT HUP INT TERM
  set +e

  if (( rc != 0 && switching == 1 )); then
    if restore; then
      switching=0
      log "previous production restored"
    else
      rc=3
      log "CRITICAL: rollback did not complete; \"$APP\" and \"$PREV\" are left for inspection"
    fi
  fi

  # A failed deploy never leaves a half-created new container behind.
  if (( switching == 0 )) && [[ -n $NEW_ID ]] && docker inspect "$NEXT" >/dev/null 2>&1; then
    [[ $(docker inspect -f '{{.State.Running}}' "$NEXT") == true ]] || docker rm "$NEXT" >/dev/null 2>&1
  fi
  if docker inspect "$SMOKE" >/dev/null 2>&1; then docker rm -f "$SMOKE" >/dev/null 2>&1; fi
  if docker volume inspect "$SMOKE_VOL" >/dev/null 2>&1; then docker volume rm "$SMOKE_VOL" >/dev/null 2>&1; fi

  if (( rc == 0 )); then log "DEPLOY_OK tag=$TAG image=$IMAGE_ID"; else log "DEPLOY_FAILED tag=$TAG rc=$rc"; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "deploy tag=$TAG host=$(hostname) src=$SRC"

# Remove our own images that no container references any more. The running container and the
# rollback container protect exactly the two images we still need.
cleanup_images() {
  local ref id users
  while read -r ref id; do
    [[ -n $ref && -n $id ]] || continue
    users=$(docker ps -aq --filter "ancestor=$id")
    if [[ -z $users ]]; then
      docker image rm "$ref" >/dev/null 2>&1 || log "WARNING: could not remove $ref"
    fi
  done < <(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
             --filter "reference=$IMAGE_REPO:*")
  docker image prune -f >/dev/null 2>&1 || true
}

for cmd in docker curl flock; do
  command -v "$cmd" >/dev/null || { log "missing command: $cmd"; exit 2; }
done
[[ -r $ENV_FILE ]] || { log "missing env file: $ENV_FILE"; exit 2; }
[[ -f $SRC/Dockerfile ]] || { log "missing source tree: $SRC"; exit 2; }
docker volume inspect "$VOLUME" >/dev/null || { log "missing volume: $VOLUME"; exit 2; }
docker inspect "$APP" >/dev/null 2>&1 || { log "no running \"$APP\" container to replace"; exit 2; }

# One deploy at a time: rsync --delete from another shell must not race this build.
exec 9>/run/lock/9router-deploy.lock
if ! flock -n 9; then log "another deploy is already running"; exit 1; fi

# Production must be healthy BEFORE we touch it, otherwise a failure cannot be told apart from
# a problem that was already there.
ready "$APP" "http://127.0.0.1:$PORT" 20 || { log "production is not healthy before the deploy — aborting"; exit 1; }
log "pre-deploy production check: ok"

cleanup_images

free_kib=$(df -Pk / | awk 'END {print $4}')
(( free_kib >= MIN_FREE_GIB * 1024 * 1024 )) || {
  log "not enough free space for the build: $((free_kib / 1024 / 1024)) GiB < ${MIN_FREE_GIB} GiB"
  exit 1
}
log "free space before build: $((free_kib / 1024 / 1024)) GiB"

cd "$SRC"
log "building $IMAGE (build log: /root/9router-build.log)"
if ! docker build -t "$IMAGE" . > /root/9router-build.log 2>&1; then
  tail -n 40 /root/9router-build.log 2>/dev/null || true
  log "build failed — production untouched"
  exit 1
fi
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE")
log "built image=$IMAGE_ID"

# --- smoke: the exact image ID that production will get, on its own volume and port -----------
docker volume create "$SMOKE_VOL" >/dev/null
docker create --name "$SMOKE" --restart no \
  -p "127.0.0.1::$PORT" \
  --mount "type=volume,src=$SMOKE_VOL,dst=/app/data" \
  --env-file "$ENV_FILE" "$IMAGE_ID" >/dev/null
docker start "$SMOKE" >/dev/null
SMOKE_ADDR=$(docker port "$SMOKE" "$PORT/tcp")
log "smoke container on $SMOKE_ADDR"
if ! ready "$SMOKE" "http://$SMOKE_ADDR" "$SMOKE_TIMEOUT"; then
  docker logs --tail 60 "$SMOKE" 2>&1 || true
  log "smoke test failed — production untouched"
  exit 1
fi
docker stop -t 5 "$SMOKE" >/dev/null
docker rm "$SMOKE" >/dev/null
docker volume rm "$SMOKE_VOL" >/dev/null
log "smoke test passed"

# --- swap ------------------------------------------------------------------------------------
# `docker create` up front: a bad image/flag is rejected before production is stopped. The port
# is only claimed on start, so the old container keeps serving until then.
NEW_ID=$(docker create --name "$NEXT" \
  --restart unless-stopped --stop-timeout "$STOP_GRACE" \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  -p "127.0.0.1:$PORT:$PORT" \
  --mount "type=volume,src=$VOLUME,dst=/app/data" \
  --env-file "$ENV_FILE" "$IMAGE_ID")

switching=1
log "stopping $APP (grace ${STOP_GRACE}s)"
docker stop -t "$STOP_GRACE" "$APP" >/dev/null
docker rename "$APP" "$PREV"
old_moved=1
docker rename "$NEXT" "$APP"
log "starting $APP on $IMAGE"
docker start "$APP" >/dev/null

if ! ready "$APP" "http://127.0.0.1:$PORT" "$READY_TIMEOUT"; then
  docker logs --tail 60 "$APP" 2>&1 || true
  exit 1 # finish() restores the previous container
fi
log "new production is healthy"

# Past this point the new container is accepted: a later cleanup error must not roll it back.
switching=0
if docker inspect "$ROLLBACK" >/dev/null 2>&1; then
  docker rm "$ROLLBACK" >/dev/null 2>&1 || log "WARNING: could not remove the old rollback container"
fi
docker rename "$PREV" "$ROLLBACK"
log "rollback generation: $ROLLBACK (image $(docker inspect -f '{{.Config.Image}}' "$ROLLBACK"))"
cleanup_images || log "WARNING: production is fine, image cleanup did not finish"

log "done — rollback: docker stop -t $STOP_GRACE $APP && docker rm $APP && docker rename $ROLLBACK $APP && docker start $APP"
