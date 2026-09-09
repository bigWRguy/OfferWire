const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
if (!TOKEN) {
  console.error('NETLIFY_AUTH_TOKEN is not set — nothing to query.');
  process.exit(1);
}

const api = async (path) => {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

const MONTH_START = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const mins = (s) => `${(s / 60).toFixed(1)}m`;

const accounts = await api('/accounts');
for (const a of accounts) {
  console.log(`account: ${a.name} (${a.slug})  plan: ${a.type_name || a.type}`);
  try {
    const status = await api(`/accounts/${a.id}/builds/status`);
    const used = status.minutes_used ?? status.used ?? null;
    const included = status.included_minutes ?? status.included ?? null;
    if (used !== null) console.log(`  build minutes: ${used} used of ${included ?? '?'} included${status.period_end_date ? ` (period ends ${status.period_end_date})` : ''}`);
    else console.log(`  build status: ${JSON.stringify(status)}`);
  } catch (e) { console.log(`  build status unavailable: ${e.message}`); }
}

console.log('\nper-project deploys this month (Netlify-side builds are the ones that cost):');
const sites = await api('/sites?per_page=100');
const rows = [];
for (const site of sites) {
  let deploys = [];
  try { deploys = await api(`/sites/${site.id}/deploys?per_page=200`); } catch { continue; }
  const month = deploys.filter((d) => new Date(d.created_at) >= MONTH_START);
  const built = month.filter((d) => d.build_id);
  const skipped = built.filter((d) => d.state === 'skipped' || d.skipped);
  const fromGit = built.filter((d) => !(d.state === 'skipped' || d.skipped));
  const fromCli = month.filter((d) => !d.build_id);
  const gitSeconds = fromGit.reduce((n, d) => n + (d.deploy_time || 0), 0);
  rows.push({
    name: site.name,
    linked: site.build_settings?.repo_url ? 'git-linked' : 'not linked',
    month: month.length,
    git: fromGit.length,
    cli: fromCli.length,
    gitSeconds,
    skipped: skipped.length,
    recent: month.slice(0, 6).map((d) => ({
      at: d.created_at, state: d.state, build: d.build_id ? 'netlify' : 'cli',
      secs: d.deploy_time || 0, sha: (d.commit_ref || '-').slice(0, 7),
      why: (d.error_message || '').replace(/\s+/g, ' ').slice(0, 90),
    })),
  });
}
rows.sort((a, b) => b.gitSeconds - a.gitSeconds);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(34)} ${r.linked.padEnd(11)} deploys ${String(r.month).padStart(4)}  git-built ${String(r.git).padStart(4)} (${mins(r.gitSeconds)})  cli ${String(r.cli).padStart(4)}  skipped ${String(r.skipped).padStart(4)}`);
}

if (rows[0]?.recent?.length) {
  console.log(`
newest deploys on ${rows[0].name}:`);
  for (const d of rows[0].recent) console.log(`  ${d.at}  built-by ${d.build.padEnd(7)} ${String(d.state).padEnd(9)} ${d.secs}s  ${d.sha}  ${d.why}`);
}

const busiest = sites.find((x) => x.name === rows[0]?.name);
if (busiest) {
  try {
    const hooks = await api(`/hooks?site_id=${busiest.id}`);
    const failure = hooks.filter((h) => /fail/i.test(h.event || '') && !h.disabled);
    console.log(`
notifications on ${busiest.name}: ${hooks.length} hook(s), ${failure.length} that fire on failure`);
    for (const h of failure) console.log(`  ${h.event} -> ${h.type}${h.data?.email ? ` (${h.data.email})` : ''}`);
    if (!failure.length) console.log('  nothing mails you when a build fails — the skipped-build rows are silent.');
  } catch (e) { console.log(`
notification hooks unavailable: ${e.message}`); }
}

const worst = rows[0];
console.log('');
if (!worst || !worst.git) console.log('VERDICT: no git-triggered builds this month — the minutes are going somewhere other than repository pushes.');
else console.log(`VERDICT: ${worst.name} ran ${worst.git} Netlify-side builds this month (${mins(worst.gitSeconds)} of build time). Those are the ones being billed; the CLI deploys are free.`);
