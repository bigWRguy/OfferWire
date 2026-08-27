// LLM extraction pass.
//
// rules.js is recall-oriented and deliberately noisy. This is where a post becomes a
// structured offer event — or gets thrown out. Three things make it affordable at wire
// volume:
//
//   1. Only posts that survive the rules prefilter are sent.
//   2. Posts are batched, so one request covers many.
//   3. The system prompt (instructions + the full 136-school roster) is byte-stable and
//      cached. The roster is what makes school disambiguation accurate; prompt caching
//      is what makes carrying it on every request affordable.
//
// If no Anthropic credential is present the pass is skipped and the pipeline runs
// rules-only at reduced confidence. The wire still works; it is just blunter.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { SCHOOLS } from '../resolve/schools.js';
import { Cache, sha1 } from '../lib/store.js';

export const MODEL = process.env.OFFERWIRE_MODEL || 'claude-opus-5';
export const enabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const ResultSchema = z.object({
  post_index: z.number().int(),
  is_new_offer: z.boolean(),
  // One entry per (player, school) pair: a single post routinely announces one player
  // collecting several offers, or one school offering several players.
  offers: z.array(z.object({
    player_name: z.string(),
    player_handle: z.string().nullable(),
    school_id: z.string(),
    class_year: z.number().int().nullable(),
    position: z.string().nullable(),
    high_school: z.string().nullable(),
    state: z.string().nullable(),
    confidence: z.number(),
  })),
  rejected_because: z.string().nullable(),
});

const BatchSchema = z.object({ results: z.array(ResultSchema) });

const ROSTER = SCHOOLS
  .map((s) => `${s.id}\t${s.name} ${s.nickname} (@${s.handle}, ${s.conference})`)
  .join('\n');

const SYSTEM = `You extract college football recruiting OFFER events from X (Twitter) posts.

An OFFER event is: an FBS program has extended a scholarship offer to a specific high school recruit, and this post is reporting that offer.

Return one result object per post you are given, in order, each carrying the post_index it was labelled with.

## What counts
- A recruit announcing an offer they received ("Blessed to receive an offer from...", "After a great conversation with Coach X...", "AGTG! Blessed to receive my 5th offer").
- A reporter or aggregator announcing an offer ("X has been offered by Y", "Y has offered 2028 ATH X").
- A program or coach account extending an offer to a named recruit.
- A post announcing several offers at once - emit one entry per (player, school) pair.
- An offer graphic where the text names the player and tags the school.

## What does NOT count - set is_new_offer false and say why in rejected_because
- Commitments, decommitments, flips, signings, enrollment, National Signing Day posts.
- Top-N lists, finalists, "narrowed down to", visit announcements, official/unofficial visit posts, camp invites, junior day invites.
- Offer-list recaps ("his offers include..."), anniversary or throwback posts.
- Preferred walk-on offers, grayshirt offers, and offers from non-FBS programs (FCS, D2, D3, NAIA, JUCO).
- Hypotheticals, questions, opinions ("should X offer him?", "this kid deserves an offer").
- Basketball, baseball, softball, or any non-football offer.
- Transfer portal offers - this wire tracks high school recruits only.
- A post that mentions an offer only as background to a different story.
- Congratulation posts that reference an offer someone else already announced, UNLESS the post is itself the announcement.

## School resolution
school_id MUST be an exact id from the roster below. If the school is not on the roster,
or you cannot tell which school is meant, DROP that offer entry.
Watch the ambiguous surfaces: "USC" (usc vs south-carolina), "Miami" (miami vs miami-oh),
"OSU" (ohio-state / oklahoma-state / oregon-state), "MSU" (michigan-state /
mississippi-state / missouri-state), "UW" (washington / wisconsin / wyoming), "UL"
(louisiana / louisiana-monroe), and bare nicknames like "Tigers", "Bulldogs",
"Wildcats", "Aggies". Use coach names, hashtags, handles, colours and regional context
to disambiguate. If it stays ambiguous, drop the entry - a missing offer is
recoverable, a wrong one poisons the wire.

## Player fields
- player_name: the recruit's name, properly cased. NEVER a coach's or reporter's name.
- player_handle: their X handle WITHOUT the @, only when the post makes clear the handle
  belongs to the recruit (they authored the post, or they are tagged as the recruit).
  Null otherwise. Never put a school, coach, or reporter handle here.
- class_year: graduating class (2027, 2028...). Null if not stated - do not infer it
  from age, grade, or context.
- position, high_school, state: only when stated or unambiguous. Null otherwise.
- confidence: 0-1, your confidence that THIS specific offer event is real and correctly
  attributed. Use the full range honestly. Below 0.5 means you are guessing.

Never invent a field to fill it. Null is always better than a plausible guess.

## FBS roster (school_id -> school)
${ROSTER}`;

let client = null;
const getClient = () => (client ??= new Anthropic());

function renderPost(p, i) {
  const meta = [
    `author=@${p.author}${p.authorName ? ` (${p.authorName})` : ''}`,
    p.authorFollowers != null ? `followers=${p.authorFollowers}` : null,
    `posted=${p.createdAt}`,
    p.mentions?.length ? `mentions=${p.mentions.map((m) => '@' + m).join(' ')}` : null,
    p.hashtags?.length ? `hashtags=${p.hashtags.map((h) => '#' + h).join(' ')}` : null,
    p.hasMedia ? 'has_image=true' : null,
  ].filter(Boolean).join(' | ');
  return `<post index="${i}">\n${meta}\n---\n${p.text}\n</post>`;
}

/**
 * @param {Array} posts candidates that survived the rules prefilter
 * @returns {Promise<Map<string, object>>} post id -> verdict
 */
export async function extractBatch(posts, { batchSize = 12, cache } = {}) {
  const out = new Map();
  if (!posts.length || !enabled()) return out;

  const c = cache || new Cache('cache/llm.json');
  const pending = [];
  for (const p of posts) {
    const key = sha1(`${MODEL}|${p.text}|${(p.mentions || []).join(',')}`);
    const hit = c.get(key);
    if (hit) out.set(p.id, hit);
    else pending.push({ p, key });
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const chunk = pending.slice(i, i + batchSize);
    const body = chunk.map(({ p }, j) => renderPost(p, j)).join('\n\n');
    try {
      const res = await getClient().beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: [{
          type: 'text',
          text: SYSTEM,
          // Stable prefix: instructions + roster never change, so every call after the
          // first is a cache hit on ~6k tokens.
          cache_control: { type: 'ephemeral' },
        }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: betaZodOutputFormat(BatchSchema) },
        messages: [{
          role: 'user',
          content: `Extract offer events from these ${chunk.length} posts.\n\n${body}`,
        }],
      });
      const parsed = res.parsed_output;
      if (!parsed) continue;
      for (const r of parsed.results) {
        const entry = chunk[r.post_index];
        if (!entry) continue;
        out.set(entry.p.id, r);
        c.set(entry.key, r);
      }
    } catch (e) {
      // A failed batch must never take the run down. Those posts fall back to their
      // rules-only verdict and are retried next run (they are deliberately not cached).
      console.error(`  [llm] batch of ${chunk.length} failed: ${e.message}`);
    }
  }
  c.flush();
  return out;
}
