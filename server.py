#!/usr/bin/env python3
"""Phone UI for the tmux session on this Mac, served on the tailnet via `tailscale serve`."""
import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", 8766
# Set by install.sh in the launchd job: this Mac's tailnet URL, and the one Tailscale login allowed in.
PUBLIC_ORIGIN = os.environ.get("TMUX_PHONE_ORIGIN", "")
ALLOWED_LOGIN = os.environ.get("TMUX_PHONE_LOGIN", "")
STATE = Path.home() / ".local/state/tmux-phone"
TTYD_SOCKET = STATE / "ttyd.sock"
INDEX = Path(__file__).resolve().parent / "static/index.html"
MAX_BODY = 64 * 1024
MAX_AUDIO = 25 * 1024 * 1024
MAX_IMAGES = 20 * 1024 * 1024  # all images in one message, before base64
UPLOADS = STATE / "uploads"
UPLOAD_DAYS = 7
IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"GIF87a": "gif", b"GIF89a": "gif"}
WHISPER_MODEL = STATE / "models/ggml-large-v3-turbo-q5_0.bin"
WHISPER_HOST, WHISPER_PORT = "127.0.0.1", 8767

PANE_ROUTE = re.compile(r"^/api/panes/(\d+)/(open|back|send|key|scroll|split|close)$")
# Phone button name -> tmux send-keys name. Digits answer Claude's numbered menus.
KEYS = {"enter": "Enter", "escape": "Escape", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
        "tab": "Tab", "shift+tab": "BTab", "ctrl+c": "C-c", "alt+p": "M-p", "1": "1", "2": "2", "3": "3"}
PANE_FIELDS = ["pane_id", "window_index", "window_name", "pane_index", "pane_title", "pane_tty", "pane_active",
               "window_active", "window_zoomed_flag", "window_panes", "pane_current_command"]

# Claude Code draws its conversation, a rule, the ❯ input line, then a footer.
RULE = re.compile(r"^\s*─{8,}")
BULLET = re.compile(r"^[⏺●•] ")
CLAUDE_NOTICE = re.compile(r"new task\? /clear|Compacted\s+while\s+idle|^[⏺●•] Compacted\b|0: Dismiss\s*$|^\s*1: Learn more\s*$")
SPINNER = re.compile(r"^[✻✶✳✢✽·*+] \S.*…")


class TmuxError(Exception):
    pass


class WhisperError(Exception):
    pass


def tmux(*args, stdin=None):
    r = subprocess.run(["tmux", *args], input=stdin, capture_output=True, text=True, timeout=10)
    if r.returncode:
        raise TmuxError(r.stderr.strip() or "tmux failed")
    return r.stdout


def claude_ttys():
    """ttys whose foreground process is Claude Code."""
    out = subprocess.run(["ps", "-A", "-o", "tty=,stat=,comm="], capture_output=True, text=True, env={"LC_ALL": "C"}).stdout
    return {parts[0] for parts in (line.split(None, 2) for line in out.splitlines())
            if len(parts) == 3 and "+" in parts[1] and os.path.basename(parts[2]) == "claude"}


def body_end(lines):
    """Index of the rule above Claude's input box; everything below it is prompt and footer."""
    for i in range(len(lines) - 2, -1, -1):
        if RULE.match(lines[i]) and lines[i + 1].lstrip().startswith("❯"):
            return i
    return len(lines)


def last_line(lines):
    lines = lines[:body_end(lines)]
    content = [l for l in lines if l.strip() and not RULE.match(l) and not CLAUDE_NOTICE.search(l)]
    spinner = next((l.strip() for l in content[-4:] if SPINNER.match(l)), None)
    if spinner:
        return spinner
    # Otherwise the start of Claude's latest reply, rejoined across its wrapped lines.
    for i in range(len(lines) - 1, -1, -1):
        if BULLET.match(lines[i]) and not CLAUDE_NOTICE.search(lines[i]):
            parts = [lines[i][2:].strip()]
            for l in lines[i + 1:]:
                if not l.startswith("  ") or not l.strip() or "⎿" in l:
                    break
                parts.append(l.strip())
            return " ".join(parts)
    return content[-1].strip() if content else ""


def status(lines):
    end = body_end(lines)
    if end == len(lines):
        return "needs_you"  # no input box on screen means a question or menu is open
    if any(SPINNER.match(l) for l in lines[:end][-30:]):
        return "working"
    return "idle"


def list_panes():
    out = tmux("list-panes", "-a", "-F", "\x1f".join(f"#{{{f}}}" for f in PANE_FIELDS))
    claude = claude_ttys()
    panes = []
    for row in out.splitlines():
        p = dict(zip(PANE_FIELDS, row.split("\x1f")))
        lines = tmux("capture-pane", "-p", "-t", p["pane_id"]).rstrip().splitlines()
        is_claude = p["pane_tty"].removeprefix("/dev/") in claude
        panes.append({
            "id": p["pane_id"].lstrip("%"),
            "window": int(p["window_index"]),
            "window_name": p["window_name"],
            "title": p["pane_title"],
            "command": p["pane_current_command"],
            "active": p["pane_active"] == "1" and p["window_active"] == "1",
            "status": status(lines) if is_claude else None,
            "last_line": last_line(lines) if is_claude else next((l.strip() for l in reversed(lines) if l.strip()), ""),
        })
    return panes


def pane_info(pane, *fields):
    return tmux("display-message", "-p", "-t", pane, "\x1f".join(f"#{{{f}}}" for f in fields)).rstrip("\n").split("\x1f")


def open_pane(pane):
    """Show one pane full screen on the phone: switch to it, and zoom it if its window is split."""
    tmux("select-window", "-t", pane)
    tmux("select-pane", "-t", pane)
    panes, zoomed = pane_info(pane, "window_panes", "window_zoomed_flag")
    if panes != "1" and zoomed == "0":
        tmux("resize-pane", "-Z", "-t", pane)


def transcribe(audio):
    """Speech to text on this Mac with whisper-server, which keeps the model loaded; the audio never leaves the Mac."""
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio\"\r\n\r\n".encode()
            + audio + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson"
            f"\r\n--{boundary}--\r\n".encode())
    conn = HTTPConnection(WHISPER_HOST, WHISPER_PORT, timeout=120)
    try:
        conn.request("POST", "/inference", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        r = conn.getresponse()
        data = r.read()
    finally:
        conn.close()
    if r.status != 200:
        raise WhisperError(f"whisper-server {r.status}: {data[:300].decode(errors='replace')}")
    return " ".join(json.loads(data)["text"].split())


def save_upload(data):
    """Store a phone image where Claude Code can read it; only real image bytes are accepted. Old ones are deleted."""
    ext = next((e for magic, e in IMAGE_TYPES.items() if data.startswith(magic)), None)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    if not ext:
        return None
    UPLOADS.mkdir(parents=True, exist_ok=True)
    for old in UPLOADS.glob("*"):
        if old.stat().st_mtime < time.time() - UPLOAD_DAYS * 86400:
            old.unlink(missing_ok=True)
    path = UPLOADS / f"{time.strftime('%Y%m%d-%H%M%S')}-{os.urandom(3).hex()}.{ext}"
    path.write_bytes(data)
    return path


def leave_scroll(pane):
    """Typing into a pane that is scrolled back would land in tmux's copy mode, so leave it first."""
    if pane_info(pane, "pane_in_mode") == ["1"]:
        tmux("copy-mode", "-q", "-t", pane)


def unzoom(pane):
    if pane_info(pane, "window_zoomed_flag") == ["1"]:
        tmux("resize-pane", "-Z", "-t", pane)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status_code, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self, needs_origin):
        login = self.headers.get("Tailscale-User-Login")
        if login != ALLOWED_LOGIN:
            self.log_message("forbidden: Tailscale-User-Login=%r", login)
            return False
        # Stops another web page open on the phone from typing into the terminal.
        if needs_origin and self.headers.get("Origin") != PUBLIC_ORIGIN:
            self.log_message("forbidden: Origin=%r", self.headers.get("Origin"))
            return False
        return True

    def do_GET(self):
        is_websocket = self.headers.get("Upgrade", "").lower() == "websocket"
        if not self.allowed(needs_origin=is_websocket):
            return self.reply(403, {"error": "forbidden"})
        try:
            if self.path.startswith("/term/") or self.path == "/term":
                return self.proxy_websocket() if is_websocket else self.proxy_http()
            if self.path == "/":
                return self.reply(200, INDEX.read_bytes(), "text/html; charset=utf-8")
            if self.path == "/api/panes":
                return self.reply(200, {"panes": list_panes()})
            self.reply(404, {"error": "not found"})
        except TmuxError as e:
            self.reply(502, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.reply(500, {"error": "server error"})

    def do_POST(self):
        content_type = self.headers.get("Content-Type", "").split(";")[0]
        length = int(self.headers.get("Content-Length") or 0)
        if self.path == "/api/transcribe":
            if not self.allowed(needs_origin=True) or not content_type.startswith("audio/"):
                return self.reply(403, {"error": "forbidden"})
            if length > MAX_AUDIO:
                return self.reply(413, {"error": "recording too long"})
            try:
                return self.reply(200, {"text": transcribe(self.rfile.read(length))})
            except (WhisperError, OSError) as e:
                return self.reply(502, {"error": f"transcription failed: {e}"})
        if not self.allowed(needs_origin=True) or content_type != "application/json":
            return self.reply(403, {"error": "forbidden"})
        if length > (MAX_IMAGES * 4 // 3 + MAX_BODY if self.path.endswith("/send") else MAX_BODY):
            return self.reply(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/api/windows":
                return self.reply(200, {"pane": tmux("new-window", "-P", "-F", "#{pane_id}").strip().lstrip("%")})
            m = PANE_ROUTE.match(self.path)
            if not m:
                return self.reply(404, {"error": "not found"})
            pane, action = f"%{m[1]}", m[2]
            if action == "open":
                open_pane(pane)
            elif action == "back":
                unzoom(pane)
            elif action == "send":
                text, images = body.get("text", ""), body.get("images") or []
                if not isinstance(text, str) or not isinstance(images, list) or not all(isinstance(i, str) for i in images):
                    return self.reply(400, {"error": "bad message"})
                if not text.strip() and not images:
                    return self.reply(400, {"error": "empty text"})
                paths = []
                for encoded in images:
                    try:
                        path = save_upload(base64.b64decode(encoded, validate=True))
                    except ValueError:
                        path = None
                    if not path:
                        return self.reply(400, {"error": "not an image"})
                    paths.append(str(path))
                # Claude Code turns a pasted image path into an attachment, but only at the end of the text.
                text = " ".join([text.strip(), *paths]).strip()
                leave_scroll(pane)
                # Bracketed paste, so a multi-line message arrives as one message, then Enter submits it.
                tmux("load-buffer", "-b", "phone", "-", stdin=text)
                tmux("paste-buffer", "-p", "-d", "-b", "phone", "-t", pane)
                time.sleep(0.15)
                tmux("send-keys", "-t", pane, "Enter")
            elif action == "key":
                key = KEYS.get(body.get("key"))
                if not key:
                    return self.reply(400, {"error": "key not allowed"})
                leave_scroll(pane)
                tmux("send-keys", "-t", pane, key)
            elif action == "scroll":
                # A swipe on the phone; positive is back in history. -e leaves copy mode on reaching the bottom.
                lines = body.get("lines")
                if not isinstance(lines, int) or not lines:
                    return self.reply(400, {"error": "bad lines"})
                lines = max(-500, min(500, lines))
                if lines > 0:
                    tmux("copy-mode", "-e", "-t", pane)
                    tmux("send-keys", "-t", pane, "-X", "-N", str(lines), "scroll-up")
                elif pane_info(pane, "pane_in_mode") == ["1"]:
                    tmux("send-keys", "-t", pane, "-X", "-N", str(-lines), "scroll-down")
            elif action == "split":
                flag = {"right": "-h", "down": "-v"}.get(body.get("direction"))
                if not flag:
                    return self.reply(400, {"error": "bad direction"})
                return self.reply(200, {"pane": tmux("split-window", flag, "-t", pane, "-P", "-F", "#{pane_id}").strip().lstrip("%")})
            elif action == "close":
                tmux("kill-pane", "-t", pane)
            self.reply(200, {"ok": True})
        except TmuxError as e:
            self.reply(502, {"error": str(e)})
        except ValueError:
            self.reply(400, {"error": "bad json"})
        except Exception:
            traceback.print_exc()
            self.reply(500, {"error": "server error"})

    def proxy_http(self):
        """ttyd's own page and token, fetched over its socket one request at a time."""
        conn = UnixHTTPConnection(str(TTYD_SOCKET))
        try:
            conn.request("GET", self.path, headers={"Host": self.headers.get("Host", ""), "Accept-Encoding": self.headers.get("Accept-Encoding", "")})
            r = conn.getresponse()
            data = r.read()
        finally:
            conn.close()
        self.send_response(r.status)
        for name, value in r.getheaders():
            if name.lower() not in ("connection", "keep-alive", "transfer-encoding", "content-length"):
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy_websocket(self):
        """Hand the checked connection to ttyd and copy bytes both ways until either side closes."""
        upstream = socket.socket(socket.AF_UNIX)
        upstream.connect(str(TTYD_SOCKET))
        # Rebuild the handshake exactly; any stray byte after it reads to ttyd as a broken frame and it hangs up.
        head = self.requestline + "\r\n" + "".join(f"{k}: {v}\r\n" for k, v in self.headers.items()) + "\r\n"
        upstream.sendall(head.encode("latin-1"))
        client = self.connection
        self.close_connection = True

        def pipe(src, dst):
            try:
                while chunk := src.recv(65536):
                    dst.sendall(chunk)
            except OSError:
                pass
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        t = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t.start()
        pipe(client, upstream)
        t.join()
        upstream.close()


class UnixHTTPConnection(HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(self.path)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def start_ttyd():
    """ttyd serves the live terminal on a socket only this server reaches; if it dies, exit so launchd restarts both."""
    TTYD_SOCKET.unlink(missing_ok=True)
    proc = subprocess.Popen([
        "ttyd", "--interface", str(TTYD_SOCKET), "--base-path", "/term", "--writable", "--check-origin",
        "-t", "fontSize=13", "-t", "disableLeaveAlert=true", "-t", "disableResizeOverlay=true",
        "tmux", "attach",
    ])
    threading.Thread(target=lambda: (proc.wait(), os._exit(1)), daemon=True).start()


def start_whisper():
    """whisper-server keeps the speech model in memory so dictation takes a second, not a reload; --convert runs ffmpeg on the phone's AAC."""
    proc = subprocess.Popen(["whisper-server", "-m", str(WHISPER_MODEL), "--host", WHISPER_HOST, "--port", str(WHISPER_PORT),
                             "-l", "auto", "--convert"], cwd=STATE)  # --convert writes its temp file to the cwd
    threading.Thread(target=lambda: (proc.wait(), os._exit(1)), daemon=True).start()


if __name__ == "__main__":
    if not (PUBLIC_ORIGIN and ALLOWED_LOGIN):
        sys.exit("TMUX_PHONE_ORIGIN and TMUX_PHONE_LOGIN must be set; run ./install.sh")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    start_ttyd()
    start_whisper()
    print(f"tmux-phone on http://{HOST}:{PORT} for {ALLOWED_LOGIN} at {PUBLIC_ORIGIN}", flush=True)
    Server((HOST, PORT), Handler).serve_forever()
