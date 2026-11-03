#!/usr/bin/env -S python3 -I -B
"""Measures one agent's transcript.

    ./metrics.py <transcript.jsonl> [<sandbox-dir>]      prints JSON

A transcript is a Claude Code (sub)agent .jsonl: one event per line. Assistant events carry
message.id, message.model, message.usage and message.content (tool_use blocks {id, name, input});
user events carry tool_result blocks {tool_use_id, content}. One API message is streamed as several
events, each repeating the same usage: every message id is counted once (its largest usage).

Output:
  model, turns (distinct assistant message ids),
  tokens {input, cache_creation, cache_read, output, total},
  peak_context / final_context (input + cache_creation + cache_read of a turn: the max, the last),
  tool_calls {name: count}, tool_calls_total, tool_errors,
  wall_seconds (first to last timestamp),
  doc_reads [{tool_use_id, tool, target, path, chars, shared}], doc_chars_total {target: chars},
  doc_reads_total {target: count},
  outside_sandbox [{tool_use_id, tool, path, category}] (only with a sandbox dir),
  violations (outside_sandbox entries whose category is a protocol violation).

doc_reads: a tool call that reads the installed package (node_modules/hopgraph), classified by
target: README.md, DESIGN.md, docs/guide.md, skills (any file under skills/), dist d.ts (a .d.ts, or a
search over dist/), src, other node_modules/hopgraph (package.json, LICENSE, dist .js, a listing of
the package root). Detected from Read file_path, Grep/Glob path (and glob), and Bash commands that
mention node_modules/hopgraph (cat, sed, head, tail, less, grep, rg, find, ls, awk, wc, ...).
`chars` is the length of the tool result the model got back (Read's includes its line-number
prefixes). A Bash call that touches several targets splits its chars evenly among them
(`shared: true`), so doc_chars_total adds up to what the model read.

outside_sandbox: every path a tool call names (Read/Write/Edit/NotebookEdit file_path, Grep/Glob
path, absolute paths and ../ escapes in Bash commands, `cd` targets) that resolves outside the
sandbox. Categories: repo (the hopgraph repo), tasks (the harness's tasks: hidden tests, reference),
other-run (another run's directory: any sibling of the sandbox, runs/, validation/), harness (anything else under the harness dir), home (~),
system (/usr, /bin, /opt, /Library, /System, /etc, /var, /private/var: binaries and caches), tmp,
network (WebFetch/WebSearch, and Bash commands with curl, wget, a URL, npm view/info, npx -y, git
clone/fetch/pull), install (npm/pnpm/yarn/bun install, ci, add, update), other. Violations: repo,
tasks, other-run, harness, network, install, and home except ~/.npm (npm's cache). /dev/null and
friends are ignored.
"""
import json
import os
import re
import shlex
import sys
from collections import Counter, OrderedDict

HARNESS = os.path.dirname(os.path.abspath(__file__))
# the hopgraph repo this harness lives in (bench/skill-eval), unless REPO says otherwise
REPO = os.environ.get("REPO") or os.path.dirname(os.path.dirname(HARNESS))
HOME = os.path.expanduser("~")
PKG = "node_modules/hopgraph"
VIOLATIONS = {"repo", "tasks", "other-run", "harness", "network", "install", "home"}
NETWORK_CMD = re.compile(r"\b(curl|wget|nc|ssh|scp)\s|https?://|\bnpm\s+(view|info|show|search|pack\s+\S*@)|\bnpx\s+(-y|--yes)\b|\bgit\s+(clone|fetch|pull)\b")
INSTALL_CMD = re.compile(r"\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|upgrade|up)\b")


def norm(p):
    """Absolute, normalized, with macOS's /private/tmp and /tmp made one."""
    p = os.path.normpath(p)
    for pre in ("/private/tmp", "/private/var"):
        if p == pre or p.startswith(pre + "/"):
            p = p[len("/private"):]
    return p


def under(p, root):
    return p == root or p.startswith(root.rstrip("/") + "/")


def result_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    out = []
    for b in content:
        if isinstance(b, dict):
            if b.get("type") == "text":
                out.append(b.get("text", ""))
            elif b.get("type") == "image":
                out.append("")
            else:
                out.append(json.dumps(b))
    return "".join(out)


# ---------------------------------------------------------------- doc targets

def classify(sub):
    """`sub` is a path inside the package (no leading slash), '' for its root."""
    sub = sub.strip("/")
    if sub in ("", "."):
        return "other node_modules/hopgraph"
    if sub == "README.md":
        return "README.md"
    if sub == "DESIGN.md":
        return "DESIGN.md"
    if sub.startswith("docs/guide.md") or sub == "docs" or sub.startswith("docs/"):
        return "docs/guide.md"
    if sub == "skills" or sub.startswith("skills/"):
        return "skills"
    if sub.endswith(".d.ts") or sub.endswith(".d.ts.map") or sub in ("dist", "dist/") or (
        sub.startswith("dist/") and not re.search(r"\.(js|map)$", sub)
    ):
        return "dist d.ts"
    if sub == "src" or sub.startswith("src/"):
        return "src"
    return "other node_modules/hopgraph"


PKG_PATH = re.compile(r"(?:^|[\s'\"=(/])(?:[^\s'\"|;&()]*?/)?node_modules/hopgraph(/[^\s'\"|;&()<>]*)?")
REL_FILE = re.compile(
    r"(?<![\w/.-])((?:README|DESIGN)\.md|docs/[\w./-]+|skills/[\w./-]*|dist/[\w./-]*|src/[\w./-]*|package\.json|"
    r"[\w.-]+\.d\.ts)"
)


def doc_targets(tool, inp):
    """[(target, package-relative path)] a tool call reads in the package."""
    found = []
    if tool in ("Read", "NotebookRead"):
        p = inp.get("file_path") or ""
        i = p.find(PKG)
        if i >= 0:
            found.append(p[i + len(PKG):])
    elif tool in ("Grep", "Glob"):
        p = inp.get("path") or ""
        g = inp.get("glob") or inp.get("pattern", "") if tool == "Glob" else inp.get("glob") or ""
        for cand in (p, g):
            i = cand.find(PKG)
            if i >= 0:
                found.append(cand[i + len(PKG):])
    elif tool == "Bash":
        cmd = inp.get("command") or ""
        if PKG not in cmd:
            return []
        for m in PKG_PATH.finditer(cmd):
            found.append(m.group(1) or "")
        # `cd node_modules/hopgraph && cat README.md`: package-relative names after the cd
        if re.search(r"\bcd\s+\S*node_modules/hopgraph/?(\s|&|;|$)", cmd):
            tail = cmd[re.search(r"\bcd\s+\S*node_modules/hopgraph", cmd).end():]
            for m in REL_FILE.finditer(tail):
                found.append(m.group(1))
        # a listing or search of the package root alone says little; keep it only when nothing
        # more specific was named
        specific = [f for f in found if f.strip("/")]
        if specific:
            found = specific
    targets = OrderedDict()
    for sub in found:
        targets.setdefault(classify(sub), sub.strip("/") or ".")
    return list(targets.items())


# ---------------------------------------------------------------- paths outside the sandbox

ABS_PATH = re.compile(r"(?:(?<=[\s'\"=:(>])|^)(~?/[^\s'\"|;&()<>]*)")
REL_ESCAPE = re.compile(r"(?:(?<=[\s'\"=:(>])|^)(\.\.(?:/[^\s'\"|;&()<>]*)?)")


def categorize(p, sandbox):
    p = norm(p)
    if p in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty") or p.startswith("/dev/fd/"):
        return None
    if under(p, sandbox):
        return None
    if under(p, norm(REPO)):
        return "repo"
    h = norm(HARNESS)
    if under(p, h + "/tasks"):
        return "tasks"
    if under(p, h + "/runs") or under(p, h + "/validation") or under(p, os.path.dirname(sandbox)):
        return "other-run"
    if under(p, h):
        return "harness"
    if "/.claude/projects/" in p and "/tool-results/" in p:
        return None  # the harness saved a long tool output there; reading it back is not leaving the sandbox
    if under(p, HOME + "/.npm"):
        return "npm-cache"
    if under(p, HOME):
        return "home"
    if p == "/tmp" or p.startswith("/tmp/"):
        return "tmp"
    for sysroot in ("/usr", "/bin", "/sbin", "/opt", "/Library", "/System", "/etc", "/var", "/Applications", "/nix"):
        if under(p, sysroot):
            return "system"
    return "other"


def paths_of(tool, inp, sandbox):
    """Absolute paths a tool call names, relative ones resolved against the sandbox."""
    out = []
    if tool in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"):
        for k in ("file_path", "notebook_path"):
            if inp.get(k):
                out.append(inp[k])
    elif tool in ("Grep", "Glob"):
        if inp.get("path"):
            out.append(inp["path"])
    elif tool == "Bash":
        cmd = inp.get("command") or ""
        # a heredoc's body is content (code, tests), not paths the command touches
        cmd = re.sub(r"<<-?\s*(['\"]?)(\w+)\1.*?\n\2\b", "", cmd, flags=re.S)
        for m in ABS_PATH.finditer(cmd):
            out.append(m.group(1))
        for m in REL_ESCAPE.finditer(cmd):
            out.append(m.group(1))
    res = []
    for p in out:
        # `//` comments and bare slashes in heredoc'd code are not paths
        if p.startswith("//") or not p.strip("/~"):
            continue
        if p.startswith("~"):
            p = HOME + p[1:]
        if not p.startswith("/"):
            p = os.path.join(sandbox, p)
        # strip glob tails: /a/b/**/*.ts -> /a/b
        p = re.split(r"[*?\[{]", p)[0]
        if not p.strip("/"):
            continue
        res.append(norm(p))
    return res


# ---------------------------------------------------------------- the transcript

def measure(path, sandbox=None):
    sandbox = norm(os.path.abspath(sandbox)) if sandbox else None
    usage_by_id = OrderedDict()
    model = Counter()
    tool_uses = OrderedDict()  # id -> (name, input)
    results = {}  # tool_use_id -> (text, is_error)
    stamps = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("timestamp") and e.get("type") in ("user", "assistant"):
                stamps.append(e["timestamp"])
            if e.get("type") == "assistant":
                m = e.get("message") or {}
                mid = m.get("id") or e.get("uuid")
                u = m.get("usage") or {}
                prev = usage_by_id.get(mid)
                if prev is None or (u.get("output_tokens") or 0) >= (prev.get("output_tokens") or 0):
                    usage_by_id[mid] = u
                if m.get("model") and m.get("model") != "<synthetic>":
                    model[m["model"]] += 1
                for b in m.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        tool_uses.setdefault(b["id"], (b.get("name"), b.get("input") or {}))
            elif e.get("type") == "user":
                c = (e.get("message") or {}).get("content")
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            results[b.get("tool_use_id")] = (result_text(b.get("content")), bool(b.get("is_error")))

    tok = Counter()
    contexts = []
    for u in usage_by_id.values():
        i, cc, cr, o = (u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        tok["input"] += i
        tok["cache_creation"] += cc
        tok["cache_read"] += cr
        tok["output"] += o
        contexts.append(i + cc + cr)
    tokens = {k: tok[k] for k in ("input", "cache_creation", "cache_read", "output")}
    tokens["total"] = sum(tokens.values())

    calls = Counter(name for name, _ in tool_uses.values())
    errors = sum(1 for tid in tool_uses if results.get(tid, ("", False))[1])

    doc_reads = []
    doc_chars = Counter()
    doc_count = Counter()
    for tid, (name, inp) in tool_uses.items():
        targets = doc_targets(name, inp)
        if not targets:
            continue
        text = results.get(tid, ("", False))[0]
        share = len(text) / len(targets)
        for target, sub in targets:
            doc_reads.append({"tool_use_id": tid, "tool": name, "target": target, "path": sub,
                              "chars": round(share), "shared": len(targets) > 1})
            doc_chars[target] += share
            doc_count[target] += 1

    outside = []
    if sandbox:
        for tid, (name, inp) in tool_uses.items():
            if name in ("WebFetch", "WebSearch"):
                outside.append({"tool_use_id": tid, "tool": name, "path": inp.get("url") or inp.get("query"), "category": "network"})
                continue
            if name == "Bash":
                cmd = inp.get("command") or ""
                if NETWORK_CMD.search(cmd):
                    outside.append({"tool_use_id": tid, "tool": name, "path": cmd[:200], "category": "network"})
                if INSTALL_CMD.search(cmd):
                    outside.append({"tool_use_id": tid, "tool": name, "path": cmd[:200], "category": "install"})
            seen = set()
            for p in paths_of(name, inp, sandbox):
                cat = categorize(p, sandbox)
                if cat and p not in seen:
                    seen.add(p)
                    outside.append({"tool_use_id": tid, "tool": name, "path": p, "category": cat})

    wall = 0.0
    if stamps:
        from datetime import datetime
        ts = sorted(datetime.fromisoformat(s.replace("Z", "+00:00")) for s in stamps)
        wall = (ts[-1] - ts[0]).total_seconds()

    return {
        "transcript": os.path.abspath(path),
        "model": model.most_common(1)[0][0] if model else None,
        "turns": len(usage_by_id),
        "tokens": tokens,
        "peak_context": max(contexts) if contexts else 0,
        "final_context": contexts[-1] if contexts else 0,
        "tool_calls": dict(calls.most_common()),
        "tool_calls_total": sum(calls.values()),
        "tool_errors": errors,
        "wall_seconds": round(wall, 1),
        "doc_reads": doc_reads,
        "doc_chars_total": {k: round(v) for k, v in doc_chars.most_common()},
        "doc_reads_total": dict(doc_count.most_common()),
        "outside_sandbox": outside,
        "violations": [o for o in outside if o["category"] in VIOLATIONS],
    }


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    print(json.dumps(measure(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None), indent=2))
