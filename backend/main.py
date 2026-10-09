"""GreenCode AI - carbon-aware code optimization backend.

Five-stage agent pipeline, streamed to the dashboard over Server-Sent Events:

    1. Profiler          - parses the syntax tree and flags Big-O bottlenecks
    2. Strategist        - ranks bottlenecks by carbon and memory impact
    3. Refactorer        - Groq LLaMA-3.3-70B rewrite, or the offline AST rule engine
    4. Verifier          - differential execution of original vs rewrite (1 retry)
    5. Carbon Accountant - Software Carbon Intensity: SCI = ((E x I) + M) per R

Run:  uvicorn main:app --port 5000 --reload      (or: python main.py)
"""

from __future__ import annotations

import ast
import difflib
import json
import math
import os
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:  # The official SDK is preferred; plain REST is the fallback transport.
    from groq import Groq  # type: ignore
except Exception:  # pragma: no cover - SDK optional at runtime
    Groq = None  # type: ignore

load_dotenv(Path(__file__).with_name(".env"))

APP_VERSION = "1.0.0"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
NODE_BIN = shutil.which("node")

# --------------------------------------------------------------------------------------
# Carbon model constants (mirrored in frontend/src/lib/carbon.js - keep in sync)
# --------------------------------------------------------------------------------------

HARDWARE_PROFILES: dict[str, dict[str, Any]] = {
    "cloud": {
        "label": "Cloud Server (Xeon/EPYC)",
        "watts_per_core": 3.5,  # CCF max per-vCPU draw at full utilisation
        "mem_watts_per_gb": 0.392,
        "pue": 1.12,
        "embodied_kg": 1300.0,
        "lifespan_years": 4.0,
        "cores": 96,
        "usd_per_core_hour": 0.0425,
        "self_hosted": False,
    },
    "edge": {
        "label": "Mid/Edge Server",
        "watts_per_core": 8.0,
        "mem_watts_per_gb": 0.392,
        "pue": 1.4,
        "embodied_kg": 900.0,
        "lifespan_years": 5.0,
        "cores": 16,
        "usd_per_core_hour": 0.015,
        "self_hosted": True,
    },
    "laptop": {
        "label": "Developer Laptop",
        "watts_per_core": 12.0,
        "mem_watts_per_gb": 0.3,
        "pue": 1.0,
        "embodied_kg": 330.0,
        "lifespan_years": 4.0,
        "cores": 10,
        "usd_per_core_hour": 0.0,
        "self_hosted": True,
    },
}

GRID_PRESETS: dict[str, dict[str, Any]] = {
    "india": {"label": "India", "intensity": 716, "usd_per_kwh": 0.10},
    "france": {"label": "France", "intensity": 56, "usd_per_kwh": 0.27},
    "us": {"label": "United States", "intensity": 385, "usd_per_kwh": 0.17},
    "custom": {"label": "Custom", "intensity": None, "usd_per_kwh": 0.15},
}

LLM_KWH_PER_TOKEN = 0.25 / 1000 / 1000  # 0.25 Wh per 1k tokens (70B-class inference)
LLM_USD_PER_TOKEN = 0.69 / 1_000_000  # blended Groq llama-3.3-70b in/out price
AI_QUERY_G_CO2E = 0.4  # reference footprint of one optimization LLM query
USD_TO_INR = 88.0
SECONDS_PER_YEAR = 365 * 24 * 3600

SEVERITY_PENALTY = {"high": 15, "medium": 7, "low": 2}
SEVERITY_WEIGHT = {"high": 10.0, "medium": 4.0, "low": 1.0}
CATEGORY_WEIGHT = {"cpu": 1.0, "network": 1.25, "memory": 0.8, "io": 0.9}

# --------------------------------------------------------------------------------------
# API models
# --------------------------------------------------------------------------------------

Language = Literal["python", "javascript", "sql"]


class Context(BaseModel):
    grid_region: str = "india"
    grid_intensity: float = Field(716, ge=0, le=2000)
    hardware: Literal["cloud", "edge", "laptop"] = "cloud"
    calls_per_day: int = Field(100_000, ge=1, le=100_000_000)
    currency: Literal["USD", "INR"] = "USD"


class OptimizeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=200_000)
    language: Language
    context: Context = Field(default_factory=Context)
    use_llm: bool = True


class VerifyRequest(BaseModel):
    original: str = Field(..., min_length=1, max_length=200_000)
    optimized: str = Field(..., min_length=1, max_length=200_000)
    language: Language


@dataclass
class Finding:
    rule: str
    title: str
    detail: str
    line: int
    severity: str  # high | medium | low
    category: str  # cpu | memory | network | io
    complexity: str = ""
    fix: str = ""
    end_line: int = 0
    id: str = ""

    def __post_init__(self) -> None:
        if not self.end_line:
            self.end_line = self.line


@dataclass
class Change:
    rule: str
    title: str
    detail: str
    line: int = 0
    markers: list[str] = field(default_factory=list)
    semantic: bool = False  # alters observable data (prompt text, call counts)
    hash_based: bool = False  # relies on elements being hashable


class RefactorError(Exception):
    pass


# --------------------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------------------


def complexity_label(exponent: int) -> str:
    return {0: "O(1)", 1: "O(N)", 2: "O(N²)", 3: "O(N³)"}.get(exponent, f"O(N^{exponent})")


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, max(0, pos)) + 1


def unique_name(base: str, taken: set[str]) -> str:
    base = re.sub(r"\W+", "_", base).strip("_") or "gc"
    if base[0].isdigit():
        base = "_" + base
    name, n = base, 2
    while name in taken:
        name = f"{base}_{n}"
        n += 1
    taken.add(name)
    return name


def apply_edits(src: str, edits: list[tuple[int, int, str]]) -> str:
    """Apply (start, end, replacement) edits computed against the same source."""
    ordered = sorted(edits, key=lambda e: (e[0], e[1]), reverse=True)
    last_start = len(src) + 1
    for start, end, text in ordered:
        if end > last_start:
            raise RefactorError("overlapping edits")
        src = src[:start] + text + src[end:]
        last_start = start
    return src


def safe_unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return ""


# --------------------------------------------------------------------------------------
# Python analysis (Stage 1) - real AST
# --------------------------------------------------------------------------------------

LOOP_NODES = (ast.For, ast.AsyncFor, ast.While)
COMP_NODES = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
FUNC_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
MUTATING_LIST_METHODS = {"append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse"}
SAFE_BUILTIN_CALLS = {
    "len", "print", "sorted", "set", "frozenset", "list", "tuple", "sum", "min", "max", "any", "all",
    "enumerate", "zip", "str", "repr", "iter", "reversed", "dict", "json.dumps",
}
REMOTE_ATTRS = {
    "complete", "completion", "completions", "create", "generate", "chat", "invoke", "post", "get",
    "put", "request", "predict", "embed", "embeddings", "send", "fetch", "urlopen", "ainvoke",
}
REMOTE_BASE_HINT = re.compile(r"(llm|openai|groq|anthropic|client|completion|chat|requests|httpx|session|api\b|model)", re.I)
REMOTE_NAME_HINT = re.compile(r"(llm|gpt|completion|openai|groq|anthropic|urlopen|call_api|fetch_)", re.I)
PROMPT_NAME_HINT = re.compile(r"(PROMPT|SYSTEM|INSTRUCTION|TEMPLATE|PREAMBLE|PERSONA)", re.I)
CACHE_DECORATOR_HINT = re.compile(r"(lru_cache|cache|memoize|cached)", re.I)


class PySourceMap:
    """Converts AST (line, utf-8 byte column) positions to string offsets."""

    def __init__(self, src: str):
        self.src = src
        self.lines = src.splitlines(keepends=True)
        self.starts = [0]
        for ln in self.lines:
            self.starts.append(self.starts[-1] + len(ln))

    def offset(self, lineno: int, col: int) -> int:
        if lineno - 1 >= len(self.lines):
            return len(self.src)
        raw = self.lines[lineno - 1].encode("utf-8")[:col]
        return self.starts[lineno - 1] + len(raw.decode("utf-8", errors="ignore"))

    def start(self, node: ast.AST) -> int:
        return self.offset(node.lineno, node.col_offset)  # type: ignore[attr-defined]

    def end(self, node: ast.AST) -> int:
        return self.offset(node.end_lineno, node.end_col_offset)  # type: ignore[attr-defined]

    def seg(self, node: ast.AST) -> str:
        return self.src[self.start(node):self.end(node)]

    def line_start(self, lineno: int) -> int:
        return self.starts[min(lineno - 1, len(self.lines))]

    def line_after(self, lineno: int) -> int:
        return self.starts[min(lineno, len(self.lines))]

    def indent(self, lineno: int) -> str:
        line = self.lines[lineno - 1] if lineno - 1 < len(self.lines) else ""
        return line[: len(line) - len(line.lstrip(" \t"))]

    def owns_line(self, node: ast.AST) -> bool:
        """True when the statement starts its own line (not `if x: stmt`)."""
        return len(self.indent(node.lineno).encode()) == node.col_offset  # type: ignore[attr-defined]


def annotate_tree(tree: ast.AST) -> None:
    """Attach parent links and static loop depth to every node."""

    def visit(node: ast.AST, depth: int, parent: Optional[ast.AST]) -> None:
        node._gc_parent = parent  # type: ignore[attr-defined]
        node._gc_depth = depth  # type: ignore[attr-defined]
        if isinstance(node, LOOP_NODES):
            for name, value in ast.iter_fields(node):
                inner = name == "body" or (isinstance(node, ast.While) and name == "test")
                for child in value if isinstance(value, list) else [value]:
                    if isinstance(child, ast.AST):
                        visit(child, depth + 1 if inner else depth, node)
        elif isinstance(node, COMP_NODES):
            for child in ast.iter_child_nodes(node):
                visit(child, depth + 1, node)
        elif isinstance(node, FUNC_NODES):
            for name, value in ast.iter_fields(node):
                for child in value if isinstance(value, list) else [value]:
                    if isinstance(child, ast.AST):
                        visit(child, 0 if name == "body" else depth, node)
        else:
            for child in ast.iter_child_nodes(node):
                visit(child, depth, node)

    visit(tree, 0, None)


def depth_of(node: ast.AST) -> int:
    return getattr(node, "_gc_depth", 0)


def parent_of(node: ast.AST) -> Optional[ast.AST]:
    return getattr(node, "_gc_parent", None)


def names_in(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def is_list_value(value: ast.AST) -> bool:
    if isinstance(value, (ast.List, ast.ListComp)):
        return True
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "list":
        return True
    if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
        return is_list_value(value.left) or is_list_value(value.right)
    return False


def is_remote_call(call: ast.Call, remote_funcs: set[str]) -> bool:
    func = call.func
    if isinstance(func, ast.Attribute):
        if func.attr in REMOTE_ATTRS and REMOTE_BASE_HINT.search(safe_unparse(func.value)):
            return True
        return False
    if isinstance(func, ast.Name):
        return func.id in remote_funcs or bool(REMOTE_NAME_HINT.search(func.id))
    return False


class PyModuleInfo:
    """Name-level facts about a module used by both the profiler and the rule engine."""

    def __init__(self, tree: ast.Module):
        self.tree = tree
        self.all_names: set[str] = set()
        assigns: dict[str, list[ast.AST]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                self.all_names.add(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.all_names.add(node.name)
            elif isinstance(node, ast.arg):
                self.all_names.add(node.arg)
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if isinstance(tgt, ast.Name):
                        assigns.setdefault(tgt.id, []).append(node.value)
                    else:
                        for n in ast.walk(tgt):
                            if isinstance(n, ast.Name):
                                assigns.setdefault(n.id, []).append(ast.Constant(None))
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
                assigns.setdefault(node.target.id, []).append(node.value or ast.Constant(None))
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                for n in ast.walk(node.target):
                    if isinstance(n, ast.Name):
                        assigns.setdefault(n.id, []).append(ast.Constant(None))
        self.assigns = assigns
        self.list_names = {name for name, values in assigns.items() if values and all(is_list_value(v) for v in values)}

        self.functions: dict[str, ast.AST] = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, node)

        self.remote_funcs: set[str] = set()
        for _ in range(3):  # transitive closure over a few levels of wrappers
            for name, fn in self.functions.items():
                if name in self.remote_funcs:
                    continue
                for call in (n for n in ast.walk(fn) if isinstance(n, ast.Call)):
                    if is_remote_call(call, self.remote_funcs):
                        self.remote_funcs.add(name)
                        break
        # Methods of classes that *implement* a client are the remote boundary, not callers.
        self.cached_funcs = {
            name for name, fn in self.functions.items()
            if any(CACHE_DECORATOR_HINT.search(safe_unparse(d)) for d in fn.decorator_list)  # type: ignore[attr-defined]
        }
        self.method_names = {
            item.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
            for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

    def name_uses(self, name: str) -> dict[str, list[ast.AST]]:
        """Classify every occurrence of `name` (approximate, module-wide)."""
        uses: dict[str, list[ast.AST]] = {
            "assign": [], "membership": [], "append": [], "mutate": [], "escape": [], "read": [],
        }
        for node in ast.walk(self.tree):
            if not (isinstance(node, ast.Name) and node.id == name):
                continue
            parent = parent_of(node)
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                if isinstance(parent, ast.Assign) and node in parent.targets:
                    uses["assign"].append(parent)
                else:
                    uses["mutate"].append(node)
            elif isinstance(parent, ast.Compare) and node in parent.comparators:
                idx = parent.comparators.index(node)
                if isinstance(parent.ops[idx], (ast.In, ast.NotIn)):
                    uses["membership"].append(parent)
                else:
                    uses["read"].append(node)
            elif isinstance(parent, ast.Attribute) and parent.value is node:
                call = parent_of(parent)
                if parent.attr == "append" and isinstance(call, ast.Call) and call.func is parent:
                    uses["append"].append(call)
                elif parent.attr in MUTATING_LIST_METHODS:
                    uses["mutate"].append(parent)
                else:
                    uses["read"].append(node)
            elif isinstance(parent, ast.Subscript) and parent.value is node and isinstance(parent.ctx, (ast.Store, ast.Del)):
                uses["mutate"].append(parent)
            elif isinstance(parent, ast.AugAssign) and parent.target is node:
                uses["mutate"].append(parent)
            elif isinstance(parent, (ast.Call, ast.keyword)):
                call = parent if isinstance(parent, ast.Call) else parent_of(parent)
                fname = safe_unparse(call.func) if isinstance(call, ast.Call) else ""
                if isinstance(call, ast.Call) and call.func is node:
                    uses["read"].append(node)
                elif fname in SAFE_BUILTIN_CALLS:
                    uses["read"].append(node)
                else:
                    uses["escape"].append(node)
            else:
                uses["read"].append(node)
        return uses


def compress_prompt(text: str) -> str:
    seen: set[str] = set()
    out: list[str] = []
    for raw in text.splitlines():
        norm = re.sub(r"\s+", " ", raw).strip()
        if not norm or norm.lower() in seen:
            continue
        seen.add(norm.lower())
        out.append(norm)
    return "\n".join(out)


def find_nested_join(outer: ast.AST, sm: PySourceMap) -> Optional[dict[str, Any]]:
    """Detect `for a in A: for b in B: if key(a) == key(b): ...` (hash-joinable)."""
    if not isinstance(outer, ast.For) or outer.orelse or not isinstance(outer.target, ast.Name):
        return None
    a = outer.target.id
    for pos, inner in enumerate(outer.body):
        if not (isinstance(inner, ast.For) and not inner.orelse and isinstance(inner.target, ast.Name)):
            continue
        if not isinstance(inner.iter, (ast.Name, ast.Attribute)):
            continue
        if len(inner.body) != 1 or not isinstance(inner.body[0], ast.If) or inner.body[0].orelse:
            continue
        b = inner.target.id
        cond = inner.body[0]
        conjuncts = cond.test.values if isinstance(cond.test, ast.BoolOp) and isinstance(cond.test.op, ast.And) else [cond.test]
        for ci, conj in enumerate(conjuncts):
            if not (isinstance(conj, ast.Compare) and len(conj.ops) == 1 and isinstance(conj.ops[0], ast.Eq)):
                continue
            left, right = conj.left, conj.comparators[0]
            if any(isinstance(n, ast.Call) for n in ast.walk(left)) or any(isinstance(n, ast.Call) for n in ast.walk(right)):
                continue
            ln, rn = names_in(left), names_in(right)
            if rn == {b} and b not in ln and ln:
                ka, kb = left, right
            elif ln == {b} and b not in rn and rn:
                ka, kb = right, left
            else:
                continue
            iter_root = names_in(inner.iter)
            mutated = False
            for node in ast.walk(outer):
                if isinstance(node, ast.Attribute) and node.attr in MUTATING_LIST_METHODS and names_in(node.value) & iter_root:
                    mutated = True
                if isinstance(node, ast.Name) and node.id in iter_root and isinstance(node.ctx, (ast.Store, ast.Del)):
                    mutated = True
            if mutated:
                continue
            later = outer.body[pos + 1:]
            if any(b in names_in(stmt) for stmt in later):
                continue
            return {"outer": outer, "inner": inner, "if": cond, "conjuncts": conjuncts, "index": ci, "ka": ka, "kb": kb, "a": a, "b": b}
    return None


def profile_python(src: str) -> dict[str, Any]:
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        f = Finding("syntax-error", "Syntax error", f"{exc.msg} - the code could not be parsed.", exc.lineno or 1, "high", "cpu")
        return {"ok": False, "error": f"SyntaxError (line {exc.lineno}): {exc.msg}", "findings": [f], "exponent": 0, "stats": {}}
    annotate_tree(tree)
    sm = PySourceMap(src)
    info = PyModuleInfo(tree)
    findings: list[Finding] = []
    seen: set[tuple[str, int]] = set()

    def add(f: Finding) -> None:
        if (f.rule, f.line) not in seen:
            seen.add((f.rule, f.line))
            findings.append(f)

    exponent = 0
    node_count = 0
    joins = {id(j["inner"]): j for j in (find_nested_join(n, sm) for n in ast.walk(tree) if isinstance(n, ast.For)) if j}
    for node in ast.walk(tree):
        node_count += 1
        d = depth_of(node)
        # `for x in index.get(key, ())` walks one hash bucket, not a whole collection.
        bucket_loop = isinstance(node, ast.For) and isinstance(node.iter, ast.Call) \
            and isinstance(node.iter.func, ast.Attribute) and node.iter.func.attr == "get"
        if isinstance(node, LOOP_NODES + COMP_NODES) and not bucket_loop:
            loops = d + (len(node.generators) if isinstance(node, COMP_NODES) else 1)
            exponent = max(exponent, loops)

        if id(node) in joins:
            join = joins[id(node)]
            inner = join["inner"]
            add(Finding(
                "nested-join", "Quadratic nested-loop join",
                f"Every `{join['a']}` scans all of `{safe_unparse(inner.iter)}` to find matches on "
                f"`{safe_unparse(join['kb'])}` - O(N·M) comparisons.",
                inner.lineno, "high", "cpu", "O(N·M)",
                f"Build a hash index on `{safe_unparse(join['kb'])}` once, then look matches up in O(1).",
                inner.body[0].end_lineno or inner.lineno,
            ))
        elif isinstance(node, LOOP_NODES) and d >= 1 and not bucket_loop:
            add(Finding(
                "nested-loop", "Nested loop", f"Loop nested {d + 1} levels deep - {complexity_label(d + 1)} work.",
                node.lineno, "medium", "cpu", complexity_label(d + 1),
                "Hoist invariant work out of the inner loop or replace it with a dict/set lookup.",
            ))

        if isinstance(node, ast.Compare) and d >= 1:
            for op, comp in zip(node.ops, node.comparators):
                if isinstance(op, (ast.In, ast.NotIn)) and isinstance(comp, ast.Name) and comp.id in info.list_names:
                    exponent = max(exponent, d + 1)
                    grows = bool(info.name_uses(comp.id)["append"])
                    add(Finding(
                        "list-membership", "Linear list lookup inside loop",
                        f"`{safe_unparse(node)}` scans the list `{comp.id}` element by element on every iteration"
                        + (" while the list keeps growing" if grows else "") + " - O(N·K).",
                        node.lineno, "high", "cpu", "O(N·K)",
                        f"Mirror `{comp.id}` in a set and test membership in O(1).",
                    ))

        if isinstance(node, ast.Call):
            fname = safe_unparse(node.func)
            if d >= 1 and is_remote_call(node, info.remote_funcs) and fname.split(".")[-1] not in info.method_names - info.remote_funcs:
                add(Finding(
                    "unbatched-remote", "Unbatched remote/LLM call inside loop",
                    f"`{fname}(...)` issues one network round-trip per iteration; each call re-sends its full prompt.",
                    node.lineno, "high", "network", "O(N) round-trips",
                    "De-duplicate inputs, cache responses and batch requests where the API allows it.",
                ))
            if d >= 1 and isinstance(node.func, ast.Attribute):
                attr = node.func.attr
                base = node.func.value
                if attr in ("index", "count") and isinstance(base, ast.Name) and base.id in info.list_names:
                    add(Finding("list-scan", f"list.{attr}() inside loop", f"`{fname}` is a linear scan per iteration.",
                                node.lineno, "medium", "cpu", "O(N·K)", "Precompute a dict of positions/counts."))
                if fname in ("copy.deepcopy", "deepcopy"):
                    add(Finding("deepcopy-loop", "Deep copy inside loop", "deepcopy allocates a full object graph every iteration.",
                                node.lineno, "medium", "memory", "O(N·S)", "Copy only the fields you mutate."))
                if attr == "sort":
                    add(Finding("sort-loop", "Sorting inside loop", "Re-sorting on every iteration costs O(N log N) each time.",
                                node.lineno, "medium", "cpu", "O(N² log N)", "Sort once outside the loop or use heapq/bisect."))
            if d >= 1 and isinstance(node.func, ast.Name):
                if node.func.id == "sorted":
                    add(Finding("sort-loop", "Sorting inside loop", "sorted() inside a loop re-sorts on every iteration.",
                                node.lineno, "medium", "cpu", "O(N² log N)", "Sort once outside the loop."))
                if node.func.id == "open":
                    add(Finding("io-loop", "File I/O inside loop", "Opening files per iteration multiplies syscalls and disk wake-ups.",
                                node.lineno, "medium", "io", "O(N) syscalls", "Open once and stream, or batch writes."))
                if node.func.id == "deepcopy":
                    add(Finding("deepcopy-loop", "Deep copy inside loop", "deepcopy allocates a full object graph every iteration.",
                                node.lineno, "medium", "memory", "O(N·S)", "Copy only the fields you mutate."))
            if (isinstance(node.func, ast.Name) and node.func.id == "range" and len(node.args) == 1
                    and isinstance(node.args[0], ast.Call) and safe_unparse(node.args[0].func) == "len"
                    and isinstance(parent_of(node), ast.For)):
                add(Finding("range-len", "range(len(...)) indexing", "Index-based iteration adds a bounds-checked lookup per element.",
                            node.lineno, "low", "cpu", "O(N)", "Iterate directly or use enumerate()."))

        if isinstance(node, ast.Dict) and d >= 1 and any(k is None for k in node.keys):
            add(Finding("dict-copy-loop", "Dict unpack copy per iteration", "`{**obj, ...}` copies every key of the source dict on each iteration.",
                        node.lineno, "low", "memory", "O(N·K)", "Store only the fields you need or reference the original."))

        if isinstance(node, ast.AugAssign) and d >= 1 and isinstance(node.op, ast.Add) and isinstance(node.target, ast.Name):
            v = node.value
            if isinstance(v, ast.JoinedStr) or (isinstance(v, ast.Constant) and isinstance(v.value, str)):
                add(Finding("str-concat", "String concatenation in loop", "Repeated `+=` on strings can copy the buffer each time.",
                            node.lineno, "low", "memory", "O(N²) worst case", "Collect parts in a list and ''.join() once."))

    # Module-level prompt bloat and uncached remote functions.
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            v = stmt.value
            name = stmt.targets[0].id
            if isinstance(v, ast.Constant) and isinstance(v.value, str) and len(v.value) >= 300 and (PROMPT_NAME_HINT.search(name) or len(v.value) >= 1200):
                compressed = compress_prompt(v.value)
                if len(compressed) <= 0.85 * len(v.value):
                    saved = (len(v.value) - len(compressed)) // 4
                    add(Finding(
                        "bloated-prompt", "Bloated system prompt",
                        f"`{name}` is ~{len(v.value) // 4} tokens with duplicated lines and padding; ~{saved} tokens are "
                        "re-sent on every call.", stmt.lineno, "medium", "network", "O(N·P) tokens",
                        "Deduplicate instructions and collapse whitespace.", stmt.end_lineno or stmt.lineno,
                    ))
    called_in_loop = {
        n.func.id for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and depth_of(n) >= 1
    }
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name in info.remote_funcs \
                and stmt.name not in info.cached_funcs and stmt.name in called_in_loop:
            add(Finding(
                "missing-cache", "Missing caching layer",
                f"`{stmt.name}()` calls a remote model but never caches results, so repeated inputs pay full inference cost.",
                stmt.lineno, "medium", "network", "O(N) calls", "Memoise on the input (functools.lru_cache or a dict cache).",
            ))

    stats = {
        "lines": len(src.splitlines()),
        "ast_nodes": node_count,
        "functions": len(info.functions),
        "max_loop_depth": max((depth_of(n) + 1 for n in ast.walk(tree) if isinstance(n, LOOP_NODES)), default=0),
    }
    return {"ok": True, "findings": findings, "exponent": exponent, "stats": stats}


# --------------------------------------------------------------------------------------
# JavaScript analysis (Stage 1) - lexical scanner + bracket tree
# --------------------------------------------------------------------------------------

JS_CALLBACK_LOOPS = {
    "map", "forEach", "reduce", "reduceRight", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "some", "every", "flatMap", "sort",
}
JS_SCAN_METHODS = {"find", "findIndex", "findLast", "findLastIndex", "filter", "some", "every", "includes", "indexOf", "lastIndexOf"}
JS_REGEX_PREFIX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"}


class JsScan:
    def __init__(self, src: str):
        self.src = src
        n = len(src)
        mask = bytearray(n)
        match: dict[int, int] = {}
        stack: list[int] = []
        i = 0
        prev_sig = ""
        prev_word = ""
        while i < n:
            c = src[i]
            nxt = src[i + 1] if i + 1 < n else ""
            if c in "\"'":
                j = i + 1
                while j < n and src[j] != c and src[j] != "\n":
                    j += 2 if src[j] == "\\" else 1
                i = j + 1
                prev_sig, prev_word = "a", ""
                continue
            if c == "`":
                j = i + 1
                while j < n and src[j] != "`":
                    j += 2 if src[j] == "\\" else 1
                i = j + 1
                prev_sig, prev_word = "a", ""
                continue
            if c == "/" and nxt == "/":
                j = src.find("\n", i)
                i = n if j == -1 else j
                continue
            if c == "/" and nxt == "*":
                j = src.find("*/", i + 2)
                i = n if j == -1 else j + 2
                continue
            if c == "/" and (prev_sig == "" or prev_sig in "(,=:[!&|?{};+-*%<>~^" or prev_word in JS_REGEX_PREFIX_WORDS):
                j = i + 1
                in_class = False
                while j < n and src[j] != "\n":
                    ch = src[j]
                    if ch == "\\":
                        j += 2
                        continue
                    if ch == "[":
                        in_class = True
                    elif ch == "]":
                        in_class = False
                    elif ch == "/" and not in_class:
                        break
                    j += 1
                j += 1
                while j < n and src[j].isalpha():
                    j += 1
                i = j
                prev_sig, prev_word = "a", ""
                continue
            mask[i] = 1
            if c in "([{":
                stack.append(i)
            elif c in ")]}":
                if stack:
                    match[stack.pop()] = i
            if c.isalnum() or c in "_$":
                j = i
                while j < n and (src[j].isalnum() or src[j] in "_$"):
                    mask[j] = 1
                    j += 1
                prev_word = src[i:j]
                prev_sig = "a"
                i = j
                continue
            if not c.isspace():
                prev_sig, prev_word = c, ""
            i += 1
        self.mask = mask
        self.match = match
        self.regions = self._loop_regions()

    def code(self, pos: int) -> bool:
        return 0 <= pos < len(self.mask) and self.mask[pos] == 1

    def _loop_regions(self) -> list[tuple[int, int, str, int]]:
        src, regions = self.src, []
        for m in re.finditer(r"\.\s*([A-Za-z_$][\w$]*)\s*\(", src):
            paren = m.end() - 1
            if self.code(m.start()) and m.group(1) in JS_CALLBACK_LOOPS and paren in self.match:
                regions.append((paren, self.match[paren], m.group(1), m.start()))
        for m in re.finditer(r"\b(for|while)\s*\(", src):
            paren = m.end() - 1
            if not self.code(m.start()) or paren not in self.match:
                continue
            j = self.match[paren] + 1
            while j < len(src) and src[j].isspace():
                j += 1
            if j < len(src) and src[j] == "{" and j in self.match:
                end = self.match[j]
            else:
                semi = src.find(";", j)
                end = len(src) if semi == -1 else semi
            regions.append((m.start(), end, m.group(1), m.start()))
        for m in re.finditer(r"\bdo\s*\{", src):
            brace = m.end() - 1
            if self.code(m.start()) and brace in self.match:
                regions.append((m.start(), self.match[brace], "do", m.start()))
        return regions

    def enclosing(self, pos: int) -> list[tuple[int, int, str, int]]:
        return sorted((r for r in self.regions if r[0] < pos < r[1]), key=lambda r: r[0])

    def depth(self, pos: int) -> int:
        return len(self.enclosing(pos))

    def split_args(self, open_idx: int) -> list[tuple[int, int]]:
        """Top-level comma-separated argument spans inside the bracket at open_idx."""
        close = self.match[open_idx]
        spans, start, i = [], open_idx + 1, open_idx + 1
        while i < close:
            if i in self.match and self.src[i] in "([{":
                i = self.match[i] + 1
                continue
            if self.src[i] == "," and self.code(i):
                spans.append((start, i))
                start = i + 1
            i += 1
        if self.src[start:close].strip():
            spans.append((start, close))
        return spans


def js_receiver(src: str, dot: int) -> tuple[int, str]:
    """Walk back from a `.method` dot over a simple dotted identifier path."""
    j = dot
    while j > 0 and (src[j - 1].isalnum() or src[j - 1] in "_$."):
        j -= 1
    recv = src[j:dot]
    if not recv or recv[0].isdigit() or recv.startswith(".") or recv.endswith("."):
        return dot, ""
    return j, recv


def profile_javascript(src: str) -> dict[str, Any]:
    scan = JsScan(src)
    findings: list[Finding] = []
    seen: set[tuple[str, int]] = set()

    def add(f: Finding) -> None:
        if (f.rule, f.line) not in seen:
            seen.add((f.rule, f.line))
            findings.append(f)

    exponent = 1 if scan.regions else 0
    for start, end, kind, tok in scan.regions:
        d = scan.depth(tok) if kind in ("for", "while", "do") else scan.depth(start)
        exponent = max(exponent, d + 1)
        if d >= 1 and kind in ("for", "while", "do", "forEach", "map", "reduce", "flatMap"):
            add(Finding("nested-loop", "Nested loop", f"`{kind}` nested inside another loop - {complexity_label(d + 1)} work.",
                        line_of(src, tok), "medium", "cpu", complexity_label(d + 1),
                        "Index the inner collection with a Map/Set before the outer loop."))

    for m in re.finditer(r"\.\s*([A-Za-z_$][\w$]*)\s*\(", src):
        name, dot = m.group(1), m.start()
        if not scan.code(dot) or name not in JS_SCAN_METHODS:
            continue
        d = scan.depth(dot)
        if d >= 1:
            exponent = max(exponent, d + 1)
            _, recv = js_receiver(src, dot)
            severity = "high" if name in ("find", "findIndex", "filter", "some", "every", "findLast") else "medium"
            add(Finding(
                "nested-scan", f"Nested .{name}() inside loop",
                f"`{recv or 'array'}.{name}()` walks the whole array for every outer iteration - O(N·M).",
                line_of(src, dot), severity, "cpu", "O(N·M)",
                f"Build a Map/Set from `{recv or 'the array'}` once and look values up in O(1).",
            ))

    for m in re.finditer(r"JSON\.parse\s*\(\s*JSON\.stringify\s*\(", src):
        if not scan.code(m.start()):
            continue
        in_loop = scan.depth(m.start()) >= 1
        add(Finding(
            "json-clone", "Deep clone via JSON round-trip" + (" inside loop" if in_loop else ""),
            "JSON.parse(JSON.stringify(x)) serialises to a string and re-parses it, allocating twice the object size.",
            line_of(src, m.start()), "high" if in_loop else "medium", "memory", "O(N·S)",
            "Use a direct structural clone or avoid cloning read-only data.",
        ))

    for start, end, kind, tok in scan.regions:
        if kind not in ("reduce", "reduceRight"):
            continue
        args = scan.split_args(start)
        if not args:
            continue
        cb = src[args[0][0]:args[0][1]]
        pm = re.match(r"\s*(?:async\s+)?(?:function\s*\w*\s*)?\(?\s*([A-Za-z_$][\w$]*)", cb)
        if not pm:
            continue
        acc = pm.group(1)
        sm = re.search(r"(\{|\[)\s*\.\.\.\s*" + re.escape(acc) + r"\b", cb)
        if sm and scan.code(args[0][0] + sm.start()):
            pos = args[0][0] + sm.start()
            kind_label = "object" if sm.group(1) == "{" else "array"
            exponent = max(exponent, scan.depth(pos) + 1)
            add(Finding(
                "reduce-spread", f"{kind_label.capitalize()} spread inside .reduce()",
                f"`...{acc}` copies the whole accumulator on every step - O(N²) time and garbage.",
                line_of(src, pos), "high", "memory", "O(N²)",
                "Mutate the fresh accumulator in place (it is owned by the reduce call).",
            ))

    for m in re.finditer(r"\bawait\b", src):
        if scan.code(m.start()) and any(k in ("for", "while", "do") for _, _, k, _ in scan.enclosing(m.start())):
            add(Finding("await-loop", "Sequential await inside loop", "Each iteration waits for the previous network/IO call.",
                        line_of(src, m.start()), "medium", "network", "O(N) round-trips", "Batch requests or use Promise.all with a concurrency limit."))
    for pattern, rule, title, sev, cat, fix in (
        (r"\.concat\s*\(", "concat-loop", "Array.concat inside loop", "medium", "memory", "Push into one array instead of re-allocating."),
        (r"new\s+RegExp\s*\(", "regexp-loop", "RegExp constructed inside loop", "low", "cpu", "Compile the RegExp once outside the loop."),
        (r"document\.(querySelector|querySelectorAll|getElementById)\s*\(", "dom-loop", "DOM query inside loop", "low", "cpu", "Query the DOM once and cache the element."),
    ):
        for m in re.finditer(pattern, src):
            if scan.code(m.start()) and scan.depth(m.start()) >= 1:
                add(Finding(rule, title, f"`{m.group(0).strip()}` runs on every iteration.", line_of(src, m.start()), sev, cat, "O(N)", fix))

    stats = {
        "lines": len(src.splitlines()),
        "tokens_scanned": sum(scan.mask),
        "loop_regions": len(scan.regions),
        "max_loop_depth": max((scan.depth(r[0]) + 1 for r in scan.regions), default=0),
    }
    return {"ok": True, "findings": findings, "exponent": exponent, "stats": stats}


# --------------------------------------------------------------------------------------
# SQL analysis (Stage 1) - statement splitter + clause-aware scanner
# --------------------------------------------------------------------------------------

SQL_KEYWORDS = {
    "where", "on", "left", "right", "inner", "outer", "join", "group", "order", "limit", "having", "union",
    "select", "from", "as", "and", "or", "not", "cross", "full", "natural", "using", "set", "values", "window",
}


def sql_mask(text: str) -> str:
    """Blank out string-literal contents and comments, keeping offsets stable."""
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and j + 1 < n and text[j + 1] == "'":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            for k in range(i + 1, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j + 1
        elif c == "-" and text[i:i + 2] == "--":
            j = text.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif c == "/" and text[i:i + 2] == "/*":
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        else:
            i += 1
    return "".join(out)


def split_sql(text: str) -> list[tuple[int, int]]:
    """Return (start, end) spans of statements, `end` excluding the semicolon."""
    masked = sql_mask(text)
    spans, start = [], 0
    for i, c in enumerate(masked):
        if c == ";":
            if masked[start:i].strip():
                spans.append((start, i))
            start = i + 1
    if masked[start:].strip():
        spans.append((start, len(text)))
    # Trim leading whitespace/comments from each span start.
    trimmed = []
    for s, e in spans:
        k = s
        while k < e and masked[k].isspace():
            k += 1
        trimmed.append((k, e))
    return trimmed


def sql_kind(stmt: str) -> str:
    head = sql_mask(stmt).strip().upper()
    if re.match(r"CREATE\s+(UNIQUE\s+)?INDEX", head):
        return "index"
    if head.startswith("SELECT") or head.startswith("VALUES"):
        return "query"
    if head.startswith("WITH") and not re.search(r"\b(INSERT|UPDATE|DELETE|REPLACE)\b", head):
        return "query"
    if head.startswith("EXPLAIN"):
        return "query"
    return "setup"


def paren_match(masked: str) -> dict[int, int]:
    stack, match = [], {}
    for i, c in enumerate(masked):
        if c == "(":
            stack.append(i)
        elif c == ")" and stack:
            match[stack.pop()] = i
    return match


def sql_depths(masked: str) -> list[int]:
    depth, out = 0, []
    for c in masked:
        if c == "(":
            depth += 1
        out.append(depth)
        if c == ")":
            depth -= 1
    return out


def sql_tables(text: str) -> tuple[set[str], dict[str, set[str]], dict[str, list[list[str]]]]:
    """Tables, primary keys and existing indexes declared in the script."""
    masked = sql_mask(text)
    tables, pks, indexes = set(), {}, {}
    for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(", masked, re.I):
        t = m.group(1).lower()
        tables.add(t)
        match = paren_match(masked)
        body = text[m.end():match.get(m.end() - 1, len(text))]
        pk = set(c.lower() for c in re.findall(r"(\w+)\s+INTEGER\s+PRIMARY\s+KEY", body, re.I))
        for grp in re.findall(r"PRIMARY\s+KEY\s*\(([^)]*)\)", body, re.I):
            pk.update(c.strip().lower() for c in grp.split(","))
        pks[t] = pk
    for m in re.finditer(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]*)\)", masked, re.I):
        indexes.setdefault(m.group(1).lower(), []).append([c.strip().split()[0].lower() for c in m.group(2).split(",") if c.strip()])
    return tables, pks, indexes


def sql_aliases(stmt_masked: str, known_tables: set[str]) -> dict[str, str]:
    aliases = {}
    for m in re.finditer(r"\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?", stmt_masked, re.I):
        table = m.group(1).lower()
        if table == "select" or (known_tables and table not in known_tables):
            continue
        alias = (m.group(2) or table).lower()
        if alias in SQL_KEYWORDS:
            alias = table
        aliases[alias] = table
        aliases.setdefault(table, table)
    return aliases


def sql_index_plan(text: str, only_queries: bool = True) -> list[dict[str, Any]]:
    """Suggest composite indexes for equality/range filters and join keys."""
    tables, pks, existing = sql_tables(text)
    per_table: dict[str, dict[str, list[str]]] = {}
    first_use: dict[tuple[str, str], int] = {}
    for s, e in split_sql(text):
        stmt = text[s:e]
        if only_queries and sql_kind(stmt) != "query":
            continue
        masked = sql_mask(stmt)
        # Predicates inside CASE expressions are projections, not filters.
        filtered = re.sub(r"\bCASE\b.*?\bEND\b", lambda m: " " * len(m.group(0)), masked, flags=re.I | re.S)
        aliases = sql_aliases(masked, tables)

        def note(alias: str, col: str, kind: str, pos: int) -> None:
            table = aliases.get(alias.lower())
            col = col.lower()
            if not table or col in pks.get(table, set()):
                return
            bucket = per_table.setdefault(table, {"eq": [], "range": [], "join": []})
            if col not in bucket[kind]:
                bucket[kind].append(col)
            first_use.setdefault((table, col), s + pos)

        for m in re.finditer(r"\b(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)", filtered):
            note(m.group(1), m.group(2), "join", m.start())
            note(m.group(3), m.group(4), "join", m.start(3))
        for m in re.finditer(r"\b(\w+)\.(\w+)\s*=\s*(?:'|\d|\?|:)", filtered):
            note(m.group(1), m.group(2), "eq", m.start())
        for m in re.finditer(r"\b(\w+)\.(\w+)\s*(?:>=|<=|<>|<|>|\bBETWEEN\b)", filtered, re.I):
            note(m.group(1), m.group(2), "range", m.start())

    plan = []
    for table, cols in per_table.items():
        leading = {idx[0] for idx in existing.get(table, []) if idx}
        candidates: list[list[str]] = []
        filt = cols["eq"][:2] + [c for c in cols["range"] if c not in cols["eq"]][:1]
        if filt:
            candidates.append(filt)
        for jc in cols["join"]:
            if not any(c[0] == jc for c in candidates):
                candidates.append([jc])
        for cand in candidates:
            if cand[0] in leading:
                continue
            leading.add(cand[0])
            plan.append({
                "table": table, "columns": cand,
                "sql": f"CREATE INDEX IF NOT EXISTS idx_{table}_{'_'.join(cand)} ON {table} ({', '.join(cand)})",
                "pos": first_use.get((table, cand[0]), 0),
            })
    return plan


NON_SARGABLE = re.compile(r"\b(strftime|date|datetime|julianday|year|month|day|lower|upper|substr|substring|trim|cast|coalesce|ifnull)\s*\(", re.I)


def profile_sql(src: str) -> dict[str, Any]:
    findings: list[Finding] = []
    seen: set[tuple[str, int]] = set()

    def add(f: Finding) -> None:
        if (f.rule, f.line) not in seen:
            seen.add((f.rule, f.line))
            findings.append(f)

    tables, _, _ = sql_tables(src)
    exponent = 0
    statements = split_sql(src)
    queries = 0
    for s, e in statements:
        stmt = src[s:e]
        if sql_kind(stmt) != "query":
            continue
        queries += 1
        masked = sql_mask(stmt)
        match = paren_match(masked)
        exponent = max(exponent, 1)
        if re.search(r"\bSELECT\s+\*", masked, re.I):
            m = re.search(r"\bSELECT\s+\*", masked, re.I)
            add(Finding("select-star", "SELECT * over-fetches columns", "Reads and ships every column, defeating covering indexes.",
                        line_of(src, s + m.start()), "medium", "io", "O(N·C)", "List only the columns the caller uses."))
        for m in NON_SARGABLE.finditer(masked):
            before = masked[:m.start()]
            if not re.search(r"\b(WHERE|AND|OR|ON|NOT)\s*\(?\s*$", before, re.I):
                continue
            close = match.get(masked.find("(", m.start()))
            inner = stmt[m.end():close] if close else ""
            if not re.search(r"\b\w+\.\w+\b|\b[a-z_]\w*\b", inner, re.I):
                continue
            add(Finding(
                "non-sargable", f"Function-wrapped column: {m.group(1)}()",
                f"`{stmt[m.start():(close or m.end()) + 1].strip()}` must be evaluated for every row, so no index can be used - full scan.",
                line_of(src, s + m.start()), "high", "cpu", "O(N) scan per probe",
                "Compare the raw column against a pre-computed range (e.g. date >= '2024-01-01' AND date < '2025-01-01').",
            ))
        outer_aliases = sql_aliases(masked, tables)
        for m in re.finditer(r"\(\s*SELECT\b", masked, re.I):
            open_idx = m.start()
            close = match.get(open_idx, len(masked))
            sub = masked[open_idx:close]
            inner_aliases = sql_aliases(sub, tables)
            refs = {a.lower() for a in re.findall(r"\b(\w+)\.\w+", sub)}
            correlated = {a for a in refs if a not in inner_aliases and a in outer_aliases}
            if correlated:
                exponent = max(exponent, 2)
                add(Finding(
                    "correlated-subquery", "Correlated subquery (runs once per outer row)",
                    f"Subquery references outer alias `{sorted(correlated)[0]}`, so it re-executes for every row - O(N·M).",
                    line_of(src, s + open_idx), "high", "cpu", "O(N·M)",
                    "Pre-aggregate once with GROUP BY and LEFT JOIN the result.",
                ))
            elif re.search(r"\bIN\s*\(\s*$", masked[:open_idx + 1], re.I):
                add(Finding("in-subquery", "IN (subquery)", "May materialise the full subquery result; EXISTS or a JOIN is usually cheaper.",
                            line_of(src, s + open_idx), "medium", "cpu", "O(N·M)", "Rewrite as EXISTS or a semi-join."))
        for m in re.finditer(r"\bLIKE\s+'%", stmt, re.I):
            add(Finding("leading-wildcard", "Leading-wildcard LIKE", "`LIKE '%...'` cannot use a B-tree index - full scan.",
                        line_of(src, s + m.start()), "medium", "cpu", "O(N)", "Use a full-text index or anchor the pattern."))
        if re.search(r"\bSELECT\s+DISTINCT\b", masked, re.I):
            m = re.search(r"\bSELECT\s+DISTINCT\b", masked, re.I)
            add(Finding("distinct", "SELECT DISTINCT", "Forces a sort/hash of the full result to remove duplicates.",
                        line_of(src, s + m.start()), "low", "cpu", "O(N log N)", "Fix the join that creates duplicates instead."))
        depths = sql_depths(masked)
        om = [m for m in re.finditer(r"\bORDER\s+BY\b", masked, re.I) if depths[m.start()] == 0]
        if om and not re.search(r"\bLIMIT\b", masked, re.I):
            add(Finding("unbounded-sort", "ORDER BY without LIMIT", "Sorts the entire result set even if the client reads a page.",
                        line_of(src, s + om[0].start()), "low", "cpu", "O(N log N)", "Add LIMIT/pagination or an index matching the order."))

    for idx in sql_index_plan(src):
        add(Finding(
            "missing-index", f"Missing index on {idx['table']}({', '.join(idx['columns'])})",
            f"Filters/joins on `{idx['table']}.{idx['columns'][0]}` have no supporting index - every probe scans the table.",
            line_of(src, idx["pos"]), "high", "io", "O(N) per probe", idx["sql"] + ";",
        ))
    stats = {"lines": len(src.splitlines()), "statements": len(statements), "queries": queries, "tables": len(tables)}
    return {"ok": True, "findings": findings, "exponent": exponent, "stats": stats}


def profile_code(code: str, language: str) -> dict[str, Any]:
    fn = {"python": profile_python, "javascript": profile_javascript, "sql": profile_sql}[language]
    result = fn(code)
    order = {"high": 0, "medium": 1, "low": 2}
    result["findings"].sort(key=lambda f: (order[f.severity], f.line))
    for i, f in enumerate(result["findings"], 1):
        f.id = f"F{i}"
    result["complexity"] = complexity_label(result["exponent"])
    return result


# --------------------------------------------------------------------------------------
# Stage 2 - Strategist
# --------------------------------------------------------------------------------------


def strategize(findings: list[Finding]) -> list[dict[str, Any]]:
    scored = []
    for f in findings:
        quad = 2.0 if re.search(r"N·|N²|N³|N\^", f.complexity) else 1.0
        impact = SEVERITY_WEIGHT[f.severity] * CATEGORY_WEIGHT.get(f.category, 1.0) * quad
        mem = "High" if f.category == "memory" and f.severity == "high" else "Medium" if f.category in ("memory", "io") else "Low"
        scored.append((impact, f, mem))
    total = sum(s[0] for s in scored) or 1.0
    scored.sort(key=lambda s: -s[0])
    return [
        {
            "rank": i,
            "finding_id": f.id,
            "rule": f.rule,
            "title": f.title,
            "line": f.line,
            "severity": f.severity,
            "category": f.category,
            "complexity": f.complexity,
            "carbon_share_pct": round(100 * impact / total, 1),
            "memory_impact": mem,
            "impact_score": round(impact, 1),
            "action": f.fix,
        }
        for i, (impact, f, mem) in enumerate(scored, 1)
    ]


# --------------------------------------------------------------------------------------
# Stage 3a - Offline deterministic rule engine
# --------------------------------------------------------------------------------------

RuleResult = Optional[tuple[str, Change]]


def _py_indent_unit(sm: PySourceMap, outer: ast.AST, inner: ast.AST) -> str:
    unit = sm.indent(inner.lineno)[len(sm.indent(outer.lineno)):]  # type: ignore[attr-defined]
    return unit or "    "


def py_rule_nested_join(src: str, tree: ast.Module, sm: PySourceMap, info: PyModuleInfo) -> RuleResult:
    for node in ast.walk(tree):
        join = find_nested_join(node, sm)
        if not join:
            continue
        outer, inner, cond = join["outer"], join["inner"], join["if"]
        if not (sm.owns_line(outer) and sm.owns_line(cond)) or cond.body[0].lineno == cond.test.end_lineno:
            continue
        kb_src, ka_src = sm.seg(join["kb"]), sm.seg(join["ka"])
        iter_src = sm.seg(inner.iter)
        key = join["kb"]
        key_name = (
            key.slice.value if isinstance(key, ast.Subscript) and isinstance(key.slice, ast.Constant) and isinstance(key.slice.value, str)
            else key.attr if isinstance(key, ast.Attribute) else "key"
        )
        base = iter_src.split(".")[-1]
        idx = unique_name(f"{base}_by_{key_name}", info.all_names)
        ind = sm.indent(outer.lineno)
        unit = _py_indent_unit(sm, outer, inner)
        b = join["b"]
        build = (
            f"{ind}# GreenCode: hash index built once - O(M) - replaces the O(N·M) inner scan\n"
            f"{ind}{idx} = {{}}\n"
            f"{ind}for {b} in {iter_src}:\n"
            f"{ind}{unit}{idx}.setdefault({kb_src}, []).append({b})\n"
        )
        edits = [
            (sm.line_start(outer.lineno), sm.line_start(outer.lineno), build),
            (sm.start(inner.iter), sm.end(inner.iter), f"{idx}.get({ka_src}, ())"),
        ]
        rest = [c for i, c in enumerate(join["conjuncts"]) if i != join["index"]]
        if rest:
            parts = []
            for c in rest:
                text = sm.seg(c)
                parts.append(f"({text})" if isinstance(c, (ast.BoolOp, ast.IfExp, ast.Lambda, ast.NamedExpr)) else text)
            edits.append((sm.start(cond.test), sm.end(cond.test), " and ".join(parts)))
        else:
            body_first = cond.body[0].lineno
            cut = len(sm.indent(body_first)) - len(sm.indent(cond.lineno))
            body_lines = sm.lines[body_first - 1:cond.end_lineno]
            dedented = []
            for ln in body_lines:
                lead = len(ln) - len(ln.lstrip(" \t"))
                dedented.append(ln[min(cut, lead):])
            text = "".join(dedented)
            if not text.endswith("\n"):
                text += "\n"
            edits.append((sm.line_start(cond.lineno), sm.line_after(cond.end_lineno), text))
        new_src = apply_edits(src, edits)
        change = Change(
            "nested-join", "Hash-join replaces nested-loop scan",
            f"Built `{idx}` (dict of `{kb_src}` → rows) once; each `{join['a']}` now looks up matches in O(1). "
            f"Complexity O(N·M) → O(N+M). Match order is preserved.",
            outer.lineno, [idx], hash_based=True,
        )
        return new_src, change
    return None


def _py_membership_targets(info: PyModuleInfo, uses: dict[str, list[ast.AST]], name: str) -> list[ast.Compare]:
    return [c for c in uses["membership"] if depth_of(c) >= 1]  # type: ignore[list-item]


def py_rule_accumulator_set(src: str, tree: ast.Module, sm: PySourceMap, info: PyModuleInfo) -> RuleResult:
    for name in sorted(info.list_names):
        uses = info.name_uses(name)
        assigns = uses["assign"]
        in_loop = _py_membership_targets(info, uses, name)
        if len(assigns) != 1 or not in_loop or uses["mutate"] or uses["escape"] or not uses["append"]:
            continue
        assign = assigns[0]
        if not (isinstance(assign.value, ast.List) and not assign.value.elts and len(assign.targets) == 1 and sm.owns_line(assign)):
            continue
        ok = True
        for call in uses["append"]:
            stmt = parent_of(call)
            arg = call.args[0] if len(call.args) == 1 else None
            if not (isinstance(stmt, ast.Expr) and sm.owns_line(stmt) and isinstance(arg, (ast.Name, ast.Attribute, ast.Subscript, ast.Constant))
                    and not any(isinstance(n, ast.Call) for n in ast.walk(arg))):
                ok = False
        if not ok:
            continue
        set_name = unique_name(f"{name}_seen", info.all_names)
        ind = sm.indent(assign.lineno)
        edits = [(sm.line_after(assign.end_lineno), sm.line_after(assign.end_lineno),
                  f"{ind}{set_name} = set()  # GreenCode: O(1) membership mirror of {name}\n")]
        for cmp in uses["membership"]:
            for comp in cmp.comparators:
                if isinstance(comp, ast.Name) and comp.id == name:
                    edits.append((sm.start(comp), sm.end(comp), set_name))
        for call in uses["append"]:
            stmt = parent_of(call)
            sind = sm.indent(stmt.lineno)
            edits.append((sm.line_after(stmt.end_lineno), sm.line_after(stmt.end_lineno),
                          f"{sind}{set_name}.add({sm.seg(call.args[0])})\n"))
        change = Change(
            "list-membership", f"Set mirror for `{name}` membership",
            f"`in {name}` was a linear scan of a growing list (O(N²) overall). A companion set `{set_name}` "
            f"is kept in sync on every append, making lookups O(1) while `{name}` keeps its order.",
            cmp.lineno, [set_name], hash_based=True,
        )
        return apply_edits(src, edits), change
    return None


def py_rule_static_set(src: str, tree: ast.Module, sm: PySourceMap, info: PyModuleInfo) -> RuleResult:
    for name in sorted(info.list_names):
        uses = info.name_uses(name)
        assigns = uses["assign"]
        in_loop = _py_membership_targets(info, uses, name)
        if len(assigns) != 1 or not in_loop or uses["mutate"] or uses["escape"] or uses["append"]:
            continue
        assign = assigns[0]
        if len(assign.targets) != 1 or not sm.owns_line(assign) or depth_of(assign) != 0:
            continue
        set_name = unique_name(f"{name}_set", info.all_names)
        ind = sm.indent(assign.lineno)
        edits = [(sm.line_after(assign.end_lineno), sm.line_after(assign.end_lineno),
                  f"{ind}{set_name} = set({name})  # GreenCode: O(1) lookups, built once\n")]
        for cmp in in_loop:
            for comp in cmp.comparators:
                if isinstance(comp, ast.Name) and comp.id == name:
                    edits.append((sm.start(comp), sm.end(comp), set_name))
        change = Change(
            "list-membership", f"Frozen lookup set for `{name}`",
            f"`{name}` never changes after creation, so membership tests now hit `{set_name}` (hash lookup) "
            f"instead of scanning {name} on every iteration.",
            in_loop[0].lineno, [set_name], hash_based=True,
        )
        return apply_edits(src, edits), change
    return None


def py_rule_prompt(src: str, tree: ast.Module, sm: PySourceMap, info: PyModuleInfo) -> RuleResult:
    for stmt in tree.body:
        if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)):
            continue
        v = stmt.value
        name = stmt.targets[0].id
        if not (isinstance(v, ast.Constant) and isinstance(v.value, str) and len(v.value) >= 300):
            continue
        if not (PROMPT_NAME_HINT.search(name) or len(v.value) >= 1200):
            continue
        compressed = compress_prompt(v.value)
        if len(compressed) > 0.85 * len(v.value):
            continue
        lines = compressed.split("\n")
        ind = sm.indent(stmt.lineno)
        body = "".join(f"{ind}    {repr(ln + chr(10)) if i < len(lines) - 1 else repr(ln)}\n" for i, ln in enumerate(lines))
        new_value = f"(  # GreenCode: deduplicated prompt\n{body}{ind})"
        before, after = len(v.value) // 4, len(compressed) // 4
        change = Change(
            "bloated-prompt", f"Compressed `{name}` prompt",
            f"Removed duplicated instructions and padding: ~{before} → ~{after} tokens "
            f"({round(100 * (1 - len(compressed) / len(v.value)))}% fewer) on every request.",
            stmt.lineno, [name], semantic=True,
        )
        return apply_edits(src, [(sm.start(v), sm.end(v), new_value)]), change
    return None


def py_rule_cache(src: str, tree: ast.Module, sm: PySourceMap, info: PyModuleInfo) -> RuleResult:
    called_in_loop = {
        n.func.id for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and depth_of(n) >= 1
    }
    for stmt in tree.body:
        if not isinstance(stmt, ast.FunctionDef) or stmt.name not in info.remote_funcs or stmt.name in info.cached_funcs:
            continue
        if stmt.name not in called_in_loop or not sm.owns_line(stmt):
            continue
        a = stmt.args
        if a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs or not a.args:
            continue
        if any(isinstance(n, (ast.Yield, ast.YieldFrom, ast.Global, ast.Nonlocal)) for n in ast.walk(stmt)):
            continue
        if any(not isinstance(d, ast.Constant) for d in a.defaults):
            continue
        first = min([stmt.lineno] + [d.lineno for d in stmt.decorator_list])
        ind = sm.indent(stmt.lineno)
        edits = [(sm.line_start(first), sm.line_start(first),
                  f"{ind}@functools.lru_cache(maxsize=4096)  # GreenCode: identical inputs reuse the response\n")]
        has_import = any(
            isinstance(n, ast.Import) and any(al.name == "functools" and not al.asname for al in n.names) for n in tree.body
        )
        if not has_import:
            anchor = None
            for n in tree.body:
                if isinstance(n, (ast.Import, ast.ImportFrom)) and not (isinstance(n, ast.ImportFrom) and n.module == "__future__"):
                    anchor = sm.line_start(n.lineno)
                    break
            if anchor is None:
                anchor = 0
                for n in tree.body:
                    is_doc = isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)
                    is_future = isinstance(n, ast.ImportFrom) and n.module == "__future__"
                    if is_doc or is_future:
                        anchor = sm.line_after(n.end_lineno)
                    else:
                        break
            edits.append((anchor, anchor, "import functools\n"))
        change = Change(
            "missing-cache", f"Response cache on `{stmt.name}()`",
            f"`{stmt.name}()` is memoised with functools.lru_cache, so repeated inputs skip the network round-trip, "
            "the prompt tokens and the inference energy entirely.",
            stmt.lineno, ["lru_cache"], semantic=True, hash_based=True,
        )
        return apply_edits(src, edits), change
    return None


PY_RULES: list[Callable[..., RuleResult]] = [py_rule_nested_join, py_rule_accumulator_set, py_rule_static_set, py_rule_prompt, py_rule_cache]


def refactor_python(src: str, allow: Callable[[Change], bool]) -> tuple[str, list[Change]]:
    changes: list[Change] = []
    if not src.endswith("\n"):
        src += "\n"
    for rule in PY_RULES:
        for _ in range(12):
            try:
                tree = ast.parse(src)
            except SyntaxError:
                return src, changes
            annotate_tree(tree)
            sm, info = PySourceMap(src), PyModuleInfo(tree)
            try:
                res = rule(src, tree, sm, info)
            except RefactorError:
                res = None
            if not res:
                break
            new_src, change = res
            if not allow(change):
                break
            try:
                ast.parse(new_src)
            except SyntaxError:
                break
            src = new_src
            changes.append(change)
    return src, changes


JS_CLONE_HELPER = """// GreenCode: allocation-light deep clone with JSON round-trip semantics
function __gcClone(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type !== 'object') return value;
  if (typeof value.toJSON === 'function') return value.toJSON();
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      out[i] = item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : __gcClone(item);
    }
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    out[key] = __gcClone(item);
  }
  return out;
}

"""


def _js_statement_line_start(src: str, pos: int) -> int:
    """Start offset of the line that begins the statement containing pos."""
    ls = src.rfind("\n", 0, pos) + 1
    while ls > 0:
        line = src[ls:src.find("\n", ls) if src.find("\n", ls) != -1 else len(src)].strip()
        prev_ls = src.rfind("\n", 0, ls - 1) + 1
        prev = src[prev_ls:ls - 1].rstrip()
        if line.startswith(".") or line.startswith("?") or line.startswith(":") or re.search(r"(=|\(|,|\.|\?|:|&&|\|\||\+|-)$", prev):
            ls = prev_ls
            continue
        break
    return ls


def _js_binds(region_text: str, name: str) -> bool:
    n = re.escape(name)
    return bool(re.search(
        rf"\b(?:const|let|var)\s+(?:\{{[^}}]*\b{n}\b[^}}]*\}}|\[[^\]]*\b{n}\b[^\]]*\]|{n}\b)"
        rf"|\(\s*(?:[\w$]+\s*,\s*)*{n}\s*[,)=]|\b{n}\s*=>|function\s*\w*\s*\([^)]*\b{n}\b",
        region_text,
    ))


def js_rule_lookup(src: str) -> RuleResult:
    scan = JsScan(src)
    for m in re.finditer(r"\.\s*(find|filter|some|includes|indexOf)\s*\(", src):
        method, dot, paren = m.group(1), m.start(), m.end() - 1
        if not scan.code(dot) or paren not in scan.match:
            continue
        regions = scan.enclosing(dot)
        if not regions:
            continue
        rstart, recv = js_receiver(src, dot)
        if not recv or recv.startswith("this.") and False:
            continue
        base = recv.split(".")[0]
        if base in ("this", "JSON", "Object", "Array", "Math", "console"):
            if base != "this":
                continue
        outer = regions[0]
        region_text = src[outer[0]:dot]
        if _js_binds(region_text, base):
            continue
        close = scan.match[paren]
        args = scan.split_args(paren)
        if len(args) != 1:
            continue
        arg = src[args[0][0]:args[0][1]].strip()
        simple = r"[\w$]+(?:\.[\w$]+|\[[\w$'\"]+\])*"
        replace_end = close + 1
        field_name = None
        if method in ("find", "filter", "some"):
            cm = re.fullmatch(r"\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*(.+)", arg, re.S)
            if not cm:
                continue
            p, body = cm.group(1), cm.group(2).strip()
            em = re.fullmatch(rf"{re.escape(p)}\.([\w$]+)\s*===\s*({simple})", body) or None
            if em:
                field_name, expr = em.group(1), em.group(2)
            else:
                em = re.fullmatch(rf"({simple})\s*===\s*{re.escape(p)}\.([\w$]+)", body)
                if not em:
                    continue
                expr, field_name = em.group(1), em.group(2)
            if re.search(rf"\b{re.escape(p)}\b", expr):
                continue
        else:
            decl = re.search(
                rf"\b(?:const|let|var)\s+{re.escape(recv)}\s*=\s*(\[|Array\.from|new\s+Array|[\w$.]+\.(?:map|filter|slice|concat|flatMap)\()",
                src,
            )
            if not decl:
                continue
            expr = arg
            negate = False
            if method == "indexOf":
                tail = re.match(r"\s*(!==\s*-1|>\s*-1|>=\s*0|===\s*-1|<\s*0)", src[close + 1:])
                if not tail:
                    continue
                negate = tail.group(1).replace(" ", "") in ("===-1", "<0")
                replace_end = close + 1 + tail.end()
        clean = re.sub(r"\W+", "_", recv.replace("this.", "")).strip("_")
        cap = (field_name[:1].upper() + field_name[1:]) if field_name else ""
        if method == "find":
            name = f"__{clean}By{cap}"
            build = (f"const {name} = new Map();\n"
                     f"for (const __item of {recv}) if (!{name}.has(__item.{field_name})) {name}.set(__item.{field_name}, __item);\n")
            replacement = f"{name}.get({expr})"
            title = f"Map index replaces nested {recv}.find()"
        elif method == "filter":
            name = f"__{clean}GroupedBy{cap}"
            build = (f"const {name} = new Map();\n"
                     f"for (const __item of {recv}) {{ const __group = {name}.get(__item.{field_name}); "
                     f"if (__group) __group.push(__item); else {name}.set(__item.{field_name}, [__item]); }}\n")
            replacement = f"({name}.get({expr}) || []).slice()"
            title = f"Grouped Map replaces nested {recv}.filter()"
        elif method == "some":
            name = f"__{clean}{cap}Set"
            build = f"const {name} = new Set();\nfor (const __item of {recv}) {name}.add(__item.{field_name});\n"
            replacement = f"{name}.has({expr})"
            title = f"Set replaces nested {recv}.some()"
        else:
            name = f"__{clean}Set"
            build = f"const {name} = new Set({recv});\n"
            replacement = ("!" if method == "indexOf" and negate else "") + f"{name}.has({expr})"
            title = f"Set replaces nested {recv}.{method}()"
        edits = [(rstart, replace_end, replacement)]
        if not re.search(rf"\bconst\s+{re.escape(name)}\s*=", src):
            ins = _js_statement_line_start(src, outer[3])
            ind = re.match(r"[ \t]*", src[ins:]).group(0)
            build_text = f"{ind}// GreenCode: index built once - O(M) - replaces an O(N·M) scan\n" + "".join(
                f"{ind}{ln}\n" for ln in build.rstrip("\n").split("\n"))
            edits.append((ins, ins, build_text))
        change = Change(
            "nested-scan", title,
            f"`{recv}.{method}()` ran inside a loop, scanning every element per iteration. `{name}` is built once "
            f"before the loop and answers each lookup in O(1) - O(N·M) → O(N+M).",
            line_of(src, dot), [name], hash_based=False,
        )
        return apply_edits(src, edits), change
    return None


def js_rule_json_clone(src: str) -> RuleResult:
    scan = JsScan(src)
    for m in re.finditer(r"JSON\.parse\s*\(\s*JSON\.stringify\s*\(", src):
        if not scan.code(m.start()):
            continue
        outer = src.index("(", m.start())
        inner = m.end() - 1
        if outer not in scan.match or inner not in scan.match:
            continue
        args = scan.split_args(inner)
        if len(args) != 1 or src[scan.match[inner] + 1:scan.match[outer]].strip():
            continue
        arg = src[args[0][0]:args[0][1]].strip()
        edits = [(m.start(), scan.match[outer] + 1, f"__gcClone({arg})")]
        if "function __gcClone(" not in src:
            pos = 0
            while True:
                lm = re.match(r"[ \t]*(//[^\n]*|'use strict';?|\"use strict\";?)?\n", src[pos:])
                if lm and lm.group(1):
                    pos += lm.end()
                    continue
                break
            edits.append((pos, pos, ("\n" if pos else "") + JS_CLONE_HELPER))
        change = Change(
            "json-clone", "Direct deep clone replaces JSON round-trip",
            f"`JSON.parse(JSON.stringify({arg}))` serialised to a string and re-parsed it. `__gcClone` walks the object "
            "once with identical JSON semantics (drops undefined/functions, NaN → null, honours toJSON).",
            line_of(src, m.start()), ["__gcClone"], semantic=False,
        )
        return apply_edits(src, edits), change
    return None


def js_rule_reduce_spread(src: str) -> RuleResult:
    scan = JsScan(src)
    for start, end, kind, tok in scan.regions:
        if kind != "reduce":
            continue
        args = scan.split_args(start)
        if len(args) != 2 or src[args[1][0]:args[1][1]].strip() not in ("{}", "[]"):
            continue
        cb_s, cb_e = args[0]
        cb = src[cb_s:cb_e]
        pm = re.match(r"\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*,|function\s*\w*\s*\(\s*([A-Za-z_$][\w$]*)\s*,)", cb)
        if not pm:
            continue
        acc = pm.group(1) or pm.group(2)
        for sm_ in re.finditer(r"(\{|\[)\s*\.\.\.\s*" + re.escape(acc) + r"\s*,", cb):
            open_idx = cb_s + sm_.start()
            if not scan.code(open_idx) or open_idx not in scan.match:
                continue
            before = src[cb_s:open_idx].rstrip()
            if not (before.endswith("=>") or before.endswith("=> (") or before.endswith("=>(") or re.search(r"\breturn$", before)):
                continue
            parts = scan.split_args(open_idx)
            if len(parts) != 2:
                continue
            item = src[parts[1][0]:parts[1][1]].strip()
            if sm_.group(1) == "[":
                if item.startswith("..."):
                    continue
                replacement = f"({acc}.push({item}), {acc})"
                detail = f"`[...{acc}, x]` re-allocated the whole array per element; `{acc}.push(x)` appends in O(1)."
            else:
                if item.startswith("..."):
                    continue
                if item.startswith("["):
                    k_open = parts[1][0] + (len(src[parts[1][0]:parts[1][1]]) - len(src[parts[1][0]:parts[1][1]].lstrip()))
                    if k_open not in scan.match:
                        continue
                    k_close = scan.match[k_open]
                    key = src[k_open + 1:k_close].strip()
                    rest = src[k_close + 1:parts[1][1]].strip()
                    if not rest.startswith(":"):
                        continue
                    value = rest[1:].strip()
                    target = f"{acc}[{key}]"
                else:
                    km = re.match(r"([A-Za-z_$][\w$]*)\s*(?::\s*(.+))?$", item, re.S)
                    if not km:
                        continue
                    target = f"{acc}.{km.group(1)}"
                    value = (km.group(2) or km.group(1)).strip()
                replacement = f"({target} = {value}, {acc})"
                detail = (f"`{{ ...{acc}, ... }}` copied every accumulated key on each step (O(N²) time + garbage). "
                          f"The accumulator is a fresh literal owned by this reduce, so it is now mutated in place - O(N).")
            rs, re_ = open_idx, scan.match[open_idx] + 1
            # `=> ({ ... })`: replace the wrapping parens too instead of nesting another pair.
            lp = len(src[:rs].rstrip()) - 1
            rp = re_ + (len(src[re_:]) - len(src[re_:].lstrip()))
            if lp >= 0 and src[lp] == "(" and scan.match.get(lp) == rp:
                rs, re_ = lp, rp + 1
            new_src = apply_edits(src, [(rs, re_, replacement)])
            change = Change("reduce-spread", "In-place accumulator in .reduce()", detail, line_of(src, open_idx), [f"{acc}["] if "[" in replacement else [acc])
            return new_src, change
    return None


JS_RULES: list[Callable[[str], RuleResult]] = [js_rule_lookup, js_rule_json_clone, js_rule_reduce_spread]


def refactor_javascript(src: str, allow: Callable[[Change], bool]) -> tuple[str, list[Change]]:
    changes: list[Change] = []
    for rule in JS_RULES:
        for _ in range(20):
            res = rule(src)
            if not res or not allow(res[1]):
                break
            src, change = res
            changes.append(change)
    return src, changes


def _year_range(col: str, year: int) -> str:
    return f"({col} >= '{year:04d}-01-01' AND {col} < '{year + 1:04d}-01-01')"


def sql_rule_sargable(text: str) -> tuple[str, list[Change]]:
    changes: list[Change] = []

    def month_range(col: str, ym: str) -> str:
        y, mth = int(ym[:4]), int(ym[5:7])
        ny, nm = (y + 1, 1) if mth == 12 else (y, mth + 1)
        return f"({col} >= '{y:04d}-{mth:02d}-01' AND {col} < '{ny:04d}-{nm:02d}-01')"

    def day_range(col: str, day: str) -> str:
        nxt = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(day, "%Y-%m-%d")) + 36 * 3600))
        return f"({col} >= '{day}' AND {col} < '{nxt}')"

    patterns: list[tuple[str, Callable[[re.Match], str]]] = [
        (r"strftime\(\s*'%Y'\s*,\s*([\w.]+)\s*\)\s*=\s*'(\d{4})'", lambda m: _year_range(m.group(1), int(m.group(2)))),
        (r"strftime\(\s*'%Y-%m'\s*,\s*([\w.]+)\s*\)\s*=\s*'(\d{4}-\d{2})'", lambda m: month_range(m.group(1), m.group(2))),
        (r"\bYEAR\(\s*([\w.]+)\s*\)\s*=\s*'?(\d{4})'?", lambda m: _year_range(m.group(1), int(m.group(2)))),
        (r"\bsubstr\(\s*([\w.]+)\s*,\s*1\s*,\s*4\s*\)\s*=\s*'(\d{4})'", lambda m: _year_range(m.group(1), int(m.group(2)))),
        (r"\bdate\(\s*([\w.]+)\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'", lambda m: day_range(m.group(1), m.group(2))),
    ]
    for pat, repl in patterns:
        def sub(m: re.Match) -> str:
            new = repl(m)
            changes.append(Change(
                "non-sargable", "Index-friendly date range predicate",
                f"`{m.group(0)}` wrapped the column in a function, forcing a full scan. Rewritten as the half-open "
                f"range `{new}`, which an index on the raw column can seek.",
                line_of(text, m.start()), [new.split(" >= ")[0].strip("(")],
            ))
            return new
        text = re.sub(pat, sub, text, flags=re.I)
    return text, changes


def _split_top(text: str, sep_regex: str) -> list[str]:
    masked = sql_mask(text)
    depths = sql_depths(masked)
    parts, last = [], 0
    for m in re.finditer(sep_regex, masked, re.I):
        if depths[m.start()] == 0 and "(" not in masked[m.start():m.end()]:
            parts.append(text[last:m.start()])
            last = m.end()
    parts.append(text[last:])
    return parts


def _clause_positions(masked: str) -> dict[str, int]:
    depths = sql_depths(masked)
    pos: dict[str, int] = {}
    for kw in ("SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "UNION", "WINDOW"):
        for m in re.finditer(r"\b" + kw.replace(" ", r"\s+") + r"\b", masked, re.I):
            if depths[m.start()] == 0:
                pos.setdefault(kw, m.start())
    return pos


CORRELATED_AGG = re.compile(
    r"^\(\s*SELECT\s+(COUNT|SUM|AVG|MIN|MAX)\s*\((.*?)\)\s+FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+WHERE\s+(.*)\)\s*(?:AS\s+)?(\w+)$",
    re.I | re.S,
)


def sql_rule_decorrelate(stmt: str) -> tuple[str, list[Change]]:
    masked = sql_mask(stmt)
    pos = _clause_positions(masked)
    if "SELECT" not in pos or "FROM" not in pos or "UNION" in pos or masked.lstrip().upper().startswith("WITH"):
        return stmt, []
    sel_start = pos["SELECT"] + len("SELECT")
    from_start = pos["FROM"]
    from_end = min([p for k, p in pos.items() if k not in ("SELECT", "FROM") and p > from_start] + [len(stmt)])
    from_clause = stmt[from_start + 4:from_end]
    fm = re.match(r"\s*(\w+)(?:\s+(?:AS\s+)?(\w+))?", from_clause, re.I)
    if not fm:
        return stmt, []
    outer_alias = (fm.group(2) if fm.group(2) and fm.group(2).lower() not in SQL_KEYWORDS else fm.group(1))
    select_text = stmt[sel_start:from_start]
    items = _split_top(select_text, r",")
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    parsed: list[Optional[dict[str, Any]]] = []
    for item in items:
        m = CORRELATED_AGG.match(item.strip())
        info = None
        if m:
            agg, arg, table, ialias, where, alias = m.groups()
            ialias = ialias or table
            if not re.search(r"\b(GROUP|ORDER|LIMIT|JOIN|UNION|SELECT|BETWEEN|OR)\b", sql_mask(where), re.I):
                conjs = [c.strip() for c in _split_top(where, r"\bAND\b")]
                corr = [
                    c for c in conjs
                    if re.fullmatch(rf"\(?\s*(?:{ialias}\.(\w+)\s*=\s*{outer_alias}\.(\w+)|{outer_alias}\.(\w+)\s*=\s*{ialias}\.(\w+))\s*\)?", c, re.I)
                ]
                rest = [c for c in conjs if c not in corr]
                if len(corr) == 1 and not any(re.search(rf"\b{outer_alias}\.", c, re.I) for c in rest + [arg]):
                    cm = re.fullmatch(rf"\(?\s*(?:{ialias}\.(\w+)\s*=\s*{outer_alias}\.(\w+)|{outer_alias}\.(\w+)\s*=\s*{ialias}\.(\w+))\s*\)?", corr[0], re.I)
                    icol = cm.group(1) or cm.group(4)
                    ocol = cm.group(2) or cm.group(3)
                    if not (agg.upper() == "COUNT" and "distinct" in arg.lower() and rest):
                        key = (table.lower(), icol.lower(), ocol.lower())
                        g = groups.setdefault(key, {"alias": ialias, "items": []})
                        canon = g["alias"]
                        norm = lambda s: re.sub(rf"\b{ialias}\.", f"{canon}.", s, flags=re.I)  # noqa: E731
                        info = {"agg": agg.upper(), "arg": norm(arg.strip()), "rest": [norm(r) for r in rest], "alias": alias,
                                "key": key, "raw": item}
                        g["items"].append(info)
        parsed.append(info)
    if not groups:
        return stmt, []

    taken = set(re.findall(r"\w+", stmt.lower()))
    joins, changes = [], []
    for (table, icol, ocol), g in groups.items():
        canon = g["alias"]
        common = [c for c in g["items"][0]["rest"] if all(c in it["rest"] for it in g["items"])]
        dname = unique_name(f"gc_{table}_{icol}_agg", taken)
        exprs = []
        for it in g["items"]:
            extra = [c for c in it["rest"] if c not in common]
            cond = " AND ".join(f"({c})" if re.search(r"\bOR\b", c, re.I) else c for c in extra)
            if it["agg"] == "COUNT":
                value = "1" if it["arg"] == "*" else it["arg"]
                expr = f"COUNT(CASE WHEN {cond} THEN {value} END)" if extra else f"COUNT({it['arg']})"
            else:
                expr = f"{it['agg']}(CASE WHEN {cond} THEN {it['arg']} END)" if extra else f"{it['agg']}({it['arg']})"
            exprs.append(f"{expr} AS {it['alias']}")
            it["replacement"] = (f"COALESCE({dname}.{it['alias']}, 0) AS {it['alias']}" if it["agg"] == "COUNT"
                                 else f"{dname}.{it['alias']} AS {it['alias']}")
        where = f"\n    WHERE {' AND '.join(common)}" if common else ""
        joins.append(
            f"LEFT JOIN (\n    SELECT {canon}.{icol} AS gc_key,\n           " + ",\n           ".join(exprs)
            + f"\n    FROM {table} {canon}{where}\n    GROUP BY {canon}.{icol}\n) {dname} ON {dname}.gc_key = {outer_alias}.{ocol}"
        )
        changes.append(Change(
            "correlated-subquery", f"De-correlated {len(g['items'])} subquer{'y' if len(g['items']) == 1 else 'ies'} on {table}",
            f"{len(g['items'])} correlated aggregate(s) re-scanned `{table}` once per outer row (O(N·M)). They are now computed "
            f"in a single GROUP BY pass (`{dname}`) and LEFT JOINed on `{ocol}`; COUNTs are COALESCEd to 0 to keep identical results.",
            0, [dname],
        ))

    edits = []
    offset = 0
    rebuilt_items = []
    for item, info in zip(items, parsed):
        if info and "replacement" in info:
            lead = item[: len(item) - len(item.lstrip())]
            trail = item[len(item.rstrip()):]
            rebuilt_items.append(lead + info["replacement"] + trail)
        else:
            rebuilt_items.append(item)
    del offset
    new_select = ",".join(rebuilt_items)
    edits.append((sel_start, from_start, new_select))
    from_body = stmt[from_start:from_end]
    trail = from_body[len(from_body.rstrip()):]
    edits.append((from_start, from_end, from_body.rstrip() + "\n" + "\n".join(joins) + (trail if trail.strip() == "" and trail else "\n")))
    return apply_edits(stmt, edits), changes


def refactor_sql(src: str, allow: Callable[[Change], bool]) -> tuple[str, list[Change]]:
    changes: list[Change] = []
    spans = split_sql(src)
    out, last = [], 0
    for s, e in spans:
        out.append(src[last:s])
        stmt = src[s:e]
        if sql_kind(stmt) == "query":
            new_stmt, ch = sql_rule_sargable(stmt)
            ch = [c for c in ch if allow(c)]
            if ch:
                for c in ch:
                    c.line = line_of(src, s) + c.line - 1
                stmt = new_stmt
                changes.extend(ch)
            new_stmt, ch = sql_rule_decorrelate(stmt)
            if ch and all(allow(c) for c in ch):
                for c in ch:
                    c.line = line_of(src, s)
                stmt = new_stmt
                changes.extend(ch)
        out.append(stmt)
        last = e
    out.append(src[last:])
    rewritten = "".join(out)

    plan = sql_index_plan(rewritten)
    if plan:
        spans = split_sql(rewritten)
        first_query = next((s for s, e in spans if sql_kind(rewritten[s:e]) == "query"), None)
        if first_query is not None:
            # Insert before the comment block that introduces the first query.
            ins = rewritten.rfind("\n", 0, first_query) + 1
            while True:
                prev = rewritten.rfind("\n", 0, max(ins - 1, 0)) + 1
                line = rewritten[prev:ins].strip()
                if ins > 0 and line.startswith("--"):
                    ins = prev
                    continue
                break
            block = "-- GreenCode: supporting indexes for filter/join columns\n" + "".join(f"{p['sql']};\n" for p in plan) + "\n"
            rewritten = rewritten[:ins] + block + rewritten[ins:]
            for p in plan:
                c = Change(
                    "missing-index", f"Index on {p['table']}({', '.join(p['columns'])})",
                    f"Added `{p['sql']}` so filters and joins on {p['table']}.{p['columns'][0]} seek a B-tree instead of scanning.",
                    line_of(src, p["pos"]), [f"idx_{p['table']}_{'_'.join(p['columns'])}"],
                )
                if allow(c):
                    changes.append(c)
    return rewritten, changes


def rule_engine_refactor(code: str, language: str, mode: str = "full") -> tuple[str, list[Change]]:
    """mode: full | conservative (no semantic rewrites) | strict (no semantic or hash-based rewrites)."""

    def allow(change: Change) -> bool:
        if mode == "conservative":
            return not change.semantic
        if mode == "strict":
            return not change.semantic and not change.hash_based
        return True

    if language == "python":
        return refactor_python(code, allow)
    if language == "javascript":
        return refactor_javascript(code, allow)
    return refactor_sql(code, allow)


# --------------------------------------------------------------------------------------
# Stage 3b - Groq LLaMA-3.3-70B refactorer
# --------------------------------------------------------------------------------------

LLM_SYSTEM_PROMPT = """You are the Refactorer agent inside GreenCode AI, a carbon-aware code optimizer.
Rewrite the user's program to minimise CPU time, memory, network round-trips and LLM tokens while preserving observable behaviour EXACTLY.

Hard rules:
1. Same language. Return a complete, runnable program - never a fragment, never placeholders or "..." ellipses.
2. Observable behaviour must be identical: same stdout lines in the same order (Python/JavaScript) or the same result rows in the same order (SQL). Keep every print/console.log and its exact formatting.
3. Lines printed with the "#METRIC" prefix are telemetry: keep them; their values may change.
4. Standard library only - no new third-party dependencies.
5. SQL: SQLite dialect. Keep every CREATE TABLE / INSERT seed statement unchanged and in place. You may add CREATE INDEX statements before the queries and rewrite the queries.
6. Keep random seeds and data generation unchanged.
7. LLM/API-call code: you may add caching and de-duplication, use batch methods only if they already exist in the code, and shorten prompts by removing duplicated text while keeping every instruction's meaning.
8. Prefer algorithmic wins (hash maps/sets instead of nested scans, single-pass aggregation, in-place accumulation) over micro-optimisations.

Respond with ONLY a JSON object:
{"optimized_code": "<full program>", "summary": "<one sentence>", "changes": [{"title": "<short>", "detail": "<what and why, with Big-O>", "line": <1-based line in optimized code>}]}"""


def groq_available() -> bool:
    return bool(GROQ_API_KEY)


def _groq_chat(messages: list[dict[str, str]]) -> tuple[str, dict[str, int]]:
    payload = dict(model=GROQ_MODEL, messages=messages, temperature=0.1, max_tokens=6000, response_format={"type": "json_object"})
    if Groq is not None:
        client = Groq(api_key=GROQ_API_KEY, timeout=60.0, max_retries=1)
        resp = client.chat.completions.create(**payload)
        usage = resp.usage
        return resp.choices[0].message.content or "", {
            "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
            "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
        }
    r = requests.post(GROQ_URL, json=payload, headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, timeout=60)
    r.raise_for_status()
    data = r.json()
    usage = data.get("usage", {})
    return data["choices"][0]["message"]["content"], {
        "prompt_tokens": usage.get("prompt_tokens", 0), "completion_tokens": usage.get("completion_tokens", 0),
    }


def groq_refactor(code: str, language: str, ranking: list[dict[str, Any]], history: list[dict[str, str]]) -> dict[str, Any]:
    if not history:
        bullet = "\n".join(
            f"- [{r['severity'].upper()}] line {r['line']}: {r['title']} ({r['complexity']}, {r['carbon_share_pct']}% of carbon impact) -> {r['action']}"
            for r in ranking[:12]
        ) or "- No static findings; look for any safe efficiency win."
        history.extend([
            {"role": "system", "content": LLM_SYSTEM_PROMPT},
            {"role": "user", "content": f"Language: {language}\n\nRanked bottlenecks from the Profiler/Strategist agents:\n{bullet}\n\nProgram:\n```{language}\n{code}\n```"},
        ])
    started = time.perf_counter()
    content, usage = _groq_chat(history)
    latency = (time.perf_counter() - started) * 1000
    history.append({"role": "assistant", "content": content})
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            raise RefactorError(f"LLM returned non-JSON output: {exc}") from exc
        data = json.loads(m.group(0))
    optimized = data.get("optimized_code") or ""
    fence = re.match(r"^\s*```[\w+-]*\n(.*)\n```\s*$", optimized, re.S)
    if fence:
        optimized = fence.group(1)
    if not optimized.strip():
        raise RefactorError("LLM returned an empty program")
    if not optimized.endswith("\n"):
        optimized += "\n"
    changes = [
        Change("llm", str(c.get("title", "LLM optimization"))[:120], str(c.get("detail", ""))[:600], int(c.get("line") or 0) if str(c.get("line") or "0").isdigit() else 0)
        for c in (data.get("changes") or []) if isinstance(c, dict)
    ]
    return {"code": optimized, "changes": changes, "summary": str(data.get("summary", "")), "usage": usage, "latency_ms": latency}


# --------------------------------------------------------------------------------------
# Stage 4 - Verifier: sandboxed differential execution
# --------------------------------------------------------------------------------------

RUN_TIMEOUT_S = 30
TIME_BUDGET_MS = 1500
MAX_REPS = 5

PY_HARNESS = r'''
import builtins, contextlib, io, json, sys, time, traceback, tracemalloc
budget_ms = float(sys.argv[1]); max_reps = int(sys.argv[2])
src = sys.stdin.read()
res = {"ok": True}
try:
    code = compile(src, "<greencode>", "exec")
    walls, cpus, first = [], [], None
    while len(walls) < max_reps:
        buf = io.StringIO()
        g = {"__name__": "__main__", "__builtins__": builtins}
        t0, c0 = time.perf_counter(), time.process_time()
        with contextlib.redirect_stdout(buf):
            exec(code, g)
        walls.append((time.perf_counter() - t0) * 1000); cpus.append((time.process_time() - c0) * 1000)
        if first is None:
            first = buf.getvalue()
        if sum(walls) >= budget_ms:
            break
    peak = None
    if walls[0] < 8000:
        tracemalloc.start()
        with contextlib.redirect_stdout(io.StringIO()):
            exec(code, {"__name__": "__main__", "__builtins__": builtins})
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
    res.update(stdout=first, walls=walls, cpus=cpus, peak_bytes=peak)
except BaseException as exc:
    res = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
           "traceback": traceback.format_exc(limit=4)[-1500:]}
sys.__stdout__.write("\n__GREENCODE_RESULT__" + json.dumps(res))
'''

JS_HARNESS = r'''
const util = require('util');
const { performance } = require('perf_hooks');
const budget = Number(process.argv[1]); const maxReps = Number(process.argv[2]);
let src = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (src += d));
process.stdin.on('end', async () => {
  const emit = (r) => process.stdout.write('\n__GREENCODE_RESULT__' + JSON.stringify(r));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction('console', 'require', 'module', 'exports', '__filename', '__dirname', src);
  } catch (e) { emit({ ok: false, error: 'SyntaxError: ' + e.message }); return; }
  const makeConsole = (sink) => {
    const w = (...a) => sink.push(util.format(...a));
    return { log: w, info: w, warn: w, error: w, debug: w, table: (x) => sink.push(util.inspect(x)) };
  };
  try {
    const walls = [], cpus = []; let first = null, heapBytes = null, rssBytes = null;
    while (walls.length < maxReps) {
      const sink = []; const m = { exports: {} };
      if (global.gc) global.gc();
      const heap0 = process.memoryUsage().heapUsed; const rss0 = process.resourceUsage().maxRSS;
      const t0 = performance.now(); const c0 = process.cpuUsage();
      await fn(makeConsole(sink), require, m, m.exports, '<greencode>', process.cwd());
      walls.push(performance.now() - t0);
      const c = process.cpuUsage(c0); cpus.push((c.user + c.system) / 1000);
      if (first === null) {
        first = sink.join('\n') + (sink.length ? '\n' : '');
        heapBytes = Math.max(0, process.memoryUsage().heapUsed - heap0);
        rssBytes = Math.max(0, (process.resourceUsage().maxRSS - rss0) * 1024);
      }
      if (walls.reduce((a, b) => a + b, 0) >= budget) break;
    }
    emit({ ok: true, stdout: first, walls, cpus, peak_bytes: Math.max(heapBytes, rssBytes), heap_bytes: heapBytes, rss_bytes: rssBytes });
  } catch (e) {
    emit({ ok: false, error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)), traceback: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
  }
});
'''

SQL_HARNESS = r'''
import json, re, resource, sqlite3, sys, time
data = json.loads(sys.stdin.read())
budget_ms, max_reps = data["budget_ms"], data["max_reps"]
res = {"ok": True}
def rss():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == "darwin" else r * 1024
try:
    con = sqlite3.connect(":memory:")
    results, plans, setup_ms, index_ms, query_walls = [], [], 0.0, 0.0, []
    rss_before = rss()
    first_total = 0.0
    for kind, stmt in data["statements"]:
        t0 = time.perf_counter()
        cur = con.execute(stmt)
        rows = cur.fetchall() if cur.description else None
        dt = (time.perf_counter() - t0) * 1000
        if kind == "query":
            first_total += dt
            results.append({"columns": [d[0] for d in cur.description or []], "rows": rows[:5000] if rows else [], "row_count": len(rows or [])})
            try:
                plans.append([r[3] for r in con.execute("EXPLAIN QUERY PLAN " + stmt).fetchall()])
            except Exception:
                plans.append([])
        elif kind == "index":
            index_ms += dt
        else:
            setup_ms += dt
    query_walls.append(first_total)
    queries = [s for k, s in data["statements"] if k == "query"]
    while queries and len(query_walls) < max_reps and sum(query_walls) < budget_ms:
        t0 = time.perf_counter()
        for q in queries:
            con.execute(q).fetchall()
        query_walls.append((time.perf_counter() - t0) * 1000)
    res.update(results=results, plans=plans, walls=query_walls, cpus=query_walls, setup_ms=setup_ms, index_ms=index_ms,
               peak_bytes=rss(), rss_delta_bytes=max(0, rss() - rss_before))
except Exception as exc:
    res = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
print("\n__GREENCODE_RESULT__" + json.dumps(res, default=str))
'''


def _limit_resources() -> None:  # pragma: no cover - runs in the child
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (RUN_TIMEOUT_S + 5, RUN_TIMEOUT_S + 5))
    except Exception:
        pass


def _exec(cmd: list[str], stdin: str, cwd: str) -> dict[str, Any]:
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONHASHSEED": "0", "LANG": "C.UTF-8", "HOME": cwd, "NODE_OPTIONS": ""}
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            cmd, input=stdin, capture_output=True, text=True, timeout=RUN_TIMEOUT_S, cwd=cwd, env=env,
            preexec_fn=_limit_resources if os.name == "posix" else None,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Timed out after {RUN_TIMEOUT_S}s", "process_ms": RUN_TIMEOUT_S * 1000}
    process_ms = (time.perf_counter() - started) * 1000
    marker = "__GREENCODE_RESULT__"
    if marker not in proc.stdout:
        err = (proc.stderr or proc.stdout or "no output").strip().splitlines()
        return {"ok": False, "error": err[-1][:400] if err else "Process crashed", "process_ms": process_ms}
    payload = json.loads(proc.stdout.rsplit(marker, 1)[1])
    payload["process_ms"] = process_ms
    return payload


def run_program(code: str, language: str) -> dict[str, Any]:
    """Execute code in an isolated subprocess and return timing, memory and output."""
    with tempfile.TemporaryDirectory(prefix="greencode-") as cwd:
        if language == "python":
            raw = _exec([sys.executable, "-I", "-c", PY_HARNESS, str(TIME_BUDGET_MS), str(MAX_REPS)], code, cwd)
            memory_label = "Python heap peak (tracemalloc)"
        elif language == "javascript":
            if not NODE_BIN:
                return {"ok": False, "error": "Node.js not found on PATH - JavaScript cannot be executed", "unavailable": True}
            raw = _exec([NODE_BIN, "--expose-gc", "-e", JS_HARNESS, str(TIME_BUDGET_MS), str(MAX_REPS)], code, cwd)
            memory_label = "V8 heap/RSS growth"
        else:
            stmts = [[sql_kind(code[s:e]), code[s:e]] for s, e in split_sql(code)]
            raw = _exec([sys.executable, "-I", "-c", SQL_HARNESS],
                        json.dumps({"statements": stmts, "budget_ms": TIME_BUDGET_MS, "max_reps": MAX_REPS}), cwd)
            memory_label = "Process peak RSS (SQLite)"
    if not raw.get("ok"):
        return raw
    walls = raw.get("walls") or [0.0]
    cpus = raw.get("cpus") or walls
    out = {
        "ok": True,
        "time_ms": round(statistics.median(walls), 3),
        "cpu_ms": round(statistics.median(cpus), 3),
        "reps": len(walls),
        "memory_mb": round((raw.get("peak_bytes") or 0) / 1_048_576, 3) if raw.get("peak_bytes") is not None else None,
        "memory_label": memory_label,
        "process_ms": raw.get("process_ms", 0),
    }
    if language == "sql":
        out.update(results=raw["results"], plans=raw["plans"], setup_ms=round(raw["setup_ms"], 2), index_ms=round(raw["index_ms"], 2))
        out["stdout_lines"] = [f"{len(r['rows'])} rows" for r in raw["results"]]
        out["metrics"] = {}
    else:
        lines = (raw.get("stdout") or "").splitlines()
        metrics: dict[str, float] = {}
        for ln in lines:
            if ln.startswith("#METRIC"):
                for k, v in re.findall(r"(\w+)=([-\d.]+)", ln):
                    try:
                        metrics[k] = float(v)
                    except ValueError:
                        pass
        out["stdout_lines"] = [ln.rstrip() for ln in lines if not ln.startswith("#METRIC")]
        out["metrics"] = metrics
    return out


def _norm_row(row: list[Any]) -> tuple:
    return tuple(round(v, 6) if isinstance(v, float) else v for v in row)


def compare_runs(orig: dict[str, Any], cand: dict[str, Any], language: str, original_code: str) -> dict[str, Any]:
    if language == "sql":
        a, b = orig["results"], cand["results"]
        if len(a) != len(b):
            return {"equivalent": False, "detail": f"Query count differs: {len(a)} vs {len(b)} result sets"}
        ordered = [bool(re.search(r"\bORDER\s+BY\b", sql_mask(code), re.I)) for code in
                   [original_code[s:e] for s, e in split_sql(original_code) if sql_kind(original_code[s:e]) == "query"]]
        total = 0
        for i, (ra, rb) in enumerate(zip(a, b)):
            rows_a = [_norm_row(r) for r in ra["rows"]]
            rows_b = [_norm_row(r) for r in rb["rows"]]
            if not (ordered[i] if i < len(ordered) else True):
                rows_a, rows_b = sorted(rows_a, key=repr), sorted(rows_b, key=repr)
            if ra["row_count"] != rb["row_count"] or rows_a != rows_b:
                diff_at = next((j for j, (x, y) in enumerate(zip(rows_a, rows_b)) if x != y), min(len(rows_a), len(rows_b)))
                return {"equivalent": False, "detail": f"Result set {i + 1} differs at row {diff_at + 1} "
                        f"({ra['row_count']} vs {rb['row_count']} rows)"}
            total += len(rows_a)
        return {"equivalent": True, "detail": f"{len(a)} result set(s), {total} rows identical (floats compared to 1e-6)"}
    la, lb = orig["stdout_lines"], cand["stdout_lines"]
    if la == lb:
        if not la:
            return {"equivalent": True, "detail": "Both programs ran cleanly but printed nothing - equivalence is weak", "weak": True}
        return {"equivalent": True, "detail": f"{len(la)} stdout line(s) byte-identical"}
    first = next((i for i, (x, y) in enumerate(zip(la, lb)) if x != y), min(len(la), len(lb)))
    exp = la[first] if first < len(la) else "<missing>"
    got = lb[first] if first < len(lb) else "<missing>"
    return {"equivalent": False, "detail": f"stdout differs at line {first + 1}: expected {exp!r}, got {got!r}"}


def syntax_ok(code: str, language: str) -> tuple[bool, str]:
    if language == "python":
        try:
            ast.parse(code)
            return True, ""
        except SyntaxError as exc:
            return False, f"SyntaxError line {exc.lineno}: {exc.msg}"
    if language == "javascript":
        if not NODE_BIN:
            return True, ""
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
            fh.write(code)
            path = fh.name
        try:
            proc = subprocess.run([NODE_BIN, "--check", path], capture_output=True, text=True, timeout=15)
            return proc.returncode == 0, (proc.stderr.strip().splitlines() or [""])[-1][:300]
        finally:
            os.unlink(path)
    con = sqlite3.connect(":memory:")
    for s, e in split_sql(code):
        stmt = code[s:e]
        if not sqlite3.complete_statement(stmt + ";"):
            return False, f"Incomplete SQL statement near line {line_of(code, s)}"
    con.close()
    return True, ""


def run_summary(run: dict[str, Any]) -> dict[str, Any]:
    keep = ("ok", "error", "time_ms", "cpu_ms", "reps", "memory_mb", "memory_label", "metrics", "setup_ms", "index_ms", "plans")
    summary = {k: run.get(k) for k in keep if k in run}
    summary["output_preview"] = (run.get("stdout_lines") or [])[:12]
    return summary


# --------------------------------------------------------------------------------------
# Stage 5 - Carbon Accountant (SCI) + Green Score
# --------------------------------------------------------------------------------------


def grid_price(ctx: Context) -> float:
    return GRID_PRESETS.get(ctx.grid_region, GRID_PRESETS["custom"])["usd_per_kwh"]


def sci_per_execution(m: dict[str, float], ctx: Context) -> dict[str, float]:
    hw = HARDWARE_PROFILES[ctx.hardware]
    t_s = max(m.get("time_ms", 0.0), 0.0) / 1000
    mem_gb = max(m.get("memory_mb", 0.0) or 0.0, 0.0) / 1024
    tokens = max(m.get("llm_tokens", 0.0) or 0.0, 0.0)
    e_cpu = hw["watts_per_core"] * t_s / 3.6e6
    e_mem = mem_gb * hw["mem_watts_per_gb"] * t_s / 3.6e6
    e_compute = (e_cpu + e_mem) * hw["pue"]
    e_llm = tokens * LLM_KWH_PER_TOKEN
    energy = e_compute + e_llm
    operational_g = energy * ctx.grid_intensity
    embodied_g = hw["embodied_kg"] * 1000 * (t_s / (hw["lifespan_years"] * SECONDS_PER_YEAR)) / hw["cores"]
    cost = (t_s / 3600) * hw["usd_per_core_hour"] + tokens * LLM_USD_PER_TOKEN
    if hw["self_hosted"]:
        cost += e_compute * grid_price(ctx)
    return {
        "energy_kwh": energy, "energy_compute_kwh": e_compute, "energy_llm_kwh": e_llm,
        "operational_g": operational_g, "embodied_g": embodied_g, "sci_g": operational_g + embodied_g, "cost_usd": cost,
    }


def green_score(findings: list[Finding], exponent: int, sci_g: float) -> dict[str, Any]:
    penalty = sum(SEVERITY_PENALTY[f.severity] for f in findings)
    penalty += 18 if exponent >= 3 else 10 if exponent == 2 else 0
    structural = max(0.0, min(100.0, 100.0 - penalty))
    per_million = max(sci_g * 1e6, 1.0)
    efficiency = max(0.0, min(100.0, 100.0 * (5 - math.log10(per_million)) / 5))
    score = round(0.6 * structural + 0.4 * efficiency, 1)
    grade = next(g for t, g in ((90, "A+"), (80, "A"), (70, "B"), (60, "C"), (50, "D"), (40, "E"), (-1, "F")) if score >= t)
    return {"score": score, "grade": grade, "structural": round(structural, 1), "efficiency": round(efficiency, 1), "penalty": penalty}


def carbon_report(measure: dict[str, Any], ctx: Context, pipeline: dict[str, Any], prof_o: dict[str, Any], prof_n: dict[str, Any]) -> dict[str, Any]:
    o = sci_per_execution(measure["original"], ctx)
    n = sci_per_execution(measure["optimized"], ctx)
    per_day = ctx.calls_per_day
    saved_g = o["sci_g"] - n["sci_g"]
    hw = HARDWARE_PROFILES[ctx.hardware]
    verify_kwh = hw["watts_per_core"] * (pipeline["compute_ms"] / 1000) / 3.6e6 * hw["pue"]
    ai_cost_g = AI_QUERY_G_CO2E * pipeline["llm_calls"] + verify_kwh * ctx.grid_intensity
    payback_execs = math.ceil(ai_cost_g / saved_g) if saved_g > 0 else None
    fx = USD_TO_INR if ctx.currency == "INR" else 1.0
    return {
        "context": ctx.model_dump(),
        "hardware": hw,
        "per_execution": {"original": o, "optimized": n},
        "savings": {
            "sci_g_per_exec": saved_g,
            "co2e_kg_per_day": saved_g * per_day / 1000,
            "co2e_kg_per_year": saved_g * per_day * 365 / 1000,
            "energy_kwh_per_year": (o["energy_kwh"] - n["energy_kwh"]) * per_day * 365,
            "money_per_year": (o["cost_usd"] - n["cost_usd"]) * per_day * 365 * fx,
            "currency": ctx.currency,
            "reduction_pct": (100 * saved_g / o["sci_g"]) if o["sci_g"] > 0 else 0.0,
        },
        "payback": {
            "ai_cost_g": ai_cost_g,
            "llm_calls": pipeline["llm_calls"],
            "verification_kwh": verify_kwh,
            "executions_to_neutral": payback_execs,
            "days_to_neutral": (payback_execs / per_day) if payback_execs else None,
        },
        "green_score": {
            "original": green_score(prof_o["findings"], prof_o["exponent"], o["sci_g"]),
            "optimized": green_score(prof_n["findings"], prof_n["exponent"], n["sci_g"]),
        },
        "formula": "SCI = ((E × I) + M) per R, E = (P_core·t + P_mem·GB·t)·PUE + tokens·e_token, M = TE·(t/TL)·(1/cores)",
    }


def estimate_measurements(prof: dict[str, Any], code: str) -> dict[str, float]:
    exp = prof["exponent"]
    base = {0: 2.0, 1: 25.0, 2: 400.0}.get(exp, 4000.0)
    remote = sum(1 for f in prof["findings"] if f.category == "network")
    high = sum(1 for f in prof["findings"] if f.severity == "high")
    time_ms = base * (1 + 0.35 * high) + remote * 300.0
    tokens = 0.0
    if any(f.rule in ("unbatched-remote", "bloated-prompt", "missing-cache") for f in prof["findings"]):
        tokens = 100 * max(200, len(code) // 8)
    return {"time_ms": round(time_ms, 2), "cpu_ms": round(time_ms, 2), "memory_mb": round(8 + 4 * exp + 2 * high, 2),
            "llm_calls": 100.0 if tokens else 0.0, "llm_tokens": tokens}


# --------------------------------------------------------------------------------------
# Annotations & pipeline orchestration
# --------------------------------------------------------------------------------------


def build_annotations(original: str, optimized: str, findings: list[Finding], changes: list[Change]) -> dict[str, list[dict[str, Any]]]:
    orig_ann = [
        {"line": f.line, "end_line": f.end_line, "severity": f.severity, "message": f"{f.id} · {f.title} - {f.detail}", "finding_id": f.id}
        for f in findings
    ]
    a, b = original.splitlines(), optimized.splitlines()
    opt_ann = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "insert") and j2 > j1:
            hunk = "\n".join(b[j1:j2])
            match = next((c for c in changes if any(mk and mk in hunk for mk in c.markers)), None)
            message = f"{match.title} - {match.detail}" if match else "Rewritten for efficiency by the Refactorer agent"
            opt_ann.append({"line": j1 + 1, "end_line": j2, "message": message, "kind": tag})
    return {"original": orig_ann, "optimized": opt_ann}


def _event(kind: str, **payload: Any) -> dict[str, Any]:
    return {"type": kind, "ts": time.time(), **payload}


def finding_dicts(findings: list[Finding]) -> list[dict[str, Any]]:
    return [asdict(f) for f in findings]


def run_pipeline(req: OptimizeRequest) -> Iterator[dict[str, Any]]:
    code = req.code if req.code.endswith("\n") else req.code + "\n"
    lang, ctx = req.language, req.context
    pipeline_started = time.perf_counter()
    timings: dict[str, float] = {}
    compute_ms = 0.0

    def log(stage: str, message: str, level: str = "info") -> dict[str, Any]:
        return _event("log", stage=stage, message=message, level=level)

    yield _event("start", language=lang, llm_configured=groq_available() and req.use_llm, model=GROQ_MODEL)

    # ---- Stage 1: Profiler -------------------------------------------------------
    t0 = time.perf_counter()
    yield _event("stage", stage="profiler", status="running")
    parser = {"python": "CPython ast module", "javascript": "lexical scanner + bracket tree", "sql": "statement splitter + clause scanner"}[lang]
    yield log("profiler", f"Parsing {len(code.splitlines())} lines of {lang} with the {parser}")
    prof = profile_code(code, lang)
    if not prof.get("ok", True):
        yield log("profiler", prof["error"], "error")
    for k, v in prof.get("stats", {}).items():
        yield log("profiler", f"{k.replace('_', ' ')}: {v}")
    yield log("profiler", f"Estimated asymptotic cost: {prof['complexity']}")
    for f in prof["findings"]:
        yield log("profiler", f"{f.id} line {f.line} [{f.severity}] {f.title} - {f.complexity}", "warn" if f.severity == "high" else "info")
    timings["profiler"] = (time.perf_counter() - t0) * 1000
    yield _event("stage", stage="profiler", status="done", elapsed_ms=timings["profiler"],
                 summary=f"{len(prof['findings'])} bottleneck(s), {prof['complexity']}",
                 data={"findings": finding_dicts(prof["findings"]), "complexity": prof["complexity"], "stats": prof.get("stats", {})})

    # ---- Stage 2: Strategist -----------------------------------------------------
    t0 = time.perf_counter()
    yield _event("stage", stage="strategist", status="running")
    ranking = strategize(prof["findings"])
    for r in ranking[:6]:
        yield log("strategist", f"#{r['rank']} {r['title']} (line {r['line']}) → {r['carbon_share_pct']}% of carbon impact, memory {r['memory_impact']}")
    if not ranking:
        yield log("strategist", "No bottlenecks ranked - code already looks efficient")
    timings["strategist"] = (time.perf_counter() - t0) * 1000
    yield _event("stage", stage="strategist", status="done", elapsed_ms=timings["strategist"],
                 summary=f"Top target: {ranking[0]['title']}" if ranking else "Nothing to optimize", data={"ranking": ranking})

    # ---- Stage 3: Refactorer -----------------------------------------------------
    t0 = time.perf_counter()
    yield _event("stage", stage="refactorer", status="running")
    usage = {"provider": "offline-rule-engine", "model": "GreenCode AST rules v1", "calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
    engine = "rules"
    fallback_reason = None
    llm_history: list[dict[str, str]] = []
    candidate, changes, summary = code, [], ""
    if req.use_llm and groq_available():
        yield log("refactorer", f"Calling Groq {GROQ_MODEL} with {len(ranking)} ranked bottleneck(s)")
        try:
            res = groq_refactor(code, lang, ranking, llm_history)
            usage.update(provider="groq", model=GROQ_MODEL, calls=1, prompt_tokens=res["usage"]["prompt_tokens"],
                         completion_tokens=res["usage"]["completion_tokens"])
            candidate, changes, summary = res["code"], res["changes"], res["summary"]
            engine = "llm"
            yield log("refactorer", f"LLM responded in {res['latency_ms']:.0f} ms · {usage['prompt_tokens']}+{usage['completion_tokens']} tokens")
        except Exception as exc:  # network, auth, rate-limit, malformed JSON
            fallback_reason = f"Groq call failed ({type(exc).__name__}: {str(exc)[:160]})"
            yield log("refactorer", fallback_reason + " - falling back to offline rule engine", "warn")
    elif req.use_llm and not groq_available():
        fallback_reason = "GROQ_API_KEY not configured"
        yield log("refactorer", "GROQ_API_KEY not set - using the offline deterministic AST rule engine", "warn")
    else:
        fallback_reason = "LLM disabled by user"
        yield log("refactorer", "LLM disabled - using the offline deterministic AST rule engine")
    rule_mode = "full"
    if engine == "rules":
        candidate, changes = rule_engine_refactor(code, lang, rule_mode)
        summary = f"Applied {len(changes)} deterministic rewrite(s)" if changes else "No safe automatic rewrite matched"
    for c in changes:
        yield log("refactorer", f"✓ {c.title}")
    if engine == "rules" and not changes:
        yield log("refactorer", "No rule matched - original code is kept", "warn")
    timings["refactorer"] = (time.perf_counter() - t0) * 1000
    yield _event("stage", stage="refactorer", status="done", elapsed_ms=timings["refactorer"],
                 summary=f"{len(changes)} change(s) via {'Groq ' + GROQ_MODEL if engine == 'llm' else 'offline rule engine'}",
                 data={"engine": engine, "changes": [asdict(c) for c in changes], "optimized_code": candidate})

    # ---- Stage 4: Verifier -------------------------------------------------------
    t0 = time.perf_counter()
    yield _event("stage", stage="verifier", status="running")
    attempts: list[dict[str, Any]] = []
    yield log("verifier", f"Executing original program in sandboxed {lang} subprocess")
    orig_run = run_program(code, lang)
    compute_ms += orig_run.get("process_ms", 0)
    verified, verification_status, equivalence = False, "estimated", {"equivalent": None, "detail": ""}
    cand_run: dict[str, Any] = {}
    if orig_run.get("ok") and lang != "sql" and not orig_run.get("stdout_lines"):
        yield log("verifier", "Original ran but printed nothing (e.g. only defines functions) - there is no observable output "
                              "to diff. Add a driver that prints results for a measured test. Using static estimates.", "warn")
        orig_run = {"ok": False, "error": "no observable output", "silent": True}
    if orig_run.get("ok"):
        yield log("verifier", f"Original: {orig_run['time_ms']:.2f} ms median of {orig_run['reps']} run(s), "
                              f"memory {orig_run['memory_mb']} MB")
    elif not orig_run.get("silent"):
        yield log("verifier", f"Original is not executable stand-alone ({orig_run.get('error')}) - switching to static estimates", "warn")

    def try_candidate(cand: str, label: str) -> Iterator[dict[str, Any]]:
        nonlocal compute_ms
        ok, msg = syntax_ok(cand, lang)
        if not ok:
            attempts.append({"label": label, "passed": False, "detail": f"Rewrite failed syntax check: {msg}"})
            yield log("verifier", f"{label}: syntax check failed - {msg}", "error")
            return
        if not orig_run.get("ok"):
            attempts.append({"label": label, "passed": None, "detail": "Syntax valid; differential test skipped (original not executable)"})
            yield log("verifier", f"{label}: syntax valid - differential test skipped")
            return
        yield log("verifier", f"{label}: executing rewritten program")
        run = run_program(cand, lang)
        compute_ms += run.get("process_ms", 0)
        if not run.get("ok"):
            attempts.append({"label": label, "passed": False, "detail": f"Rewrite crashed: {run.get('error')}"})
            yield log("verifier", f"{label}: rewrite crashed - {run.get('error')}", "error")
            return
        cmp = compare_runs(orig_run, run, lang, code)
        attempts.append({"label": label, "passed": cmp["equivalent"], "detail": cmp["detail"], "run": run})
        yield log("verifier", f"{label}: {'PASS' if cmp['equivalent'] else 'FAIL'} - {cmp['detail']} · "
                              f"{run['time_ms']:.2f} ms", "info" if cmp["equivalent"] else "error")

    def last_passed() -> bool:
        return bool(attempts) and attempts[-1]["passed"] is not False

    if candidate == code:
        yield log("verifier", "No rewrite to verify - optimized code equals original")
        attempts.append({"label": "Attempt 1", "passed": True if orig_run.get("ok") else None, "detail": "Unchanged code", "run": orig_run})
    else:
        yield from try_candidate(candidate, "Attempt 1")
        if not last_passed():
            # ---- single retry --------------------------------------------------
            if engine == "llm":
                yield log("verifier", "Retry 1/1: sending the failure report back to the Refactorer (Groq)", "warn")
                try:
                    feedback = (f"Verification FAILED: {attempts[-1]['detail']}. Fix the program so its observable output is identical "
                                "to the original. Return the full corrected program in the same JSON format.")
                    llm_history.append({"role": "user", "content": feedback})
                    res = groq_refactor(code, lang, ranking, llm_history)
                    usage["calls"] += 1
                    usage["prompt_tokens"] += res["usage"]["prompt_tokens"]
                    usage["completion_tokens"] += res["usage"]["completion_tokens"]
                    candidate, changes = res["code"], res["changes"]
                    yield from try_candidate(candidate, "Retry")
                except Exception as exc:
                    attempts.append({"label": "Retry", "passed": False, "detail": f"Groq retry failed: {exc}"})
                    yield log("verifier", f"Groq retry failed: {exc}", "error")
                if not last_passed():
                    fallback_reason = "LLM rewrite failed verification twice"
                    yield log("verifier", "LLM rewrite rejected - falling back to the offline rule engine", "warn")
                    engine = "rules"
                    candidate, changes = rule_engine_refactor(code, lang, "full")
                    if candidate != code:
                        yield from try_candidate(candidate, "Rule-engine fallback")
            else:
                had_semantic = any(c.semantic for c in changes)
                rule_mode = "conservative" if had_semantic else "strict"
                yield log("verifier", f"Retry 1/1: re-running the rule engine in {rule_mode} mode "
                                      f"({'no semantic rewrites' if had_semantic else 'no hash-based rewrites'})", "warn")
                candidate, changes = rule_engine_refactor(code, lang, rule_mode)
                if candidate != code:
                    yield from try_candidate(candidate, "Retry")
                else:
                    attempts.append({"label": "Retry", "passed": False, "detail": f"No rules applicable in {rule_mode} mode"})
        if not last_passed():
            yield log("verifier", "All candidates rejected - keeping the original code (safety first)", "error")
            candidate, changes = code, []

    final = attempts[-1] if attempts else {"passed": None}
    if final.get("passed") is True and orig_run.get("ok"):
        verified, verification_status = True, "passed"
        cand_run = final.get("run") or orig_run
        equivalence = {"equivalent": True, "detail": final["detail"]}
    elif final.get("passed") is False or (candidate == code and attempts and attempts[-1]["passed"] is False):
        verification_status = "failed"
        cand_run = orig_run if orig_run.get("ok") else {}
        equivalence = {"equivalent": False, "detail": final.get("detail", "")}
    else:
        verification_status = "estimated"
        equivalence = {"equivalent": None, "detail": final.get("detail", "Differential test not possible")}
    if candidate == code and orig_run.get("ok"):
        cand_run = orig_run
        verification_status = "passed" if verification_status != "failed" else "failed"
        if verification_status == "failed":
            verified = False
    timings["verifier"] = (time.perf_counter() - t0) * 1000
    yield _event("stage", stage="verifier", status="done" if verification_status != "failed" else "warning",
                 elapsed_ms=timings["verifier"],
                 summary={"passed": "Outputs identical", "failed": "Rewrite rejected - original kept",
                          "estimated": "Static check only (not executable)"}[verification_status],
                 data={"status": verification_status, "attempts": [{k: v for k, v in a.items() if k != "run"} for a in attempts]})

    # ---- Stage 5: Carbon Accountant ---------------------------------------------
    t0 = time.perf_counter()
    yield _event("stage", stage="accountant", status="running")
    prof_new = profile_code(candidate, lang)
    measured = bool(orig_run.get("ok") and cand_run.get("ok"))
    if measured:
        def pick(run: dict[str, Any]) -> dict[str, float]:
            return {
                "time_ms": run["time_ms"], "cpu_ms": run["cpu_ms"], "memory_mb": run.get("memory_mb") or 0.0,
                "llm_calls": run["metrics"].get("llm_calls", 0.0), "llm_tokens": run["metrics"].get("llm_tokens", 0.0),
            }
        mo, mn = pick(orig_run), pick(cand_run)
        has_tokens = "llm_tokens" in orig_run["metrics"] or "llm_tokens" in cand_run["metrics"]
        basis = {"time": "measured", "memory": "measured" if orig_run.get("memory_mb") is not None else "estimated",
                 "tokens": "measured" if has_tokens else "estimated", "carbon": "measured"}
        if not has_tokens:
            est_o, est_n = estimate_measurements(prof, code), estimate_measurements(prof_new, candidate)
            if est_o["llm_tokens"]:
                mo["llm_tokens"], mo["llm_calls"] = est_o["llm_tokens"], est_o["llm_calls"]
                mn["llm_tokens"], mn["llm_calls"] = est_n["llm_tokens"], est_n["llm_calls"]
            else:
                basis["tokens"] = "measured"
    else:
        mo, mn = estimate_measurements(prof, code), estimate_measurements(prof_new, candidate)
        mn["time_ms"] = min(mn["time_ms"], mo["time_ms"])
        mn["memory_mb"] = min(mn["memory_mb"], mo["memory_mb"])
        basis = {"time": "estimated", "memory": "estimated", "tokens": "estimated", "carbon": "estimated"}
    measurements = {
        "original": mo, "optimized": mn, "basis": basis,
        "memory_label": (orig_run.get("memory_label") if measured else "Static estimate"),
        "speedup": (mo["time_ms"] / mn["time_ms"]) if mn["time_ms"] > 0 else None,
        "sql": {"original_plan": orig_run.get("plans"), "optimized_plan": cand_run.get("plans"),
                "index_build_ms": cand_run.get("index_ms")} if lang == "sql" else None,
    }
    pipeline_info = {"compute_ms": compute_ms, "llm_calls": usage["calls"]}
    carbon = carbon_report(measurements, ctx, pipeline_info, prof, prof_new)
    s = carbon["savings"]
    yield log("accountant", f"Grid {ctx.grid_intensity:.0f} gCO₂e/kWh · {carbon['hardware']['label']} · {ctx.calls_per_day:,} executions/day")
    yield log("accountant", f"SCI per execution: {carbon['per_execution']['original']['sci_g']:.6f} g → {carbon['per_execution']['optimized']['sci_g']:.6f} g")
    yield log("accountant", f"Annual savings: {s['co2e_kg_per_year']:.2f} kg CO₂e · {s['energy_kwh_per_year']:.2f} kWh")
    gs = carbon["green_score"]
    yield log("accountant", f"Green Score {gs['original']['grade']} ({gs['original']['score']}) → {gs['optimized']['grade']} ({gs['optimized']['score']})")
    timings["accountant"] = (time.perf_counter() - t0) * 1000
    yield _event("stage", stage="accountant", status="done", elapsed_ms=timings["accountant"],
                 summary=f"{s['reduction_pct']:.1f}% less carbon per execution", data={"carbon": carbon})

    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    usage["pipeline_compute_ms"] = compute_ms
    result = {
        "language": lang,
        "original_code": code,
        "optimized_code": candidate,
        "summary": summary,
        "engine": {"type": engine, "provider": usage["provider"], "model": usage["model"], "fallback_reason": fallback_reason, "rule_mode": rule_mode},
        "profile": {
            "original": {"findings": finding_dicts(prof["findings"]), "complexity": prof["complexity"], "exponent": prof["exponent"], "stats": prof.get("stats", {})},
            "optimized": {"findings": finding_dicts(prof_new["findings"]), "complexity": prof_new["complexity"], "exponent": prof_new["exponent"], "stats": prof_new.get("stats", {})},
        },
        "ranking": ranking,
        "changes": [asdict(c) for c in changes],
        "annotations": build_annotations(code, candidate, prof["findings"], changes),
        "verification": {
            "status": verification_status, "verified": verified, "equivalence": equivalence,
            "attempts": [{k: v for k, v in a.items() if k != "run"} for a in attempts],
            "original": run_summary(orig_run), "optimized": run_summary(cand_run) if cand_run else None,
        },
        "measurements": measurements,
        "refactor_usage": usage,
        "carbon": carbon,
        "timings": {**timings, "total": (time.perf_counter() - pipeline_started) * 1000},
    }
    yield _event("result", result=result)


# --------------------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------------------

app = FastAPI(title="GreenCode AI", version=APP_VERSION, description="Carbon-aware code optimization agent pipeline")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _node_version() -> Optional[str]:
    if not NODE_BIN:
        return None
    try:
        return subprocess.run([NODE_BIN, "--version"], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return None


NODE_VERSION = _node_version()


@app.get("/api/ping")
def ping() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "greencode-ai",
        "version": APP_VERSION,
        "llm": {"provider": "groq", "configured": groq_available(), "model": GROQ_MODEL, "transport": "sdk" if Groq else "rest"},
        "runtimes": {"python": sys.version.split()[0], "node": NODE_VERSION, "sqlite": sqlite3.sqlite_version},
        "profiles": {"hardware": HARDWARE_PROFILES, "grids": GRID_PRESETS},
    }


@app.post("/api/optimize")
def optimize(req: OptimizeRequest) -> dict[str, Any]:
    """Run the whole pipeline and return the final result (non-streaming)."""
    events = list(run_pipeline(req))
    result = next(e["result"] for e in events if e["type"] == "result")
    result["events"] = [e for e in events if e["type"] in ("stage", "log")]
    return result


@app.post("/api/optimize/stream")
def optimize_stream(req: OptimizeRequest) -> StreamingResponse:
    """Server-Sent Events stream of the live 5-stage agent pipeline."""

    def gen() -> Iterator[str]:
        try:
            for event in run_pipeline(req):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except Exception as exc:  # surface unexpected failures to the UI instead of a dead stream
            yield f"data: {json.dumps(_event('error', message=f'{type(exc).__name__}: {exc}'))}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/verify")
def verify(req: VerifyRequest) -> dict[str, Any]:
    """Differential execution test of two versions (used after manual edits)."""
    ok, msg = syntax_ok(req.optimized, req.language)
    if not ok:
        return {"status": "failed", "equivalent": False, "detail": f"Syntax error: {msg}", "original": None, "optimized": None}
    orig = run_program(req.original, req.language)
    if not orig.get("ok"):
        return {"status": "estimated", "equivalent": None, "detail": f"Original not executable: {orig.get('error')}",
                "original": run_summary(orig), "optimized": None}
    cand = run_program(req.optimized, req.language)
    if not cand.get("ok"):
        return {"status": "failed", "equivalent": False, "detail": f"Optimized version crashed: {cand.get('error')}",
                "original": run_summary(orig), "optimized": run_summary(cand)}
    cmp = compare_runs(orig, cand, req.language, req.original)
    return {
        "status": "passed" if cmp["equivalent"] else "failed",
        "equivalent": cmp["equivalent"],
        "detail": cmp["detail"],
        "original": run_summary(orig),
        "optimized": run_summary(cand),
        "speedup": orig["time_ms"] / cand["time_ms"] if cand["time_ms"] > 0 else None,
        "measurements": {
            side: {"time_ms": r["time_ms"], "cpu_ms": r["cpu_ms"], "memory_mb": r.get("memory_mb") or 0.0,
                   "llm_calls": r["metrics"].get("llm_calls", 0.0), "llm_tokens": r["metrics"].get("llm_tokens", 0.0)}
            for side, r in (("original", orig), ("optimized", cand))
        },
    }


@app.post("/api/analyze")
def analyze(req: OptimizeRequest) -> dict[str, Any]:
    """Profiler + Strategist only (fast, no execution) - handy for editor-as-you-type hints."""
    prof = profile_code(req.code, req.language)
    return {"findings": finding_dicts(prof["findings"]), "complexity": prof["complexity"],
            "stats": prof.get("stats", {}), "ranking": strategize(prof["findings"])}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "5000")), reload=False)
