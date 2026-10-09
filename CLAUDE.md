# GreenCode AI

A carbon-aware code optimizer. Paste Python, JavaScript or SQL; a 5-agent pipeline profiles it, ranks bottlenecks by carbon impact, rewrites it (Groq LLaMA-3.3-70B or an offline AST rule engine), **proves the rewrite is equivalent by running both versions**, and reports Software Carbon Intensity (SCI) savings.

```
greencode-ai/
├── CLAUDE.md                     ← this file
├── backend/                      FastAPI on :5000
│   ├── main.py                   pipeline, rule engine, verifier, carbon model, API
│   ├── test_benchmarks.py        offline smoke test over the 4 UI benchmarks
│   ├── requirements.txt
│   └── .env / .env.example       GROQ_API_KEY, GROQ_MODEL, PORT
└── frontend/                     React 18 + Vite + Tailwind on :3000
    ├── vite.config.js            dev server :3000, proxies /api → backend
    └── src/
        ├── App.jsx               dashboard: state, SSE stream, wiring
        ├── main.jsx, index.css   entry + Tailwind + Monaco decoration styles
        ├── data/benchmarks.js    the 4 preloaded benchmark programs
        ├── lib/carbon.js         SCI model + Green Score (mirrors backend constants)
        ├── lib/api.js            fetch + SSE client
        ├── lib/report.js         audit report data + jsPDF renderer
        ├── lib/diff.js           LCS line diff for the report
        ├── lib/monaco.js         local Monaco bundle + theme (no CDN)
        └── components/           Header, ContextBar, PipelineStream, CodeWorkspace,
                                  ImpactPanel, CarbonPayback, GreenScore,
                                  FindingsPanel, ReportModal, Badge
```

## Setup

Requires Python ≥ 3.10, Node ≥ 18 (Node is also used to *execute* JavaScript during verification).

```bash
# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# optional: put your key in backend/.env →  GROQ_API_KEY=gsk_...
.venv/bin/uvicorn main:app --port 5000 --reload        # or: .venv/bin/python main.py

# Frontend (second terminal)
cd frontend
npm install
npm run dev                                           # http://localhost:3000
```

### macOS port 5000 clash
macOS AirPlay Receiver listens on :5000. Either turn it off (System Settings → General → AirDrop & Handoff → AirPlay Receiver) or run on another port:

```bash
cd backend  && PORT=5055 .venv/bin/python main.py
cd frontend && VITE_BACKEND_URL=http://localhost:5055 npm run dev
```

Without `GROQ_API_KEY` everything works offline using the deterministic rule engine; the header shows which engine is active.

## Architecture

```
 Browser (React, :3000)                         FastAPI (:5000)
 ┌─────────────────────────┐  POST /api/optimize/stream (SSE)
 │ ContextBar  grid/hw/vol │ ─────────────────────────────────▶ run_pipeline()
 │ Monaco split view       │                                     │
 │ PipelineStream (5 cards)│ ◀── data: {type: stage|log|result}  ├─ 1 Profiler     ast / JS scanner / SQL clause scanner
 │ Impact · Payback · Score│                                     ├─ 2 Strategist   severity × category × Big-O weight
 │ ReportModal → jsPDF     │                                     ├─ 3 Refactorer   Groq llama-3.3-70b (JSON mode)
 └──────────┬──────────────┘                                     │                  └─ fallback: offline AST rule engine
            │ live recompute                                     ├─ 4 Verifier     sandboxed subprocess runs, diff outputs,
            ▼ (lib/carbon.js)                                    │                  1 retry (LLM w/ feedback | conservative rules)
   SCI / money / score update                                    └─ 5 Accountant   SCI = ((E×I)+M)/R, Green Score
   instantly when sliders move           POST /api/verify  ◀── "Re-verify" after manual edits
```

**Endpoints**
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/ping` | health, LLM config, runtimes, carbon profiles |
| POST | `/api/optimize/stream` | SSE stream of the live pipeline (used by the UI) |
| POST | `/api/optimize` | same pipeline, single JSON response (+ `events`) |
| POST | `/api/verify` | differential test of `{original, optimized, language}` |
| POST | `/api/analyze` | profiler + strategist only, no execution |

**Rule engine (offline fallback)** — text edits computed from real syntax positions, so comments/formatting survive:
- Python (CPython `ast`): nested-loop equality join → hash index; `x in growing_list` → mirrored set; `x in static_list` → frozen set; duplicated prompt constants → deduplicated; uncached LLM wrapper called in a loop → `functools.lru_cache`.
- JavaScript (lexical scanner + bracket tree): nested `.find/.filter/.some/.includes` → hoisted `Map`/`Set`; `JSON.parse(JSON.stringify(x))` → `__gcClone` (same JSON semantics); `{...acc}` / `[...acc]` in `.reduce` with a literal seed → in-place mutation.
- SQL (SQLite): `strftime/YEAR/date/substr` on a column → half-open range; correlated scalar aggregates → one `GROUP BY` derived table + `LEFT JOIN` (conditional aggregation, COUNT coalesced to 0); supporting `CREATE INDEX` for filter/join columns.

Rules are tagged `semantic` (changes data, e.g. prompt text) or `hash_based` (needs hashable values). On verification failure the single retry re-runs with `conservative` (no semantic) or `strict` (no hash-based) rules; if that also fails the original code is kept.

**Verifier** — each version runs in a fresh subprocess (`python -I`, `node --expose-gc`, in-memory SQLite) with `PYTHONHASHSEED=0`, a 30 s timeout and a CPU rlimit. Timing = median of up to 5 runs within a 1.5 s budget. Equivalence = byte-identical stdout (Python/JS; lines starting `#METRIC` are telemetry, e.g. `#METRIC llm_calls=8 llm_tokens=998`) or identical SQL result sets (floats to 1e-6; order-insensitive unless the query has `ORDER BY`). Code that prints nothing, or isn't self-contained, gets **Estimated** badges instead of **Measured**.

> Security: the verifier executes submitted code locally. This is a hackathon prototype — run it on your own machine only, don't expose port 5000 publicly.

**Carbon model** (constants in `backend/main.py` and `frontend/src/lib/carbon.js` — keep them in sync)
- `E = (P_core·t + P_mem·GB·t)·PUE + tokens·0.25 Wh/1k` · `I` = grid (India 716, France 56, US 385, custom) · `M = TE·(t/lifespan)·(1/cores)`
- Hardware: Cloud 3.5 W/vCPU PUE 1.12 · Edge 8 W/core PUE 1.4 · Laptop 12 W/core PUE 1.0
- Green Score = 0.6·structural (100 − finding penalties − Big-O penalty) + 0.4·efficiency (log-scaled SCI per 1M runs); A+ ≥ 90 … F < 40
- Payback: ~0.4 g CO₂e per LLM refactor query + measured energy of profiling/verification runs, divided by savings per execution.

## Testing

```bash
# 1. Backend smoke test - all 4 benchmarks must verify and speed up (exit code 0)
cd backend && .venv/bin/python test_benchmarks.py
#   PASS  pythonDataPipeline   python     verification=passed  speedup=  84.0x ...
#   PASS  pythonLlmLoop        python     verification=passed  speedup=  20.2x ...
#   PASS  heavySql             sql        verification=passed  speedup= 168.4x ...
#   PASS  jsFrontendLoop       javascript verification=passed  speedup= 369.9x ...

# 2. API
curl -s localhost:5000/api/ping | python3 -m json.tool
curl -sN -X POST localhost:5000/api/optimize/stream -H 'content-type: application/json' \
  -d '{"language":"python","use_llm":false,"code":"xs=list(range(3000))\nseen=[]\nfor x in xs+xs:\n    if x not in seen:\n        seen.append(x)\nprint(len(seen))\n"}'

# 3. Frontend build check
cd frontend && npm run build
```

Manual UI checklist (http://localhost:3000):
1. Click each benchmark → **Run pipeline**; the 5 stage cards animate and `agent.log` streams.
2. Original pane shows red hotspot lines (hover for details), optimized pane shows emerald changed lines and "Verified equivalent".
3. Move the grid / hardware / volume controls — impact cards, payback and Green Score update instantly without re-running.
4. Toggle ₹ / $ in the header.
5. Edit the optimized code → pill turns "Edited - re-verify" → **Re-verify** runs `/api/verify`.
6. **Show the math** expands the SCI formula with the plugged-in numbers.
7. **Audit Report** → preview modal → **Download PDF** (4-page report incl. side-by-side diff and methodology).
8. Retry path: paste the Python below; the set rewrite crashes on unhashable lists, the retry runs in strict mode, and the original is kept:
   ```python
   pairs = [[i, i + 1] for i in range(300)]
   seen = []
   for p in pairs + pairs:
       if p not in seen:
           seen.append(p)
   print(len(seen))
   ```

## Conventions
- Keep benchmark sources free of backticks and `${` (they're embedded with `String.raw`).
- New rule-engine rewrites return `(new_source, Change)` and must be safe to re-run until no match remains (`refactor_python` / `refactor_javascript` apply each rule to a fixpoint).
- Every user-facing metric must carry a `basis` of `measured` or `estimated`.
