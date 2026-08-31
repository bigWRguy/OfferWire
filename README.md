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

The current X session was measured rate-limiting on request 37 in a 15-minute window.
OfferWire stops at 36. While the one-time baseline is incomplete it reserves 80% for
history; as soon as the queue empties all 36 requests automatically return to live work.
Live latency is intentionally reduced during this short bootstrap period.

| Sessions | Full sweep of all 136 schools |
|---|---|
| 1 | ~75-90 min |
| 2 | ~45 min |
| 3 | ~30 min |
| 4 | ~15-30 min |
| 6 | ~15 min |

`node scripts/coverage.mjs N` prints this for your actual config. Running out of budget
mid-sweep is normal and is reported as such — it is not treated as a failure.

**What the Actions coverage gate means.** The workflow's `verify coverage` step fails the
run only when the wire is genuinely **broken** — search not configured, a warm run that
burned requests but swept nothing (dead / fully rate-limited session), or incomplete
offers published (a data-integrity bug). *Latency* is not a failure: staleness beyond the
current budget's expected envelope (backfill bootstrap, or busy programs whose watermark
legitimately trails a page behind wall-clock because they flood faster than one page per
sweep) prints an amber `coverage:` warning instead of red, because it loses nothing and
recovers on its own. If you want a hard ceiling anyway, set `OFFERWIRE_STALE_CEILING_H`
(a repo variable; default 48h): more than 20 schools beyond it fails the run. To actually
reduce latency, raise `OFFERWIRE_SCROLLS` (read more pages per sweep — the busy-program
case) or add sessions (`node scripts/coverage.mjs N`).

### Historical backfill

`OFFERWIRE_BACKFILL_DAYS=30` adds one fixed 30-day window per school: **136 initial
queries instead of 4,080 empty-heavy school-day queries**. A busy school's window
paginates backward with a persisted cursor; an empty school completes in one request.
Every successful window is marked complete and every failed or unreadable X response
stays pending. With one credential the initial pass takes about five quota windows plus
whatever pagination busy programs require—normally hours rather than days. The window
is anchored so completed work cannot slide out as dates advance.

The live workflow assigns 80% of quota to history until all school-windows are complete,
then automatically spends 100% on live coverage. The separate backfill workflow remains
manual-only because scheduling it beside the live job would compete for the same X
quota. `OFFERWIRE_BACKFILL_CHUNK_DAYS` defaults to 30; smaller chunks are a fallback if
X ever stops honoring cursor pagination.

To deliberately restart the baseline, set
`OFFERWIRE_BACKFILL_ANCHOR=<YYYY-MM-DD[T]HH:mm:ssZ>`. New window keys are idempotent:
already-seen post IDs and offer keys prevent duplicates.
A built-in 15-day grace (`OFFERWIRE_BACKFILL_GRACE_DAYS`, default 15) keeps even the
oldest slice of an anchored window eligible for the ledger for the whole drain, so
backfilled posts are never thrown away for being old on arrival.

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

GitHub documents that scheduled Actions may be delayed or dropped. OfferWire therefore
ships a Netlify Scheduled Function at :10, :25, :40 and :55 as a fallback. For a private
repository, create a fine-grained GitHub token scoped only to `bigWRguy/OfferWire` with
**Actions: read and write**, then add it in Netlify as the secret environment variable
`GITHUB_DISPATCH_TOKEN` and redeploy. The function checks for a run in the preceding ten
minutes before dispatching, and the workflow independently skips duplicate collectors.

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

Class-year precision, every rule below written against a live mis-file:
- **Award/season years are masked before class extraction** — `All State '25`, `2025 1st
  Team All District`, `National Champs '22` date an honor, not the recruit. Without the
  mask a 2028 kid whose bio read "San Ramon Valley 2028 … Soph All State '25" was filed
  as class of **2025**. `maskAwardYears` is shared with `findClassYear` so post text and
  bios behave identically.
- **School-suffix and bare-`Class` shorthands are classes** — `Marysville HS 28`,
  `Milton HS l 29 OL`, `Class 28`, `University HS *28`. A `#` between the school name
  and the number (a jersey) never is.
- **`RT`/`LT`/`RG`/`LG` are real positions in a bio** — `C/28 6-3 280 RT/G` is a
  tackle. They stay out of post-text scanning, where `RT` means retweet.
- **A handle that ends in a class year is the class**, used last — `coltonfitz2028`,
  `landonghea2029`, `c_burris2028` — when the text and bio both omit one.

**Recruit filter** (`looksLikeRecruit`) — rules-only mode's guard against attributing an
offer to a coach, an agency, or a basketball player. Measurables take precedence over
keyword rejection, because a real recruit crediting `Head Coach @basorecoach` in his bio
was being thrown out as a coach. A self-announcement must additionally show a **football
token** — a position, or football language (`football`, `FB`, `FBU`, 🏈), or a 40-yard
time — so a bare stat-block bio that could be basketball ("5'11 · G/F · 4.0 GPA") stays
out of the wire while "Football/Track Star" and "FBU All American" bios get in.
"Flag football" counts only when the same bio shows tackle evidence (a position or 40).
A bio that names an unambiguous football position code (`ATH`, `WR`, `OL`, `DL`, …)
is football context for sport disambiguation even when the word "football" is absent —
bare **"Guard"** is ambiguous (an OL position as much as a basketball one), and an
`ATH | Guard` bio announcing an `@SMUFB` offer was silently dropped as "different sport"
until presence of `ATH` settled it. (`C` and `S` are deliberately not counted: `C/O`
and `'s` are everywhere.)

**Recap posts are fatal, not just taxed.** "He Has Offers From The Duke Blue Devils,
Maryland Terrapins, Appalachian State Mountaineers, & More" is existing offer inventory,
not a new offer event — highlights accounts post this shape constantly, and a recap whose
schools happen to resolve to one FBS program filed fabricated rows. When a post's only
offer language is a state-of-recruiting recap (has/have/holds/boasts offers from) it is a
hard negative; the same sentence survives only when a *new-offer verb* (received, was
offered, picked up, landed, earned) is present, so a recruit announcing a fresh offer with
a recap tail is not lost. Corollary: **a high school is never a player.** The prose-name
grammar could grab "Evans High School" out of a highlights recap and publish the school as
the recruit; institutional-school tokens kill the capture. And team accounts are filtered
by DISPLAY NAME as well as handle ("EHigh Trojans Football" rides @ehstrojanftbl, which
contains no "football"), so the tagged recruit is found instead of the post being judged
ambiguous.

**A non-FBS institution as the offer source is a veto.** "Blessed to receive an offer from
Community Christian College! … Go cyclones!" names a small non-FBS college as the offer;
the trailing cheer resolves to Iowa State (the Cyclones) and filed a fabricated P4 offer.
When the offer verb attaches to an institution-shaped name (…College / …University /
…Academy / …Institute) that contains **no FBS school surface**, the post is not reporting
an FBS offer and is rejected — a cheer in it can never be read as the target. It is
deliberately attached (must sit directly after "offer from"/"offered by"), so a bare
mention of a college elsewhere never vetoes a real FBS offer, and an FBS school named as
"X University" (Auburn University, Western Kentucky University) is never vetoed.

**Player identity** (`src/resolve/players.js`) — never merges on name alone. A merge needs
the name *plus* corroboration (handle, high school, class, state, position); any hard
conflict blocks it. Ambiguity creates a new record and logs to `data/review.ndjson`.
Duplicates are recoverable; wrong merges are not.

---

## Operating it

```bash
npm run wire         # one full cycle
npm run health       # live search probe, per-school staleness, session validity
npm run selftest     # offline parser/resolution/backfill assertions
node scripts/coverage.mjs 3    # latency math for a 3-session pool
node scripts/fixture-run.mjs   # ledger: dedupe, corroboration, offer dating
node scripts/replay.mjs        # re-extract the archive offline (no search budget spent)
npm run rebuild      # deterministically regenerate ledgers from the raw archive
npm run plan-lists             # optional corroboration Lists
npm run audit        # committed-audit-trail summary + every rejected candidate grouped by reason
```

`npm run rebuild` uses the newest archived evidence timestamp as its replay clock, so
running it twice against the same archive produces byte-for-byte identical artifacts.

`npm run health` is the one to run when the wire looks quiet — it separates "nothing is
happening" from "the session died".

### Auditing and improving extraction

`npm run audit` is the "what are we missing?" command, and it is the loop you are
supposed to run:

1. `scripts/audit.mjs` reads the committed per-run trail (`data/audit/*.ndjson` — every
   run appends its funnel, rejection-reason census with capped samples, and search
   health) and prints the trend. Reasons tagged **recruit-shaped** are the ones where a
   post *read* like a real player being offered but a field the rules insist on was
   missing — the false-negative candidates.
2. `scripts/replay.mjs --rejected` re-extracts the raw archive through the *current*
   code (no search budget, no drift from `src/pipeline.js`) and prints every rejected
   candidate grouped by reason, recruit-shaped misses first with author and bio, so you
   can see exactly what got dropped and why.
3. Fix the rule, re-run `node scripts/replay.mjs` and compare the funnel — a change is
   good when the recruit-shaped counts fall and the accepted count rises without a jump
   in the noise buckets. Then `npm run rebuild` to fold the fix into the committed
   ledger.

Because `data/audit/` is committed, `git log data/audit/` is a permanent, diffable
history of what the wire saw and threw away since day one.

---

## Data

| File | Contents |
|---|---|
| `data/offers.json` | The ledger. One row per (player, school) with every post reporting it. Each row carries a `tier` (`P4`/`G5`). |
| `data/players.json` | Resolved identities, bios, mined measurables, and evidence-backed `offerCounts` (total / P4 / G5). |
| `data/state.json` | Per-school watermarks, completed backfill slices, rate budget. |
| `data/watchlist.json` | Recruit handles discovered by the wire, scored and promoted. |
| `data/review.ndjson` | Ambiguous merges for human review. |
| `data/raw/*.ndjson` | Every post collected, for replay and backtesting. |
| `data/audit/*.ndjson` | Per-run funnel, rejection reasons, and representative samples. |

Offers are dated to the **earliest** post reporting them — a reporter recapping three
days later must not reset the clock.

**P4 vs G5.** Schools tier automatically by conference: ACC / Big Ten / Big 12 / SEC plus
Notre Dame are **Power 4**; AAC / C-USA / MAC / Mountain West / Sun Belt and the other
independents are **Group of 5**. Every offer row is tagged `tier`, and per-player
`offerCounts` (total / P4 / G5) are evidence-backed ledger totals. The site shows observed offer history and does not claim any offer was a player's first.

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
