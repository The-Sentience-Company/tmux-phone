#!/usr/bin/env python3
"""Phone UI for the tmux session on this Mac, served on the tailnet via `tailscale serve`."""
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import uuid
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", int(os.environ.get("TMUX_PHONE_PORT", "8766"))
# Set by install.sh in the launchd job: this Mac's tailnet URL, and the one Tailscale login allowed in.
PUBLIC_ORIGIN = os.environ.get("TMUX_PHONE_ORIGIN", "")
ALLOWED_LOGIN = os.environ.get("TMUX_PHONE_LOGIN", "")
STATE = Path.home() / ".local/state/tmux-phone"
TTYD_SOCKET = STATE / "ttyd.sock"
STATIC = Path(__file__).resolve().parent / "static"
INDEX = STATIC / "index.html"
SERVER_SOURCE = Path(__file__).read_bytes()  # a change to this file needs a restart, so reading it once is enough
# The terminal library, web app manifest and icons the page loads; only these paths are served.
STATIC_FILES = {"/vendor/xterm.js": "text/javascript; charset=utf-8", "/vendor/xterm.css": "text/css; charset=utf-8",
                "/vendor/addon-fit.js": "text/javascript; charset=utf-8",
                "/manifest.json": "application/manifest+json", "/icon-180.png": "image/png", "/icon-512.png": "image/png"}
MAX_BODY = 64 * 1024
MAX_AUDIO = 25 * 1024 * 1024
MAX_IMAGES = 20 * 1024 * 1024  # all images in one paste, before base64
UPLOADS = STATE / "uploads"
UPLOAD_DAYS = 7
IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"GIF87a": "gif", b"GIF89a": "gif"}
WHISPER_MODEL = STATE / "models/ggml-large-v3-turbo-q5_0.bin"
WHISPER_HOST, WHISPER_PORT = "127.0.0.1", int(os.environ.get("TMUX_PHONE_WHISPER_PORT", "8767"))

PANE_ROUTE = re.compile(r"^/api/panes/(\d+)/(open|back|paste|key|close|rename)$")
WINDOW_ROUTE = re.compile(r"^/api/windows/(\d+)/(rename|panes)$")  # by window id: 3 is tmux's @3
MAX_NAME = 100
# Phone button name -> tmux send-keys name. Digits answer Claude's numbered menus.
KEYS = {"enter": "Enter", "escape": "Escape", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
        "tab": "Tab", "shift+tab": "BTab", "ctrl+c": "C-c", "alt+p": "M-p", "1": "1", "2": "2", "3": "3"}
PANE_FIELDS = ["pane_id", "window_id", "window_index", "window_name", "pane_index", "pane_title", "pane_tty", "pane_active",
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


# The phone's own tmux session. It shares the Mac session's windows (a tmux session group) but has its own
# current window and no status line, so switching windows on the phone does not move the Mac.
PHONE = "phone"


def ensure_phone_session():
    """Create the phone's session if it is gone: grouped with the most recently used other session, status line off."""
    if subprocess.run(["tmux", "has-session", "-t", f"={PHONE}"], capture_output=True).returncode:
        sessions = subprocess.run(["tmux", "list-sessions", "-F", "#{session_last_attached} #{session_name}"],
                                  capture_output=True, text=True).stdout.splitlines()
        others = sorted((line.split(" ", 1) for line in sessions if line.split(" ", 1)[1] != PHONE),
                        key=lambda s: int(s[0] or 0), reverse=True)
        group = ["-t", f"={others[0][1]}"] if others else []
        tmux("new-session", "-d", "-s", PHONE, *group)
        tmux("set-option", "-t", f"={PHONE}:", "status", "off")  # set-option takes a pane target, so the colon


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
    ensure_phone_session()
    # The phone session's panes, each once: `list-panes -a` would list a grouped window once per session.
    out = tmux("list-panes", "-s", "-t", f"={PHONE}", "-F", "\x1f".join(f"#{{{f}}}" for f in PANE_FIELDS))
    claude = claude_ttys()
    panes = []
    for row in out.splitlines():
        p = dict(zip(PANE_FIELDS, row.split("\x1f")))
        lines = tmux("capture-pane", "-p", "-t", p["pane_id"]).rstrip().splitlines()
        is_claude = p["pane_tty"].removeprefix("/dev/") in claude
        panes.append({
            "id": p["pane_id"].lstrip("%"),
            "window": int(p["window_index"]),
            "window_id": p["window_id"].lstrip("@"),
            "window_name": p["window_name"],
            "title": p["pane_title"],
            "command": p["pane_current_command"],
            "active": p["pane_active"] == "1" and p["window_active"] == "1",
            "status": status(lines) if is_claude else None,
            "last_line": last_line(lines) if is_claude else next((l.strip() for l in reversed(lines) if l.strip()), ""),
        })
    return panes


def phone_windows():
    """The phone session's windows for the status line, in tmux's order, with the phone's current one marked."""
    out = tmux("list-windows", "-t", f"={PHONE}", "-F", "#{window_index}\x1f#{window_name}\x1f#{window_active}")
    return [{"index": int(i), "name": n, "active": a == "1"} for i, n, a in (l.split("\x1f") for l in out.splitlines())]


def pane_info(pane, *fields):
    return tmux("display-message", "-p", "-t", pane, "\x1f".join(f"#{{{f}}}" for f in fields)).rstrip("\n").split("\x1f")


def open_pane(pane):
    """Show one pane full screen on the phone: switch the phone's session to it, and zoom it if its window is split.
    The window is named through the phone's session; a bare %pane could pick the Mac's session and switch the Mac."""
    ensure_phone_session()
    tmux("select-window", "-t", f"={PHONE}:{pane_info(pane, 'window_id')[0]}")
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


def valid_name(name):
    return (isinstance(name, str) and name.strip() != "" and len(name) <= MAX_NAME
            and not any(unicodedata.category(c) == "Cc" for c in name))


def tmux_literal(name):
    """tmux reads #{...} in a new name as a format; ## is a plain #."""
    return name.replace("#", "##")


def add_pane(window):
    """Split the window and return the new pane's id. Side by side if the window is wide, else one above the other."""
    width, height = (int(n) for n in tmux("display-message", "-p", "-t", window, "#{window_width} #{window_height}").split())
    side = "-h" if width > 2.5 * height else "-v"
    return tmux("split-window", side, "-t", window, "-P", "-F", "#{pane_id}").strip().lstrip("%")


def version(page):
    """Changes when this server or the page changes. The phone reloads itself when it sees a new one."""
    return hashlib.sha1(SERVER_SOURCE + page).hexdigest()[:12]


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
            if self.path == "/term/ws" and is_websocket:
                return self.proxy_websocket()
            if self.path == "/":
                page = INDEX.read_bytes()
                return self.reply(200, page.replace(b"{{VERSION}}", version(page).encode()), "text/html; charset=utf-8")
            if self.path in STATIC_FILES:
                return self.reply(200, (STATIC / self.path.lstrip("/")).read_bytes(), STATIC_FILES[self.path])
            if self.path == "/api/panes":
                panes = list_panes()
                return self.reply(200, {"panes": panes, "windows": phone_windows(), "version": version(INDEX.read_bytes())})
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
        if length > (MAX_IMAGES * 4 // 3 + MAX_BODY if self.path.endswith("/paste") else MAX_BODY):
            return self.reply(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/api/windows":
                ensure_phone_session()  # the new window joins the group, so the Mac has it too
                return self.reply(200, {"pane": tmux("new-window", "-t", f"={PHONE}:", "-P", "-F", "#{pane_id}").strip().lstrip("%")})
            m = WINDOW_ROUTE.match(self.path)
            if m:
                window, action = f"@{m[1]}", m[2]
                if action == "panes":
                    return self.reply(200, {"pane": add_pane(window)})
                if not valid_name(body.get("name")):
                    return self.reply(400, {"error": "bad name"})
                # Naming a window also turns off tmux's automatic-rename for it, so the name sticks.
                tmux("rename-window", "-t", window, "--", tmux_literal(body["name"]))
                return self.reply(200, {"ok": True})
            m = PANE_ROUTE.match(self.path)
            if not m:
                return self.reply(404, {"error": "not found"})
            pane, action = f"%{m[1]}", m[2]
            if action == "open":
                open_pane(pane)
            elif action == "back":
                unzoom(pane)
            elif action == "paste":
                # Dictated text or photos go into the pane's input; the phone's Enter key submits it.
                text, images = body.get("text", ""), body.get("images") or []
                if not isinstance(text, str) or not isinstance(images, list) or not all(isinstance(i, str) for i in images):
                    return self.reply(400, {"error": "bad paste"})
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
                # Bracketed paste, so multi-line text arrives as one paste and nothing is submitted.
                tmux("load-buffer", "-b", "phone", "-", stdin=text)
                tmux("paste-buffer", "-p", "-d", "-b", "phone", "-t", pane)
            elif action == "key":
                key = KEYS.get(body.get("key"))
                if not key:
                    return self.reply(400, {"error": "key not allowed"})
                leave_scroll(pane)
                tmux("send-keys", "-t", pane, key)
            elif action == "close":
                tmux("kill-pane", "-t", pane)
            elif action == "rename":
                if not valid_name(body.get("name")):
                    return self.reply(400, {"error": "bad name"})
                tmux("select-pane", "-t", pane, "-T", tmux_literal(body["name"]))
            self.reply(200, {"ok": True})
        except TmuxError as e:
            self.reply(502, {"error": str(e)})
        except ValueError:
            self.reply(400, {"error": "bad json"})
        except Exception:
            traceback.print_exc()
            self.reply(500, {"error": "server error"})

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


class Server(ThreadingHTTPServer):
    daemon_threads = True


def start_ttyd():
    """ttyd serves the live terminal on a socket only this server reaches; if it dies, exit so launchd restarts both."""
    TTYD_SOCKET.unlink(missing_ok=True)
    proc = subprocess.Popen([
        "ttyd", "--interface", str(TTYD_SOCKET), "--base-path", "/term", "--writable", "--check-origin",
        sys.executable, str(Path(__file__).resolve()), "attach",
    ])
    threading.Thread(target=lambda: (proc.wait(), os._exit(1)), daemon=True).start()


def keep_awake():
    """Plugged in, the Mac does not sleep while this server runs (-s works on AC only; the display may still sleep).
    caffeinate exits with the server. It is not needed to serve, so its exit does not stop the server."""
    subprocess.Popen(["caffeinate", "-s", "-w", str(os.getpid())])


def start_whisper():
    """whisper-server keeps the speech model in memory so dictation takes a second, not a reload; --convert runs ffmpeg on the phone's AAC."""
    proc = subprocess.Popen(["whisper-server", "-m", str(WHISPER_MODEL), "--host", WHISPER_HOST, "--port", str(WHISPER_PORT),
                             "-l", "auto", "--convert"], cwd=STATE)  # --convert writes its temp file to the cwd
    threading.Thread(target=lambda: (proc.wait(), os._exit(1)), daemon=True).start()


if __name__ == "__main__":
    if sys.argv[1:] == ["attach"]:
        # What ttyd runs for each terminal connection: attach to the phone's session, made again if it is gone.
        ensure_phone_session()
        os.execvp("tmux", ["tmux", "attach", "-t", f"={PHONE}"])
    if not (PUBLIC_ORIGIN and ALLOWED_LOGIN):
        sys.exit("TMUX_PHONE_ORIGIN and TMUX_PHONE_LOGIN must be set; run ./install.sh")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    start_ttyd()
    start_whisper()
    keep_awake()
    print(f"tmux-phone on http://{HOST}:{PORT} for {ALLOWED_LOGIN} at {PUBLIC_ORIGIN}", flush=True)
    Server((HOST, PORT), Handler).serve_forever()
