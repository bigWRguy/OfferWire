# OfferWire

An FBS offer wire built on **targeted per-school search of X**. Every one of the 136 FBS
programs gets its own query, run on a loop, asking X directly: who has this school
offered since the last time I looked.

That construction is the point. **Recruits announce their own offers** — schools can't,
NCAA rules forbid publicising recruits. So the offer exists on X the moment a kid with
40 followers posts "Blessed to receive an offer from @AlabamaFTBL", hours or days before
a service writes it up. Search is the only way to reach that post. Following accounts
only ever shows you what people you already follow chose to say, which is the coverage
the services already have.

Compute is GitHub Actions. The database is this repo — each run commits `data/`, so
`git log data/offers.json` is a permanent record of when every offer was first seen and
from which post. Netlify serves `site/` as a static drop-in.

## Deployment (how the site goes live)

The live site **is not** automatically refreshed from git until one of these is done
(only the site owner can do it):

1. **Add Netlify deploy secrets** to this repo: `NETLIFY_AUTH_TOKEN` (a Netlify personal
   access token) and `NETLIFY_SITE_ID`. The `wire` and `backfill` workflows then run
   `netlify-cli deploy` against `site/` after every successful run.
2. **Or link the repository in Netlify** (Site → Build & deploy): publish dir `site`,
   build command `node scripts/build-status.mjs && node scripts/build-site.mjs`
   (already set in `netlify.toml`).

Until either is done the site will keep showing whatever was last dragged into Netlify.

Verified live on 2026-08-27: a single sweep surfaced a 2028 RB's own announcement
(`@jaymitch_1`, "#AGTG … blessed to receive an offer from Unive[rsity of Alabama]"),
corroborated within the same sweep by two independent reporters.

---

## How it gets the data

X gates its search endpoint (`SearchTimeline`) behind a per-request signed header,
`x-client-transaction-id`, computed in their JavaScript. Measured on one session, same
cookies, same minute:

| Request | Result |
|---|---|
| `UserTweets` (unsigned) | **200**, 218KB of posts |
| `SearchTimeline` (unsigned) | **404**, empty |
| `SearchTimeline` (forged signature, several lengths) | **404**, empty |

So OfferWire **drives a real browser** and lets X's own client sign its own requests,
reading the resulting JSON off the wire. Nothing X protects is reimplemented, which also
means there is nothing to repair when they rotate the algorithm.

Everything else that was tried and ruled out, so nobody re-treads it:

| Surface | Result |
|---|---|
| X API free tier | 100 posts/month. Unusable. |
| `api.x.com/1.1/search/tweets.json` | **Removed** (404, code 34) |
| Nitter, entire public pool | **Dead** — 410 / 403 / whitelist-gated |
| Guest token + GraphQL `SearchTimeline` | Not served to guests |
| `Followers` (for graph-crawling recruits) | **404** — gated |
| `cdn.syndication` **profile** widget | Per-account cached, often frozen — `@Hayesfawcett3` was **10 months** stale while `@TexasFootball` was current. Not bustable. |
| `cdn.syndication` **list** widget | Works, ~68 posts / ~78 authors, live. Used for corroboration only. |

---

## Coverage: latency, never completeness

The sweep is **incremental and watermarked**. Every school carries its own `since_time`.
A school swept 40 minutes ago asks for the last 40 minutes; one swept 4 hours ago asks
for the last 4 hours.

**So pool size buys latency, not completeness.** If the budget only reaches 60 schools
this cycle, the other 76 keep their older watermark and go first next cycle with a wider
window. Nothing is skipped. If a school's results overflow the page budget, its watermark
advances only as far as was actually read — never to "now" — so a busy program cannot
silently lose a day.

Rate limit is ~50 search requests per 15-minute window per account. OfferWire spends a
conservative 45, reserving 75% for 164 live jobs and 25% for history while backfill is
incomplete. Against the four quarter-hour triggers, one session therefore needs roughly
75 minutes for a live pass; after backfill completes, it needs roughly 60 minutes.

| Sessions | Full sweep of all 136 schools |
|---|---|
| 1 | ~60-75 min |
| 2 | ~30-45 min |
| 3 | ~30 min |
| 4 | ~15-30 min |
| 6 | ~15 min |

`node scripts/coverage.mjs N` prints this for your actual config. Running out of budget
mid-sweep is normal and is reported as such — it is not treated as a failure.

### Historical backfill

`OFFERWIRE_BACKFILL_DAYS=30` adds one job per school per past day (136 × 30 = 4,080
slices), so the ledger starts populated instead of empty. Slices are fixed date windows,
resumable, and marked complete once done. Each live run assigns 25% of its search quota
to history. With one session and reliable quarter-hour starts, the initial month drains
in roughly four days. The separate backfill workflow is manual-only because scheduling
it beside the live job would make both jobs compete for the same 15-minute X quota.

---

## Setup

### 1. Session cookies (required)

From a logged-in browser on x.com: DevTools → Application → Cookies → `https://x.com`,
copy **`auth_token`** and **`ct0`**.

Set as GitHub repo secrets `X_AUTH_TOKEN` and `X_CT0`. Pool several accounts with
`X_SESSIONS=tok1:ct01,tok2:ct02` — budget scales linearly.

Be clear-eyed: automated reading with a session cookie is against X's terms, and the
account carrying it can be rate-limited, locked, or suspended. Use a secondary account
you can afford to lose.

### 2. Push and enable Actions

Four explicit hourly cron entries run `.github/workflows/wire.yml` at :07, :22, :37,
and :52; the workflow installs Chromium and commits the ledger
**first**, then fails the run if the engine is genuinely broken — so a dead session is
loud in the Actions UI instead of showing green while coverage collapses. A cold ledger
gets a warm-up grace period so the first runs don't false-alarm.

### 3. Netlify

Point Netlify at the repo. `netlify.toml` publishes `site/`; the build is a file copy.
Each wire commit triggers a redeploy.

### 4. Optional: `ANTHROPIC_API_KEY`

Adds an LLM adjudication pass. **Not required** — extraction is fully deterministic
without it. Turn it on only if you want extra recall on unusual phrasings.

---

## The extraction chain

**Rules prefilter** (`src/extract/rules.js`) — deterministic, recall-oriented. Kills
commitment posts, offer-list recaps, walk-on offers, throwbacks and hypotheticals before
they cost a token.

**Player identification is deterministic.** X's payload carries the DISPLAY NAME of every
tagged account, so when a reporter writes *"2028 RB Jayshawn Mitchell (@JAYMITCH_1)
brings in an Alabama offer"*, the recruit's real name is already in the data — nothing is
inferred. Three paths, most reliable first:

1. **Tagged recruit** — exactly one tagged account that is neither a school nor a known
   media outlet. Yields handle *and* real name. Confidence 0.6.
2. **Reporter grammar** — fixed patterns around the offer verb, after stripping star
   ratings, rank noise and emoji, with a leading position token peeled off the capture
   (`ATH Marcus Lee` → `Marcus Lee`). Confidence 0.5.
3. **Self-announcement** — the author *is* the recruit, and their bio must pass the
   recruit filter. Confidence 0.45.

Ambiguity never becomes a guess: two unknown tagged accounts means no attribution at all.
Bare mentions are archived but never published in rules-only mode; they require LLM
adjudication because a tagged account alone proved too noisy in the live archive.

**LLM extraction** (`src/extract/llm.js`) is an optional extra pass, inert unless
`ANTHROPIC_API_KEY` is set. Its system prompt carries all 136 schools and is byte-stable
so prompt caching makes it cheap, and verdicts are hash-cached so no post is paid for
twice. It only adds recall on phrasings the grammars miss.

**School resolution** (`src/resolve/schools.js`) — handles, names, nicknames,
abbreviations, camelCase hashtags. Longest-form-first *with span consumption*, so
"Michigan State" cannot also fire "Michigan". Ambiguous surfaces — `USC`, `Miami`, `OSU`,
`MSU`, `UW`, bare `Tigers` — are **never guessed**: they resolve only on evidence
independent of the ambiguous token, otherwise the LLM arbitrates.

**Bio mining** (`parseBio`) — a self-announced offer carries the author's bio, and
recruits format them almost identically: `C/O 28 Cache HS |#7| 6'2 180 | 4.35 40`. Class,
position, height, weight, 40, stars, GPA, state and high school, free, from the same
request. Three traps are handled explicitly, each found in live data:
- **`FB` means FOOTBALL, not fullback** in almost every recruit bio
- **`NCAA ID:2602827047`** parses as the state of Idaho unless stripped
- position tokens hide inside handles — `@ByronNelsonFB` is a school, not a fullback

**Recruit filter** (`looksLikeRecruit`) — rules-only mode's guard against attributing an
offer to a coach, an agency, or a basketball player. Measurables take precedence over
keyword rejection, because a real recruit crediting `Head Coach @basorecoach` in his bio
was being thrown out as a coach.

**Player identity** (`src/resolve/players.js`) — never merges on name alone. A merge needs
the name *plus* corroboration (handle, high school, class, state, position); any hard
conflict blocks it. Ambiguity creates a new record and logs to `data/review.ndjson`.
Duplicates are recoverable; wrong merges are not.

---

## Operating it

```bash
npm run wire         # one full cycle
npm run health       # live search probe, per-school staleness, session validity
npm run selftest     # 97 offline assertions
node scripts/coverage.mjs 3    # latency math for a 3-session pool
node scripts/fixture-run.mjs   # ledger: dedupe, corroboration, offer dating
node scripts/replay.mjs        # re-extract the archive offline (no search budget spent)
npm run plan-lists             # optional corroboration Lists
```

`npm run health` is the one to run when the wire looks quiet — it separates "nothing is
happening" from "the session died".

---

## Data

| File | Contents |
|---|---|
| `data/offers.json` | The ledger. One row per (player, school) with every post reporting it. |
| `data/players.json` | Resolved identities, bios, mined measurables. |
| `data/state.json` | Per-school watermarks, completed backfill slices, rate budget. |
| `data/watchlist.json` | Recruit handles discovered by the wire, scored and promoted. |
| `data/review.ndjson` | Ambiguous merges for human review. |
| `data/raw/*.ndjson` | Every post collected, for replay and backtesting. |

Offers are dated to the **earliest** post reporting them — a reporter recapping three
days later must not reset the clock.

---

## Known limits

- **Session cookies expire.** `npm run health` reports it; refresh the secrets.
- **Unusual phrasings still slip through.** The grammars cover the forms that dominate
  real offer posts, but recruiting language mutates. `node scripts/replay.mjs --rejected`
  re-extracts the archive offline so you can see exactly what was dropped and why, then
  fix a pattern and re-measure without spending a single search request.
- **No image OCR.** A pure graphic with no caption and no tags is invisible. Most offer
  graphics carry one or the other, so this is a minority loss — but a real one.
- **Signing-day volume.** When every school bursts at once, page budgets truncate more
  often. Watermarks keep it correct, but raise `OFFERWIRE_SCROLLS` and add sessions
  before December.
- **Offer dating is post dating.** We record when an offer was *reported*.
