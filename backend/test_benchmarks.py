"""Offline smoke test: runs the full 5-stage pipeline on all 4 UI benchmarks.

Usage:  .venv/bin/python test_benchmarks.py
Exits non-zero if any benchmark fails verification or does not get faster.
"""

import re
import sys
from pathlib import Path

import main

BENCH_FILE = Path(__file__).resolve().parent.parent / "frontend" / "src" / "data" / "benchmarks.js"
LANG_BY_VAR = {"pythonDataPipeline": "python", "pythonLlmLoop": "python", "heavySql": "sql", "jsFrontendLoop": "javascript"}


def load_benchmarks() -> list[tuple[str, str, str]]:
    text = BENCH_FILE.read_text()
    out = []
    for var, code in re.findall(r"const (\w+) = String\.raw`(.*?)`;", text, re.S):
        out.append((var, LANG_BY_VAR[var], code))
    return out


def main_() -> int:
    failures = 0
    for name, lang, code in load_benchmarks():
        req = main.OptimizeRequest(code=code, language=lang, use_llm=False)
        result = next(e["result"] for e in main.run_pipeline(req) if e["type"] == "result")
        status = result["verification"]["status"]
        speedup = result["measurements"]["speedup"] or 0
        ok = status == "passed" and speedup > 1.5
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name:20s} {lang:10s} verification={status:9s} "
              f"speedup={speedup:7.1f}x  changes={len(result['changes'])}  "
              f"grade {result['carbon']['green_score']['original']['grade']} -> {result['carbon']['green_score']['optimized']['grade']}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main_())
