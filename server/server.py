"""
gkall.online — All-Knowledge Challenge backend.

Endpoints
  GET  /api/health
  GET  /api/stats                  → totals + jackpot
  GET  /api/questions/draw?exclude=1,5,12
                                   → 10 questions ([2 easy, 3 med, 3 hard, 2 expert])
                                     excluding given IDs where possible.
  GET  /api/leaderboard            → top 50
  POST /api/leaderboard            → submit a score
  POST /api/claim                  → winner submits TRC20 payout request
  GET  /api/sponsor                → donation wallet info
  GET  /api/admin/claims           → list claims  (header: X-Admin-Token)
  POST /api/admin/claims/<id>/paid → mark paid    (header: X-Admin-Token)
  GET  /                           → SPA (index.html)

Static files in ./public. Storage: SQLite at ./quizdb.sqlite.
On first run, the questions table is seeded from questions_seed.json AND
optionally extended with ~150 questions fetched from Open Trivia DB.
"""
import json, os, sqlite3, time, urllib.request, urllib.parse, html, secrets, re, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE         = Path(__file__).parent.resolve()
STATIC_DIR   = HERE / "public"
DB_PATH      = HERE / "quizdb.sqlite"
SEED_PATH    = HERE / "questions_seed.json"
LISTEN       = ("127.0.0.1", 8080)    # bound locally — Caddy fronts it on :443
ADMIN_TOKEN  = os.environ.get("ADMIN_TOKEN", "change-me-admin-token")
SPONSOR_WALLET = os.environ.get("SPONSOR_WALLET", "TCUQq4iHrAW4vzAE97ZHNFPHeoqBh5XarM")
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")  # e.g. "7890123456:ABC..."
TG_CHANNEL   = os.environ.get("TG_CHANNEL", "")    # e.g. "@gkall_official" or "-100123..."
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "")   # public; ok to send to client
TURNSTILE_SECRET   = os.environ.get("TURNSTILE_SECRET", "")     # private; server-side only
SOCIAL_TWITTER     = os.environ.get("SOCIAL_TWITTER", "")
SOCIAL_INSTAGRAM   = os.environ.get("SOCIAL_INSTAGRAM", "")
SOCIAL_TIKTOK      = os.environ.get("SOCIAL_TIKTOK", "")
SOCIAL_FACEBOOK    = os.environ.get("SOCIAL_FACEBOOK", "")
LAUNCH_DATE_UTC    = os.environ.get("LAUNCH_DATE_UTC", "2026-06-01T00:00:00Z")  # full launch
SPONSORSHIP_TIERS  = [
    {"name": "Pioneer Sponsor", "min": 50,   "max": 199,  "icon": "🌱",
     "perks": ["Logo or text on the public Sponsor wall (every visitor sees it)",
               "Thank-you post on our Telegram channel",
               "Mention in the next monthly winners announcement"]},
    {"name": "Round Sponsor",   "min": 200,  "max": 999,  "icon": "🛡",
     "perks": ["Everything in Pioneer Sponsor",
               "Featured & pinned for 24 hours on our Telegram channel",
               "Auto-featured on X / Instagram / TikTok / Facebook as those launch",
               "Named tag on the monthly prize: 'Sponsored by [Brand]'",
               "Mention in every winner announcement that month"]},
    {"name": "Title Sponsor",   "min": 1000, "max": None, "icon": "👑",
     "perks": ["Everything in Round Sponsor",
               "Logo at top of homepage hero for the month",
               "Branded category (e.g. '[Brand] Science Week')",
               "Co-branded social content series across all channels",
               "Permanent recognition in the Hall of Fame"]},
]
SPONSOR_MIN_USDT = 50  # smallest accepted contribution = entry to Pioneer Sponsor tier
PRIZE_USDT   = 1
MONTHLY_PRIZES = [50, 25, 10]    # 1st, 2nd, 3rd place at month end (USDT TRC20)
QUALIFY_MIN  = 5                  # minimum score to appear on any ranked leaderboard
INSTANT_WIN_CAP_PER_MONTH = 3    # max paid instant-wins per unique player per month
ABOUT_HAG_AI = (
    "HAG_Ai — A full-fledged AI-enabled consulting firm. "
    "AI agents for finance functions that move a number — "
    "Revenue Assurance, Prediction Service (Markets · Football · Outcomes), "
    "Customize ERP, Close & Reconciliation, FP&A & Variance, AP/AR Automation, "
    "Internal Control & Audit, Board Packs. "
    "Full firm context: https://hagai.online · Consulting inquiries: hello@hagai.online. "
    "gkall.online is our first public product — same engineering rigor we bring to client work, made public so people can win real USDT for what they know."
)
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # Crockford-ish, no 0/O/1/I
TIMER_SEC    = 10                 # per-question timer (client + server)
TIMER_BUFFER = 1.5                # seconds of slack on server check (network + animation)
SESSION_TTL  = 600                # active session expires after this many seconds idle
GAME_COMPOSITION = [(1, 2), (2, 3), (3, 3), (4, 2)]  # (difficulty, count)
START_PER_MIN     = 5             # max /api/game/start per IP per minute
START_PER_DAY     = 50            # max /api/game/start per IP per 24h
ACTIVE_SESSIONS_PER_IP = 1        # max concurrent active sessions for one IP
OTDB_BATCH   = 50  # per difficulty
TRC20_RE     = re.compile(r"^T[1-9A-HJ-NP-Za-km-z]{33}$")
MAX_NAME     = 24
MAX_CONTACT  = 100
MAX_LIMIT    = 50

# ---- DB ----
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def gen_claim_code():
    parts = [''.join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(3)]
    return '-'.join(parts)

def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            score INTEGER NOT NULL,
            prize INTEGER NOT NULL,
            won INTEGER NOT NULL,
            total_time REAL NOT NULL,
            ip TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores(score DESC, total_time ASC);

        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            difficulty INTEGER NOT NULL,         -- 1=easy 2=medium 3=hard 4=expert
            question TEXT NOT NULL,
            options TEXT NOT NULL,               -- JSON list
            answer_index INTEGER NOT NULL,
            source TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(question, difficulty)
        );
        CREATE INDEX IF NOT EXISTS idx_q_diff ON questions(difficulty);

        CREATE TABLE IF NOT EXISTS claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            wallet TEXT NOT NULL,                -- TRC20 address
            contact TEXT,                        -- email/telegram/handle
            amount_usdt INTEGER NOT NULL,
            score_id INTEGER,                    -- nullable linkage to scores
            status TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|rejected
            tx_hash TEXT,
            ip TEXT,
            social_attested INTEGER NOT NULL DEFAULT 0,
            social_handle TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monthly_winners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year_month TEXT NOT NULL,              -- 'YYYY-MM'
            rank INTEGER NOT NULL,                 -- 1, 2, or 3
            name TEXT NOT NULL,
            score INTEGER NOT NULL,
            total_time REAL NOT NULL,
            score_id INTEGER,
            prize_usdt INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',-- pending|paid|rejected
            wallet TEXT,
            contact TEXT,
            tx_hash TEXT,
            finalized_at INTEGER NOT NULL,
            paid_at INTEGER,
            UNIQUE(year_month, rank)
        );
        CREATE INDEX IF NOT EXISTS idx_mw_ym ON monthly_winners(year_month);

        CREATE TABLE IF NOT EXISTS sponsors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            tier TEXT NOT NULL,                 -- pioneer | round | title
            amount_usdt INTEGER NOT NULL,
            month TEXT,                          -- YYYY-MM the sponsorship covers (optional)
            tx_hash TEXT,
            link_url TEXT,
            note TEXT,
            display_order INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active', -- active | hidden
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sponsors_active ON sponsors(status, display_order);

        CREATE TABLE IF NOT EXISTS countdown_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_date TEXT NOT NULL,             -- YYYY-MM-DD when this should fire
            theme TEXT,
            message TEXT NOT NULL,
            posted_at INTEGER,
            UNIQUE(post_date)
        );

        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            contact TEXT,
            category TEXT NOT NULL,    -- bug | suggestion | praise | other
            rating INTEGER,            -- 1-5 optional
            message TEXT NOT NULL,
            ip TEXT,
            status TEXT NOT NULL DEFAULT 'new',  -- new | reviewed | actioned | archived
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_new ON feedback(status, created_at DESC);

        CREATE TABLE IF NOT EXISTS page_views (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_utc INTEGER NOT NULL,
            path TEXT NOT NULL,
            referer TEXT,
            ip_hash TEXT,
            ua_short TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pv_ts ON page_views(ts_utc);
        CREATE INDEX IF NOT EXISTS idx_pv_path ON page_views(path);
        CREATE INDEX IF NOT EXISTS idx_pv_iph ON page_views(ip_hash, ts_utc);

        CREATE TABLE IF NOT EXISTS game_sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ip TEXT,
            question_plan TEXT NOT NULL,    -- JSON: [{q_id,cat,diff,q,opts,a}, ...]
            current_q INTEGER NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0,
            answers TEXT NOT NULL DEFAULT '[]',  -- per-answer log for forensic review
            started_at INTEGER NOT NULL,
            last_action_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',  -- active|won|lost|forfeited|expired
            score_id INTEGER,
            forfeit_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_active ON game_sessions(status, last_action_at);
        """)
        # Add claim_code to scores if missing
        cols = [r[1] for r in c.execute("PRAGMA table_info(scores)").fetchall()]
        if "claim_code" not in cols:
            c.execute("ALTER TABLE scores ADD COLUMN claim_code TEXT")
            c.execute("CREATE INDEX IF NOT EXISTS idx_scores_code ON scores(claim_code)")
        # Add social attestation columns if missing
        for tbl in ("claims", "monthly_winners"):
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({tbl})").fetchall()]
            if "social_attested" not in cols:
                c.execute(f"ALTER TABLE {tbl} ADD COLUMN social_attested INTEGER NOT NULL DEFAULT 0")
            if "social_handle" not in cols:
                c.execute(f"ALTER TABLE {tbl} ADD COLUMN social_handle TEXT")
        # Monthly winners (top-3, $50/$25/$10) must also attest X follow + like pinned post
        cols = [r[1] for r in c.execute("PRAGMA table_info(monthly_winners)").fetchall()]
        if "x_attested" not in cols:
            c.execute("ALTER TABLE monthly_winners ADD COLUMN x_attested INTEGER NOT NULL DEFAULT 0")
        if "x_handle" not in cols:
            c.execute("ALTER TABLE monthly_winners ADD COLUMN x_handle TEXT")

        # Country + referral tracking on scores (Phase 1 growth instrumentation)
        cols = [r[1] for r in c.execute("PRAGMA table_info(scores)").fetchall()]
        if "country" not in cols:
            c.execute("ALTER TABLE scores ADD COLUMN country TEXT")  # ISO 3166-1 alpha-2, e.g. NG, IN
            c.execute("CREATE INDEX IF NOT EXISTS idx_scores_country ON scores(country, score DESC, total_time ASC)")
        if "referral_code" not in cols:
            c.execute("ALTER TABLE scores ADD COLUMN referral_code TEXT")
            c.execute("CREATE INDEX IF NOT EXISTS idx_scores_refcode ON scores(referral_code)")
        if "referred_by" not in cols:
            c.execute("ALTER TABLE scores ADD COLUMN referred_by TEXT")
            c.execute("CREATE INDEX IF NOT EXISTS idx_scores_refby ON scores(referred_by)")
        # Persist country + referred_by on the live game session too so it survives the round
        cols = [r[1] for r in c.execute("PRAGMA table_info(game_sessions)").fetchall()]
        if "country" not in cols:
            c.execute("ALTER TABLE game_sessions ADD COLUMN country TEXT")
        if "referred_by" not in cols:
            c.execute("ALTER TABLE game_sessions ADD COLUMN referred_by TEXT")

        # Re-tag graduate-level MMLU subjects to Expert (difficulty=4)
        c.execute("""
            UPDATE questions SET difficulty = 4
            WHERE source = 'mmlu' AND difficulty = 3 AND (
              category LIKE 'College %' OR
              category LIKE 'Professional %' OR
              category LIKE 'Abstract %' OR
              category IN ('Formal Logic','Machine Learning','Medical Genetics','Econometrics','Philosophy','Anatomy','Clinical Knowledge')
            )
        """)

        # Seed prelaunch countdown posts (May 19 - May 31) — idempotent via UNIQUE(post_date)
        countdown_seed = [
            ("2026-05-19", "first-pioneer",  "🎯 *Day 2 of prelaunch.*\nFirst Pioneer completed a round — feedback already shaping v1.1. Want in?\n\nhttps://gkall.online"),
            ("2026-05-20", "anti-cheat",     "🛡 *Why our quiz can't be cheated by AI extensions:*\n• Server-side scoring (browser never sees the answer)\n• Cloudflare Turnstile gate\n• Per-session option shuffling\n\nKnowledge wins. Scrapers lose.\nhttps://gkall.online"),
            ("2026-05-21", "sponsors-call",  "🌱 *Sponsors wanted.*\nFrom $50 (Pioneer Sponsor) to $1,000+ (Title Sponsor). Your brand on every winner announcement. Public sponsor wall.\n\nDM @ALLKNWNG_BOT or email hello@gkall.online"),
            ("2026-05-22", "question-sample","🧠 *Today's sample (hard tier):*\nWhich Dutch post-Impressionist famously cut off part of his own ear?\n\nA. Rembrandt  B. Vermeer  C. Van Gogh  D. Mondrian\n\nThink you know? Play → https://gkall.online"),
            ("2026-05-23", "pioneer-spotlight","🙏 *Shoutout to our Pioneer cohort.*\nRounds played, feedback received, bugs squashed. The site you'll see at launch is partly yours.\n\nJoin them → https://gkall.online"),
            ("2026-05-24", "how-it-works",   "📜 *How gkall works:*\n10 questions. 10 seconds each. Difficulty climbs.\nTab-switch or devtools = game over.\nSkill only. https://gkall.online"),
            ("2026-05-25", "why-usdt",       "💸 *Why USDT on Tron?*\nTransfer fee ≈ $0.001. More of every sponsor dollar reaches winners. Most blockchains lose 1–10% to gas. We don't."),
            ("2026-05-26", "defense-stack",  "🔒 *Anti-cheat layer #1: server-side game sessions.*\nYour browser never sees the answer. Even with devtools open, you can't cheat. We built it after our own audit.\n\nDetails → https://gkall.online/#how"),
            ("2026-05-27", "pioneer-push",   "⏳ *T-5 days to launch.*\nSeeking 50 more Pioneers before June 1. Play. Win. Tell us what to fix. Free + sponsored.\nhttps://gkall.online"),
            ("2026-05-28", "telegram-push",  "📣 *Channel reminder:* this is where live winner announcements drop, plus drops, behind-the-scenes, and Pioneer credit. Tap notifications. → https://t.me/gkallonline"),
            ("2026-05-29", "categories",     "📚 *Categories on gkall:*\nSport • Science • History • Religion • Music • Art • Movies • Literature • Geography • Food • Animals • Lifestyle • plus MMLU's 57 academic subjects. If it's known, it's in here."),
            ("2026-05-30", "24-hr",          "🚀 *T-24 hours to public launch.*\nJune 1: first Top 3 monthly announced. May Pioneers locked in.\nLast chance to climb before everyone sees the board.\n\nhttps://gkall.online"),
            ("2026-05-31", "launch-eve",     "🎯 *Tomorrow we go fully public.*\nMay 2026 winners decided at midnight UTC. $50 / $25 / $10 USDT for top 3.\nPioneers — this is your last day. Push it.\n\nhttps://gkall.online"),
            ("2026-06-01", "launch",         "🚀 *gkall is officially LIVE.*\n\nThe All-Knowledge Challenge. 33,000+ questions. $1 USDT for every 10/10 round + $50/$25/$10 monthly top 3.\n\nPowered by HAG_Ai — a full-fledged AI-enabled consulting firm building AI agents for finance functions. Full context: https://hagai.online\n\nMay 2026 winners announced today.\n\nTry your knowledge → https://gkall.online"),
        ]
        for (d, t, m) in countdown_seed:
            c.execute("INSERT OR IGNORE INTO countdown_posts(post_date, theme, message) VALUES(?,?,?)", (d, t, m))

def question_count():
    with db() as c:
        return c.execute("SELECT COUNT(*) FROM questions").fetchone()[0]

def insert_question(category, difficulty, question, options, answer_index, source):
    try:
        with db() as c:
            c.execute(
                "INSERT OR IGNORE INTO questions(category,difficulty,question,options,answer_index,source,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (category, int(difficulty), question.strip(), json.dumps(options), int(answer_index), source, int(time.time()))
            )
    except Exception as e:
        print("insert_question error:", e)

def seed_from_json():
    if not SEED_PATH.exists():
        print("no seed file at", SEED_PATH)
        return 0
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    n = 0
    for q in data:
        insert_question(q["cat"], q["diff"], q["q"], q["opts"], q["a"], "curated")
        n += 1
    print(f"seeded {n} curated questions")
    return n

OTDB_DIFF = {"easy": 1, "medium": 3, "hard": 4}  # easy→easy, medium→hard, hard→expert

def seed_from_otdb():
    """Fetch from Open Trivia DB. Best-effort: don't crash if offline."""
    total = 0
    try:
        for otdb_diff, our_diff in OTDB_DIFF.items():
            url = ("https://opentdb.com/api.php?amount=%d&type=multiple&difficulty=%s&encode=base64"
                   % (OTDB_BATCH, otdb_diff))
            with urllib.request.urlopen(url, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            import base64
            def dec(s): return base64.b64decode(s).decode("utf-8")
            for item in data.get("results", []):
                q       = dec(item["question"])
                correct = dec(item["correct_answer"])
                wrong   = [dec(x) for x in item["incorrect_answers"]]
                cat     = dec(item["category"])
                opts    = wrong + [correct]
                # deterministic shuffle so same Q always has same option order
                seed = sum(ord(c) for c in q)
                opts = sorted(opts, key=lambda x: (seed * 31 + hash(x)) % 9973)
                ans_i = opts.index(correct)
                # normalize category to short label
                short_cat = cat.split(":")[-1].strip()
                short_cat = re.sub(r"^Entertainment:\s*", "", short_cat)
                if len(short_cat) > 24: short_cat = short_cat[:22] + "…"
                insert_question(short_cat, our_diff, q, opts, ans_i, "otdb")
                total += 1
            time.sleep(5)  # OTDB rate-limit
    except Exception as e:
        print("otdb seed warning:", e)
    print(f"otdb fetched ~{total} questions")
    return total

def bootstrap_questions():
    if question_count() < 40:
        seed_from_json()
    if question_count() < 200:
        seed_from_otdb()
    print(f"questions in db: {question_count()}")

# ---- Cloudflare Turnstile ----
def verify_turnstile(token, ip):
    """Return True if Turnstile token is valid, OR if Turnstile not configured."""
    if not TURNSTILE_SECRET:
        return True   # feature disabled — let through
    if not token:
        return False
    try:
        # remoteip intentionally omitted — Caddy reverse-proxy means the IP
        # Python sees may not match the IP that issued the token. The secret +
        # token check is itself sufficient.
        data = urllib.parse.urlencode({
            "secret": TURNSTILE_SECRET,
            "response": token,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read().decode("utf-8"))
        if not result.get("success"):
            print("turnstile rejected:", result.get("error-codes"))
        return bool(result.get("success"))
    except Exception as e:
        print("turnstile verify error:", e); return False

# ---- Game session helpers ----
def _now(): return int(time.time())

# ---- IP -> country (in-memory cache; ip-api.com free tier) ----
_country_cache = {}  # ip -> (cc, ts)
_COUNTRY_TTL = 86400  # cache for 24h

def country_for_ip(ip):
    """Return ISO-3166-1 alpha-2 country code (e.g. 'NG') or '' on failure."""
    if not ip or ip in ("127.0.0.1", "::1"):
        return ""
    now = _now()
    cached = _country_cache.get(ip)
    if cached and (now - cached[1]) < _COUNTRY_TTL:
        return cached[0]
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,countryCode"
        with urllib.request.urlopen(url, timeout=3) as r:
            body = json.loads(r.read())
        cc = body.get("countryCode","") if body.get("status") == "success" else ""
    except Exception:
        cc = ""
    _country_cache[ip] = (cc, now)
    return cc

# ---- Referral codes ----
_REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # 32 chars, Crockford-ish

def _new_referral_code():
    """8-char Crockford-style code (40 bits entropy, ample for our scale)."""
    return "".join(secrets.choice(_REF_ALPHABET) for _ in range(8))

def referral_code_for_name(c, name):
    """Get-or-create a stable referral code for this player name (case-insensitive).
    Convention: the code on the OLDEST score for this name is the canonical owner.
    Returns the canonical code (string) or generates a new one if no row has one yet.
    """
    if not name: return ""
    row = c.execute(
        "SELECT referral_code FROM scores "
        "WHERE LOWER(name)=LOWER(?) AND referral_code IS NOT NULL AND referral_code != '' "
        "ORDER BY created_at ASC LIMIT 1",
        (name,)
    ).fetchone()
    if row and row["referral_code"]:
        return row["referral_code"]
    # Generate a new unique code
    for _ in range(8):
        code = _new_referral_code()
        clash = c.execute("SELECT 1 FROM scores WHERE referral_code=?", (code,)).fetchone()
        if not clash:
            return code
    # Vanishingly unlikely fallback
    return _new_referral_code()


def _new_session_id():
    return secrets.token_urlsafe(16)

def _secrets_shuffle(arr):
    """Crypto-secure Fisher-Yates."""
    n = len(arr)
    for i in range(n - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        arr[i], arr[j] = arr[j], arr[i]

def _expire_old_sessions(c):
    cutoff = _now() - SESSION_TTL
    c.execute("UPDATE game_sessions SET status='expired' WHERE status='active' AND last_action_at < ?", (cutoff,))

def _build_question_plan(c):
    """Pick questions per GAME_COMPOSITION, shuffle their options per session."""
    plan = []
    chosen_ids = set()
    for diff, count in GAME_COMPOSITION:
        params = (diff,) + tuple(chosen_ids) + (count,)
        placeholder = "" if not chosen_ids else (" AND id NOT IN (" + ",".join("?" * len(chosen_ids)) + ")")
        rows = c.execute(
            f"SELECT id, category, difficulty, question, options, answer_index "
            f"FROM questions WHERE difficulty=?{placeholder} ORDER BY RANDOM() LIMIT ?",
            params
        ).fetchall()
        if len(rows) < count:
            # Top up without exclusion if pool is small
            fill = c.execute(
                "SELECT id, category, difficulty, question, options, answer_index "
                "FROM questions WHERE difficulty=? ORDER BY RANDOM() LIMIT ?",
                (diff, count - len(rows))
            ).fetchall()
            rows = list(rows) + list(fill)
        for r in rows:
            opts = json.loads(r["options"])
            correct = opts[r["answer_index"]]
            shuffled = list(opts)
            _secrets_shuffle(shuffled)
            plan.append({
                "q_id": r["id"],
                "cat": r["category"],
                "diff": r["difficulty"],
                "q": r["question"],
                "opts": shuffled,
                "a": shuffled.index(correct),  # answer index AFTER shuffling
            })
            chosen_ids.add(r["id"])
    return plan

def _public_question(plan, idx):
    """Strip the 'a' field — clients NEVER see the answer."""
    q = plan[idx]
    return {
        "index": idx,
        "q_id": q["q_id"],
        "cat": q["cat"],
        "diff": q["diff"],
        "q": q["q"],
        "opts": q["opts"],
    }

def _finalize_session_score(c, sess, plan, new_score, total_time, status, ip):
    """Create the scores row when a game ends. Returns (score_id, claim_code, cap_reached)."""
    won = (status == "won")
    # Check per-player monthly cap
    cap_reached = False
    if won:
        already = player_instant_wins_this_month(c, sess["name"])
        if already >= INSTANT_WIN_CAP_PER_MONTH:
            cap_reached = True
    prize = 0 if (not won or cap_reached) else PRIZE_USDT
    # Unique claim code
    code = None
    for _ in range(5):
        candidate = gen_claim_code()
        if not c.execute("SELECT 1 FROM scores WHERE claim_code=?", (candidate,)).fetchone():
            code = candidate; break
    if not code: code = gen_claim_code()
    # Persist country + referral attribution from the session
    country = (sess["country"] if "country" in sess.keys() else None) if hasattr(sess, "keys") else None
    referred_by = (sess["referred_by"] if "referred_by" in sess.keys() else None) if hasattr(sess, "keys") else None
    # Stable referral code for this player (case-insensitive name)
    ref_code = referral_code_for_name(c, sess["name"]) or None
    cur = c.execute(
        "INSERT INTO scores(name,score,prize,won,total_time,ip,created_at,claim_code,country,referral_code,referred_by) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (sess["name"], new_score, prize, 1 if won else 0, total_time, ip, _now(), code,
         country, ref_code, referred_by)
    )
    return cur.lastrowid, code, cap_reached

# ---- Telegram announcer ----
import threading
def tg_announce(text):
    """Fire-and-forget Telegram channel post. No-op if env vars unset."""
    if not (TG_BOT_TOKEN and TG_CHANNEL): return
    def _send():
        try:
            url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
            data = json.dumps({
                "chat_id": TG_CHANNEL,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            }).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                r.read()
        except Exception as e:
            print("tg_announce error:", e)
    threading.Thread(target=_send, daemon=True).start()

# ---- Countdown post scheduler ----
def _countdown_loop():
    """Background thread: posts the next due countdown message to Telegram once per check."""
    while True:
        try:
            today = time.strftime("%Y-%m-%d", time.gmtime())
            with db() as c:
                row = c.execute(
                    "SELECT id, message FROM countdown_posts "
                    "WHERE post_date <= ? AND posted_at IS NULL "
                    "ORDER BY post_date ASC LIMIT 1",
                    (today,)
                ).fetchone()
                if row:
                    tg_announce(row["message"])
                    c.execute("UPDATE countdown_posts SET posted_at = ? WHERE id = ?",
                              (int(time.time()), row["id"]))
                    c.commit()
                    print(f"[countdown] posted id={row['id']}", flush=True)
        except Exception as e:
            print("countdown loop err:", e)
        time.sleep(3600)  # check hourly

def start_countdown_scheduler():
    t = threading.Thread(target=_countdown_loop, daemon=True)
    t.start()
    print("countdown scheduler started", flush=True)

# ---- Instant win cap helper ----
def player_instant_wins_this_month(c, name):
    return c.execute("""
        SELECT COUNT(*) FROM scores
        WHERE LOWER(name) = LOWER(?)
          AND won = 1
          AND prize > 0
          AND strftime('%Y-%m', created_at, 'unixepoch') = ?
    """, (name, current_ym())).fetchone()[0]

# ---- Monthly leaderboard ----
def current_ym():
    """Current year-month in UTC, e.g. '2026-05'."""
    return time.strftime("%Y-%m", time.gmtime())

def prev_ym(ym):
    """Given 'YYYY-MM', return previous month's 'YYYY-MM'."""
    y, m = int(ym[:4]), int(ym[5:7])
    if m == 1: return f"{y-1:04d}-12"
    return f"{y:04d}-{m-1:02d}"

def month_leaderboard(c, ym, limit=10):
    """Return top entries for the given month: best run per name. Only qualifying scores."""
    rows = c.execute("""
        WITH ranked AS (
            SELECT id, name, score, prize, won, total_time, created_at,
                   ROW_NUMBER() OVER (PARTITION BY LOWER(name)
                                      ORDER BY score DESC, total_time ASC, created_at ASC) AS rn
            FROM scores
            WHERE strftime('%Y-%m', created_at, 'unixepoch') = ?
              AND score >= ?
        )
        SELECT id AS score_id, name, score, prize, won, total_time,
               strftime('%Y-%m-%d', created_at, 'unixepoch') AS date
        FROM ranked WHERE rn=1
        ORDER BY score DESC, total_time ASC, created_at ASC
        LIMIT ?
    """, (ym, QUALIFY_MIN, limit)).fetchall()
    return [dict(r) for r in rows]

def finalize_month(c, ym):
    """Snapshot top 3 best-run-per-name into monthly_winners. Idempotent."""
    existing = c.execute("SELECT COUNT(*) FROM monthly_winners WHERE year_month=?", (ym,)).fetchone()[0]
    if existing > 0:
        return existing
    top = month_leaderboard(c, ym, limit=3)
    now = int(time.time())
    inserted = 0
    finalized_rows = []
    for i, row in enumerate(top):
        rank = i + 1
        prize = MONTHLY_PRIZES[i] if i < len(MONTHLY_PRIZES) else 0
        try:
            c.execute(
                "INSERT INTO monthly_winners(year_month, rank, name, score, total_time, score_id, prize_usdt, finalized_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (ym, rank, row["name"], row["score"], row["total_time"], row["score_id"], prize, now)
            )
            inserted += 1
            finalized_rows.append({**row, "rank": rank, "prize": prize})
        except sqlite3.IntegrityError:
            pass
    c.commit()
    if finalized_rows:
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        lines = [f"🎉 *{ym} Monthly Winners Announced!*\n"]
        for r in finalized_rows:
            obf = obfuscate_name(r["name"])
            lines.append(f"{medals.get(r['rank'],'#'+str(r['rank']))} *{obf}* — {r['score']}/10 in {r['total_time']:.1f}s — *${r['prize']} USDT*")
        lines.append(f"\nWinners: paste your claim code to confirm → https://gkall.online/#monthly-claim")
        lines.append(f"New month, new chance → https://gkall.online")
        tg_announce("\n".join(lines))
    return inserted

def maybe_finalize_past_months(c):
    """Auto-finalize any completed past months that have scores but no winners yet."""
    cur = current_ym()
    rows = c.execute("""
        SELECT DISTINCT strftime('%Y-%m', created_at, 'unixepoch') AS ym FROM scores
        WHERE strftime('%Y-%m', created_at, 'unixepoch') < ?
    """, (cur,)).fetchall()
    finalized = []
    for r in rows:
        ym = r["ym"]
        if not ym: continue
        existing = c.execute("SELECT COUNT(*) FROM monthly_winners WHERE year_month=?", (ym,)).fetchone()[0]
        if existing == 0:
            n = finalize_month(c, ym)
            if n > 0: finalized.append({"ym": ym, "winners": n})
    return finalized

def obfuscate_name(name):
    n = (name or "").strip()
    if not n: return "***"
    if len(n) <= 2: return n[0] + "***"
    if len(n) <= 4: return n[:1] + "***" + n[-1:]
    return n[:2] + "***" + n[-2:]

def month_meta(ym):
    """Returns days_remaining (0 for past months) + is_current."""
    y, m = int(ym[:4]), int(ym[5:7])
    # last day of month
    import calendar
    last_day = calendar.monthrange(y, m)[1]
    now = time.gmtime()
    if (now.tm_year, now.tm_mon) == (y, m):
        return {"is_current": True, "days_remaining": last_day - now.tm_mday + 1}
    return {"is_current": False, "days_remaining": 0}

# ---- Rate limit (in-memory) ----
_subs = {}
def rate_ok(ip, key, window=60, maxn=10):
    now = time.time()
    bucket = _subs.setdefault((ip, key), [])
    bucket[:] = [t for t in bucket if now - t < window]
    if len(bucket) >= maxn: return False
    bucket.append(now); return True

# ---- HTTP ----
class Handler(BaseHTTPRequestHandler):
    server_version = "gkall/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.client_address[0]} {fmt % args}", flush=True)

    def _client_ip(self):
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()

    def _json(self, code, payload, cache="no-store"):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        if not path.exists() or not path.is_file():
            return self.send_error(404, "Not Found")
        mime = {
            ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
            ".js":"application/javascript; charset=utf-8", ".json":"application/json",
            ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
            ".svg":"image/svg+xml", ".ico":"image/x-icon", ".webp":"image/webp",
            ".gif":"image/gif", ".mp4":"video/mp4", ".webm":"video/webm",
            ".mp3":"audio/mpeg", ".wav":"audio/wav",
            ".txt":"text/plain; charset=utf-8", ".xml":"application/xml; charset=utf-8",
        }.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(data)

    def _body(self, max_size=8192):
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > max_size:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def _admin_ok(self):
        return secrets.compare_digest(self.headers.get("X-Admin-Token", ""), ADMIN_TOKEN)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
        self.end_headers()

    def do_HEAD(self): self.do_GET(send_body=False)

    def do_GET(self, send_body=True):
        u = urlparse(self.path); p = u.path
        if p == "/api/health":
            return self._json(200, {"ok": True, "time": int(time.time())})

        if p == "/api/config":
            return self._json(200, {
                "turnstile_site_key": TURNSTILE_SITE_KEY or "",
                "turnstile_enabled": bool(TURNSTILE_SECRET),
            }, cache="public, max-age=60")

        if p == "/api/stats":
            cur_ym = current_ym()
            with db() as c:
                total_plays = c.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
                winners     = c.execute("SELECT COUNT(*) FROM scores WHERE won=1").fetchone()[0]
                paid_out    = c.execute("SELECT COALESCE(SUM(amount_usdt),0) FROM claims WHERE status='paid'").fetchone()[0]
                monthly_paid= c.execute("SELECT COALESCE(SUM(prize_usdt),0) FROM monthly_winners WHERE status='paid'").fetchone()[0]
                pending     = c.execute("SELECT COUNT(*) FROM claims WHERE status='pending'").fetchone()[0]
                qcount      = c.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
                month_players = c.execute("""
                    SELECT COUNT(DISTINCT LOWER(name)) FROM scores
                    WHERE strftime('%Y-%m', created_at, 'unixepoch') = ?
                      AND score >= ?
                """, (cur_ym, QUALIFY_MIN)).fetchone()[0]
            meta = month_meta(cur_ym)
            return self._json(200, {
                "plays": total_plays, "winners": winners,
                "paid_usdt": paid_out + monthly_paid, "pending_claims": pending,
                "questions": qcount, "prize_usdt": PRIZE_USDT,
                "monthly_prizes": MONTHLY_PRIZES,
                "month": cur_ym, "month_players": month_players,
                "days_remaining": meta["days_remaining"],
            })

        if p == "/api/leaderboard/monthly":
            qs = parse_qs(u.query)
            ym = (qs.get("ym", [None])[0] or current_ym()).strip()[:7]
            if not re.match(r"^\d{4}-\d{2}$", ym):
                return self._json(400, {"error":"bad_ym"})
            try:
                with db() as c:
                    rows = month_leaderboard(c, ym, limit=10)
            except Exception as e:
                return self._json(500, {"error": str(e)})
            # Obfuscate top-3 names (the ones with prizes on the line)
            for i, r in enumerate(rows):
                if i < 3: r["name"] = obfuscate_name(r["name"])
            return self._json(200, {"ym": ym, "rows": rows, **month_meta(ym)})

        if p == "/api/winners/monthly":
            qs = parse_qs(u.query)
            limit = min(int(qs.get("limit", ["12"])[0] or "12"), 36)
            with db() as c:
                # auto-finalize any past months that need it
                try: maybe_finalize_past_months(c)
                except Exception as e: print("auto-finalize err:", e)
                rows = c.execute("""
                    SELECT year_month AS ym, rank, name, score, total_time, prize_usdt,
                           status, tx_hash, finalized_at,
                           strftime('%Y-%m-%d', finalized_at, 'unixepoch') AS finalized_date
                    FROM monthly_winners
                    ORDER BY year_month DESC, rank ASC
                """).fetchall()
            # group by ym, obfuscate names so impersonators can't latch onto them
            grouped = {}
            for r in rows:
                d = dict(r)
                d["name"] = obfuscate_name(d["name"])
                grouped.setdefault(d["ym"], []).append(d)
            months = [{"ym": ym, "winners": ws} for ym, ws in list(grouped.items())[:limit]]
            return self._json(200, {"months": months})

        if p == "/api/about":
            return self._json(200, {
                "operator": "HAG_Ai",
                "operator_url": "https://hagai.online",
                "description": ABOUT_HAG_AI,
                "tagline": "AI agents for finance functions that move a number.",
                "motto": "The edge is no longer the tool. It is how effectively tools become outcomes.",
                "services": [
                    {"name": "Revenue Assurance",        "tagline": "Leakage detection · pricing audit · recovery"},
                    {"name": "Prediction Service",       "tagline": "Markets · Football · Outcomes — calibrated probabilities, locked logs"},
                    {"name": "Customize ERP",            "tagline": "End-to-end ERP — SAP · NetSuite · Dynamics · Odoo · Sage · custom"},
                    {"name": "Close & Reconciliation",   "tagline": "Month-end close · GL recs · financial reporting"},
                    {"name": "FP&A and Variance",        "tagline": "Forecasting · driver analysis · commentary"},
                    {"name": "AP/AR Automation",         "tagline": "Invoice capture · 3-way match · collections"},
                    {"name": "Internal Control & Audit", "tagline": "Controls design · testing · workpapers"},
                    {"name": "Board Packs",              "tagline": "Narrative + numbers, ready to ship"},
                ],
                "contact_email": "hello@gkall.online",
                "consulting_email": "hello@hagai.online",
            }, cache="public, max-age=300")

        if p == "/api/sponsors":
            with db() as c:
                rows = c.execute(
                    "SELECT name, tier, amount_usdt, month, link_url, note, display_order "
                    "FROM sponsors WHERE status='active' "
                    "ORDER BY display_order ASC, amount_usdt DESC, created_at ASC"
                ).fetchall()
            return self._json(200, [dict(r) for r in rows], cache="public, max-age=60")

        if p == "/api/sponsor":
            tg_url = ""
            if TG_CHANNEL:
                ch = TG_CHANNEL.lstrip("@")
                if not ch.startswith("-"): tg_url = f"https://t.me/{ch}"
            socials = {}
            if SOCIAL_TWITTER:   socials["twitter"]   = SOCIAL_TWITTER
            if SOCIAL_INSTAGRAM: socials["instagram"] = SOCIAL_INSTAGRAM
            if SOCIAL_TIKTOK:    socials["tiktok"]    = SOCIAL_TIKTOK
            if SOCIAL_FACEBOOK:  socials["facebook"]  = SOCIAL_FACEBOOK
            if tg_url:           socials["telegram"]  = tg_url
            return self._json(200, {
                "wallet": SPONSOR_WALLET,
                "network": "Tron (TRC20)",
                "asset": "USDT",
                "prize_usdt": PRIZE_USDT,
                "monthly_prizes": MONTHLY_PRIZES,
                "note": "Donations cover winner payouts. Manual review.",
                "telegram_url": tg_url,
                "socials": socials,
                "tiers": SPONSORSHIP_TIERS,
                "minimum_usdt": SPONSOR_MIN_USDT,
                "launch_date_utc": LAUNCH_DATE_UTC,
                "contact_email": "hello@gkall.online",
            }, cache="public, max-age=60")

        if p == "/api/questions/draw":
            # Deprecated. Answers used to be exposed here; now hidden behind /api/game/*.
            return self._json(410, {"error":"deprecated", "detail":"Use /api/game/start to play. Answers are no longer exposed."})

        if p == "/api/leaderboard":
            # All-time: only qualifying scores (>= QUALIFY_MIN), best run per player
            qs = parse_qs(u.query or "")
            country_filter = (qs.get("country") or [""])[0].strip().upper()[:2] or None
            params = [QUALIFY_MIN]
            cf_clause = ""
            if country_filter:
                cf_clause = " AND country = ?"
                params.append(country_filter)
            params.append(MAX_LIMIT)
            with db() as c:
                rows = c.execute(f"""
                    WITH ranked AS (
                        SELECT id, name, score, prize, won, total_time, created_at, country,
                               ROW_NUMBER() OVER (PARTITION BY LOWER(name)
                                                  ORDER BY score DESC, total_time ASC, created_at ASC) AS rn
                        FROM scores
                        WHERE score >= ?{cf_clause}
                    )
                    SELECT id, name, score, prize, won, total_time AS totalTime, country,
                           strftime('%Y-%m-%d', created_at, 'unixepoch') AS date
                    FROM ranked WHERE rn=1
                    ORDER BY score DESC, total_time ASC, created_at ASC
                    LIMIT ?
                """, params).fetchall()
            out = []
            for r in rows:
                d = dict(r); d["won"] = bool(d["won"]); out.append(d)
            return self._json(200, out)

        if p == "/api/stats/countries":
            # Aggregate plays + distinct players per country (for the country toggle UI)
            with db() as c:
                rows = c.execute("""
                    SELECT country, COUNT(*) AS plays, COUNT(DISTINCT LOWER(name)) AS players
                    FROM scores
                    WHERE country IS NOT NULL AND country != ''
                    GROUP BY country
                    ORDER BY plays DESC
                    LIMIT 50
                """).fetchall()
                total_players = c.execute(
                    "SELECT COUNT(DISTINCT LOWER(name)) FROM scores WHERE score >= ?",
                    (QUALIFY_MIN,)
                ).fetchone()[0]
            return self._json(200, {
                "countries": [dict(r) for r in rows],
                "all_players": total_players,
            })

        if p == "/api/referral/me":
            # Look up referral code + counts for a player name
            qs = parse_qs(u.query or "")
            name = (qs.get("name") or [""])[0].strip()[:MAX_NAME]
            if not name:
                return self._json(400, {"error":"name_required"})
            cur_ym = current_ym()
            with db() as c:
                code_row = c.execute(
                    "SELECT referral_code FROM scores "
                    "WHERE LOWER(name)=LOWER(?) AND referral_code IS NOT NULL "
                    "ORDER BY created_at ASC LIMIT 1", (name,)
                ).fetchone()
                if not code_row:
                    return self._json(404, {"error":"no_plays_yet", "detail":"Play one round to get your referral code."})
                code = code_row["referral_code"]
                total = c.execute(
                    "SELECT COUNT(DISTINCT LOWER(name)) FROM scores "
                    "WHERE referred_by=? AND score >= ?", (code, QUALIFY_MIN)
                ).fetchone()[0]
                this_month = c.execute(
                    "SELECT COUNT(DISTINCT LOWER(name)) FROM scores "
                    "WHERE referred_by=? AND score >= ? "
                    "AND strftime('%Y-%m', created_at, 'unixepoch') = ?",
                    (code, QUALIFY_MIN, cur_ym)
                ).fetchone()[0]
            return self._json(200, {
                "code": code,
                "share_url": f"https://gkall.online/?ref={code}",
                "total_referrals": total,
                "month_referrals": this_month,
                "current_month": cur_ym,
            })

        if p == "/api/referral/leaderboard":
            # Top referrers this month
            cur_ym = current_ym()
            with db() as c:
                rows = c.execute("""
                    SELECT r.referred_by AS code,
                           o.name AS referrer_name,
                           COUNT(DISTINCT LOWER(r.name)) AS month_referrals
                    FROM scores r
                    LEFT JOIN scores o ON o.referral_code = r.referred_by
                                       AND o.id = (SELECT MIN(id) FROM scores WHERE referral_code = r.referred_by)
                    WHERE r.referred_by IS NOT NULL
                      AND r.score >= ?
                      AND strftime('%Y-%m', r.created_at, 'unixepoch') = ?
                    GROUP BY r.referred_by
                    ORDER BY month_referrals DESC, r.referred_by
                    LIMIT 20
                """, (QUALIFY_MIN, cur_ym)).fetchall()
            return self._json(200, {
                "month": cur_ym,
                "top": [{"code": r["code"], "referrer": obfuscate_name(r["referrer_name"] or ""), "referrals": r["month_referrals"]} for r in rows]
            })

        if p == "/api/admin/claims":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            with db() as c:
                rows = c.execute(
                    "SELECT id, name, wallet, contact, amount_usdt, score_id, status, tx_hash, "
                    "datetime(created_at,'unixepoch') AS created, "
                    "datetime(updated_at,'unixepoch') AS updated, ip "
                    "FROM claims ORDER BY created_at DESC"
                ).fetchall()
            return self._json(200, [dict(r) for r in rows])

        if p == "/api/admin/monthly":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            with db() as c:
                # auto-finalize any past months that need it
                try: maybe_finalize_past_months(c)
                except Exception as e: print("auto-finalize err:", e)
                rows = c.execute("""
                    SELECT id, year_month AS ym, rank, name, score, total_time,
                           score_id, prize_usdt, status, wallet, contact, tx_hash,
                           social_attested, social_handle,
                           x_attested, x_handle,
                           datetime(finalized_at,'unixepoch') AS finalized,
                           datetime(paid_at,'unixepoch') AS paid_at
                    FROM monthly_winners
                    ORDER BY year_month DESC, rank ASC
                """).fetchall()
            return self._json(200, [dict(r) for r in rows])

        if p == "/api/admin/sponsors":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            with db() as c:
                rows = c.execute(
                    "SELECT id, name, tier, amount_usdt, month, tx_hash, link_url, note, "
                    "display_order, status, datetime(created_at,'unixepoch') AS created "
                    "FROM sponsors ORDER BY created_at DESC"
                ).fetchall()
            return self._json(200, [dict(r) for r in rows])

        if p == "/api/admin/feedback":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            with db() as c:
                rows = c.execute(
                    "SELECT id, name, contact, category, rating, message, status, ip, "
                    "datetime(created_at,'unixepoch') AS created "
                    "FROM feedback ORDER BY created_at DESC LIMIT 200"
                ).fetchall()
            return self._json(200, [dict(r) for r in rows])

        if p == "/api/admin/stats/traffic":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            qs = parse_qs(u.query or "")
            try: days = max(1, min(90, int((qs.get("days") or ["7"])[0])))
            except (TypeError, ValueError): days = 7
            cutoff = _now() - days * 86400
            with db() as c:
                total = c.execute("SELECT COUNT(*) FROM page_views WHERE ts_utc >= ?", (cutoff,)).fetchone()[0]
                uniques = c.execute("SELECT COUNT(DISTINCT ip_hash) FROM page_views WHERE ts_utc >= ?", (cutoff,)).fetchone()[0]
                top_paths = c.execute(
                    "SELECT path, COUNT(*) AS n FROM page_views WHERE ts_utc >= ? "
                    "GROUP BY path ORDER BY n DESC LIMIT 20", (cutoff,)
                ).fetchall()
                top_refs = c.execute(
                    "SELECT COALESCE(referer,'(direct)') AS r, COUNT(*) AS n FROM page_views "
                    "WHERE ts_utc >= ? GROUP BY r ORDER BY n DESC LIMIT 20", (cutoff,)
                ).fetchall()
                by_day = c.execute(
                    "SELECT strftime('%Y-%m-%d', ts_utc, 'unixepoch') AS d, "
                    "COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques "
                    "FROM page_views WHERE ts_utc >= ? GROUP BY d ORDER BY d", (cutoff,)
                ).fetchall()
                by_ua = c.execute(
                    "SELECT ua_short, COUNT(*) AS n FROM page_views WHERE ts_utc >= ? "
                    "GROUP BY ua_short ORDER BY n DESC", (cutoff,)
                ).fetchall()
            return self._json(200, {
                "days": days,
                "total_views": total,
                "unique_visitors": uniques,
                "by_day": [dict(r) for r in by_day],
                "top_paths": [dict(r) for r in top_paths],
                "top_referers": [dict(r) for r in top_refs],
                "by_ua_class": [dict(r) for r in by_ua],
            })

        if p == "/api/admin/overview":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            with db() as c:
                pending_instant = c.execute("SELECT COUNT(*), COALESCE(SUM(amount_usdt),0) FROM claims WHERE status='pending'").fetchone()
                pending_monthly = c.execute("SELECT COUNT(*), COALESCE(SUM(prize_usdt),0) FROM monthly_winners WHERE status='pending'").fetchone()
                paid_instant    = c.execute("SELECT COUNT(*), COALESCE(SUM(amount_usdt),0) FROM claims WHERE status='paid'").fetchone()
                paid_monthly    = c.execute("SELECT COUNT(*), COALESCE(SUM(prize_usdt),0) FROM monthly_winners WHERE status='paid'").fetchone()
            return self._json(200, {
                "pending": {"instant": {"count": pending_instant[0], "amount": pending_instant[1]},
                            "monthly": {"count": pending_monthly[0], "amount": pending_monthly[1]}},
                "paid":    {"instant": {"count": paid_instant[0],    "amount": paid_instant[1]},
                            "monthly": {"count": paid_monthly[0],    "amount": paid_monthly[1]}},
            })

        # /admin pretty URL
        if p in ("/admin", "/admin/"):
            return self._file(STATIC_DIR / "admin.html")

        # Static
        rel = p.lstrip("/")
        if rel == "": rel = "index.html"
        try:
            target = (STATIC_DIR / rel).resolve()
            target.relative_to(STATIC_DIR.resolve())
        except (ValueError, OSError):
            return self.send_error(403, "Forbidden")
        if not target.exists():
            # SPA fallback
            target = STATIC_DIR / "index.html"
        return self._file(target)

    def _draw_questions(self, exclude):
        plan = [(1, 2), (2, 3), (3, 3), (4, 2)]   # (difficulty, count)
        picked, picked_ids = [], set(exclude)
        with db() as c:
            for diff, count in plan:
                # Try unseen first
                if picked_ids:
                    placeholders = ",".join("?" * len(picked_ids))
                    rows = c.execute(
                        f"SELECT * FROM questions WHERE difficulty=? AND id NOT IN ({placeholders}) "
                        f"ORDER BY RANDOM() LIMIT ?",
                        (diff, *picked_ids, count)
                    ).fetchall()
                else:
                    rows = c.execute(
                        "SELECT * FROM questions WHERE difficulty=? ORDER BY RANDOM() LIMIT ?",
                        (diff, count)
                    ).fetchall()
                # Top up with seen if pool too small
                if len(rows) < count:
                    need = count - len(rows)
                    fill = c.execute(
                        "SELECT * FROM questions WHERE difficulty=? ORDER BY RANDOM() LIMIT ?",
                        (diff, need)
                    ).fetchall()
                    rows = list(rows) + list(fill)
                for r in rows:
                    picked_ids.add(r["id"])
                    picked.append({
                        "id": r["id"], "cat": r["category"], "diff": r["difficulty"],
                        "q": r["question"], "opts": json.loads(r["options"]), "a": r["answer_index"],
                    })
        return self._json(200, picked)

    def do_POST(self):
        u = urlparse(self.path); p = u.path; ip = self._client_ip()

        if p == "/api/admin/tg/announce":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            if not (TG_BOT_TOKEN and TG_CHANNEL):
                return self._json(503, {"error":"tg_not_configured"})
            payload = self._body(8192) or {}
            text = str(payload.get("text","")).strip()
            if not text or len(text) > 4000:
                return self._json(400, {"error":"bad_text", "detail":"1-4000 chars required"})
            try:
                url_ = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
                data = json.dumps({
                    "chat_id": TG_CHANNEL, "text": text,
                    "parse_mode": "Markdown", "disable_web_page_preview": False,
                }).encode("utf-8")
                req = urllib.request.Request(url_, data=data,
                    headers={"Content-Type":"application/json"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    body = json.loads(r.read())
                return self._json(200, {"ok": bool(body.get("ok")), "tg_response": body})
            except Exception as e:
                return self._json(502, {"error":"tg_send_failed", "detail": str(e)})

        if p == "/api/admin/tg/set_description":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            if not (TG_BOT_TOKEN and TG_CHANNEL):
                return self._json(503, {"error":"tg_not_configured"})
            payload = self._body(8192) or {}
            description = str(payload.get("description","")).strip()
            if len(description) > 255:
                return self._json(400, {"error":"too_long", "detail":"Telegram caps description at 255 chars"})
            try:
                url_ = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/setChatDescription"
                data = json.dumps({"chat_id": TG_CHANNEL, "description": description}).encode("utf-8")
                req = urllib.request.Request(url_, data=data,
                    headers={"Content-Type":"application/json"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    body = json.loads(r.read())
                return self._json(200, {"ok": bool(body.get("ok")), "tg_response": body})
            except Exception as e:
                return self._json(502, {"error":"tg_set_description_failed", "detail": str(e)})

        if p == "/api/track":
            # Self-hosted page-view tracking. Tiny, no third-party calls.
            # Rate-limited per IP to prevent abuse.
            if not rate_ok(ip, "track", window=60, maxn=60):
                return self._json(429, {"ok": False})
            payload = self._body(2048) or {}
            path_str = str(payload.get("path", "/")).strip()[:200]
            if not path_str.startswith("/"):
                path_str = "/" + path_str
            ref = str(payload.get("referer", "")).strip()[:300] or None
            ua_full = (self.headers.get("User-Agent") or "")[:300]
            # Coarse UA tag (keep it short; full UA isn't useful for traffic)
            ua_tag = "bot" if ("bot" in ua_full.lower() or "spider" in ua_full.lower() or "crawl" in ua_full.lower()) \
                else ("mobile" if "mobi" in ua_full.lower() else "desktop")
            ip_h = hashlib.sha256((ip + "|gkall_pv_salt").encode("utf-8")).hexdigest()[:16] if ip else None
            try:
                with db() as c:
                    c.execute(
                        "INSERT INTO page_views(ts_utc,path,referer,ip_hash,ua_short) VALUES (?,?,?,?,?)",
                        (_now(), path_str, ref, ip_h, ua_tag)
                    )
                    c.commit()
            except Exception:
                pass
            return self._json(200, {"ok": True})

        if p == "/api/feedback":
            if not rate_ok(ip, "feedback", window=3600, maxn=5):
                return self._json(429, {"error":"rate_limited"})
            payload = self._body(4096)
            if not payload: return self._json(400, {"error":"bad_json"})
            name     = str(payload.get("name","")).strip()[:MAX_NAME]
            contact  = str(payload.get("contact","")).strip()[:MAX_CONTACT]
            category = str(payload.get("category","other")).strip().lower()[:24]
            if category not in ("bug","suggestion","praise","other"):
                category = "other"
            try:
                rating = int(payload.get("rating") or 0)
                if not (0 <= rating <= 5): rating = 0
            except (TypeError, ValueError):
                rating = 0
            message  = str(payload.get("message","")).strip()[:2000]
            if len(message) < 5:
                return self._json(400, {"error":"too_short", "detail":"Tell us a bit more — at least 5 characters."})
            with db() as c:
                c.execute(
                    "INSERT INTO feedback(name,contact,category,rating,message,ip,created_at) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (name or None, contact or None, category, rating or None, message, ip, _now())
                )
                c.commit()
            # Telegram nudge so operator knows feedback arrived
            tg_announce(f"💬 New {category} feedback received on gkall.online.")
            return self._json(200, {"ok": True, "message":"Thanks Pioneer — feedback received."})

        if p == "/api/game/start":
            # Rate limits: 5/min and 50/day per IP
            if not rate_ok(ip, "game_start", window=60, maxn=START_PER_MIN):
                return self._json(429, {"error":"rate_limited", "detail":"Too many starts in the past minute. Slow down."})
            if not rate_ok(ip, "game_start_daily", window=86400, maxn=START_PER_DAY):
                return self._json(429, {"error":"daily_limit", "detail":f"Daily limit ({START_PER_DAY} games) reached. Resets in 24h."})

            # 8KB body cap — Turnstile tokens can be 1-2 KB
            payload = self._body(8192) or {}
            name = str(payload.get("name","")).strip()[:MAX_NAME] or "Anonymous"
            turnstile_token = str(payload.get("turnstile_token","")).strip()
            # Referral: 8-char Crockford-base32; ignore anything malformed
            referred_by_raw = str(payload.get("referred_by","")).strip().upper()
            referred_by = referred_by_raw if re.match(r"^[A-Z0-9]{8}$", referred_by_raw) else ""
            if TURNSTILE_SECRET and not turnstile_token:
                print(f"WARN /api/game/start no token in body (size={self.headers.get('Content-Length')})")

            # Turnstile (only enforced when configured)
            if TURNSTILE_SECRET and not verify_turnstile(turnstile_token, ip):
                return self._json(403, {"error":"captcha_failed", "detail":"Please complete the human-verification check."})

            # Country geo-lookup (best-effort, never blocks)
            country = country_for_ip(ip)

            with db() as c:
                _expire_old_sessions(c)

                # Make sure the referral code points to a real player (no self-referral, no bogus codes)
                if referred_by:
                    valid = c.execute("SELECT LOWER(name) AS lname FROM scores WHERE referral_code=? LIMIT 1", (referred_by,)).fetchone()
                    if not valid or valid["lname"] == name.lower():
                        referred_by = ""

                # Single active session per IP — kill any existing
                c.execute(
                    "UPDATE game_sessions SET status='superseded', last_action_at=? "
                    "WHERE ip=? AND status='active'",
                    (_now(), ip)
                )

                try:
                    plan = _build_question_plan(c)
                except Exception as e:
                    print("plan build error:", e)
                    return self._json(500, {"error":"plan_failed"})
                if len(plan) < 10:
                    return self._json(503, {"error":"insufficient_questions"})
                sid = _new_session_id()
                now = _now()
                c.execute(
                    "INSERT INTO game_sessions(id,name,ip,question_plan,started_at,last_action_at,country,referred_by) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (sid, name, ip, json.dumps(plan), now, now, country or None, referred_by or None)
                )
                c.commit()
            return self._json(200, {
                "session_id": sid,
                "question_count": len(plan),
                "timer_seconds": TIMER_SEC,
                "question": _public_question(plan, 0),
            })

        if p == "/api/game/answer":
            if not rate_ok(ip, "game_answer", window=60, maxn=200):
                return self._json(429, {"error":"rate_limited"})
            payload = self._body(8192)   # allow bigger body for behavioral data
            if not payload: return self._json(400, {"error":"bad_json"})
            sid = str(payload.get("session_id","")).strip()
            try:
                qid = int(payload.get("q_id"))
                choice = int(payload.get("choice"))
            except (TypeError, ValueError):
                return self._json(400, {"error":"bad_fields"})
            if not sid: return self._json(400, {"error":"missing_session"})
            if not (0 <= choice <= 3): return self._json(400, {"error":"bad_choice"})

            # Behavioral fingerprint (optional — capped to avoid bloat)
            mouse_samples = payload.get("mouse", [])
            if not isinstance(mouse_samples, list): mouse_samples = []
            mouse_samples = mouse_samples[:60]   # max 60 samples per question (15s at 4Hz)
            client_elapsed_ms = payload.get("client_elapsed_ms")
            try: client_elapsed_ms = float(client_elapsed_ms) if client_elapsed_ms is not None else None
            except (TypeError, ValueError): client_elapsed_ms = None

            with db() as c:
                sess = c.execute("SELECT * FROM game_sessions WHERE id=?", (sid,)).fetchone()
                if not sess: return self._json(404, {"error":"session_not_found"})
                if sess["status"] != "active":
                    return self._json(410, {"error":"session_inactive", "status": sess["status"]})

                plan = json.loads(sess["question_plan"])
                cq = sess["current_q"]
                if cq >= len(plan):
                    return self._json(410, {"error":"session_complete"})

                expected_qid = plan[cq]["q_id"]
                if qid != expected_qid:
                    return self._json(400, {"error":"wrong_question_id", "expected": expected_qid})

                now = _now()
                elapsed = now - sess["last_action_at"]   # seconds since last action (server clock)
                timeout = elapsed > (TIMER_SEC + TIMER_BUFFER)
                correct = (not timeout) and (choice == plan[cq]["a"])

                # Append to answer log (forensic). Mouse trail kept for later analysis.
                answers = json.loads(sess["answers"])
                answers.append({
                    "q_id": qid, "choice": choice, "correct": correct,
                    "timeout": timeout, "elapsed_s": elapsed, "ts": now,
                    "client_elapsed_ms": client_elapsed_ms,
                    "mouse_samples": len(mouse_samples),
                    "mouse": mouse_samples,
                })

                new_q = cq + 1
                new_score = sess["score"] + (1 if correct else 0)

                game_over = (not correct) or (new_q >= len(plan))
                new_status = ("won" if (correct and new_q >= len(plan))
                              else ("lost" if not correct else "active"))

                if game_over:
                    total_time = now - sess["started_at"]
                    score_id, claim_code, cap_reached = _finalize_session_score(c, sess, plan, new_score, total_time, new_status, ip)
                    c.execute(
                        "UPDATE game_sessions SET current_q=?, score=?, answers=?, last_action_at=?, status=?, score_id=? WHERE id=?",
                        (new_q, new_score, json.dumps(answers), now, new_status, score_id, sid)
                    )
                    c.commit()
                    # Telegram announce 10/10 only when payout is real
                    if new_status == "won" and new_score == 10 and not cap_reached:
                        tg_announce(
                            f"🏆 *New 10/10 winner!*\n\n"
                            f"*{sess['name']}* aced 10 questions in {total_time:.1f}s and just won *${PRIZE_USDT} USDT* on gkall.online.\n\n"
                            f"Try your luck → https://gkall.online"
                        )
                    response = {
                        "correct": correct, "timeout": timeout,
                        "score": new_score, "q_index": cq,
                        "game_over": True, "won": (new_status == "won"),
                        "total_time": total_time,
                        "score_id": score_id,
                        "claim_code": (claim_code if new_score >= QUALIFY_MIN else None),
                        "cap_reached": cap_reached,
                        "monthly_cap": INSTANT_WIN_CAP_PER_MONTH,
                    }
                    # Reveal correct option text ONLY on full-round timeouts at Q10
                    # (prevents bots from enumerating answers by intentionally answering wrong)
                    if not correct and cq == len(plan) - 1 and timeout:
                        response["correct_text"] = plan[cq]["opts"][plan[cq]["a"]]
                    return self._json(200, response)
                else:
                    c.execute(
                        "UPDATE game_sessions SET current_q=?, score=?, answers=?, last_action_at=? WHERE id=?",
                        (new_q, new_score, json.dumps(answers), now, sid)
                    )
                    c.commit()
                    return self._json(200, {
                        "correct": True, "timeout": False,
                        "score": new_score, "q_index": cq,
                        "game_over": False,
                        "next_question": _public_question(plan, new_q),
                    })

        if p == "/api/game/forfeit":
            payload = self._body(1024) or {}
            sid = str(payload.get("session_id","")).strip()
            reason = str(payload.get("reason","unspecified"))[:200]
            if not sid: return self._json(400, {"error":"missing_session"})
            with db() as c:
                sess = c.execute("SELECT id, status FROM game_sessions WHERE id=?", (sid,)).fetchone()
                if not sess: return self._json(404, {"error":"session_not_found"})
                if sess["status"] != "active":
                    return self._json(200, {"ok": True, "already": sess["status"]})
                c.execute("UPDATE game_sessions SET status='forfeited', forfeit_reason=?, last_action_at=? WHERE id=?",
                          (reason, _now(), sid))
                c.commit()
            print(f"FORFEIT session={sid} ip={ip} reason={reason}", flush=True)
            return self._json(200, {"ok": True})

        if p == "/api/leaderboard":
            return self._json(410, {"error":"deprecated", "detail":"Scoring is now server-side via /api/game/*. Please refresh the page."})

        if p == "/api/leaderboard_legacy":  # never used, kept for symmetry
            if not rate_ok(ip, "score"): return self._json(429, {"error":"rate_limited"})
            payload = self._body()
            if not payload: return self._json(400, {"error":"bad_json"})
            try:
                name = str(payload.get("name","")).strip()[:MAX_NAME] or "Anonymous"
                score = int(payload.get("score", 0))
                prize = int(payload.get("prize", 0))
                won   = bool(payload.get("won", False))
                tt    = float(payload.get("totalTime", 0))
            except (TypeError, ValueError):
                return self._json(400, {"error":"bad_fields"})
            if not (0 <= score <= 10) or not (0 <= prize <= 10) or not (0 <= tt <= 600):
                return self._json(400, {"error":"out_of_range"})
            if won and (score != 10 or prize != PRIZE_USDT):
                return self._json(400, {"error":"won_inconsistent"})
            if score > 0 and tt / max(score, 1) < 0.3:
                return self._json(400, {"error":"implausible_speed"})
            # Unique claim code (retry on rare collision)
            code = None
            with db() as c:
                for _ in range(5):
                    candidate = gen_claim_code()
                    if not c.execute("SELECT 1 FROM scores WHERE claim_code=?", (candidate,)).fetchone():
                        code = candidate; break
                if not code: code = gen_claim_code()  # accept tiny collision risk
                cur = c.execute(
                    "INSERT INTO scores(name,score,prize,won,total_time,ip,created_at,claim_code) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (name, score, prize, 1 if won else 0, tt, ip, int(time.time()), code)
                )
                sid = cur.lastrowid
                c.commit()
            # Announce 10/10 wins on Telegram
            if won and score == 10:
                tg_announce(
                    f"🏆 *New 10/10 winner!*\n\n"
                    f"*{name}* aced 10 questions in {tt:.1f}s and just won *${PRIZE_USDT} USDT* on gkall.online.\n\n"
                    f"Try your luck → https://gkall.online"
                )
            return self._json(200, {"ok": True, "score_id": sid, "claim_code": code})

        if p == "/api/claim/monthly":
            if not rate_ok(ip, "claim_monthly", window=3600, maxn=5):
                return self._json(429, {"error":"rate_limited"})
            payload = self._body(2048)
            if not payload: return self._json(400, {"error":"bad_json"})
            code = str(payload.get("code","")).strip().upper().replace(" ","")
            wallet = str(payload.get("wallet","")).strip()
            contact = str(payload.get("contact","")).strip()[:MAX_CONTACT]
            social_attested = bool(payload.get("social_attested", False))
            social_handle = str(payload.get("social_handle","")).strip()[:64]
            x_attested = bool(payload.get("x_attested", False))
            x_handle = str(payload.get("x_handle","")).strip()[:64]
            if not re.match(r"^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$", code):
                return self._json(400, {"error":"bad_code", "detail":"Format: XXXX-XXXX-XXXX"})
            if not TRC20_RE.match(wallet):
                return self._json(400, {"error":"bad_wallet", "detail":"TRC20 address must start with T and be 34 chars."})
            if not social_attested:
                return self._json(400, {"error":"social_required", "detail":"Please confirm you've joined our Telegram channel — required for payout (https://t.me/gkallonline)."})
            if not x_attested:
                return self._json(400, {"error":"x_required", "detail":"Please confirm you follow @gkallonline on X AND liked the pinned launch post — required for monthly payout (https://x.com/gkallonline)."})
            with db() as c:
                score = c.execute("SELECT id, name FROM scores WHERE claim_code=?", (code,)).fetchone()
                if not score:
                    return self._json(404, {"error":"code_not_found", "detail":"This claim code doesn't match any record."})
                winner = c.execute("SELECT id, year_month, rank, prize_usdt, status FROM monthly_winners WHERE score_id=?", (score["id"],)).fetchone()
                if not winner:
                    return self._json(403, {"error":"not_a_winner", "detail":"This code belongs to a real run, but it didn't finish top 3 in its month. Keep playing!"})
                if winner["status"] != "pending":
                    return self._json(409, {"error":"already_processed", "detail":f"This prize was already {winner['status']}."})
                c.execute(
                    "UPDATE monthly_winners SET wallet=?, contact=?, "
                    "social_attested=1, social_handle=?, "
                    "x_attested=1, x_handle=?, "
                    "paid_at=NULL WHERE id=?",
                    (wallet, contact, social_handle, x_handle, winner["id"])
                )
                c.commit()
            return self._json(200, {"ok": True, "rank": winner["rank"], "prize_usdt": winner["prize_usdt"],
                                    "ym": winner["year_month"],
                                    "message": "Verified. Your prize will be paid after we verify your Telegram + X follows."})

        if p == "/api/claim":
            if not rate_ok(ip, "claim", window=3600, maxn=3):
                return self._json(429, {"error":"rate_limited"})
            payload = self._body(2048)
            if not payload: return self._json(400, {"error":"bad_json"})
            name    = str(payload.get("name","")).strip()[:MAX_NAME] or "Anonymous"
            wallet  = str(payload.get("wallet","")).strip()
            contact = str(payload.get("contact","")).strip()[:MAX_CONTACT]
            score_id = payload.get("score_id")
            social_attested = bool(payload.get("social_attested", False))
            social_handle = str(payload.get("social_handle","")).strip()[:64]
            if not TRC20_RE.match(wallet):
                return self._json(400, {"error":"bad_wallet", "detail":"Tron TRC20 address must start with T and be 34 chars."})
            if not social_attested:
                return self._json(400, {"error":"social_required", "detail":"Please confirm you've joined our Telegram channel — required for payout (https://t.me/gkallonline)."})
            try:
                score_id = int(score_id) if score_id is not None else None
            except (TypeError, ValueError):
                score_id = None
            with db() as c:
                row = c.execute("SELECT id, won, prize FROM scores WHERE id=?", (score_id,)).fetchone() if score_id else None
                if not row or not row["won"]:
                    return self._json(400, {"error":"no_winning_score", "detail":"This score is not eligible. Win 10/10 first."})
                if row["prize"] != PRIZE_USDT:
                    return self._json(400, {"error":"cap_reached", "detail":f"This 10/10 hit the monthly instant-payout cap ({INSTANT_WIN_CAP_PER_MONTH} per player per month). Your score still counts toward the monthly leaderboard."})
                dup = c.execute("SELECT id FROM claims WHERE score_id=?", (score_id,)).fetchone()
                if dup:
                    return self._json(409, {"error":"already_claimed", "claim_id": dup["id"]})
                now = int(time.time())
                cur = c.execute(
                    "INSERT INTO claims(name,wallet,contact,amount_usdt,score_id,status,ip,social_attested,social_handle,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (name, wallet, contact, PRIZE_USDT, score_id, "pending", ip, 1, social_handle, now, now)
                )
                cid = cur.lastrowid
                c.commit()
            return self._json(200, {"ok": True, "claim_id": cid, "status": "pending"})

        if p == "/api/admin/monthly/finalize":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            payload = self._body() or {}
            ym = str(payload.get("ym","")).strip()[:7]
            if not re.match(r"^\d{4}-\d{2}$", ym):
                return self._json(400, {"error":"bad_ym"})
            with db() as c:
                n = finalize_month(c, ym)
                rows = c.execute(
                    "SELECT rank, name, score, total_time, prize_usdt, status FROM monthly_winners "
                    "WHERE year_month=? ORDER BY rank", (ym,)
                ).fetchall()
            return self._json(200, {"ok": True, "ym": ym, "inserted": n, "winners": [dict(r) for r in rows]})

        if p == "/api/admin/sponsors/add":
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            payload = self._body(2048) or {}
            name   = str(payload.get("name","")).strip()[:80]
            tier   = str(payload.get("tier","pioneer")).strip().lower()
            try: amount = int(payload.get("amount_usdt", 0))
            except (TypeError, ValueError): amount = 0
            month  = str(payload.get("month","")).strip()[:7] or None
            tx     = str(payload.get("tx_hash","")).strip()[:128] or None
            link   = str(payload.get("link_url","")).strip()[:200] or None
            note   = str(payload.get("note","")).strip()[:500] or None
            order_ = int(payload.get("display_order", 0) or 0)
            if not name or tier not in ("pioneer","round","title") or amount <= 0:
                return self._json(400, {"error":"bad_fields"})
            with db() as c:
                cur = c.execute(
                    "INSERT INTO sponsors(name,tier,amount_usdt,month,tx_hash,link_url,note,display_order,created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (name, tier, amount, month, tx, link, note, order_, int(time.time()))
                )
                c.commit()
            tg_announce(f"💎 *New {tier.title()} Sponsor — {name}!*\nContribution: ${amount} USDT. Thank you for supporting the gkall prize pool.")
            return self._json(200, {"ok": True, "id": cur.lastrowid})

        m_sp = re.match(r"^/api/admin/sponsors/(\d+)/(hide|show|remove)$", p)
        if m_sp:
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            sid = int(m_sp.group(1)); action = m_sp.group(2)
            with db() as c:
                if action == "remove":
                    c.execute("DELETE FROM sponsors WHERE id=?", (sid,))
                else:
                    c.execute("UPDATE sponsors SET status=? WHERE id=?",
                              ("hidden" if action == "hide" else "active", sid))
                c.commit()
            return self._json(200, {"ok": True})

        m_mw = re.match(r"^/api/admin/monthly/(\d+)/(paid|reject)$", p)
        if m_mw:
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            mid = int(m_mw.group(1)); action = m_mw.group(2)
            payload = self._body() or {}
            tx = str(payload.get("tx_hash","")).strip()[:128]
            wallet = str(payload.get("wallet","")).strip()
            contact = str(payload.get("contact","")).strip()[:MAX_CONTACT]
            new_status = "paid" if action == "paid" else "rejected"
            with db() as c:
                r = c.execute("SELECT id, name, rank, year_month, prize_usdt FROM monthly_winners WHERE id=?", (mid,)).fetchone()
                if not r: return self._json(404, {"error":"not_found"})
                c.execute("""UPDATE monthly_winners
                             SET status=?, tx_hash=COALESCE(NULLIF(?,''), tx_hash),
                                 wallet=COALESCE(NULLIF(?,''), wallet),
                                 contact=COALESCE(NULLIF(?,''), contact),
                                 paid_at=CASE WHEN ?='paid' THEN strftime('%s','now') ELSE paid_at END
                             WHERE id=?""",
                          (new_status, tx, wallet, contact, new_status, mid))
                c.commit()
            if action == "paid":
                medals = {1: "🥇", 2: "🥈", 3: "🥉"}
                medal = medals.get(r["rank"], f"#{r['rank']}")
                msg = (f"✅ *${r['prize_usdt']} USDT paid* — {medal} {obfuscate_name(r['name'])} for {r['year_month']}\n")
                if tx:
                    msg += f"\ntx: https://tronscan.org/#/transaction/{tx}"
                tg_announce(msg)
            return self._json(200, {"ok": True, "id": mid, "status": new_status})

        # /api/admin/claims/<id>/paid
        m = re.match(r"^/api/admin/claims/(\d+)/(paid|reject)$", p)
        if m:
            if not self._admin_ok(): return self._json(401, {"error":"unauthorized"})
            cid = int(m.group(1)); action = m.group(2)
            payload = self._body() or {}
            tx = str(payload.get("tx_hash","")).strip()[:128]
            new_status = "paid" if action == "paid" else "rejected"
            with db() as c:
                r = c.execute("SELECT id FROM claims WHERE id=?", (cid,)).fetchone()
                if not r: return self._json(404, {"error":"not_found"})
                c.execute("UPDATE claims SET status=?, tx_hash=?, updated_at=? WHERE id=?",
                          (new_status, tx, int(time.time()), cid))
                c.commit()
            return self._json(200, {"ok": True, "id": cid, "status": new_status})

        return self.send_error(404, "Not Found")


def main():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    print(f"questions in db at startup: {question_count()}")
    if question_count() < 200:
        print("bootstrapping question bank…")
        bootstrap_questions()
    start_countdown_scheduler()
    httpd = ThreadingHTTPServer(LISTEN, Handler)
    print(f"gkall listening on {LISTEN[0]}:{LISTEN[1]}  static={STATIC_DIR}  db={DB_PATH}", flush=True)
    print(f"admin token: {'SET' if ADMIN_TOKEN != 'change-me-admin-token' else 'DEFAULT (change ADMIN_TOKEN env var!)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
