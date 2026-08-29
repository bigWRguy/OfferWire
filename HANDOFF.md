**Netlify:** https://scintillating-lollipop-09797d.netlify.app — **drag-and-drop deploy,
NOT linked to the repo.** It does not auto-update. See "Blocker 3".

---

## Rescue status — 2026-08-29 (evidence-backed)

The fixes below this header are now **committed and pushed to `origin/main`
(`95687e6` on 2026-08-29)** and **re-verified offline against the real 3-day archive**:

- Replayed all **1379 archived posts** (`data/raw/2026-08-27..29.ndjson`) through the
  current pipeline: **30 offers, 30 players, 0 garbage.** The basketball rows, the "The
  Associated Press", "Gabrielle Giffords", and the null-name/no-class/no-position offers
  the wire had been committing are gone. The frontend now renders all 30 rows (every one
  has a player name, class year, and FBS position).
- The commit also ships `.gitattributes` (pin line endings to LF so the Windows checkout
  stops making every diff look like a full rewrite) and `scripts/build-status.mjs`.
- **The next scheduled GitHub Actions run will run this pushed code**, so the ledger
  stays clean instead of regressing to the 185-row garbage it was producing.

**What is still a human action, and only a human can do it:**

1. **Netlify** — the live site is still the frozen 2026-08-27 drag-and-drop snapshot.
   It will **not** update from git until you either
   (a) add `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` as repo secrets (the workflow's
       "deploy directly to Netlify" step then deploys `site/` every run), or
   (b) link the repository in Netlify (build command already set in `netlify.toml`).
   `netlify.toml` build = `node scripts/build-status.mjs && node scripts/build-site.mjs`.
2. **Throughput** — with a single X session the sweep reaches only a fraction of the 136
   FBS schools per run, so the workflow's coverage gate will stay red (honest, not
   broken) until you add more sessions via `X_SESSIONS`. `node scripts/coverage.mjs N`.

---