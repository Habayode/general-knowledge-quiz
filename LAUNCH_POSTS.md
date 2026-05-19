# gkall.online — June 1 Launch-Day Posts (ready to publish)

All posts below are pre-written. On June 1, 2026 (00:00 UTC), copy-paste each
into its platform. Stagger by ~3 hours across the day so they don't all hit at
the same time and crowd each other out.

**Pre-flight checklist** (do May 31):
- [ ] Twitter/X handle `@gkallonline` created
- [ ] ProductHunt account exists, 10+ followers
- [ ] HN account is at least 24 hours old (newer accounts get auto-throttled)
- [ ] OG image renders correctly on https://gkall.online (test with https://www.opengraph.xyz/)
- [ ] First sponsor wallet has at least $200 USDT in it (so when a winner claims, payout is instant — a screenshot of an *actual* paid winner during launch week is worth more than any post)

---

## 09:00 UTC — ProductHunt

**Tagline (60 chars max):**
```
Skill-based quiz that pays in USDT — no signup, anti-cheat
```

**Description (260 chars max):**
```
Answer 10 questions in 10s each. Hit 10/10 → win $1 USDT instantly.
Monthly leaderboard pays $50 / $25 / $10. Server-side scoring,
Cloudflare human-check, claim codes — built like a money game should be.
Free to play. Powered by HAG_Ai.
```

**First comment (post immediately after going live):**
```
Maker here. gkall is HAG_Ai's first public product — we wanted a way
to prove our engineering craft in the open before clients sign NDAs.

A few build details PH might care about:
- 33,000+ questions from 8 free academic datasets (MMLU, ARC,
  OpenBookQA, etc.) ingested into SQLite
- Server-side game sessions — answers never sent to the client,
  so you can't open devtools and cheat
- Per-session option shuffling defeats answer enumeration
- Cloudflare Turnstile at game start, tab-switch & devtools
  detection during play, claim codes with 60+ bits of entropy
- Payouts in USDT on Tron (TRC20), reviewed manually by the operator —
  no auto-payout, but all on-chain verifiable

Happy to answer anything about the anti-cheat stack or the prelaunch
Pioneer program. Feedback shapes what we build next.
```

**Gallery (5 images):**
1. `og-image.png` (hero)
2. Pioneer Pass square (`gkall-assets/pioneer-pass.png`)
3. Pioneer Card portrait (`gkall-assets/pioneer-card-portrait.png`)
4. Vertical explainer (upload as video — PH supports MP4)
5. Anti-cheat stack diagram (TODO if time — otherwise omit)

---

## 12:00 UTC — Hacker News (Show HN)

**Title (80 chars max):**
```
Show HN: gkall – Skill-based USDT quiz with server-side anti-cheat
```

**URL:** `https://gkall.online`

**Text (optional, post as first comment instead — HN convention):**
```
I built gkall to prove HAG_Ai's engineering craft in the open before
client NDAs. The brief was simple: a skill-based quiz that pays real
USDT, where the only way to win is actually knowing things.

Hard parts that were fun:

- Server-side scoring. Game state lives on the server in a SQLite-
  backed session table. The client never sees the correct answer; it
  only sees which letter it picked. Submission is a server check
  against the stored answer, with the question's actual id hashed
  per-session to defeat replay.

- Per-session option shuffling. The four options get reordered via
  Fisher-Yates seeded by secrets.token_urlsafe at session start, so
  two clients on the same question get different "B is correct."

- Anti-cheat overlay. Tab-switch, devtools open, right-click, paste,
  and implausibly-fast answers (<1.5s on HARD) all forfeit the round.
  Caught events are passively logged to a mouse-trail JSON for forensic
  review of monthly winners before payout.

- Claim codes. Winners get a 12-char Crockford-base32 code (60+ bits)
  formatted XXXX-XXXX-XXXX. They submit it on /#claim with a TRC20
  wallet. Payout is manual but on-chain verifiable.

Stack: Python 3.12 stdlib http.server (ThreadingHTTPServer), SQLite
in WAL mode, Caddy v2 reverse proxy with auto-Let's-Encrypt, Cloudflare
Turnstile, ~33k questions imported from MMLU / ARC / OpenBookQA /
CommonsenseQA / TruthfulQA / SciQ / QASC / OpenTriviaDB. No framework
on the frontend — single-page vanilla JS / CSS. ~70 KB index.html.

Free to play. Paid in USDT on Tron (~$0.01 fees). Prize structure:
$1 per 10/10 instant (capped at 3/mo per player) + $50/$25/$10 monthly
top-three. The May pool is guaranteed by HAG_Ai; sponsorship picks up
from June.

The Pioneer prelaunch ran for 13 days with ~50 testers. Today is
public launch. Would love feedback on the anti-cheat surface
specifically — if you find a hole, I'd much rather hear it here than
have it cost a prize pool.
```

---

## 15:00 UTC — Reddit r/SideProject

**Title (300 chars max):**
```
I built a skill-based quiz that pays $1 USDT for every 10/10 — server-side anti-cheat, 33k questions, free to play
```

**Body:**
```
Hey r/SideProject — 14 months of evenings/weekends, today is public launch.

**What it is:** gkall.online — 10 questions, 10 seconds each, multiple
choice. Hit 10/10 in a round and you get $1 USDT (TRC20) on the spot.
Monthly leaderboard pays an additional $50 / $25 / $10 to the top 3.
Free to play. No signup. No deposit. No wallet connect.

**Why I built it:** It's the first public product from my AI consulting
firm (HAG_Ai). Consulting is gated behind NDAs — I wanted something
where every line of anti-cheat code, every payout, and every sponsor
recognition is publicly inspectable. Proof of craft.

**Stack:** Python stdlib http.server, SQLite (WAL), Caddy v2 reverse
proxy, Cloudflare Turnstile. 33k questions ingested from 8 free
academic datasets. Single-page vanilla JS frontend (~70 KB).

**The hardest part:** anti-cheat. The site is paying real money so
"a clever 12-year-old shouldn't break it on day one" was the bar.
What's in production:

- Server-side scoring (game state lives in SQLite, client never sees
  the correct answer)
- Per-session Fisher-Yates option shuffling (so "B is correct" varies
  per player on the same question)
- Cloudflare Turnstile at game start
- Tab-switch + devtools + paste + right-click detection during play
- Floor of 1.5s reaction time on HARD questions
- Claim codes (12-char Crockford-base32, 60+ bits) for identity at
  payout time

Open to feedback — especially from people who've shipped money-paying
side projects and learned what NOT to do. AMA below.

Site: https://gkall.online
Build journal / roadmap: in the GitHub repo linked from the About page
```

---

## 18:00 UTC — Reddit r/cryptocurrency

**Title (300 chars max):**
```
Built a free skill-based quiz that pays USDT (TRC20). No deposit, no wallet connect, no presale. Win up to $51/month for actually knowing things.
```

**Body:**
```
Most "earn crypto" sites are lotteries with extra steps. gkall.online
is the opposite — it's a trivia/knowledge quiz where the ONLY way to
win is by being right on hard questions, fast.

**The mechanic:**
- 10 questions per round, 10 seconds each, multiple choice
- Difficulty climbs as you answer correctly (EASY → MEDIUM → HARD → ELITE)
- Hit 10/10 → instant $1 USDT (capped 3 paid wins per player per month)
- Top 3 of the monthly leaderboard split $50 / $25 / $10
- Free. No signup. No wallet connect. No deposit. No referral pyramid.

**Why it's not a scam (the unpleasant part of any "earn USDT" post):**
- May 2026 prize pool is guaranteed by HAG_Ai (the consulting firm
  that built it) regardless of donations
- Every payout is on Tron (TRC20) and on-chain verifiable
- Wallet is public on the Sponsor page — you can watch the pool
- The site is publicly inspectable: anti-cheat code, claim codes,
  sponsorship wall, manual-review payout flow
- I'm the operator and I'm putting my name behind it. Twitter / Telegram
  in profile

**What you should know before playing:**
- It's HARD. The question pool is from MMLU, ARC, OpenBookQA, TruthfulQA,
  SciQ, QASC etc. — actual academic benchmarks. 10/10 is uncommon.
- Anti-cheat is real. Tab-switch, devtools, paste, right-click, or
  super-fast HARD answers forfeit the round. Don't try to script it.
- TRC20 only. Tron fees are basically free; ERC20 wasn't feasible.

Site: https://gkall.online (Telegram: t.me/gkallonline)

Not affiliated with any token. No presale. Nothing to buy. AMA.
```

---

## 21:00 UTC — Reddit r/passive_income

**Title (300 chars max):**
```
I built a free quiz site that pays real USDT for skill — not a "passive" income source, but possibly the most honest "earn while doing X" I've seen
```

**Body:**
```
Disclaimer up front: this is **not passive**. You actually have to know
things and answer fast. I'm posting it here because it's the most
honest "earn money for X" mechanic I've encountered, and r/passive_income
tends to see the most scams.

**What gkall.online is:**
- A free, no-signup quiz that pays in USDT (Tron / TRC20)
- 10 questions, 10s each, multiple choice
- Hit 10/10 → $1 USDT instant (up to 3 paid wins / player / month)
- Top 3 of the monthly leaderboard → $50 / $25 / $10

Max realistic earnings: ~$53/month for someone consistently hitting
10/10 and finishing top of the leaderboard. That's lunch money, not
rent money — and that's the point. It's deliberately not lottery-sized
so the incentive is "play because it's fun + small reward" not "play
because I might get rich."

**Why I'm telling r/passive_income about a non-passive thing:**
Because subscribing to my no-effort-passive-money guides is the scam
flavor of the year, and I think we should be honest about what we
actually pay people for.

Built by my AI consulting firm (HAG_Ai). May 2026 prize pool is
guaranteed by us regardless of sponsorship. Payout is on Tron, on-chain
verifiable.

https://gkall.online
```

---

## Post-launch follow-up (June 1, 22:00 UTC)

When the first 10/10 winner of the public launch day comes in:

1. Take a screenshot of their leaderboard row + the Tronscan transaction page showing the USDT payout to their wallet
2. Get their consent for a public mention (Telegram DM works)
3. Compose a single tweet / Telegram post / Reddit update reply with:
   - The screenshot
   - "First public-launch-day winner: @<handle> · $1 USDT · paid in N minutes"
   - Tronscan link to the transaction
4. Reply to every launch-day post above with that artifact

This single artifact will outperform every paragraph of copy above.

---

## DO NOT do on launch day

- Don't crosspost identical text across multiple subreddits — Reddit's
  anti-spam catches this. Each post above is intentionally different.
- Don't reply to your own posts with sock accounts to "warm them up."
  Mods catch it and shadowban.
- Don't argue with skeptics about "is this gambling." Link the FAQ
  ("Why TRC20 / Is this gambling / Can I lose money playing") and
  move on. The skeptics aren't your buyers.
- Don't share the admin token / wallet private key anywhere. Public
  wallet address is fine; private key never leaves the operator
  hardware.
