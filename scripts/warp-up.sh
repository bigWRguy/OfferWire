#!/usr/bin/env bash
set -uo pipefail

PORT="${WARP_SOCKS_PORT:-25344}"
say() { echo "  warp: $*"; }

setup() {
  set -e
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
    | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflare-warp
  sudo systemctl start warp-svc
  for _ in $(seq 1 15); do warp-cli --accept-tos status >/dev/null 2>&1 && break; sleep 2; done
  warp-cli --accept-tos registration new
  warp-cli --accept-tos mode proxy
  warp-cli --accept-tos proxy port "$PORT"
  warp-cli --accept-tos connect
}

if ! setup > /tmp/warp-setup.log 2>&1; then
  say "could not be installed — running direct. Last lines:"
  tail -5 /tmp/warp-setup.log | sed 's/^/  warp: | /'
fi

tunnel=""
for _ in $(seq 1 20); do
  tunnel=$(curl -s --socks5-hostname "127.0.0.1:$PORT" --max-time 5 https://api.ipify.org || true)
  [ -n "$tunnel" ] && break
  sleep 2
done

runner=$(curl -s --max-time 10 https://api.ipify.org || echo unknown)
if [ -n "$tunnel" ] && [ "$tunnel" != "$runner" ]; then
  say "browser leaves from $tunnel (runner is $runner)"
  echo "OFFERWIRE_PROXY=socks5://127.0.0.1:$PORT" >> "${GITHUB_ENV:-/dev/null}"
else
  say "tunnel did not come up — the browser will go direct from $runner and X will very"
  say "likely refuse it. Nothing is lost: watermarks are untouched and the next run retries."
fi
exit 0
