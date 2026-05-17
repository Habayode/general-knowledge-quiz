"""
import_datasets.py — One-shot expansion of the gkall question pool.

Pulls multi-choice questions from public datasets via the HuggingFace
datasets-server API (no auth required for public datasets) and from the
Open Trivia DB API. Normalizes each to (category, difficulty, question,
4 options, answer_index) and inserts into the existing SQLite DB.

Run:
  python C:\\quiz\\import_datasets.py [DATASET_NAME ...]
  (no args = run all)

Idempotent: UNIQUE(question, difficulty) prevents duplicates on re-runs.
Safe to run while server.py is serving — SQLite WAL handles concurrent
readers + a single writer.

Datasets (license, target difficulty):
  otdb        - Open Trivia DB scrape (CC BY-SA 4.0)            [1-4]
  mmlu        - cais/mmlu     all/test                  (MIT)   [3-4]
  arc_easy    - allenai/ai2_arc ARC-Easy / train+test   (CC)    [2]
  arc_chal    - allenai/ai2_arc ARC-Challenge / train+test       [3]
  obqa        - openbookqa main / train+test            (Apache)[2]
  csqa        - tau/commonsense_qa default / train+val  (CC)    [2]
  truthfulqa  - truthful_qa multiple_choice / validation(Apache)[4]
  sciq        - sciq default / train+test+validation    (CC)    [2]
"""

import argparse, base64, hashlib, html, json, os, random, re, sqlite3, sys, time
import urllib.parse, urllib.request

DB_PATH = os.environ.get("QUIZ_DB", r"C:\quiz\quizdb.sqlite")
UA      = "gkall-importer/1.0"
HF_API  = "https://datasets-server.huggingface.co/rows"
PAGE    = 100      # rows per HF API call
SLEEP   = 0.6      # between HF API calls
OTDB_SLEEP = 5.5   # OTDB rate limit
MAX_QLEN   = 380
MAX_OPTLEN = 180

# ----------------- HTTP -----------------
def http_json(url, retries=4):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"HTTP failed after retries: {url} :: {last}")

def hf_rows(dataset, config, split, max_rows=200_000):
    """Generator of row dicts from HF datasets-server, paginated."""
    offset = 0
    while offset < max_rows:
        q = urllib.parse.urlencode({"dataset": dataset, "config": config, "split": split,
                                    "offset": offset, "length": PAGE})
        data = http_json(f"{HF_API}?{q}")
        rows = data.get("rows", [])
        if not rows: break
        for r in rows:
            yield r.get("row", {})
        offset += PAGE
        time.sleep(SLEEP)

# ----------------- DB -----------------
def open_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn

def existing_count(conn):
    return conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]

# ----------------- Normalization / insert -----------------
_OPT_BAD = re.compile(r"^(all of the above|none of the above|both [a-d]|a and b|a, b|all of these|none of these)$", re.I)

def clean_text(s):
    if s is None: return ""
    s = html.unescape(str(s)).strip()
    s = re.sub(r"\s+", " ", s)
    return s

def normalize_q(cat, diff, q, opts, answer_index, source):
    q = clean_text(q)
    if len(q) < 8 or len(q) > MAX_QLEN: return None
    if any(p in q.lower() for p in ("[blank]", "____", "...continued", "all of the above")): return None
    if len(opts) < 4: return None
    opts = [clean_text(o)[:MAX_OPTLEN] for o in opts[:4]] if len(opts) >= 4 else None
    if not opts or any(not o for o in opts) or len(set(opts)) != 4: return None
    if any(_OPT_BAD.match(o) for o in opts): return None
    if not (0 <= answer_index < 4): return None
    cat = clean_text(cat) or "General"
    return {"cat": cat[:24], "diff": int(diff), "q": q, "opts": opts, "a": int(answer_index), "src": source}

def insert(conn, row):
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO questions(category,difficulty,question,options,answer_index,source,created_at)"
            " VALUES(?,?,?,?,?,?,strftime('%s','now'))",
            (row["cat"], row["diff"], row["q"], json.dumps(row["opts"]), row["a"], row["src"])
        )
        return cur.rowcount > 0
    except Exception as e:
        return False

# ----------------- Dataset importers -----------------
def imp_otdb(conn):
    """Scrape Open Trivia DB exhaustively using session token."""
    name = "otdb"
    print(f"\n=== {name} ===", flush=True)
    # session token to dedupe across requests
    tok = http_json("https://opentdb.com/api_token.php?command=request").get("token")
    if not tok:
        print("OTDB: token failed"); return 0
    # categories 9-32 (some may not exist; OTDB returns response_code=1 for empty)
    diff_map = {"easy": 1, "medium": 3, "hard": 4}
    inserted = 0
    for cat_id in range(9, 33):
        for diff_name, diff_num in diff_map.items():
            empty_streak = 0
            while empty_streak < 2:
                url = (f"https://opentdb.com/api.php?amount=50&type=multiple"
                       f"&difficulty={diff_name}&category={cat_id}&token={tok}&encode=base64")
                try:
                    data = http_json(url)
                except Exception:
                    break
                code = data.get("response_code")
                # 0=ok, 1=no results, 2=invalid param, 3=token not found, 4=token empty (all seen)
                if code != 0:
                    empty_streak += 1
                    time.sleep(OTDB_SLEEP); continue
                results = data.get("results", [])
                if not results:
                    empty_streak += 1
                    time.sleep(OTDB_SLEEP); continue
                empty_streak = 0
                for item in results:
                    try:
                        q       = base64.b64decode(item["question"]).decode("utf-8")
                        correct = base64.b64decode(item["correct_answer"]).decode("utf-8")
                        wrong   = [base64.b64decode(x).decode("utf-8") for x in item["incorrect_answers"]]
                        cat     = base64.b64decode(item["category"]).decode("utf-8")
                    except Exception:
                        continue
                    opts = wrong + [correct]
                    # deterministic shuffle
                    h = int(hashlib.md5(q.encode()).hexdigest(), 16)
                    opts = sorted(opts, key=lambda x: (h * 17 + hash(x)) % 9973)
                    try: ai = opts.index(correct)
                    except ValueError: continue
                    short_cat = re.sub(r"^Entertainment:\s*", "", cat).split(":")[-1].strip()[:24]
                    row = normalize_q(short_cat, diff_num, q, opts, ai, "otdb")
                    if row and insert(conn, row): inserted += 1
                time.sleep(OTDB_SLEEP)
        conn.commit()
        print(f"  otdb cat={cat_id} cumulative={inserted}", flush=True)
    return inserted

def imp_hf_simple(conn, dataset, config, splits, target_diff, source_label,
                  q_field, choices_field, answer_field, category_field=None,
                  answer_kind="index"):
    """
    Generic HF importer for datasets where question + choices + answer are simple fields.
    - answer_kind: 'index' (int 0-N), 'letter' (A/B/C/D), 'text' (string matching one option)
    """
    print(f"\n=== {source_label} ({dataset}/{config}) ===", flush=True)
    inserted = 0
    for split in splits:
        print(f"  split={split}", flush=True)
        try:
            for row in hf_rows(dataset, config, split):
                try:
                    q = row.get(q_field)
                    ch = row.get(choices_field)
                    ans = row.get(answer_field)
                    # choices may be {"text":[...], "label":[...]} or a plain list
                    if isinstance(ch, dict): opts = ch.get("text") or ch.get("choices") or []
                    else: opts = ch or []
                    if not q or not opts: continue
                    if len(opts) > 4:
                        # if 5+ options (e.g. CommonsenseQA has 5), keep the correct one + 3 others
                        if answer_kind == "letter":
                            correct_idx = "ABCDE".find(str(ans))
                        elif answer_kind == "index":
                            correct_idx = int(ans)
                        else:
                            correct_idx = opts.index(ans) if ans in opts else 0
                        if not (0 <= correct_idx < len(opts)): continue
                        correct = opts[correct_idx]
                        others = [o for i, o in enumerate(opts) if i != correct_idx]
                        random.shuffle(others)
                        opts = others[:3] + [correct]
                        random.shuffle(opts)
                        ai = opts.index(correct)
                    elif len(opts) == 4:
                        if answer_kind == "letter":
                            ai = "ABCD".find(str(ans))
                        elif answer_kind == "index":
                            ai = int(ans)
                        else:
                            ai = opts.index(ans) if ans in opts else -1
                    else:
                        continue
                    cat = (row.get(category_field) if category_field else "") or source_label
                    cat = cat.replace("_", " ").title()[:24] if isinstance(cat, str) else source_label
                    norm = normalize_q(cat, target_diff, q, opts, ai, source_label)
                    if norm and insert(conn, norm): inserted += 1
                except Exception:
                    continue
            conn.commit()
            print(f"    cumulative={inserted}", flush=True)
        except Exception as e:
            print(f"    split error: {e}", flush=True)
    return inserted

def imp_mmlu(conn):
    return imp_hf_simple(conn, "cais/mmlu", "all", ["test","validation"],
        target_diff=3, source_label="mmlu",
        q_field="question", choices_field="choices", answer_field="answer",
        category_field="subject", answer_kind="index")

def imp_arc_easy(conn):
    return imp_hf_simple(conn, "allenai/ai2_arc", "ARC-Easy", ["train","validation","test"],
        target_diff=2, source_label="arc-easy",
        q_field="question", choices_field="choices", answer_field="answerKey",
        category_field=None, answer_kind="letter")

def imp_arc_chal(conn):
    return imp_hf_simple(conn, "allenai/ai2_arc", "ARC-Challenge", ["train","validation","test"],
        target_diff=3, source_label="arc-challenge",
        q_field="question", choices_field="choices", answer_field="answerKey",
        category_field=None, answer_kind="letter")

def imp_obqa(conn):
    return imp_hf_simple(conn, "openbookqa", "main", ["train","validation","test"],
        target_diff=2, source_label="openbookqa",
        q_field="question_stem", choices_field="choices", answer_field="answerKey",
        category_field=None, answer_kind="letter")

def imp_csqa(conn):
    return imp_hf_simple(conn, "tau/commonsense_qa", "default", ["train","validation"],
        target_diff=2, source_label="commonsense",
        q_field="question", choices_field="choices", answer_field="answerKey",
        category_field=None, answer_kind="letter")

def imp_truthfulqa(conn):
    """TruthfulQA mc1: row has question + mc1_targets:{choices,labels}."""
    print(f"\n=== truthfulqa ===", flush=True)
    inserted = 0
    try:
        for row in hf_rows("truthful_qa", "multiple_choice", "validation"):
            try:
                q = row.get("question")
                mc = row.get("mc1_targets") or {}
                choices = mc.get("choices") or []
                labels  = mc.get("labels")  or []
                if len(choices) < 4 or len(choices) != len(labels): continue
                # one label==1 is correct
                if labels.count(1) != 1: continue
                correct_idx = labels.index(1)
                correct = choices[correct_idx]
                wrong = [c for i, c in enumerate(choices) if i != correct_idx]
                random.shuffle(wrong)
                opts = wrong[:3] + [correct]
                random.shuffle(opts)
                ai = opts.index(correct)
                norm = normalize_q("Truthfulness", 4, q, opts, ai, "truthfulqa")
                if norm and insert(conn, norm): inserted += 1
            except Exception:
                continue
        conn.commit()
    except Exception as e:
        print(f"  truthfulqa error: {e}")
    print(f"  truthfulqa inserted={inserted}", flush=True)
    return inserted

def imp_sciq(conn):
    """SciQ: question + correct_answer + distractor1/2/3."""
    print(f"\n=== sciq ===", flush=True)
    inserted = 0
    for split in ["train","validation","test"]:
        try:
            for row in hf_rows("sciq", "default", split):
                try:
                    q = row.get("question")
                    correct = row.get("correct_answer")
                    d1, d2, d3 = row.get("distractor1"), row.get("distractor2"), row.get("distractor3")
                    if not (q and correct and d1 and d2 and d3): continue
                    opts = [d1, d2, d3, correct]
                    random.shuffle(opts)
                    ai = opts.index(correct)
                    norm = normalize_q("Science", 2, q, opts, ai, "sciq")
                    if norm and insert(conn, norm): inserted += 1
                except Exception:
                    continue
            conn.commit()
            print(f"  sciq split={split} cumulative={inserted}", flush=True)
        except Exception as e:
            print(f"  sciq split={split} error: {e}", flush=True)
    return inserted

# ----------------- Main -----------------
IMPORTERS = {
    "otdb": imp_otdb,
    "mmlu": imp_mmlu,
    "arc_easy": imp_arc_easy,
    "arc_chal": imp_arc_chal,
    "obqa": imp_obqa,
    "csqa": imp_csqa,
    "truthfulqa": imp_truthfulqa,
    "sciq": imp_sciq,
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("datasets", nargs="*", help="subset to run; empty=all")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()
    global DB_PATH
    DB_PATH = args.db
    targets = args.datasets or list(IMPORTERS.keys())
    print(f"DB: {DB_PATH}\nDatasets: {targets}\n", flush=True)
    conn = open_db()
    start_total = existing_count(conn)
    print(f"Existing questions in DB: {start_total}\n", flush=True)
    grand = 0
    for name in targets:
        if name not in IMPORTERS:
            print(f"unknown dataset {name}; skip"); continue
        t0 = time.time()
        try:
            n = IMPORTERS[name](conn)
            grand += n
            print(f"---> {name} added {n} in {int(time.time()-t0)}s", flush=True)
        except Exception as e:
            print(f"!!! {name} crashed: {e}", flush=True)
    end_total = existing_count(conn)
    print(f"\nDONE. Inserted this run: {grand}.  DB total: {start_total} → {end_total} ({end_total-start_total:+})", flush=True)
    conn.close()

if __name__ == "__main__":
    main()
