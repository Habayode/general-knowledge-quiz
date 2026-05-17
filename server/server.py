"""
gkall.online — General Knowledge Quiz backend.

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
import json, os, sqlite3, time, urllib.request, urllib.parse, html, secrets, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE         = Path(__file__).parent.resolve()
STATIC_DIR   = HERE / "public"
DB_PATH      = HERE / "quizdb.sqlite"
SEED_PATH    = HERE / "questions_seed.json"
LISTEN       = ("127.0.0.1", 8080)    # bound locally — Caddy fronts it on :443
ADMIN_TOKEN  = os.environ.get("ADMIN_TOKEN", "change-me-admin-token")
SPONSOR_WALLET = os.environ.get("SPONSOR_WALLET", "TMNVuGuxMfTVVFJuVcjsxswYsCkMnTZRSy")
PRIZE_USDT   = 10
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        """)

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
            ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml",
            ".ico":"image/x-icon", ".webp":"image/webp", ".txt":"text/plain; charset=utf-8",
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

        if p == "/api/stats":
            with db() as c:
                total_plays = c.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
                winners     = c.execute("SELECT COUNT(*) FROM scores WHERE won=1").fetchone()[0]
                paid_out    = c.execute("SELECT COALESCE(SUM(amount_usdt),0) FROM claims WHERE status='paid'").fetchone()[0]
                pending     = c.execute("SELECT COUNT(*) FROM claims WHERE status='pending'").fetchone()[0]
                qcount      = c.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
            return self._json(200, {
                "plays": total_plays, "winners": winners,
                "paid_usdt": paid_out, "pending_claims": pending,
                "questions": qcount, "prize_usdt": PRIZE_USDT,
            })

        if p == "/api/sponsor":
            return self._json(200, {
                "wallet": SPONSOR_WALLET,
                "network": "Tron (TRC20)",
                "asset": "USDT",
                "prize_usdt": PRIZE_USDT,
                "note": "Donations cover winner payouts. Manual review.",
            }, cache="public, max-age=60")

        if p == "/api/questions/draw":
            qs = parse_qs(u.query)
            try:
                exclude = [int(x) for x in (qs.get("exclude", [""])[0] or "").split(",") if x.strip().isdigit()]
            except Exception:
                exclude = []
            return self._draw_questions(exclude)

        if p == "/api/leaderboard":
            with db() as c:
                rows = c.execute(
                    "SELECT id, name, score, prize, won, total_time AS totalTime, "
                    "strftime('%Y-%m-%d', created_at,'unixepoch') AS date "
                    "FROM scores ORDER BY score DESC, total_time ASC LIMIT ?",
                    (MAX_LIMIT,)
                ).fetchall()
            out = []
            for r in rows:
                d = dict(r); d["won"] = bool(d["won"]); out.append(d)
            return self._json(200, out)

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

        if p == "/api/leaderboard":
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
            with db() as c:
                cur = c.execute(
                    "INSERT INTO scores(name,score,prize,won,total_time,ip,created_at) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (name, score, prize, 1 if won else 0, tt, ip, int(time.time()))
                )
                sid = cur.lastrowid
                c.commit()
            return self._json(200, {"ok": True, "score_id": sid})

        if p == "/api/claim":
            if not rate_ok(ip, "claim", window=3600, maxn=3):
                return self._json(429, {"error":"rate_limited"})
            payload = self._body(2048)
            if not payload: return self._json(400, {"error":"bad_json"})
            name    = str(payload.get("name","")).strip()[:MAX_NAME] or "Anonymous"
            wallet  = str(payload.get("wallet","")).strip()
            contact = str(payload.get("contact","")).strip()[:MAX_CONTACT]
            score_id = payload.get("score_id")
            if not TRC20_RE.match(wallet):
                return self._json(400, {"error":"bad_wallet", "detail":"Tron TRC20 address must start with T and be 34 chars."})
            try:
                score_id = int(score_id) if score_id is not None else None
            except (TypeError, ValueError):
                score_id = None
            # verify score exists and is a winner
            with db() as c:
                row = c.execute("SELECT id, won, prize FROM scores WHERE id=?", (score_id,)).fetchone() if score_id else None
                if not row or not row["won"] or row["prize"] != PRIZE_USDT:
                    return self._json(400, {"error":"no_winning_score", "detail":"This score is not eligible. Win the quiz first."})
                # don't allow duplicate claims for the same score
                dup = c.execute("SELECT id FROM claims WHERE score_id=?", (score_id,)).fetchone()
                if dup:
                    return self._json(409, {"error":"already_claimed", "claim_id": dup["id"]})
                now = int(time.time())
                cur = c.execute(
                    "INSERT INTO claims(name,wallet,contact,amount_usdt,score_id,status,ip,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (name, wallet, contact, PRIZE_USDT, score_id, "pending", ip, now, now)
                )
                cid = cur.lastrowid
                c.commit()
            return self._json(200, {"ok": True, "claim_id": cid, "status": "pending"})

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
    httpd = ThreadingHTTPServer(LISTEN, Handler)
    print(f"gkall listening on {LISTEN[0]}:{LISTEN[1]}  static={STATIC_DIR}  db={DB_PATH}", flush=True)
    print(f"admin token: {'SET' if ADMIN_TOKEN != 'change-me-admin-token' else 'DEFAULT (change ADMIN_TOKEN env var!)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
