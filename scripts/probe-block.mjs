// Who is X refusing — this runner, or this account?
//
// When the bot check will not clear, the fix depends entirely on which of those it is
// and the wire's own logs cannot tell them apart: every search job carries the account's
// cookies, so a blocked job is consistent with both. This probe separates them by
// loading the same page twice with the same browser from the same address, once signed
// out and once signed in.
//
//   signed out passes, signed in blocked  -> the ACCOUNT is flagged. New X credentials.
//   both blocked                          -> the ADDRESS is scored. GitHub-hosted runners
//                                            are the problem; move the run or proxy it.
//   both pass                             -> whatever it was has lifted; rerun the wire.
//
//   node scripts/probe-block.mjs
import { SearchSession, loadCredentials } from '../src/collect/search.js';

const NO_CRED = { authToken: '', ct0: '', id: 'signed-out' };

// The session applies cookies at open(); an empty pair must not be sent at all, or X
// sees a malformed auth cookie rather than an anonymous visitor.
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
