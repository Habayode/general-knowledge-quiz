"""
Global leaderboard + static file server for the General Knowledge Quiz.

Endpoints:
  GET  /api/leaderboard           -> top 50 scores (JSON)
  POST /api/leaderboard           -> submit a score { name, score, prize, won, totalTime }
  GET  /api/health                -> simple ping
  GET  /                          -> serves index.html
  GET  /<file>                    -> serves static files

Listens on 0.0.0.0:8080. Caddy in front of this handles HTTPS for gkall.online.
Storage: SQLite in leaderboard.db (same directory).
"""
import json
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent.resolve()
STATIC_DIR = HERE / "public"
DB_PATH = HERE / "leaderboard.db"
LISTEN = ("0.0.0.0", 8080)
MAX_NAME = 20
MAX_LIMIT = 50
RATE_WINDOW = 60       # seconds
RATE_MAX = 10          # submissions per IP per window

# ---- DB ----
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                score INTEGER NOT NULL,
                prize INTEGER NOT NULL,
                won INTEGER NOT NULL,
                total_time REAL NOT NULL,
                ip TEXT,
                created_at INTEGER NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores(score DESC, total_time ASC)")

# ---- Rate limit (simple in-memory) ----
_submissions = {}  # ip -> list[timestamp]

def rate_ok(ip):
    now = time.time()
    arr = [t for t in _submissions.get(ip, []) if now - t < RATE_WINDOW]
    if len(arr) >= RATE_MAX:
        _submissions[ip] = arr
        return False
    arr.append(now)
    _submissions[ip] = arr
    return True

# ---- HTTP handler ----
class Handler(BaseHTTPRequestHandler):
    server_version = "GKQuiz/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}", flush=True)

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return
        # MIME
        ext = path.suffix.lower()
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".txt": "text/plain; charset=utf-8",
        }.get(ext, "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/health":
            return self._send_json(200, {"ok": True, "time": int(time.time())})
        if u.path == "/api/leaderboard":
            with db() as c:
                rows = c.execute(
                    "SELECT name, score, prize, won, total_time AS totalTime, "
                    "datetime(created_at,'unixepoch') AS date "
                    "FROM scores ORDER BY score DESC, total_time ASC LIMIT ?",
                    (MAX_LIMIT,)
                ).fetchall()
            out = [dict(r) for r in rows]
            for r in out:
                r["won"] = bool(r["won"])
                r["date"] = r["date"].split(" ")[0] if r["date"] else ""
            return self._send_json(200, out)

        # Static
        rel = u.path.lstrip("/")
        if rel == "":
            rel = "index.html"
        target = (STATIC_DIR / rel).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self.send_error(403, "Forbidden")
        self._send_file(target)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/leaderboard":
            return self.send_error(404, "Not Found")
        ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        if not rate_ok(ip):
            return self._send_json(429, {"error": "rate_limited"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096:
                return self._send_json(400, {"error": "bad_size"})
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send_json(400, {"error": "bad_json"})

        try:
            name = str(payload.get("name", "")).strip()[:MAX_NAME] or "Anonymous"
            score = int(payload.get("score", 0))
            prize = int(payload.get("prize", 0))
            won = bool(payload.get("won", False))
            total_time = float(payload.get("totalTime", 0))
        except (TypeError, ValueError):
            return self._send_json(400, {"error": "bad_fields"})

        if not (0 <= score <= 10): return self._send_json(400, {"error": "bad_score"})
        if not (0 <= prize <= 10): return self._send_json(400, {"error": "bad_prize"})
        if not (0 <= total_time <= 600): return self._send_json(400, {"error": "bad_time"})
        # win implies score==10 and prize==10
        if won and (score != 10 or prize != 10):
            return self._send_json(400, {"error": "bad_won"})
        # plausibility: at least ~0.5s per answered question
        if score > 0 and total_time / max(score, 1) < 0.3:
            return self._send_json(400, {"error": "implausible_speed"})

        with db() as c:
            c.execute(
                "INSERT INTO scores (name, score, prize, won, total_time, ip, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (name, score, prize, 1 if won else 0, total_time, ip, int(time.time()))
            )
            c.commit()
        self._send_json(200, {"ok": True})


def main():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    httpd = ThreadingHTTPServer(LISTEN, Handler)
    print(f"Serving on http://{LISTEN[0]}:{LISTEN[1]}  static={STATIC_DIR}  db={DB_PATH}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
