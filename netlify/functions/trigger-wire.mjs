// Netlify is the reliable clock; GitHub Actions remains the browser-capable worker.
// This function only dispatches the private-repo workflow and finishes in milliseconds.
const API = 'https://api.github.com/repos/bigWRguy/OfferWire';
const RECENT_MS = 10 * 60 * 1000;

export async function dispatchWire({
  token = process.env.GITHUB_DISPATCH_TOKEN,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!token) return { ok: true, skipped: 'missing GITHUB_DISPATCH_TOKEN' };

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const runsResponse = await fetchImpl(
    API + '/actions/workflows/wire.yml/runs?per_page=5',
    { headers },
  );
  if (!runsResponse.ok) {
    throw new Error('GitHub runs check failed: ' + runsResponse.status + ' ' + await runsResponse.text());
  }

  const runs = (await runsResponse.json()).workflow_runs || [];
  const recent = runs.find((run) =>
    Number.isFinite(Date.parse(run.created_at)) && now - Date.parse(run.created_at) < RECENT_MS);
  if (recent) {
    return { ok: true, skipped: 'recent run exists', runId: recent.id, status: recent.status };
  }

  const dispatchResponse = await fetchImpl(
    API + '/actions/workflows/wire.yml/dispatches',
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!dispatchResponse.ok) {
    throw new Error('GitHub dispatch failed: ' + dispatchResponse.status + ' ' + await dispatchResponse.text());
  }
  return { ok: true, dispatched: true };
}

export default async () => Response.json(await dispatchWire());

export const config = {
  // Three minutes after GitHub's own triggers: fill dropped runs without racing healthy ones.
  schedule: '10,25,40,55 * * * *',
};
