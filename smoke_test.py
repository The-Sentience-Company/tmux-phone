#!/usr/bin/env python3
"""Checks the live install the way the phone uses it, through the tailnet URL.

Each check asserts what you would see, not a step on the way: the pane in the list, the
command's output in the pane, that output on the terminal stream, the right words from dictation.

Usage: ./smoke_test.py https://<this-mac>.<tailnet>.ts.net
Opens a scratch tmux window for a few seconds, then closes it and switches back.
"""
import base64
import json
import os
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
MARK = f"smoke-{os.getpid()}"
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


def terminal_stream(origin, seconds):
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
    payload = json.dumps({"AuthToken": "", "columns": 120, "rows": 40}).encode()
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
    previous_window = tmux("display-message", "-p", "#{window_id}")
    # A plain sh so the prompt is predictable. Detached, so the Mac's view only moves when the test opens it.
    pane = tmux("new-window", "-d", "-n", "smoke-test", "-P", "-F", "#{pane_id}", "sh").lstrip("%")
    try:
        def page():
            status, body = request("/")
            assert status == 200 and b"<title>tmux</title>" in body, f"GET / returned {status}"
        check("page loads", page)

        def pane_listed():
            status, body = request("/api/panes")
            assert status == 200, f"GET /api/panes returned {status}: {body[:200]!r}"
            ids = [p["id"] for p in json.loads(body)["panes"]]
            assert pane in ids, f"test pane %{pane} not in list {ids}"
        check("pane list shows the new pane", pane_listed)

        def open_pane():
            status, body = request(f"/api/panes/{pane}/open", {})
            assert status == 200, f"{status}: {body[:200]!r}"
            assert tmux("display-message", "-p", "#{pane_id}") == f"%{pane}", "tmux did not switch to the pane"
        check("opening a pane switches tmux to it", open_pane)

        def send():
            # The quotes split the typed text, so MARK alone on a line only shows up if the shell ran it.
            status, body = request(f"/api/panes/{pane}/send", {"text": f"echo smoke-\"\"{os.getpid()}"})
            assert status == 200, f"{status}: {body[:200]!r}"
            for _ in range(20):
                if MARK in tmux("capture-pane", "-p", "-t", f"%{pane}").splitlines():
                    return
                time.sleep(0.1)
            raise AssertionError(f"{MARK} never printed in the pane")
        check("message box runs a command in the pane", send)

        def image():
            # 1x1 PNG. `wc -c` plus the path the server appends prints the saved file's size and path.
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            status, body = request(f"/api/panes/{pane}/send", {"text": "wc -c", "images": [base64.b64encode(png).decode()]})
            assert status == 200, f"{status}: {body[:200]!r}"
            for _ in range(20):
                saved = [l.split()[-1] for l in tmux("capture-pane", "-p", "-t", f"%{pane}").splitlines()
                         if "/uploads/" in l and l.split()[0].isdigit()]
                if saved:
                    with open(saved[-1], "rb") as f:
                        assert f.read() == png, f"{saved[-1]} does not hold the image that was sent"
                    os.unlink(saved[-1])
                    return
                time.sleep(0.1)
            raise AssertionError("the pane never received a saved image path")
        check("photo arrives in the pane as a saved file", image)


        def terminal():
            status, text = terminal_stream(ORIGIN, seconds=3)
            assert " 101 " in status, f"websocket handshake: {status}"
            assert text, "connected, but no terminal output arrived (the 'Reconnecting…' bug)"
            assert MARK in text, f"terminal output arrived ({len(text)} chars) but does not show the pane's {MARK}"
        check("terminal shows the pane's screen", terminal)

        def scroll():
            # Fill the pane's history first, or there is nothing to scroll back to.
            tmux("send-keys", "-t", f"%{pane}", "seq 200", "Enter")
            time.sleep(0.3)
            status, body = request(f"/api/panes/{pane}/scroll", {"lines": 3})
            assert status == 200, f"{status}: {body[:200]!r}"
            mode, position = tmux("display-message", "-p", "-t", f"%{pane}", "#{pane_in_mode} #{scroll_position}").split()
            assert (mode, position) == ("1", "3"), f"pane is not scrolled back 3 lines (in_mode={mode}, position={position})"
            status, body = request(f"/api/panes/{pane}/key", {"key": "enter"})
            assert status == 200, f"{status}: {body[:200]!r}"
            assert tmux("display-message", "-p", "-t", f"%{pane}", "#{pane_in_mode}") == "0", "a key press left the pane scrolled back"
        check("swiping scrolls the pane, and typing returns to the bottom", scroll)

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
            status, _ = request(f"/api/panes/{pane}/key", {"key": "enter"}, origin="https://evil.example")
            assert status == 403, f"POST from another origin returned {status}"
            status, _ = terminal_stream("https://evil.example", seconds=0)
            assert " 403 " in status, f"terminal from another origin: {status}"
        check("other websites can't type or open the terminal", other_sites_blocked)
    finally:
        subprocess.run(["tmux", "kill-pane", "-t", f"%{pane}"], capture_output=True)
        subprocess.run(["tmux", "select-window", "-t", previous_window], capture_output=True)

    if failures:
        sys.exit(f"\n{len(failures)} failed: {', '.join(failures)}")
    print("\nall checks passed")


if __name__ == "__main__":
    main()
