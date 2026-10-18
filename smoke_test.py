#!/usr/bin/env python3
"""Checks the live install the way the phone uses it, through the tailnet URL.

Each check asserts what you would see, not a step on the way: your panes in the list, the
screen you're looking at on the terminal stream, the right words from dictation.

It only reads. It never creates, switches, types into or resizes anything in your tmux, so
opening, sending, photos and scrolling are not covered here.

Usage: ./smoke_test.py https://<this-mac>.<tailnet>.ts.net
"""
import base64
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

ORIGIN = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else sys.exit(__doc__)
HOST = urlparse(ORIGIN).hostname
# Escape sequences tmux draws with; stripped so the stream can be compared with the pane's text.
ESCAPES = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]")
failures = []


def check(name, fn):
    try:
        fn()
        print(f"✓ {name}")
    except Exception as e:
        failures.append(name)
        print(f"✗ {name}: {e}")


def request(path, body=None, content_type="application/json", origin=ORIGIN):
    headers = {"Origin": origin}
    if body is not None:
        headers["Content-Type"] = content_type
        if content_type == "application/json":
            body = json.dumps(body).encode()
    req = urllib.request.Request(ORIGIN + path, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, check=True).stdout.strip()


def terminal_stream(origin, seconds, columns=80, rows=24):
    """Opens the terminal websocket like the page does and returns (status line, text received)."""
    sock = ssl.create_default_context().wrap_socket(socket.create_connection((HOST, 443), timeout=10), server_hostname=HOST)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET /term/ws HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tty\r\n"
                  f"Origin: {origin}\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, buf = buf.partition(b"\r\n\r\n")
    status = head.split(b"\r\n")[0].decode()
    if " 101 " not in status:
        sock.close()
        return status, ""
    # ttyd starts `tmux attach` once the page sends its size, as a masked binary frame.
    payload = json.dumps({"AuthToken": "", "columns": columns, "rows": rows}).encode()
    mask = os.urandom(4)
    sock.sendall(bytes([0x82, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    text, deadline = b"", time.time() + seconds
    sock.settimeout(0.5)
    while time.time() < deadline:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
        # Unframe server frames (never masked): 1 opcode byte, then a 7-bit, 16-bit or 64-bit length.
        while len(buf) >= 2:
            n, start = buf[1] & 0x7F, 2
            if n == 126:
                n, start = int.from_bytes(buf[2:4], "big"), 4
            elif n == 127:
                n, start = int.from_bytes(buf[2:10], "big"), 10
            if len(buf) < start + n:
                break
            frame, buf = buf[start:start + n], buf[start + n:]
            if frame[:1] == b"0":  # ttyd's terminal output message
                text += frame[1:]
    sock.close()
    return status, text.decode(errors="replace")


def main():
    def page():
        status, body = request("/")
        assert status == 200 and b"<title>tmux</title>" in body, f"GET / returned {status}"
    check("page loads", page)

    def pane_list():
        status, body = request("/api/panes")
        assert status == 200, f"GET /api/panes returned {status}: {body[:200]!r}"
        listed = sorted(p["id"] for p in json.loads(body)["panes"])
        # The phone's tmux session shares the Mac session's windows, so `list-panes -a` lists them twice; count each once.
        real = sorted(set(tmux("list-panes", "-a", "-F", "#{pane_id}").replace("%", "").split()))
        assert listed == real, f"list shows {listed}, tmux has {real}"
    check("pane list matches tmux", pane_list)

    def terminal():
        # The stream shows the phone's own tmux session. Attach at its window's size so the Mac's layout doesn't change.
        pane, columns, rows = tmux("display-message", "-p", "-t", "=phone:", "#{pane_id} #{window_width} #{window_height}").split()
        status, text = terminal_stream(ORIGIN, seconds=3, columns=int(columns), rows=int(rows))
        assert " 101 " in status, f"websocket handshake: {status}"
        assert text, "connected, but no terminal output arrived (the 'Reconnecting…' bug)"
        lines = [l for l in tmux("capture-pane", "-p", "-t", pane).splitlines() if len(l.split()) >= 2]
        assert lines, "the active pane is blank, nothing to compare"
        # tmux may draw spaces as cursor moves, so compare with all whitespace removed.
        line = max(lines, key=len)
        assert "".join(line.split()) in "".join(ESCAPES.sub("", text).split()), f"stream does not show the screen's line {line.strip()!r}"
    check("terminal shows the screen you're on", terminal)

    def dictation():
        with tempfile.TemporaryDirectory() as d:
            clip = os.path.join(d, "clip.m4a")
            subprocess.run(["say", "-o", clip, "--data-format=aac", "The quick brown fox jumps over the lazy dog."], check=True)
            with open(clip, "rb") as f:
                status, body = request("/api/transcribe", f.read(), content_type="audio/mp4")
        assert status == 200, f"{status}: {body[:200]!r}"
        text = json.loads(body)["text"].lower()
        assert "quick brown fox" in text, f"got {text!r}"
    check("dictation returns the spoken words", dictation)

    def other_sites_blocked():
        # Pane 0 needn't exist: the origin is refused before anything reaches tmux.
        status, _ = request("/api/panes/0/key", {"key": "enter"}, origin="https://evil.example")
        assert status == 403, f"POST from another origin returned {status}"
        status, _ = terminal_stream("https://evil.example", seconds=0)
        assert " 403 " in status, f"terminal from another origin: {status}"
    check("other websites can't type or open the terminal", other_sites_blocked)

    if failures:
        sys.exit(f"\n{len(failures)} failed: {', '.join(failures)}")
    print("\nall checks passed")


if __name__ == "__main__":
    main()
