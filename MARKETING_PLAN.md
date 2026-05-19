# gkall.online — Marketing Plan (Prelaunch → Launch → Growth)

**Owner:** HAG_Ai
**Period:** May 18 – June 30, 2026

---

## Brand identity (use consistently across all channels)

- **Name:** gkall (lowercase) — short for "**all knowledge** for all"; positioned as the **All-Knowledge Challenge**
- **Tagline:** "Win up to $51 USDT for what you know."
- **Voice:** Confident, transparent, lightly playful. Never spammy, never crypto-bro.
- **Visuals:**
  - Primary color: gold (`#f5c451` → `#ffae3a` gradient)
  - Background: deep navy / black
  - Font: Space Grotesk (headlines), Inter (body)
- **Logo:** "G" badge — gold gradient square with rounded corners, bold black "G"

---

## About HAG_Ai (operator)

**HAG_Ai** — A full-fledged **AI-enabled consulting firm**. AI agents for finance functions that move a number. Eight service lines: Revenue Assurance · Prediction Service (Markets · Football · Outcomes) · Customize ERP · Close & Reconciliation · FP&A & Variance · AP/AR Automation · Internal Control & Audit · Board Packs.

- Firm site: https://hagai.online
- Consulting: hello@hagai.online
- Motto: *"The edge is no longer the tool. It is how effectively tools become outcomes."*

gkall.online is HAG_Ai's first public-facing product. Every line of code, every payout, every sponsor recognition is public — proof of craft for consulting prospects who want to see real engineering before signing an NDA.

## Phase A — Telegram-first (NOW through June 1)

For prelaunch, **Telegram is our only active social channel.** It's already live with bot auto-announcer. Pioneer outreach and sponsorship pitches drive players here:

- Channel: https://t.me/gkallonline
- Bot: @ALLKNWNG_BOT (auto-posts 10/10 wins, monthly winners, sponsor thanks)
- **Daily prelaunch countdown posts run automatically** May 19–June 1 (already seeded in DB; cron hourly check)

**Why Telegram first?** Crypto/Web3 audiences live there. The bot does the work autonomously. We can prove value without spreading thin across X / IG / TikTok / FB which need real-time human posting.

## Phase B — Multi-channel social rollout (post June 1)

Once we have early winners, sponsor proof, and Pioneer testimonials, we expand to:

| Platform | Handle to claim | Bio (copy/paste) |
|---|---|---|
| **X / Twitter** | `@gkallonline` (or `@gkall_official`) | "The All-Knowledge Challenge. Win up to $51 USDT (Tron / TRC20) for breadth across every domain — pop culture to academic depth. Powered by HAG_Ai. https://gkall.online" |
| **Instagram** | `@gkall.online` (or `@gkallofficial`) | "🧠 Test your knowledge. Win USDT. \| 10 Qs · 10s each · $1 instant + $85 monthly pool \| Live: gkall.online" |
| **TikTok** | `@gkall.online` | "Quiz · 10 questions · 10 sec each · Win up to $51 USDT 🏆 \| gkall.online" |
| **Facebook Page** | `gkall.online` | Same as X bio. |
| **Reddit** | `u/gkall_official` (personal account, post in trivia/crypto subs) | "Founder of gkall.online — skill-based USDT quiz." |
| **YouTube** | `@gkallonline` (for short-form, future) | Same as X bio. |

### Profile picture / banner
- **PFP:** the gold "G" mark (same as site brand-mark)
- **Banner:** "Win up to $51 USDT for what you know · gkall.online · Powered by HAG_Ai" on the navy-to-gold gradient

I can generate these images on request — say "build me the brand assets" and I'll produce PNG/SVG.

### Linking the accounts
Once each is created, paste the URL into your VPS env vars so the site footer auto-shows them:

```powershell
[Environment]::SetEnvironmentVariable('SOCIAL_TWITTER',   'https://twitter.com/gkallonline', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_INSTAGRAM', 'https://instagram.com/gkall.online', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_TIKTOK',    'https://tiktok.com/@gkall.online', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_FACEBOOK',  'https://facebook.com/gkall.online', 'Machine')
Stop-ScheduledTask QuizApi -EA SilentlyContinue
Get-Process python -EA SilentlyContinue | Where-Object { $_.Path -like '*Python312*' } | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 3
Start-ScheduledTask QuizApi
"social handles wired"
```

Once these env vars exist, the site footer + Sponsor + Feedback page show the social media icons automatically.

---

## Content calendar — Prelaunch (May 18–May 31)

13 days × 1 post/day per platform = 52 posts. Below is a thematic schedule. Copy-paste, customize, post.

| Day | Theme | Post idea (X, paraphrase for IG / TikTok) |
|---|---|---|
| May 18 (Sun) | **Launch declaration** | "We're live in prelaunch. 33,000+ questions. $1 USDT for every 10/10. $85 monthly pool for top 3. May guaranteed by HAG_Ai. → gkall.online 🚀" |
| May 19 (Mon) | **The first $1 winner** (or honor of trying) | "Day 2 of prelaunch. First Pioneer completed a round — feedback already shaping v1.1. Want in? gkall.online" |
| May 20 (Tue) | **Behind the build** | "Why our quiz can't be cheated by AI extensions: 1) Server-side scoring 2) Cloudflare Turnstile 3) Per-session option shuffling. Knowledge wins, scrapers lose. 🔒" |
| May 21 (Wed) | **Sponsorship call** | "Sponsors wanted. $50–$5,000 USDT, your brand on the winners post, public sponsor wall. DM or hello@gkall.online" |
| May 22 (Thu) | **Question sample** | "Today's hardest question on gkall (yesterday's hardest tier): 'Which Dutch post-Impressionist famously cut off part of his own ear?' Think you know? Play → gkall.online" |
| May 23 (Fri) | **Pioneer spotlight** | "Shoutout to our first Pioneer cohort. 30+ rounds played, 12 feedback items received. Bugs squashed, ideas in the backlog." |
| May 24 (Sat) | **Game mechanics** | "How it works: 10 questions. 10 seconds each. Difficulty climbs. Tab-switch = game over. Skill only." |
| May 25 (Sun) | **Why USDT / Tron** | "Why USDT on Tron? Transfer fee ≈ $0.001. More of every sponsor dollar reaches winners. Most blockchains lose 1–10% to gas." |
| May 26 (Mon) | **Anti-cheat deep dive** | "Anti-cheat layer #1: server-side game sessions. Your browser never sees the answer. Even with devtools, you can't cheat. We built it after our own audit. 🛡️" |
| May 27 (Tue) | **Pioneer push** | "1 week to launch. We're seeking 50 more Pioneers before June 1. Play → win → tell us what to fix. Free + sponsored. gkall.online" |
| May 28 (Wed) | **Telegram channel push** | "Join our channel for live winner announcements + drops. https://t.me/gkallonline" |
| May 29 (Thu) | **Knowledge domains** | "Categories on gkall: Sport · Science · History · Religion · Music · Art · Movies · Literature · Geography · Food · Animals · Lifestyle · MMLU's 57 academic subjects. If it's known, it's in here." |
| May 30 (Fri) | **Final 24 hr countdown** | "T-24 hours to public launch. June 1 = first Top 3 announced. May Pioneers locked in. Last call to join the leaderboard before everyone sees it. ⏰" |
| May 31 (Sat) | **Launch eve** | "Tomorrow we go fully public. May 2026 winners decided at midnight UTC. $50/$25/$10 USDT. Pioneers, this is your last chance to climb." |

---

## Launch day — June 1, 2026

### 09:00 UTC — "Public launch" post (all platforms, simultaneous)
> 🚀 gkall is officially LIVE.
>
> Win $1 USDT for every 10/10 round + an $85 monthly prize pool for the top 3. Skill only. Anti-cheat verified. Paid on Tron (TRC20).
>
> May 2026 winners announced today.
>
> Try your knowledge → https://gkall.online
>
> #USDT #Trivia #Crypto #SkillBased #GeneralKnowledge

### 12:00 UTC — "May winners announced"
Server auto-posts to Telegram. Within an hour, copy that announcement to X / IG / TikTok with screenshots of the Past Winners page.

### 18:00 UTC — Founder thread on X
A behind-the-scenes thread: why we built gkall, how the anti-cheat works, how sponsorship enables real payouts. End with: "Reply 'Pioneer' to get a personally curated invite to the next round."

### Reddit on launch day
Post in r/SideProject (Show your work), r/cryptocurrency (Discussion flair), r/Tronix, r/trivia. Personal account, transparent about being the builder. No spam — answer questions in comments.

---

## Sponsorship outreach script (for cold DMs / emails)

**Subject:** Brief - sponsor a skill-based USDT quiz, ~$50/mo for top-3 placement

**Body:**

> Hey [Name],
>
> I'm running gkall.online — a skill-based **all-knowledge challenge** that pays winners in USDT (TRC20). Currently in prelaunch with 33K+ questions spanning pop culture to academic depth, anti-cheat enforced, with an $85 monthly prize pool guaranteed by HAG_Ai for May.
>
> For June onward we're opening to sponsors. $50–$5,000 USDT range. Sponsorship gets you:
> - Logo + link on the Sponsor wall (every visitor sees it)
> - Mention in every winner announcement (Telegram channel growing daily)
> - Optional "Sponsored by X" tag on the monthly prize for the month you fund
>
> [Site] gkall.online · [Channel] t.me/gkallonline · [Contact] hello@gkall.online
>
> Worth a quick conversation?
>
> — [Your name], HAG_Ai

Send to 20–30 contacts. Aim for 3–5 replies, 1–2 closes by end of May.

---

## "Follow & like" mechanism for participants/winners

This is enforced in the **claim flow**, not the play flow. We want everyone to be able to play, but require social engagement to *get paid*.

On the claim form for both **$1 instant** and **$50/$25/$10 monthly**, the winner must:
- Tick a checkbox attesting they have **followed all linked gkall social accounts**
- Tick a checkbox attesting they have **liked the latest pinned post on each**

You verify manually before paying — open the social profile, look for their handle in followers. If they're listed, pay. If not, reply "please follow + like + retry the claim" and re-issue.

The site shows this requirement upfront on the rules page and the claim form, so no one is surprised.

(Site code change implementing this is in place — see commit history.)

---

## Engagement metrics to track per post

| Metric | Why |
|---|---|
| Impressions | Reach |
| Likes | Engagement signal |
| Replies / comments | Quality engagement |
| Follower delta day-over-day | Account growth |
| Click-through to gkall.online | Funnel efficiency |
| New plays attributable to that day's post | ROI |

A spreadsheet tracker is enough. No marketing analytics tools needed at this stage.

---

## Weekly cadence after launch

| Day | Activity |
|---|---|
| **Monday** | Weekly recap post (last week's winner, sponsorship pool balance, fun stat) |
| **Tuesday** | Question of the day / lure for new players |
| **Wednesday** | Pioneer spotlight or feature update |
| **Thursday** | Sponsorship push — what your $ funds |
| **Friday** | Behind-the-scenes (build, audit, decisions) |
| **Saturday** | High-engagement format — poll, challenge, "name the famous person" |
| **Sunday** | Cross-post / community amplification, thank sponsors |

---

## Budget guidance (when ready to spend)

Right now: **zero ad spend**. Organic only. Channels are too new to spend on.

When ready to scale (after ~1,000 monthly players):
- $50–100/week on X promoted posts targeted at #trivia, #crypto, #USDT
- $50/week on Reddit ads in r/SideProject and r/cryptocurrency
- $100/month on Telegram sponsored channels (only after audience is 1,000+)

Total: ~$400–800/month at scale. Should generate 2–3x in player acquisition once funnel is dialed.
