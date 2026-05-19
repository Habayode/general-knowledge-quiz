# gkall.online — Launch Checklist (Things YOU Do)

Most of the technical work is automated. The items below need a real human (you) — they require your identity, phone number, or judgment calls AI can't make.

---

## This week (May 18–24)

### Social accounts (highest priority — ~30 min)
- [ ] **X / Twitter**: create `@gkallonline`. Use Cloudflare email for signup, your phone for verification.
- [ ] **Instagram**: create `@gkall.online`. Same email + phone.
- [ ] **TikTok**: create `@gkall.online`. Same email + phone.
- [ ] **Facebook Page**: create `gkall.online`. Use your personal FB account, then create the Page.

For each, use:
- **PFP**: I'll generate the gold "G" mark on request — say "build me the logo PNG"
- **Bio**: copy from `MARKETING_PLAN.md` per platform
- **Cover image**: I'll generate on request

### Wire social handles into the site (5 min once accounts exist)
Once each account is live, paste this on the VPS PowerShell (substitute your real URLs):

```powershell
[Environment]::SetEnvironmentVariable('SOCIAL_TWITTER',   'https://x.com/gkallonline', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_INSTAGRAM', 'https://instagram.com/gkall.online', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_TIKTOK',    'https://tiktok.com/@gkall.online', 'Machine')
[Environment]::SetEnvironmentVariable('SOCIAL_FACEBOOK',  'https://facebook.com/gkall.online', 'Machine')
Stop-ScheduledTask QuizApi -EA SilentlyContinue
Get-Process python -EA SilentlyContinue | Where-Object { $_.Path -like '*Python312*' } | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 3
Start-ScheduledTask QuizApi
```

Site footer + claim form + sponsor page will auto-update.

### Pioneer outreach (high impact — ~1 hour)
- [ ] Send the Pioneer welcome email to 20–50 contacts (template below in `PIONEER_EMAIL.md`)
- [ ] Personal DMs in 2–3 Telegram crypto groups
- [ ] One personal X post: "Building a USDT-paying quiz, would love early testers, DM me if interested"

### Sponsorship outreach (high leverage — ~1 hour)
- [ ] Send the sponsorship pitch (`MARKETING_PLAN.md` script) to 10–20 contacts
- [ ] Post a sponsor-seeking note in 1 crypto community group with permission
- [ ] LinkedIn post if you're on it: "Sponsoring a USDT prize quiz, looking for fellow funders"

---

## Next week (May 25–31)

### Daily Telegram posts (auto-scheduled, you just check)
- I'm setting up a daily countdown bot. You don't need to post manually.

### Pioneer feedback review (ongoing — ~15 min/day)
- Open the admin endpoint daily: `curl -H "X-Admin-Token: ckR69BYdiaWrXj5tO2J1UHAlghNEowb70Gn4DTz3" https://gkall.online/api/admin/feedback`
- Or open https://gkall.online/admin
- Read what's coming in. Bugs reported should be in your "fix before June 1" pile. Feature requests → backlog.

### Final launch prep (May 28–31)
- [ ] Pin the prelaunch-completion post on Telegram (I can draft on May 28)
- [ ] Draft launch-day social posts and schedule them
- [ ] Verify sponsorship wallet has enough USDT for May payouts (HAG_Ai-guaranteed: ~$85 + winner $1s)
- [ ] Brief any pioneer contacts: "Public launch June 1. Be ready to share."

---

## Launch day (June 1)

### Morning (your timezone, but UTC 09:00 hits Asia + Europe in waking hours)
- [ ] Post the launch announcement on X, IG, TikTok, FB simultaneously
- [ ] Post in r/SideProject ("Show & Tell" flair) and r/cryptocurrency
- [ ] Submit to IndieHackers
- [ ] Optionally: ProductHunt (June 1 launch — costs nothing, can get visibility)

### Mid-day
- [ ] Verify May winners auto-announced in Telegram at 00:00 UTC (server does this automatically)
- [ ] Pay out May Top 3 from the wallet, mark paid in admin

### Evening
- [ ] Founder thread on X — the build journey, anti-cheat, sponsorship
- [ ] Reply to every Reddit / IndieHackers / ProductHunt comment

---

## When a winner emerges

### $1 instant win
- [ ] They submit a claim with wallet + attest to "I follow all gkall socials"
- [ ] Open /admin → check Pending claims → find their entry
- [ ] **Verify follow** — open each social profile, search for their handle in followers
- [ ] If they're following, send USDT from wallet, paste tx hash in /admin → mark paid
- [ ] If NOT following, reply to their contact: "Please follow + retry claim"

### Monthly $50/$25/$10
- Same flow, but tier checked accordingly.
- Telegram channel auto-announces the payment with Tronscan link.

---

## When a sponsor signs

- [ ] Funds land in wallet — you see Tronscan notification
- [ ] Reply to the sender within 4 hours: "Got it. Tier confirmed. Posting your thank-you within 24 hours."
- [ ] If Pioneer tier: post the standard thank-you (template in MARKETING_PLAN.md)
- [ ] If Round/Title: schedule the dedicated content. Ask for their preferred logo/link.
- [ ] Add them to the Sponsor wall — for now, message me with the details and I'll add to the site. (Phase B will add a self-serve sponsor form.)

---

## Ongoing — every week

- Monday: Look at /admin overview → are there pending things? Pay them out.
- Wednesday: Read all Pioneer feedback → reply to anyone who left contact info.
- Friday: Tweet/post a behind-the-scenes update. Even if nothing big happened, mention what's growing.

---

## Things AI can do for you (just ask)

- "Draft this week's social posts" → I write them
- "Generate brand assets" → I produce logo / banner PNGs
- "Run the sponsorship outreach" → I draft personalized emails, you send
- "Review the Pioneer feedback" → I summarize, prioritize, suggest responses
- "Schedule daily Telegram posts" → I write them, server schedules
- "Update the site with [feature]" → I build it

## Things only you can do

- Create real social media accounts (identity needed)
- Send USDT to winners (private key access)
- Reply to DMs in your personality
- Show up on a podcast / interview
- Sign a sponsor contract

Don't try to make me do those. They'd fail.
