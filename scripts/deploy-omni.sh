#!/usr/bin/env bash
# Deploy the 9router fork to omni-fr.
#
#   ./scripts/deploy-omni.sh [tag]        # default: askid<UTC timestamp>
#
# The heavy lifting runs server-side (scripts/deploy-omni-remote.sh, uploaded to
# /root/deploy-9router.sh): build while production keeps serving -> smoke-test the new image on a
# throwaway port -> swap containers with an automatic rollback -> keep one rollback generation.
# This script only syncs sources, starts it detached and polls for its DEPLOY_OK / DEPLOY_FAILED
# marker, so an SSH drop does not kill a build halfway.
set -euo pipefail

TAG="${1:-askid$(date -u +%Y%m%dT%H%M%SZ)}"
HOST="${HOST:-omni-fr}"
REMOTE_SRC="${REMOTE_SRC:-/root/9router-fork-src}"
REMOTE_SCRIPT=/root/deploy-9router.sh
REMOTE_LOG=/root/9router-deploy.log
TIMEOUT_MIN="${TIMEOUT_MIN:-30}"

[[ $TAG =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$ ]] || { echo "bad tag: $TAG" >&2; exit 2; }

echo "── rsync → $HOST:$REMOTE_SRC"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.zcode' \
  --exclude='tests/node_modules' --exclude='cli/node_modules' --exclude='.env' \
  ./ "$HOST:$REMOTE_SRC/"

echo "── upload remote half"
scp -q scripts/deploy-omni-remote.sh "$HOST:$REMOTE_SCRIPT"

echo "── start deploy $TAG (server log: $REMOTE_LOG)"
ssh "$HOST" "chmod +x $REMOTE_SCRIPT && : > $REMOTE_LOG && setsid nohup bash $REMOTE_SCRIPT '$TAG' >> $REMOTE_LOG 2>&1 < /dev/null & echo started"

deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
seen=0
while :; do
  sleep 10
  chunk=$(ssh "$HOST" "tail -n +$(( seen + 1 )) $REMOTE_LOG" 2>/dev/null || true)
  if [[ -n $chunk ]]; then
    printf '%s\n' "$chunk" | sed 's/^/  /'
    seen=$(( seen + $(printf '%s\n' "$chunk" | grep -c '') ))
  fi

  if grep -q 'DEPLOY_OK' <<< "$chunk"; then exit 0; fi
  if grep -q 'DEPLOY_FAILED' <<< "$chunk"; then exit 1; fi
  if (( $(date +%s) > deadline )); then
    echo "── timeout after ${TIMEOUT_MIN}m — the server-side deploy may still be running:" >&2
    echo "   ssh $HOST 'tail -f $REMOTE_LOG'" >&2
    exit 1
  fi
done
