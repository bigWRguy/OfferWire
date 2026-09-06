#!/usr/bin/env bash
# Route the BROWSER — and only the browser — out through Cloudflare WARP.
#
# X's bot check scores the address a request comes from, and as of 2026-09-06 it refuses
# GitHub-hosted runners outright: five distinct Azure addresses were turned away signed
# out as well as signed in, and the wire went 104 runs in a row without sweeping a single
# school. Nothing about the credential or the fingerprint can fix an address block. The
# same probe through WARP saw no bot check at all, so this is the free fix, and it needs
# no machine of our own.
#
# WARP runs in PROXY mode: it opens a local SOCKS5 port and does NOT touch the runner's
# routing table. The Actions control channel, the checkout and the ledger push all still
# go out directly, so a tunnel that fails costs one run's collection instead of the job.
# That is also why this script never exits non-zero — if the tunnel does not come up it
# leaves OFFERWIRE_PROXY empty and the run proceeds exactly as it did before, blocked but
# honest, and the block escalation in src/pipeline.js reports it.
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
  # A fresh anonymous registration per run. No account, no card, no key to rotate.
  warp-cli --accept-tos registration new
  warp-cli --accept-tos mode proxy
  warp-cli --accept-tos proxy port "$PORT"
  warp-cli --accept-tos connect
}

if ! setup > /tmp/warp-setup.log 2>&1; then
  say "could not be installed — running direct. Last lines:"
  tail -5 /tmp/warp-setup.log | sed 's/^/  warp: | /'
fi

# The tunnel is only real if traffic actually comes out the other side, so prove it with
# the address rather than trusting "Connected".
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
