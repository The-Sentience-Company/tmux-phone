#!/usr/bin/env python3
"""Phone UI for the tmux session on this Mac, served on the tailnet via `tailscale serve`."""
import base64
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import uuid
from http.client import HTTPConnection
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

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
                "/vendor/addon-fit.js": "text/javascript; charset=utf-8", "/vendor/codemirror.js": "text/javascript; charset=utf-8",
                "/manifest.json": "application/manifest+json", "/icon-180.png": "image/png", "/icon-512.png": "image/png"}
MAX_BODY = 64 * 1024
MAX_FILE = 2 * 1024 * 1024  # bigger files are not shown on the phone
MAX_AUDIO = 25 * 1024 * 1024
MAX_IMAGES = 20 * 1024 * 1024  # all images in one paste, before base64
UPLOADS = STATE / "uploads"
UPLOAD_DAYS = 7
IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"GIF87a": "gif", b"GIF89a": "gif"}
WHISPER_MODEL = STATE / "models/ggml-large-v3-turbo-q5_0.bin"
WHISPER_HOST, WHISPER_PORT = "127.0.0.1", int(os.environ.get("TMUX_PHONE_WHISPER_PORT", "8767"))
# Dictation is on if install.sh found whisper-cpp and ffmpeg and downloaded the model; otherwise the page hides the mic.
DICTATION = WHISPER_MODEL.exists() and bool(shutil.which("whisper-server")) and bool(shutil.which("ffmpeg"))

PANE_ROUTE = re.compile(r"^/api/panes/(\d+)/(open|split|paste|key|close|rename)$")
WINDOW_ROUTE = re.compile(r"^/api/windows/(\d+)/(rename|panes|close)$")  # by window id: 3 is tmux's @3
SESSION_ROUTE = re.compile(r"^/api/sessions/(\d+)/(switch|rename|close)$")  # by session id: 3 is tmux's $3
MAX_NAME = 100
# Phone button name -> tmux send-keys name. Digits answer Claude's numbered menus.
KEYS = {"enter": "Enter", "escape": "Escape", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
        "tab": "Tab", "shift+tab": "BTab", "ctrl+c": "C-c", "alt+p": "M-p", "1": "1", "2": "2", "3": "3"}
PANE_FIELDS = ["pane_id", "window_id", "window_index", "window_name", "pane_index", "pane_title", "pane_tty", "pane_active",
               "window_active", "window_zoomed_flag", "window_panes", "pane_current_command", "mouse_any_flag",
               "pane_top", "pane_height", "window_height", "pane-border-status"]

# Claude Code draws its conversation, a rule, the ❯ input line, then a footer.
RULE = re.compile(r"^\s*─{8,}")
BULLET = re.compile(r"^[⏺●•] ")
CLAUDE_NOTICE = re.compile(r"new task\? /clear|Compacted\s+while\s+idle|^[⏺●•] Compacted\b|0: Dismiss\s*$|^\s*1: Learn more\s*$")
# Claude Code's spinner line ("✻ Thinking…"), or Cursor's (" ⠰⠳ Working").
SPINNER = re.compile(r"^[✻✶✳✢✽·*+] \S.*…|^ [⠀-⣿]+ \S")
# The coding agents a pane can run, by process name. Cursor's CLI is started as `agent` or `cursor-agent`.
AGENT_PROCESS = {"claude": "claude", "codex": "codex", "agent": "cursor", "cursor-agent": "cursor"}
# For each agent: its input box, matched against a line and the next one joined by "\n", and a line it shows
# while it works.
# Claude Code: a rule, then the ❯ line. Cursor: a bar of ▄, then the → line. Codex: the › line, with no rule.
INPUT_BOX = {"claude": re.compile(r"\s*─{8,}.*\n\s*❯"), "cursor": re.compile(r"\s*▄{8,}.*\n\s*→"),
             "codex": re.compile(r"›(\s|$)")}
WORKING = {"claude": SPINNER, "cursor": re.compile(r"ctrl\+c to stop\s*$"), "codex": re.compile(r"to interrupt\)")}
# Claude Code and Cursor hide the input box while they ask you something. Codex keeps its › line, so its
# question or approval is known by the hint under it.
CODEX_ASK = re.compile(r"to confirm\b|to submit (answer|all)\b|enter continue")


class TmuxError(Exception):
    pass


class WhisperError(Exception):
    pass


def tmux(*args, stdin=None):
    r = subprocess.run(["tmux", *args], input=stdin, capture_output=True, text=True, timeout=10)
    if r.returncode:
        raise TmuxError(r.stderr.strip() or "tmux failed")
    return r.stdout


# The phone's viewer: a hidden tmux session grouped with one real session, the target. It shares the target's
# windows but has its own current window and no status line, so switching windows on the phone does not move the Mac.
# It is never listed as a session. The target is the real session in the viewer's group, so tmux itself remembers it.
VIEWER = "_phone"
OLD_VIEWER = "phone"  # the viewer's name before _phone
SESSION_FIELDS = ["session_id", "session_name", "session_grouped", "session_group", "session_windows",
                  "session_attached", "session_last_attached", "session_activity"]


def list_sessions():
    """Every tmux session, the viewer included, most recently used first. No tmux server means no sessions."""
    r = subprocess.run(["tmux", "list-sessions", "-F", "\x1f".join(f"#{{{f}}}" for f in SESSION_FIELDS)],
                       capture_output=True, text=True)
    rows = [dict(zip(SESSION_FIELDS, line.split("\x1f"))) for line in r.stdout.splitlines()] if r.returncode == 0 else []
    return sorted(rows, key=lambda s: (int(s["session_last_attached"] or 0), int(s["session_activity"] or 0)), reverse=True)


def viewer_target(sessions):
    """Id of the real session the viewer is grouped with, or None if the viewer or that session is gone."""
    viewer = next((s for s in sessions if s["session_name"] == VIEWER), None)
    if not viewer or viewer["session_grouped"] != "1":
        return None
    return next((s["session_id"] for s in sessions if s["session_name"] != VIEWER and s["session_grouped"] == "1"
                 and s["session_group"] == viewer["session_group"]), None)


@contextmanager
def viewer_lock():
    """One change to the viewer at a time: ttyd's attach and the web server both remake it."""
    with open(STATE / "viewer.lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def new_real_session():
    """An ordinary tmux session with tmux's numbered name, which the Mac sees in `tmux ls`. Returns its id."""
    return tmux("new-session", "-d", "-c", str(Path.home()), "-P", "-F", "#{session_id}").strip()


def group_viewer(target):
    """Make the viewer again, grouped with target ($id). tmux can't move a session to another group.
    Killing the old viewer ends ttyd's attach, and the page reconnects to the new one. Caller holds viewer_lock."""
    subprocess.run(["tmux", "kill-session", "-t", f"={VIEWER}"], capture_output=True)
    tmux("new-session", "-d", "-s", VIEWER, "-t", target)
    tmux("set-option", "-t", f"={VIEWER}:", "status", "off")  # set-option takes a pane target, so the colon
    tmux("set-option", "-t", f"={VIEWER}:", "detach-on-destroy", "on")  # killed, its client exits, not moves to the Mac's session


def fix_viewer():
    """Keep the viewer's target while it exists. Else group it with the most recently used real session,
    or with a new real session if there is none. Returns the target's id. Caller holds viewer_lock."""
    sessions = list_sessions()
    target = viewer_target(sessions)
    if target:
        return target
    real = [s["session_id"] for s in sessions if s["session_name"] != VIEWER]
    target = real[0] if real else new_real_session()
    group_viewer(target)
    return target


def ensure_viewer():
    with viewer_lock():
        return fix_viewer()


# A window has one size and one layout, shared by the Mac and the phone. When the phone shows a window, tmux shrinks
# it to the phone's size and squeezes every pane; growing it back does not bring the old pane sizes back. So the Mac's
# layout, active pane and zoom are kept in window options just before the phone can shrink the window. When the phone
# shrinks it, @phone_shrunk is set; when a Mac client resizes it after that, the kept layout is put back.
SAVE_LAYOUT = ("set -wF @phone_layout '#{window_layout}' ; set -wF @phone_active '#{pane_id}' ; "
               "set -wF @phone_zoomed '#{window_zoomed_flag}'")
LAYOUT_OPTIONS = ("@phone_layout", "@phone_active", "@phone_zoomed", "@phone_shrunk")
HOOK = 42  # the index of our hooks in tmux's hook arrays, so we don't replace hooks of the user's own
# The phone shows one pane: zoom its pane in a split window, unless [desktop panes] set @phone_split on the window.
ZOOM = (f"if -F '#{{&&:#{{==:#{{session_name}},{VIEWER}}},#{{&&:#{{!=:#{{window_panes}},1}},"
        f"#{{&&:#{{!=:#{{window_zoomed_flag}},1}},#{{!=:#{{@phone_split}},1}}}}}}}}' {{ resize-pane -Z }}")


def set_layout_hooks():
    """tmux runs client-active when a client types after another client did, before the window is resized: the last
    moment the window still has the Mac's size. By then open_pane has saved the window with the Mac's zoom, so a
    saved window is not saved again. window-resized runs for each window that changed size."""
    tmux("set-hook", "-g", f"client-active[{HOOK}]",
         f"if -F '#{{&&:#{{==:#{{client_session}},{VIEWER}}},#{{==:#{{@phone_layout}},}}}}' {{ {SAVE_LAYOUT} }}")
    tmux("set-hook", "-g", f"window-resized[{HOOK}]",
         f"if -F '#{{==:#{{client_session}},{VIEWER}}}' {{ set -w @phone_shrunk 1 }} "
         f"{{ if -F '#{{@phone_shrunk}}' "
         f"{{ run-shell -b \"'{sys.executable}' '{Path(__file__).resolve()}' restore '#{{window_id}}'\" }} }}")
    # Runs after the save above, so the Mac's own zoom is what gets saved. Coming back to the phone resets the toggle.
    tmux("set-hook", "-g", f"client-active[{HOOK + 1}]", ZOOM)
    tmux("set-hook", "-g", f"session-window-changed[{HOOK + 1}]", ZOOM)
    tmux("set-hook", "-g", f"client-attached[{HOOK + 1}]",
         f"if -F '#{{==:#{{session_name}},{VIEWER}}}' {{ set -wu @phone_split }} ; {ZOOM}")


def save_desktop_layout(window):
    """For when tmux runs no client-active: the phone attaching, and the phone switching to a window while it is
    already the active client. A window the phone has not shrunk is saved again, as the Mac may have changed it
    since an earlier save."""
    if pane_info(window, "@phone_shrunk") == [""]:
        values = pane_info(window, "window_layout", "pane_id", "window_zoomed_flag")
        for option, value in zip(LAYOUT_OPTIONS, values):
            tmux("set-option", "-w", "-t", window, option, value)


def restore_desktop_layout(window):
    """Put back the Mac's pane sizes, active pane and zoom. Fails if a pane was added or closed since the save."""
    layout, active, zoomed = pane_info(window, *LAYOUT_OPTIONS[:3])
    for option in LAYOUT_OPTIONS:
        tmux("set-option", "-wu", "-t", window, option)
    tmux("select-layout", "-t", window, layout)  # unzooms first
    tmux("select-pane", "-t", active)
    if zoomed == "1":
        tmux("resize-pane", "-Z", "-t", active)


def kill_old_viewer():
    """Before _phone, the viewer was named phone. Kill it if it is grouped with a real session: it only showed that
    session's windows. A phone session standing alone, or grouped only with _phone, holds real work and stays."""
    sessions = list_sessions()
    old = next((s for s in sessions if s["session_name"] == OLD_VIEWER and s["session_grouped"] == "1"), None)
    if old and any(s["session_group"] == old["session_group"] and s["session_name"] not in (OLD_VIEWER, VIEWER)
                   for s in sessions):
        tmux("kill-session", "-t", old["session_id"])


def sessions_for_phone(target):
    return [{"id": s["session_id"].lstrip("$"), "name": s["session_name"], "windows": int(s["session_windows"]),
             "attached": int(s["session_attached"]), "current": s["session_id"] == target}
            for s in list_sessions() if s["session_name"] != VIEWER]


def agent_ttys():
    """tty -> the coding agent in its foreground: "claude", "codex" or "cursor"."""
    out = subprocess.run(["ps", "-A", "-o", "tty=,stat=,comm="], capture_output=True, text=True, env={"LC_ALL": "C"}).stdout
    return {parts[0]: AGENT_PROCESS[os.path.basename(parts[2])] for parts in (line.split(None, 2) for line in out.splitlines())
            if len(parts) == 3 and "+" in parts[1] and os.path.basename(parts[2]) in AGENT_PROCESS}


def body_end(lines, agent):
    """Index of the top of the agent's input box; everything from there down is prompt and footer."""
    for i in range(len(lines) - 2, -1, -1):
        if INPUT_BOX[agent].match(lines[i] + "\n" + lines[i + 1]):
            return i
    return len(lines)


def last_line(lines, agent):
    lines = lines[:body_end(lines, agent)]
    # A line with no letter or digit is blank or a box border.
    content = [l for l in lines if re.search(r"\w", l) and not RULE.match(l) and not CLAUDE_NOTICE.search(l)]
    spinner = next((l.strip() for l in content[-4:] if SPINNER.match(l)), None)
    if spinner:
        return spinner
    # Otherwise the start of the latest reply, rejoined across its wrapped lines. Claude Code and Codex start
    # each reply with a bullet; Cursor does not, so for Cursor this is mostly the last line above the box.
    for i in range(len(lines) - 1, -1, -1):
        if BULLET.match(lines[i]) and not CLAUDE_NOTICE.search(lines[i]):
            parts = [lines[i][2:].strip()]
            for l in lines[i + 1:]:
                if not l.startswith("  ") or not l.strip() or "⎿" in l:
                    break
                parts.append(l.strip())
            return " ".join(parts)
    return content[-1].strip() if content else ""


def status(lines, agent):
    end = body_end(lines, agent)
    if end == len(lines) or agent == "codex" and any(CODEX_ASK.search(l) for l in lines[end:]):
        return "needs_you"  # no input box on screen means a question or menu is open
    # The two lines at the top of the box too: Cursor shows "ctrl+c to stop" in its → line.
    if any(WORKING[agent].search(l) for l in lines[:end + 2][-30:]):
        return "working"
    return "idle"


def list_panes():
    # The viewer's panes, which are the target session's, each once: `list-panes -a` would list a grouped window once per session.
    out = tmux("list-panes", "-s", "-t", f"={VIEWER}", "-F", "\x1f".join(f"#{{{f}}}" for f in PANE_FIELDS))
    agents = agent_ttys()
    panes = []
    for row in out.splitlines():
        p = dict(zip(PANE_FIELDS, row.split("\x1f")))
        lines = tmux("capture-pane", "-p", "-t", p["pane_id"]).rstrip().splitlines()
        agent = agents.get(p["pane_tty"].removeprefix("/dev/"))
        panes.append({
            "id": p["pane_id"].lstrip("%"),
            "window": int(p["window_index"]),
            "window_id": p["window_id"].lstrip("@"),
            "window_name": p["window_name"],
            "title": p["pane_title"],
            "command": p["pane_current_command"],
            "active": p["pane_active"] == "1" and p["window_active"] == "1",
            # The app reads the mouse, so tmux hands it the wheel; if not, the wheel scrolls tmux's copy mode.
            "reads_mouse": p["mouse_any_flag"] == "1",
            "border": border_row(p),
            "status": status(lines, agent) if agent else None,
            "last_line": last_line(lines, agent) if agent else next((l.strip() for l in reversed(lines) if l.strip()), ""),
        })
    return panes


def border_row(p):
    """Which edge of the window holds tmux's pane title row next to this pane: "top", "bottom" or None.
    Only from tmux's own option and geometry. The phone hides that row, as it shows one pane at a time."""
    top, height, window_height = int(p["pane_top"]), int(p["pane_height"]), int(p["window_height"])
    if p["pane-border-status"] == "top" and top == 1:
        return "top"
    if p["pane-border-status"] == "bottom" and top + height == window_height - 1:
        return "bottom"
    return None


def pane_info(pane, *fields):
    return tmux("display-message", "-p", "-t", pane, "\x1f".join(f"#{{{f}}}" for f in fields)).rstrip("\n").split("\x1f")


def open_pane(pane):
    """Show one pane full screen on the phone: switch the phone's session to it, and zoom it if its window is split.
    The window is named through the viewer; a bare %pane could pick the Mac's session and switch the Mac."""
    ensure_viewer()
    window = pane_info(pane, "window_id")[0]
    save_desktop_layout(window)
    tmux("set-option", "-wu", "-t", window, "@phone_split")
    tmux("select-window", "-t", f"={VIEWER}:{window}")
    tmux("select-pane", "-t", pane)
    panes, zoomed = pane_info(pane, "window_panes", "window_zoomed_flag")
    if panes != "1" and zoomed == "0":
        tmux("resize-pane", "-Z", "-t", pane)
    fields = ["pane_top", "pane_height", "window_height", "pane-border-status"]
    return border_row(dict(zip(fields, pane_info(pane, *fields))))


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


def valid_session_name(name):
    """tmux uses . and : in targets, so a session name can't have them; _phone is the viewer's."""
    return valid_name(name) and not any(c in name for c in ".:") and name != VIEWER


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


def toggle_split(pane):
    """[desktop panes] shows the window split as on the Mac; [one pane] zooms the pane again. Returns True if split."""
    window = pane_info(pane, "window_id")[0]
    split = pane_info(window, "@phone_split") != ["1"]
    tmux("set-option", "-w", "-t", window, "@phone_split", "1" if split else "0")
    panes, zoomed = pane_info(pane, "window_panes", "window_zoomed_flag")
    if panes != "1" and zoomed == ("1" if split else "0"):
        tmux("resize-pane", "-Z", "-t", pane)
    return split


# The file screen: folders and text files on the Mac, read and written as UTF-8.
def pane_folder(pane):
    return pane_info(pane, "pane_current_path")[0]


def full_path(path, pane):
    """An absolute path. ~ is the home folder; a relative path, or none, starts at the pane's folder."""
    path = os.path.expanduser(path or "")
    if not os.path.isabs(path):
        path = os.path.join(pane_folder(pane) if pane else str(Path.home()), path)
    return os.path.normpath(path)


def list_folder(path):
    """Folders first, then the rest, each sorted by name. Hidden files are listed too."""
    with os.scandir(path) as it:
        entries = [{"name": e.name, "folder": e.is_dir()} for e in it]
    entries.sort(key=lambda e: (not e["folder"], e["name"].lower(), e["name"]))
    return {"path": path, "parent": os.path.dirname(path), "entries": entries}


def read_file(path):
    """The file's text and its mtime, or a one-line note instead of text for a big, binary or non-UTF-8 file.
    The mtime is a string: nanoseconds don't fit in a JavaScript number."""
    st = os.stat(path)
    out = {"path": path, "mtime": str(st.st_mtime_ns)}
    if st.st_size > MAX_FILE:
        return {**out, "note": f"too big to show: {st.st_size / 1024 / 1024:.1f} MB"}
    data = Path(path).read_bytes()
    if b"\0" in data[:8192]:
        return {**out, "note": "binary file, not shown"}
    try:
        return {**out, "text": data.decode("utf-8")}
    except UnicodeDecodeError as e:
        return {**out, "note": f"not UTF-8, not shown: {e}"}


def write_file(path, text, mtime):
    """Write the file, unless it changed on disk since the phone read it. Returns the new mtime, or None if it changed."""
    if str(os.stat(path).st_mtime_ns) != mtime:
        return None
    Path(path).write_bytes(text.encode("utf-8"))
    reload_in_nvim(path)
    return str(os.stat(path).st_mtime_ns)


# nvim 0.9+ opens a server socket by itself at $TMPDIR/nvim.$USER/<random>/nvim.<pid>.0. In a terminal, nvim is two
# processes: the screen one on the tty, and its child that holds the file and the socket.
def nvim_sockets(pids=None):
    found = glob.glob(os.path.join(os.environ.get("TMPDIR", "/tmp"), "nvim.*", "*", "nvim.*.0"))
    return [s for s in found if pids is None or s.split(".")[-2] in pids]


def nvim(socket_path, expr):
    """Ask a running nvim for the value of a Vim expression."""
    r = subprocess.run(["nvim", "--server", socket_path, "--remote-expr", expr], capture_output=True, text=True, timeout=3)
    return r.stdout if r.returncode == 0 else None


def nvim_file(pane):
    """The file open in the nvim that is the pane's foreground process, or None."""
    tty = pane_info(pane, "pane_tty")[0].removeprefix("/dev/")
    rows = [line.split(None, 4) for line in
            subprocess.run(["ps", "-A", "-o", "pid=,ppid=,tty=,stat=,comm="], capture_output=True, text=True,
                           env={"LC_ALL": "C"}).stdout.splitlines()]
    rows = [r for r in rows if len(r) == 5]
    front = {r[0] for r in rows if r[2] == tty and "+" in r[3] and os.path.basename(r[4]) == "nvim"}
    if not front:
        return None
    pids = front | {r[0] for r in rows if r[1] in front}
    for s in nvim_sockets(pids):
        try:
            path = nvim(s, 'expand("%:p")')
        except (OSError, subprocess.TimeoutExpired):
            continue
        if path and os.path.isfile(path):
            return path
    return None


def reload_in_nvim(path):
    """After a save from the phone, every nvim with that file open reloads it (:checktime). It runs on a timer
    inside nvim, so a question nvim asks there (the buffer has its own changes too) can't hold up the save."""
    name = path.replace("'", "''")
    expr = f"timer_start(0, {{-> execute(map(filter(getbufinfo(), {{_, b -> b.name ==# '{name}'}}), {{_, b -> 'checktime ' .. b.bufnr}}))}})"
    for s in nvim_sockets():
        try:
            nvim(s, expr)
        except (OSError, subprocess.TimeoutExpired):
            pass


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
                target = ensure_viewer()
                panes = list_panes()
                return self.reply(200, {"panes": panes, "sessions": sessions_for_phone(target),
                                        "version": version(INDEX.read_bytes()), "dictation": DICTATION})
            url = urlsplit(self.path)
            if url.path in ("/api/files", "/api/file"):
                query = {k: v[0] for k, v in parse_qs(url.query).items()}
                pane = f"%{query['pane']}" if query.get("pane", "").isdigit() else None
                if url.path == "/api/file":
                    return self.reply(200, read_file(full_path(query.get("path"), pane)))
                # With no path, the pane's folder, and the file open in the pane's nvim if there is one.
                folder = list_folder(full_path(query.get("path"), pane))
                return self.reply(200, folder if query.get("path") else {**folder, "nvim_file": pane and nvim_file(pane)})
            self.reply(404, {"error": "not found"})
        except TmuxError as e:
            self.reply(502, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as e:
            self.reply(400, {"error": str(e)})
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
        limit = MAX_IMAGES * 4 // 3 + MAX_BODY if self.path.endswith("/paste") else MAX_BODY
        if self.path == "/api/file":
            limit = 2 * MAX_FILE + MAX_BODY  # JSON escapes can make the text longer
        if length > limit:
            return self.reply(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/api/file":
                path, text, mtime = body.get("path"), body.get("text"), body.get("mtime")
                if not all(isinstance(v, str) for v in (path, text, mtime)) or not os.path.isabs(path):
                    return self.reply(400, {"error": "bad save"})
                new_mtime = write_file(path, text, mtime)
                if new_mtime is None:
                    return self.reply(409, {"error": "Not saved: the file changed on disk after you opened it. Go back and open it again."})
                return self.reply(200, {"mtime": new_mtime})
            if self.path == "/api/windows":
                ensure_viewer()  # the new window joins the group, so the Mac has it too
                return self.reply(200, {"pane": tmux("new-window", "-t", f"={VIEWER}:", "-P", "-F", "#{pane_id}").strip().lstrip("%")})
            if self.path == "/api/sessions":
                with viewer_lock():
                    target = new_real_session()
                    group_viewer(target)
                return self.reply(200, {"session": target.lstrip("$")})
            m = SESSION_ROUTE.match(self.path)
            if m:
                return self.session_action(f"${m[1]}", m[2], body)
            m = WINDOW_ROUTE.match(self.path)
            if m:
                window, action = f"@{m[1]}", m[2]
                if action == "panes":
                    return self.reply(200, {"pane": add_pane(window)})
                if action == "close":
                    tmux("kill-window", "-t", window)
                    return self.reply(200, {"ok": True})
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
                return self.reply(200, {"ok": True, "border": open_pane(pane)})
            elif action == "split":
                return self.reply(200, {"split": toggle_split(pane)})
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
        except OSError as e:
            self.reply(400, {"error": str(e)})
        except Exception:
            traceback.print_exc()
            self.reply(500, {"error": "server error"})

    def session_action(self, session, action, body):
        """Switch the phone to a real session, rename it, or close it. Closing the target moves the phone to another."""
        if session not in {s["session_id"] for s in list_sessions() if s["session_name"] != VIEWER}:
            return self.reply(404, {"error": f"can't find session {session}"})
        if action == "rename":
            if not valid_session_name(body.get("name")):
                return self.reply(400, {"error": "bad name: a session name can't have . or :"})
            tmux("rename-session", "-t", session, "--", tmux_literal(body["name"]))
            return self.reply(200, {"ok": True})
        with viewer_lock():
            if action == "switch":
                if fix_viewer() != session:
                    group_viewer(session)
            else:
                # The viewer still holds a killed target's windows; fix_viewer then kills it and its copy of them.
                tmux("kill-session", "-t", session)
                fix_viewer()
        self.reply(200, {"ok": True})

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
        # What ttyd runs for each terminal connection: attach to the viewer, made again if it is gone.
        ensure_viewer()
        set_layout_hooks()
        save_desktop_layout(pane_info(f"={VIEWER}:", "window_id")[0])
        os.execvp("tmux", ["tmux", "attach", "-t", f"={VIEWER}"])
    if sys.argv[1:2] == ["restore"]:
        # What the window-resized hook runs: tmux-phone restore @3
        restore_desktop_layout(sys.argv[2])
        sys.exit()
    if not (PUBLIC_ORIGIN and ALLOWED_LOGIN):
        sys.exit("TMUX_PHONE_ORIGIN and TMUX_PHONE_LOGIN must be set; run ./install.sh")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    kill_old_viewer()
    start_ttyd()
    if DICTATION:
        start_whisper()
    keep_awake()
    print(f"tmux-phone on http://{HOST}:{PORT} for {ALLOWED_LOGIN} at {PUBLIC_ORIGIN}", flush=True)
    Server((HOST, PORT), Handler).serve_forever()
