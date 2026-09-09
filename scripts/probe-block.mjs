import { SearchSession, loadCredentials } from '../src/collect/search.js';

const NO_CRED = { authToken: '', ct0: '', id: 'signed-out' };

class AnonSession extends SearchSession {
  async open() {
    const saved = this.cred;
    this.cred = { authToken: 'x', ct0: 'x', id: saved.id };
    await super.open();
    await this.page.context().clearCookies();
    this.cred = saved;
    return this;
  }
}

const probe = async (label, session) => {
  const out = { label, blocked: null, note: '' };
  try {
    await session.open();
    await session.page.goto('https://x.com/explore', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await session.page.waitForTimeout(1500);
    const sawCheck = await session.onInterstitial();
    if (sawCheck) await session.passInterstitial(45000);
    out.blocked = await session.onInterstitial();
    out.note = sawCheck ? (out.blocked ? 'bot check served, never cleared' : 'bot check served, cleared') : 'no bot check';
    const d = await session.diagnose();
    if (d.snippet) out.page = d.snippet.slice(0, 120);
  } catch (e) {
    out.note = `probe error: ${e.message}`;
  } finally {
    await session.close();
  }
  return out;
};

let egress = 'unknown';
try {
  egress = (await (await fetch('https://api.ipify.org')).text()).trim();
} catch {}
console.log(`egress address: ${egress}`);

if ((process.env.OFFERWIRE_PROXY || '').trim()) {
  let via = 'unreachable — the tunnel is down, so nothing below is meaningful';
  const s = new AnonSession(NO_CRED);
  try {
    await s.open();
    await s.page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded', timeout: 30000 });
    via = (await s.page.textContent('body'))?.trim() || via;
  } catch (e) {
    via = `unreachable: ${e.message}`;
  } finally {
    await s.close();
  }
  console.log(`browser egress via ${process.env.OFFERWIRE_PROXY}: ${via}`);
}

const creds = loadCredentials();
const results = [await probe('signed out', new AnonSession(NO_CRED))];
if (creds.length) results.push(await probe('signed in', new SearchSession(creds[0])));
else console.log('no credentials in the environment — signed-in half skipped');

for (const r of results) console.log(`  ${r.label.padEnd(11)} blocked=${r.blocked}  ${r.note}${r.page ? `\n              page: ${r.page}` : ''}`);

const [anon, auth] = results;
console.log('');
if (!auth) console.log('VERDICT: inconclusive without credentials.');
else if (anon.blocked && auth.blocked) console.log("VERDICT: the ADDRESS is scored. Both halves blocked from the same IP, so the account is not the problem — GitHub-hosted runners are. Move the run to a self-hosted runner or route it through a residential proxy.");
else if (!anon.blocked && auth.blocked) console.log('VERDICT: the ACCOUNT is flagged. Signed out passes from this very address and signed in does not. Refresh X_AUTH_TOKEN / X_CT0 from a different X account.');
else if (!anon.blocked && !auth.blocked) console.log('VERDICT: nothing is blocked right now. The check is intermittent; rerun the wire.');
else console.log('VERDICT: odd — signed out blocked while signed in passed. Rerun before acting on it.');
