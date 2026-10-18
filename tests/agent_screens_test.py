#!/usr/bin/env python3
"""Feeds screens captured from Codex and Cursor (tests/screens) to server.py's status and last-line parser.

Each file is `<agent>_<state>.txt`, captured with `tmux capture-pane -p` from a real run.

Usage: python3 tests/agent_screens_test.py
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import server  # noqa: E402

# file -> (status, last line shown in the list)
EXPECTED = {
    "codex_working": ("working", "Working (3s • esc to interrupt)"),
    "codex_approval": ("needs_you", "Running curl -sI https://example.com | head -1"),
    "codex_question": ("needs_you", "Tmux keeps my windows glowing through the night. I step from pane to pane, and every task stays bright."),
    "codex_idle": ("idle", "Tmux keeps my windows glowing through the night. I step from pane to pane, and every task stays bright."),
    "cursor_working": ("working", "⠠⠜ Running  39 tokens"),
    "cursor_approval": ("needs_you", "Skip & tell the agent what to do instead (esc or n)"),
    "cursor_question": ("needs_you", "│ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip                     │"),
    "cursor_idle": ("idle", "access to get the true response.)"),
}

failures = 0
for name, want in EXPECTED.items():
    agent = name.rsplit("_", 1)[0]
    lines = (HERE / "screens" / f"{name}.txt").read_text().rstrip().splitlines()
    got = (server.status(lines, agent), server.last_line(lines, agent))
    ok = got == want
    failures += not ok
    print(f"{'✓' if ok else '✗'} {name}: {got[0]} | {got[1]}" + ("" if ok else f"\n    want {want[0]} | {want[1]}"))
sys.exit(1 if failures else 0)
