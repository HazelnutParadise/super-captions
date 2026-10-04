#!/bin/sh
# Run in a disposable Alpine container: this test owns /app and /opt/youtube.
set -eu

mkdir -p /app /tmp/startup-bin
cp /source/docker-entrypoint.sh /app/docker-entrypoint.sh
cp /source/requirements-youtube.txt /app/requirements-youtube.txt
export PATH="/tmp/startup-bin:$PATH"
export CALLS=/tmp/startup-calls
cd /app

cat > /tmp/startup-bin/mock <<'MOCK'
#!/bin/sh
set -eu
name=$(basename "$0")
printf '%s %s\n' "$name" "$*" >> "$CALLS"
if [ "$name" = "${FAIL_PHASE:-}" ]; then exit 17; fi
case "$name" in
  python3)
    mkdir -p /opt/youtube/bin
    cp /tmp/startup-bin/mock /opt/youtube/bin/pip
    cp /tmp/startup-bin/mock /opt/youtube/bin/yt-dlp
    ;;
esac
MOCK
chmod +x /tmp/startup-bin/mock
for name in apk python3 ffmpeg; do
  cp /tmp/startup-bin/mock "/tmp/startup-bin/$name"
done

start_server() {
  sh /app/docker-entrypoint.sh sh -c 'echo server >> "$CALLS"'
}

start_server
test "$(tail -n 1 "$CALLS")" = server
test -s /opt/youtube/.requirements.sha256
test "$(grep -c '^apk ' "$CALLS")" = 1
echo 'PASS: install completes before the server starts'

start_server
test "$(grep -c '^apk ' "$CALLS")" = 1
test "$(grep -c '^server$' "$CALLS")" = 2
echo 'PASS: a restart skips completed installation'

printf '\n# changed requirements\n' >> requirements-youtube.txt
start_server
test "$(grep -c '^apk ' "$CALLS")" = 2
echo 'PASS: changed requirements trigger installation'

rm /opt/youtube/bin/yt-dlp
start_server
test "$(grep -c '^apk ' "$CALLS")" = 3
echo 'PASS: a missing executable triggers repair'

for phase in apk pip; do
  rm /opt/youtube/.requirements.sha256
  before=$(grep -c '^server$' "$CALLS")
  if FAIL_PHASE="$phase" start_server; then
    echo "FAIL: $phase failure was ignored" >&2
    exit 1
  fi
  test ! -f /opt/youtube/.requirements.sha256
  test "$(grep -c '^server$' "$CALLS")" = "$before"
  start_server
  test -s /opt/youtube/.requirements.sha256
  echo "PASS: $phase failure prevents startup and can be retried"
done

rm /opt/youtube/.requirements.sha256
before=$(grep -c '^server$' "$CALLS")
sh /app/docker-entrypoint.sh --install-only
test -s /opt/youtube/.requirements.sha256
test "$(grep -c '^server$' "$CALLS")" = "$before"
echo 'PASS: build-time installation does not start the server'

status=0
sh /app/docker-entrypoint.sh sh -c 'test "$1" = "argument with spaces" || exit 99; exit 23' -- 'argument with spaces' || status=$?
test "$status" = 23
echo 'PASS: server arguments and exit status are preserved'
