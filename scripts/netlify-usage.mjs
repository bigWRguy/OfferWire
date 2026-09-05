// Where are the Netlify build minutes going?
//
// The wire pushes a ledger commit to main every quarter hour. If the Netlify project is
// ALSO linked to the repository, each of those pushes starts a build on Netlify's
// infrastructure — around a hundred a day, none of which produce anything, because the
// workflow already builds the site on the GitHub runner and deploys it with the CLI.
//
// This attributes the month's usage before anything is changed, across every project on
// the account: the billing warning names the account, not the project, and guessing which
// one is spending is exactly how you disable the wrong thing.
//
//   NETLIFY_AUTH_TOKEN=... node scripts/netlify-usage.mjs
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
  // A deploy carrying a commit ref was started by a git push and BUILT ON NETLIFY.
  // A CLI deploy arrives prebuilt and costs no build minutes.
  // `build_id` is the only honest discriminator. commit_ref is NOT: the CLI deploys from
  // a git checkout on the runner and attaches the commit it is sitting on, so classifying
  // by commit_ref counts our own free deploys as billed builds. A deploy that was built on
  // Netlify's infrastructure — the only kind that spends minutes — carries a build_id.
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
      // The reason matters: a build that is being SKIPPED costs nothing, one that is
      // genuinely failing still occupied a builder and still gets billed for it.
      why: (d.error_message || '').replace(/\s+/g, ' ').slice(0, 90),
    })),
  });
}
rows.sort((a, b) => b.gitSeconds - a.gitSeconds);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(34)} ${r.linked.padEnd(11)} deploys ${String(r.month).padStart(4)}  git-built ${String(r.git).padStart(4)} (${mins(r.gitSeconds)})  cli ${String(r.cli).padStart(4)}  skipped ${String(r.skipped).padStart(4)}`);
}

// Show the newest deploys on the busiest project: a fix that stops Netlify-side builds
// must be visible as a change in the most recent rows, not inferred from a rolling total.
if (rows[0]?.recent?.length) {
  console.log(`
newest deploys on ${rows[0].name}:`);
  for (const d of rows[0].recent) console.log(`  ${d.at}  built-by ${d.build.padEnd(7)} ${String(d.state).padEnd(9)} ${d.secs}s  ${d.sha}  ${d.why}`);
}

// Skipping a git build leaves an "error" row behind (Netlify records the cancel that
// way), which is harmless for billing but not harmless for the inbox if this project has
// deploy-failure notifications wired up. Say so plainly rather than finding out by email.
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
