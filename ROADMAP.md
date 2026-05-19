# gkall.online — Product Roadmap to Full Launch

**Status as of May 18, 2026:** Prelaunch live. Pioneer Round 1 open.
**Full launch target:** June 1, 2026 (00:00 UTC)

---

## Vision

A skill-based, fair, USDT-paying **all-knowledge challenge** where Pioneers and casual players alike can earn real money for their breadth of knowledge — from pop culture to academic depth. Sponsored by HAG_Ai (initial prize guarantor) and scaling via community sponsorship.

## About HAG_Ai

**HAG_Ai** — A full-fledged **AI-enabled consulting firm**. We build **AI agents for finance functions that move a number**. Eight service lines:

- **Revenue Assurance** — leakage detection · pricing audit · recovery
- **Prediction Service** — Markets · Football · Outcomes (calibrated probabilities, locked logs)
- **Customize ERP** — end-to-end ERP (SAP · NetSuite · Dynamics · Odoo · Sage · custom)
- **Close & Reconciliation** — month-end close · GL recs · financial reporting
- **FP&A and Variance** — forecasting · driver analysis · commentary
- **AP/AR Automation** — invoice capture · 3-way match · collections
- **Internal Control & Audit** — controls design · testing · workpapers
- **Board Packs** — narrative + numbers, ready to ship

Motto: *"The edge is no longer the tool. It is how effectively tools become outcomes."*

- Firm site: **https://hagai.online**
- Consulting inquiries: **hello@hagai.online**
- WhatsApp: **+234 704 491 8728**

gkall.online is HAG_Ai's first public-facing product — used both as a proof-of-craft (engineering quality visible to potential clients) and as a community platform. Public success here de-risks consulting conversations later.

## Social channel strategy

**Phase A (Prelaunch → June 1):** Telegram only. Channel: https://t.me/gkallonline. Auto-announcer bot live.
**Phase B (post-launch, June 1 onward):** Expand to X / Instagram / TikTok / Facebook as operator bandwidth allows. Claim-flow attestation will extend to those channels once they're live.

## Strategic positioning

| What gkall IS | What gkall is NOT |
|---|---|
| Skill-based reward | Lottery / gambling |
| Free to play | Pay-to-win |
| Transparent (public leaderboard, Tronscan-verifiable payouts) | Anonymous / shady |
| Single-prize-per-round | Endless monetization grind |

---

## Phase 1 — Prelaunch (May 18 → May 31, 2026)

**Goal:** Validate gameplay, gather Pioneer feedback, refine before public launch.

### Done
- Site live with full anti-cheat stack (server-side scoring, Cloudflare Turnstile, claim codes, mouse-trail logging)
- 33,186-question pool from 8 free datasets
- $1 instant + $50/$25/$10 monthly prize structure (May guaranteed by HAG_Ai)
- Telegram channel + auto-announcer bot
- Pioneer feedback form
- Email: hello@gkall.online
- Branded as HAG_Ai property

### To do (next 13 days)
- [ ] **Create social handles** (X, Instagram, TikTok, Facebook) — by May 21
- [ ] **Seed Pioneer cohort** — invite 20–50 testers personally — by May 22
- [ ] **First sponsor outreach** to 10–20 crypto / education-adjacent brands — by May 25
- [ ] **Launch countdown posts** to Telegram daily — automated
- [ ] **Collect and review Pioneer feedback** — ongoing
- [ ] **Polish any bugs Pioneers find** — within 48 hours of each report
- [ ] **Finalize June 1 launch announcement** — by May 28

---

## Phase 2 — Full Launch (June 1, 2026)

**Goal:** Move from prelaunch to publicly promoted product.

### Day 1 activities
- 09:00 UTC: launch post on all social channels (X, Instagram, TikTok, Facebook, Telegram)
- 12:00 UTC: May 2026 winners auto-finalized + announced
- 15:00 UTC: HAG_Ai pays out May Top 3 from sponsorship wallet
- 18:00 UTC: First sponsor (if any signed) gets a thank-you post

### Week 1 KPIs to track
- Total plays
- Distinct players (`month_players`)
- 10/10 winners
- Pioneer feedback volume
- Social media follower growth
- Sponsor pool balance

### Week 1 promotional pushes
- Reddit: r/cryptocurrency, r/TronTrx, r/trivia, r/SideProject
- IndieHackers + ProductHunt launch (June 1 or 2)
- Twitter threads on the build journey (engineering, anti-cheat)

---

## Phase 3 — Growth (June 2026 → September 2026)

**Goal:** 1,000 distinct monthly players, 10+ active sponsors, sustainable prize funding.

### Features to build
- **Pioneer #N badge** — first 100 distinct players get a permanent "Pioneer #N" honor on the leaderboard
- **Achievement system** — first 10/10, first 5-day streak, etc.
- **Daily challenge mode** — same 10 questions for everyone that day, separate leaderboard
- **Category-specific events** — "Science Week", "History Weekend"
- **Referral codes** — invite a friend who hits 10/10 → both get $5 bonus
- **Question submission queue** — community submits questions, voted on, top entries enter the pool
- **Multi-currency** — accept USDC, BNB, native TRX as sponsorship in addition to USDT

### Technical hardening
- Move admin UI to a separate subdomain with stronger auth (2FA)
- Add automated SQLite backup to S3/B2 (daily snapshot)
- Add Cloudflare Workers proxy for DDoS resilience
- Implement question-as-image rendering (Tier 2 audit deferred item)

---

## Phase 4 — Scale (October 2026 onward)

**Goal:** 10,000 distinct monthly players. Self-funding prize pool through sponsors.

### Strategic options to evaluate
- **Premium tier** — pay $5/month for unlimited replays, exclusive monthly bonus rounds
- **Team competitions** — Pioneer League (clans of 4–8 players, team monthly prize)
- **White-label** — let brands run their own branded versions ("CryptoIQ", "FinanceQuiz")
- **API access** — paid API for trivia content licensing
- **Mobile app** — native iOS/Android

---

## Success metrics by phase

| KPI | Phase 1 (Prelaunch) | Phase 2 (Launch month) | Phase 3 (Growth) | Phase 4 (Scale) |
|---|---|---|---|---|
| Distinct monthly players | 50 | 500 | 1,000 | 10,000 |
| 10/10 wins | 5 | 50 | 200 | 1,500 |
| Pioneer feedback received | 30 | — | — | — |
| Sponsors signed | 0–2 | 3–5 | 10–15 | 30+ |
| Prize pool funded externally | 0% | 25% | 60% | 100% |
| Social media followers (combined) | 50 | 500 | 5,000 | 50,000 |

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| No Pioneer signups | Direct outreach via X/Telegram crypto communities. Personally invite 50 people. |
| Bot attacks during launch | Turnstile + server-side scoring + per-IP limits already in place. Monitor for anomalies via /api/admin/feedback and /api/admin/claims. |
| Prize pool runs dry | HAG_Ai guarantees May. June onward, only finalize prizes if sponsorship covers. Site is transparent about funded vs guaranteed. |
| Negative AI-cheating narrative on social media | Be open. Publish the audit + Tier 1/2 defenses. Reframe: "the only way to win is actually knowing things". |
| Tronscan / USDT fee changes | Backup plan: accept USDC + USDT, switch network if needed. |
| Cloudflare / Caddy outage | SQLite + Python is portable. Have a recovery doc for "if VPS dies": clone to another VPS, restore from latest backup. |

---

## Decision log

- 2026-05-18: Prelaunch with HAG_Ai guarantee. Full launch June 1.
- 2026-05-18: Prize structure right-sized for prelaunch: $1 instant + $50/$25/$10 monthly. Sustainable on HAG_Ai's solo guarantee (~$85/month base + $1 per 10/10).
- 2026-05-18: Scale-up trigger: when monthly sponsorship hits $500+, restore to original $10 instant + $100/$75/$50 monthly. See SPONSORSHIP.md.
- 2026-05-18: Social media expansion BEFORE sponsor outreach (sponsors want to see audience).
