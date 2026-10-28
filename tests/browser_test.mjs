#!/usr/bin/env node
// Drives the phone page in WebKit as an iPhone, against a private copy of the app.
//
// It never touches your real tmux: the server runs with its own HOME and TMUX_TMPDIR, so every
// tmux call, ttyd's attach to the phone's session included, talks to a private tmux server made here.
//
// Each check asserts what you would see on the phone, or what the pane shows on the Mac.
//
// Usage: cd tests && npm ci && npx playwright install webkit && node browser_test.mjs

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit, devices } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGIN = "test@example.com";
const MODEL = path.join(os.homedir(), ".local/state/tmux-phone/models/ggml-large-v3-turbo-q5_0.bin");
const PROMPT = "phone$ ";
const RECONNECT_PROMPT = "Press ⏎ to Reconnect";
// A 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Short base path: tmux and ttyd sockets live under it, and Unix socket paths max out near 104 bytes.
const base = fs.mkdtempSync("/tmp/tmux-phone-test-");
const home = path.join(base, "home");
const state = path.join(home, ".local/state/tmux-phone");
const tmuxDir = path.join(base, "tmux");
// The server runs from a copy of the app, so a check can change the page without touching the repo.
const app = path.join(base, "app");
fs.cpSync(path.join(REPO, "server.py"), path.join(app, "server.py"));
fs.cpSync(path.join(REPO, "static"), path.join(app, "static"), { recursive: true });
const appIndex = path.join(app, "static/index.html");
fs.mkdirSync(path.join(state, "models"), { recursive: true });
fs.mkdirSync(tmuxDir);

// Env for the server and for every tmux call here. TMUX is dropped, or tmux would use the socket of the
// session this test may be running in.
const env = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxDir, PS1: PROMPT, ENV: "" };
for (const k of ["TMUX", "TMUX_PANE", "XDG_CONFIG_HOME"]) delete env[k];

const tmux = (...args) => execFileSync("tmux", args, { env, encoding: "utf8" });
const paneInfo = (pane, field) => tmux("display-message", "-p", "-t", pane, `#{${field}}`).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The current window of a session; `=` matches the session name exactly.
const currentWindow = (session) => tmux("display-message", "-p", "-t", `=${session}:`, "#{window_id}").trim();

let server = null, serverLog = "";
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`✗ ${name}: ${e.message}`);
  }
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    }).on("error", reject);
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); }).on("error", () => resolve(false));
  });
}

function startServer(port, whisperPort) {
  // Its own process group, so one kill stops it with ttyd and whisper-server.
  server = spawn("python3", [path.join(app, "server.py")], {
    env: { ...env, TMUX_PHONE_PORT: String(port), TMUX_PHONE_WHISPER_PORT: String(whisperPort),
           TMUX_PHONE_ORIGIN: `http://127.0.0.1:${port}`, TMUX_PHONE_LOGIN: LOGIN },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  return waitFor(() => canConnect(port), 15000, `the server on port ${port}`);
}

async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  const exited = new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null) ? r() : proc.once("exit", r));
  try { process.kill(-proc.pid, "SIGTERM"); } catch {}
  await Promise.race([exited, sleep(3000)]);
  try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  await sleep(300);  // let ttyd and whisper-server go before anything reuses their socket and port
}

// The phone's sessions as the page has them, from its last list poll.
const pageSessions = (page) => page.evaluate(() => sessions);
const currentName = async (page) => ((await pageSessions(page)).find((s) => s.current) || {}).name;
// Real sessions in tmux, the viewer left out.
const realSessions = () => execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter((n) => n && n !== "_phone");
// The real session the viewer is grouped with.
const viewerGroupMate = () => {
  const rows = tmux("list-sessions", "-F", "#{session_name}\t#{session_grouped}\t#{session_group}").trim().split("\n").map((r) => r.split("\t"));
  const viewer = rows.find((r) => r[0] === "_phone");
  return viewer && viewer[1] === "1" ? (rows.find((r) => r[0] !== "_phone" && r[1] === "1" && r[2] === viewer[2]) || [])[0] : undefined;
};

// The terminal rows inside #term-wrap's box, which is what shows on the phone.
const visibleText = (page) => page.evaluate(() => {
  const wrap = $("term-wrap").getBoundingClientRect();
  return [...document.querySelectorAll(".xterm-rows > div")].filter((r) => {
    const b = r.getBoundingClientRect();
    return b.top >= wrap.top - 0.5 && b.bottom <= wrap.bottom + 0.5;
  }).map((r) => r.textContent.replace(/\u00a0/g, " ")).join("\n");
});

// What the phone's terminal shows: xterm's rendered rows, one line per row.
const screenText = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent.replace(/ /g, " ")).join("\n"));

// A finger dragging down the middle of the terminal. WebKit builds touches the old iOS way, with createTouch.
async function swipeDown(page, px) {
  await page.evaluate(async (px) => {
    const box = document.querySelector(".xterm").getBoundingClientRect();
    const x = box.left + box.width / 2, y0 = box.top + box.height * 0.3;
    const target = document.elementFromPoint(x, y0);
    const fire = (type, y) => {
      const t = document.createTouch(window, target, 1, x, y, x, y);
      const touches = type === "touchend" ? document.createTouchList() : document.createTouchList(t);
      target.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: document.createTouchList(t),
                                                  bubbles: true, cancelable: true, composed: true }));
    };
    fire("touchstart", y0);
    for (let i = 1; i <= 15; i++) {
      fire("touchmove", y0 + (px * i) / 15);
      await new Promise((r) => setTimeout(r, 16));
    }
    fire("touchend", y0 + px);
  }, px);
}

// Two fingers spreading apart vertically from the middle of the terminal, or of another element. The first finger
// moves down, so a page that took it for a one-finger swipe would send wheel-up and scroll the pane back.
async function pinchOut(page, px, selector = ".xterm") {
  await page.evaluate(async ([px, selector]) => {
    const box = document.querySelector(selector).getBoundingClientRect();
    const x = box.left + box.width / 2, yc = box.top + box.height / 2;
    const target = document.elementFromPoint(x, yc);
    const touch = (id, y) => document.createTouch(window, target, id, x, y, x, y);
    const fire = (type, touches, changed) => {
      const list = document.createTouchList(...touches);
      target.dispatchEvent(new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: document.createTouchList(...changed),
                                                  bubbles: true, cancelable: true, composed: true }));
    };
    let a = touch(1, yc + 20), b = touch(2, yc - 20);
    fire("touchstart", [a], [a]);
    fire("touchstart", [a, b], [b]);
    for (let i = 1; i <= 15; i++) {
      a = touch(1, yc + 20 + (px * i) / 15);
      b = touch(2, yc - 20 - (px * i) / 15);
      fire("touchmove", [a, b], [a, b]);
      await new Promise((r) => setTimeout(r, 16));
    }
    fire("touchend", [a], [b]);
    fire("touchend", [], [a]);
  }, [px, selector]);
}

async function main() {
  assert(fs.existsSync(MODEL), `whisper model missing at ${MODEL}; run ./install.sh once`);
  fs.symlinkSync(MODEL, path.join(state, "models/ggml-large-v3-turbo-q5_0.bin"));

  // A private tmux server with one `sh` window and 300 lines of history to scroll back through.
  // The mouse is on, as on the Mac: a swipe is sent as wheel input, and tmux decides what it scrolls.
  tmux("new-session", "-d", "-s", "test", "-n", "phone", "-x", "80", "-y", "24", "sh");
  tmux("set", "-g", "mouse", "on");
  const pane = tmux("display-message", "-p", "-t", "test:phone", "#{pane_id}").trim();
  const paneId = pane.slice(1);
  tmux("send-keys", "-t", pane, "clear; i=1; while [ $i -le 300 ]; do echo history line $i; i=$((i+1)); done", "Enter");
  await waitFor(() => tmux("capture-pane", "-p", "-t", pane).includes("history line 300"), 5000, "the history to print");

  // An old viewer from before _phone: a session named phone, grouped with the Mac's. The server kills it on start.
  tmux("new-session", "-d", "-s", "phone", "-t", "test");

  const port = await freePort(), whisperPort = await freePort();
  await startServer(port, whisperPort);

  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"], baseURL: `http://127.0.0.1:${port}`, extraHTTPHeaders: { "Tailscale-User-Login": LOGIN },
    });
    const page = await context.newPage();
    // Note the moment ttyd's "press Enter" prompt shows anywhere on the page, even briefly.
    await page.addInitScript((text) => {
      window.__sawReconnectPrompt = false;
      new MutationObserver(() => {
        if (document.body && document.body.textContent.includes(text)) window.__sawReconnectPrompt = true;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, RECONNECT_PROMPT);
    // Playwright can't grant WebKit clipboard access, so the clipboard holds one PNG, as after "Copy and Delete".
    await page.addInitScript((b64) => {
      const png = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      navigator.clipboard.read = async () => [new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })];
    }, PNG_B64);
    await page.goto("/");
    await page.tap(`button[data-pane="${paneId}"]`);

    await check("opening the pane shows its text in the terminal", async () => {
      await waitFor(async () => (await screenText(page)).includes("history line 300"), 10000,
                    "'history line 300' in the terminal");
    });

    await check("the old grouped phone viewer is gone; _phone is grouped with the Mac's session", async () => {
      assert(!realSessions().includes("phone"), `sessions: ${realSessions()}`);
      assert(viewerGroupMate() === "test", `_phone is grouped with ${viewerGroupMate()}`);
    });

    await check("the phone's terminal has no tmux status row; the Mac session's status line is unchanged", async () => {
      assert(tmux("show-options", "-v", "-t", "=_phone:", "status").trim() === "off", "session _phone has its status line on");
      assert(tmux("show-options", "-v", "-t", "=test:", "status").trim() === "", "the Mac session's status option was changed");
      // tmux's default status line starts with [session name].
      const screen = await screenText(page);
      assert(!/\[(_phone|test)\]/.test(screen), `the terminal shows a status line:\n${screen}`);
    });

    await check("the strip sits below the key bar and a dim line, and names the open pane's window in its top part", async () => {
      await waitFor(async () => (await page.textContent("#statusline")) === `${paneInfo(pane, "window_index")}: ${paneInfo(pane, "window_name")}`,
                    5000, `the window's name in the strip (shows ${JSON.stringify(await page.textContent("#statusline"))})`);
      const centered = await page.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents($("statusline"));
        const t = r.getBoundingClientRect(), s = $("statusline").getBoundingClientRect();
        return Math.abs((t.left + t.right) / 2 - (s.left + s.right) / 2) <= 2 && t.top >= s.top && t.bottom <= s.top + 20;
      });
      assert(centered, "the name is not centered across the strip, in its top 20px");
      const border = await page.evaluate(() => {
        const st = getComputedStyle($("statusline"));
        return st.borderTopWidth + " " + st.borderTopColor;
      });
      assert(border === "1px rgb(87, 88, 79)", `the strip's top line is ${border}`);
      const bar = await page.locator("#keys .bar").boundingBox(), strip = await page.locator("#statusline").boundingBox();
      const height = page.viewportSize().height;
      assert(strip.y >= bar.y + bar.height - 1 && Math.abs(strip.y + strip.height - height) <= 1 && strip.height >= 20,
             `key bar ${JSON.stringify(bar)}, strip ${JSON.stringify(strip)}, screen height ${height}`);
    });

    await check("opening a pane in another window moves the phone's current window, not the Mac's", async () => {
      const other = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "test:", "-n", "other", "sh").trim();
      const otherWindow = paneInfo(other, "window_id"), macWindow = currentWindow("test");
      assert(otherWindow !== macWindow, "the new window is already the Mac's current window");
      await page.tap("#back");
      await page.tap(`button[data-pane="${other.slice(1)}"]`);
      await waitFor(() => currentWindow("_phone") === otherWindow, 5000, `phone's current window ${otherWindow} (is ${currentWindow("_phone")})`);
      assert(currentWindow("test") === macWindow, `the Mac's current window moved to ${currentWindow("test")}`);
      await page.tap("#back");
      tmux("kill-pane", "-t", other);
      await page.waitForSelector(`button[data-pane="${other.slice(1)}"]`, { state: "detached" });
      await page.tap(`button[data-pane="${paneId}"]`);
      await page.waitForSelector("#pane:not(.hidden)");
    });

    await check("swiping down on the terminal scrolls the pane back", async () => {
      await swipeDown(page, 300);
      await waitFor(() => paneInfo(pane, "pane_in_mode") === "1" && Number(paneInfo(pane, "scroll_position")) > 0, 5000,
                    `the pane to be scrolled back (pane_in_mode=${paneInfo(pane, "pane_in_mode")}, ` +
                    `scroll_position=${paneInfo(pane, "scroll_position") || "none"})`);
    });

    await check("tapping Enter while scrolled back leaves scroll mode", async () => {
      assert(paneInfo(pane, "pane_in_mode") === "1", "pane was not scrolled back before the tap");
      await page.tap('[data-key="enter"]');
      await waitFor(() => paneInfo(pane, "pane_in_mode") === "0", 5000, "pane_in_mode=0");
    });

    await check("a swipe scrolls about as many lines as the finger moves rows; [↓ bottom] goes back and hides", async () => {
      assert(paneInfo(pane, "pane_in_mode") === "0", "pane is already scrolled back");
      const rowPx = await page.evaluate(() => document.querySelector(".xterm-screen").getBoundingClientRect().height / term.rows);
      const px = 450, expected = px / rowPx;
      await swipeDown(page, px);
      await sleep(500);
      const got = Number(paneInfo(pane, "scroll_position"));
      assert(Math.abs(got - expected) <= 5, `swiped ${px}px at ${rowPx.toFixed(1)}px a row: expected ~${expected.toFixed(1)} lines, scrolled ${got}`);
      assert(await page.locator("#to-bottom").isVisible(), "[↓ bottom] is not showing");
      assert((await page.textContent("#to-bottom")) === "↓ bottom", `label is ${await page.textContent("#to-bottom")}`);
      await page.tap("#to-bottom");
      await waitFor(() => paneInfo(pane, "pane_in_mode") === "0" || paneInfo(pane, "scroll_position") === "0", 5000,
                    `the bottom (pane_in_mode=${paneInfo(pane, "pane_in_mode")}, scroll_position=${paneInfo(pane, "scroll_position")})`);
      assert(!(await page.locator("#to-bottom").isVisible()), "[↓ bottom] still shows");
    });

    await check("swiping in an app that reads the mouse sends it the wheel, not tmux scroll mode", async () => {
      // A small stand-in for Claude Code: alternate screen, SGR mouse codes on, and it logs what it gets.
      const log = path.join(base, "app-input.log");
      const app = `import os, sys, tty; sys.stdout.write("\\x1b[?1049h\\x1b[?1000h\\x1b[?1006happ ready"); ` +
                  `sys.stdout.flush(); tty.setraw(0); f = open("${log}", "ab", 0); ` +
                  `[f.write(os.read(0, 1024)) for _ in iter(int, 1)]`;
      const appPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "test", "-n", "app",
                           "python3", "-c", app).trim();
      await waitFor(() => paneInfo(appPane, "mouse_sgr_flag") === "1", 5000, "the app to turn on the mouse");
      await page.tap("#back");
      await page.tap(`button[data-pane="${appPane.slice(1)}"]`);
      await waitFor(async () => (await screenText(page)).includes("app ready"), 10000, "'app ready' in the terminal");
      await swipeDown(page, 300);
      await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, "latin1").includes("\x1b[<64;"), 5000,
                    `wheel-up codes in the app's input (got ${JSON.stringify(fs.existsSync(log) ? fs.readFileSync(log, "latin1") : "")})`);
      assert(paneInfo(appPane, "pane_in_mode") === "0", "the pane went into tmux scroll mode");
      await page.tap("#back");
      tmux("kill-pane", "-t", appPane);
      await page.waitForSelector(`button[data-pane="${appPane.slice(1)}"]`, { state: "detached" });
      await page.tap(`button[data-pane="${paneId}"]`);
      await page.waitForSelector("#pane:not(.hidden)");
    });

    await check("the terminal comes back by itself after the server restarts", async () => {
      await stopServer();
      await waitFor(() => page.evaluate(() => socket.readyState !== WebSocket.OPEN), 10000, "the terminal connection to drop");
      await startServer(port, whisperPort);
      // A line printed after the restart can only show up over a new connection.
      const marker = `after restart ${Date.now()}`;
      tmux("send-keys", "-t", pane, `echo ${marker}`, "Enter");
      await waitFor(async () => (await screenText(page)).includes(`\n${marker}`), 10000, `'${marker}' in the terminal`);
      assert(!(await page.evaluate(() => window.__sawReconnectPrompt)), `the page showed "${RECONNECT_PROMPT}"`);
    });

    await check("without the speech model the mic is hidden, and with it the mic shows", async () => {
      const link = path.join(state, "models/ggml-large-v3-turbo-q5_0.bin");
      assert(await page.isVisible("#mic"), "the mic is hidden while dictation is on");
      await stopServer();
      fs.unlinkSync(link);
      await startServer(port, whisperPort);
      await waitFor(async () => !(await page.isVisible("#mic")), 10000, "the mic to hide");
      await stopServer();
      fs.symlinkSync(MODEL, link);
      await startServer(port, whisperPort);
      await waitFor(() => page.isVisible("#mic"), 10000, "the mic to show again");
    });

    await check("tapping a key bar button keeps the keyboard on the terminal", async () => {
      await page.focus(".xterm-helper-textarea");
      await page.tap('[data-key="1"]');
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).includes(`${PROMPT}1`), 5000, "the tapped 1 in the pane");
      tmux("send-keys", "-t", pane, "C-u");
      const active = await page.evaluate(() => document.activeElement.className || document.activeElement.tagName);
      assert(active.includes("xterm-helper-textarea"), `focus moved to ${active}`);
    });

    await check("Ctrl, then c typed on the keyboard, stops a running command", async () => {
      const shell = paneInfo(pane, "pane_current_command");
      tmux("send-keys", "-t", pane, "sleep 30", "Enter");
      await waitFor(() => paneInfo(pane, "pane_current_command") === "sleep", 5000, "sleep to start");
      await page.focus(".xterm-helper-textarea");
      await page.tap('[data-mod="ctrl"]');
      assert(await page.locator('[data-mod="ctrl"].armed').count(), "Ctrl does not show armed");
      await page.keyboard.type("c");
      await waitFor(() => paneInfo(pane, "pane_current_command") === shell, 3000,
                    `sleep to stop (pane runs ${paneInfo(pane, "pane_current_command")})`);
      assert(!(await page.locator('[data-mod="ctrl"].armed').count()), "Ctrl is still armed after one key");
    });

    // Clears the pane, runs send, then expects one prompt line holding a saved uploads/ path, not run.
    async function expectPastedPath(send) {
      tmux("send-keys", "-t", pane, "clear", "Enter");
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).trim() === PROMPT.trim(), 5000, "a clear prompt");
      await send();
      const uploads = path.join(state, "uploads");
      const lines = await waitFor(() => {
        const l = tmux("capture-pane", "-p", "-J", "-t", pane).split("\n").filter((s) => s.trim());
        return l.some((s) => s.includes(uploads)) && l;
      }, 10000, `a path under ${uploads} in the pane`);
      await sleep(1000);  // give a stray Enter time to run the path
      const now = tmux("capture-pane", "-p", "-J", "-t", pane).split("\n").filter((s) => s.trim());
      assert(now.length === 1 && now[0].startsWith(PROMPT) && now[0].includes(uploads),
             `expected one unexecuted prompt line with the path, pane shows:\n${now.join("\n")}`);
      const pasted = now[0].slice(PROMPT.length).trim();
      assert(fs.existsSync(pasted), `pasted path ${pasted} is not a saved file (first seen: ${lines.join(" | ")})`);
      tmux("send-keys", "-t", pane, "C-u");
    }

    await check("a photo pastes its saved path into the pane without pressing Enter", async () => {
      await expectPastedPath(() => page.setInputFiles("#file", { name: "dot.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") }));
    });

    await check("[photo] opens the file picker straight away, and the picked image's path is pasted", async () => {
      await expectPastedPath(async () => {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 3000 }), page.tap("#attach")]);
        await chooser.setFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") });
      });
    });

    await check("[paste] pastes the clipboard image's saved path without pressing Enter", async () => {
      await expectPastedPath(() => page.tap("#paste"));
    });

    await check("[paste] pastes multi-line clipboard text as one paste, with nothing submitted", async () => {
      // zsh takes a bracketed paste into its line editor and runs nothing until Enter; sh would run each line.
      const text = "echo PASTED_ONE\necho PASTED_TWO";
      await page.evaluate((t) => {
        navigator.clipboard.read = async () => [new ClipboardItem({ "text/plain": new Blob([t], { type: "text/plain" }) })];
      }, text);
      const shell = paneInfo(pane, "pane_current_command");
      tmux("send-keys", "-t", pane, "clear; zsh -f", "Enter");
      await waitFor(() => paneInfo(pane, "pane_current_command") === "zsh", 5000, "zsh to start");
      tmux("send-keys", "-t", pane, "clear", "Enter");
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).trim() === PROMPT.trim(), 5000, "a clear zsh prompt");
      await page.tap("#paste");
      const want = `${PROMPT}${text}`;
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).trimEnd() === want, 5000, "the pasted text in the pane");
      await sleep(1000);  // give a stray Enter time to run a line
      const now = tmux("capture-pane", "-p", "-t", pane).trimEnd();
      assert(now === want, `expected only the unsubmitted paste, pane shows:\n${now}`);
      assert((await page.locator("#paste").textContent()) === "paste", "[paste] still shows the dots");
      tmux("send-keys", "-t", pane, "C-c");
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).trimEnd().endsWith(`\n${PROMPT.trim()}`), 5000, "a fresh zsh prompt");
      tmux("send-keys", "-t", pane, "exit", "Enter");
      await waitFor(() => paneInfo(pane, "pane_current_command") === shell, 5000,
                    `zsh to exit, pane shows:\n${tmux("capture-pane", "-p", "-t", pane)}`);
    });

    await check("the pane view has no message box and no Send button", async () => {
      assert(await page.locator("#pane").isVisible(), "the pane view is not showing");
      // xterm's own hidden textarea takes the keyboard; it is not a message box.
      const boxes = await page.locator("#pane textarea:not(.xterm-helper-textarea)").count();
      const sends = await page.locator("#pane").getByRole("button", { name: /^send$/i }).count() + await page.locator("#send").count();
      assert(!boxes && !sends, `found ${boxes} textarea(s) and ${sends} Send button(s)`);
    });

    await check("pinching out grows the font, tmux gets fewer columns, and no wheel input is sent", async () => {
      // Note every wheel code the page sends from here on.
      await page.evaluate(() => {
        window.__wheels = 0;
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (new TextDecoder().decode(data).includes("\x1b[<6")) window.__wheels++;
          return send.call(this, data);
        };
      });
      const clientWidth = () => Number(tmux("list-clients", "-F", "#{client_width}").trim().split("\n")[0]);
      const size0 = await page.evaluate(() => term.options.fontSize), cols0 = clientWidth();
      await pinchOut(page, 40);
      const size1 = await page.evaluate(() => term.options.fontSize);
      assert(size1 > size0, `font size went from ${size0} to ${size1}`);
      await waitFor(() => clientWidth() < cols0, 5000, `the tmux client to get narrower than ${cols0} columns (now ${clientWidth()})`);
      assert(await page.evaluate(() => localStorage.getItem("tmux-phone.fontSize")) === String(size1), "the size was not saved");
      await sleep(500);
      assert(!(await page.evaluate(() => window.__wheels)), "the pinch sent wheel input");
      assert(paneInfo(pane, "pane_in_mode") === "0", "the pane went into tmux scroll mode");
    });

    // Rows the terminal box has room for, and rows the terminal has.
    const termRows = () => page.evaluate(() => {
      const rowPx = document.querySelector(".xterm-screen").getBoundingClientRect().height / term.rows;
      return { rows: term.rows, fit: Math.floor($("term-wrap").clientHeight / rowPx + 0.01) };
    });

    await check("with pane-border-status top, the title row is hidden and the pane's first line shows", async () => {
      tmux("select-pane", "-t", pane, "-T", "bordertitle");
      tmux("send-keys", "-t", pane, "clear; echo first-content-line", "Enter");
      tmux("set-option", "-w", "-t", pane, "pane-border-status", "top");
      await waitFor(async () => (await termRows()).rows === (await termRows()).fit + 1, 10000,
                    `one extra terminal row (${JSON.stringify(await termRows())})`);
      await waitFor(async () => (await screenText(page)).includes("bordertitle"), 5000, "tmux to draw the title row");
      await waitFor(async () => (await visibleText(page)).includes("first-content-line"), 5000, "the first line on screen");
      const visible = await visibleText(page);
      assert(!visible.includes("bordertitle"), `the title row shows:\n${visible}`);
    });

    await check("with pane-border-status off, nothing is cropped", async () => {
      tmux("set-option", "-w", "-t", pane, "pane-border-status", "off");
      await waitFor(async () => (await termRows()).rows === (await termRows()).fit, 10000,
                    `terminal rows equal to visible rows (${JSON.stringify(await termRows())})`);
      const top = () => tmux("capture-pane", "-p", "-t", pane).split("\n")[0].trim();
      await waitFor(async () => (await visibleText(page)).split("\n")[0].trim() === top(), 5000,
                    `the pane's top line ${JSON.stringify(top())} on the phone's top row (${JSON.stringify((await visibleText(page)).split("\n")[0])})`);
      assert((await visibleText(page)).includes("first-content-line"), "the first content line is not on screen");
      tmux("set-option", "-wu", "-t", pane, "pane-border-status");
    });

    // A folder for the file screen, and the pane's shell in it. tmux reports /tmp as /private/tmp, so compare real paths.
    const proj = path.join(fs.realpathSync(base), "project-folder");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".hidden"), "secret\n");
    fs.writeFileSync(path.join(proj, "a.txt"), "plain text\n");
    fs.writeFileSync(path.join(proj, "b.py"), "def hello():\n    return 'hi'  # greet\n");
    fs.writeFileSync(path.join(proj, "Big.log"), Buffer.alloc(3 * 1024 * 1024, 97));
    fs.writeFileSync(path.join(proj, "nul.dat"), Buffer.from("ab\0cd"));
    const bpy = path.join(proj, "b.py");
    const entryLabels = () => page.evaluate(() => [...document.querySelectorAll("#folder .entry")].map((b) => b.textContent));
    const tapEntry = (label) => page.tap(`#folder .entry:text-is("${label}")`);
    const fileText = () => page.evaluate(() => file && file.view ? file.view.state.doc.toString() : null);

    await check("[files] opens the pane's folder: .. first, then folders, then files by name, hidden files too", async () => {
      tmux("send-keys", "-t", pane, `cd '${proj}'; clear`, "Enter");
      await waitFor(() => paneInfo(pane, "pane_current_path") === proj, 5000, `the pane in ${proj} (is ${paneInfo(pane, "pane_current_path")})`);
      const labels = await page.evaluate(() => [...document.querySelectorAll("#pane-header button")].map((b) => b.textContent));
      assert(JSON.stringify(labels) === JSON.stringify(["‹ Panes", "desktop panes", "files", "Close"]), `pane header buttons: ${labels}`);
      await page.tap("#files-open");
      await page.waitForSelector("#files:not(.hidden) #folder .entry");
      const got = await entryLabels(), want = ["..", "sub/", ".hidden", "a.txt", "b.py", "Big.log", "nul.dat"];
      assert(JSON.stringify(got) === JSON.stringify(want), `rows: ${JSON.stringify(got)}`);
    });

    await check("the folder's path is at the top, cut from the left so its end shows", async () => {
      const t = await page.evaluate(() => {
        const h = $("files-title"), r = document.createRange(), text = h.firstChild;
        r.setStart(text, text.length - "project-folder".length);
        r.setEnd(text, text.length);
        const e = r.getBoundingClientRect(), b = h.getBoundingClientRect();
        return { text: h.textContent, cut: h.scrollWidth > h.clientWidth, endShows: e.left >= b.left - 1 && e.right <= b.right + 1 };
      });
      assert(t.text.endsWith(proj), `title is ${JSON.stringify(t.text)}`);
      assert(t.endShows, `the end of the path is not on screen: ${JSON.stringify(t)}`);
    });

    await check("[‹ back] on a folder goes into it and back out with .., then [‹ back] returns to the pane", async () => {
      await tapEntry("sub/");
      await waitFor(async () => JSON.stringify(await entryLabels()) === '[".."]', 5000, `sub's rows (${await entryLabels()})`);
      assert((await page.textContent("#files-title")).endsWith("/sub"), "the title is not sub's path");
      await tapEntry("..");
      await waitFor(async () => (await entryLabels()).includes("b.py"), 5000, "the project folder again");
      await page.tap("#files-back");
      await page.waitForSelector("#pane:not(.hidden)");
      assert(await page.locator("#files").isHidden(), "the file screen still shows");
      await page.tap("#files-open");
      await page.waitForSelector('#folder .entry:text-is("b.py")');
    });

    await check("tapping a file shows its text highlighted, with line numbers, read-only; [‹ back] b.py [edit]", async () => {
      await tapEntry("b.py");
      await page.waitForSelector("#file-body .cm-content");
      await waitFor(async () => (await page.textContent("#file-body .cm-content")).includes("def hello():"), 5000, "the file's text");
      const look = await page.evaluate(() => ({
        keyword: getComputedStyle(document.querySelector("#file-body .tok-keyword")).color,
        comment: getComputedStyle(document.querySelector("#file-body .tok-comment")).color,
        plain: getComputedStyle(document.querySelector("#file-body .cm-content")).color,
        background: getComputedStyle(document.querySelector("#file-body .cm-editor")).backgroundColor,
        numbers: [...document.querySelectorAll("#file-body .cm-lineNumbers .cm-gutterElement")].map((e) => e.textContent).filter(Boolean),
        editable: document.querySelector("#file-body .cm-content").getAttribute("contenteditable"),
        header: [...document.querySelectorAll("#files header > *")].filter((e) => !e.classList.contains("hidden")).map((e) => e.textContent),
      }));
      assert(look.keyword !== look.plain && look.comment !== look.plain, `no highlighting: ${JSON.stringify(look)}`);
      assert(look.background === "rgb(39, 40, 34)", `background ${look.background}`);
      assert(look.numbers.includes("1") && look.numbers.includes("2"), `line numbers ${look.numbers}`);
      assert(look.editable === "false", `contenteditable=${look.editable}`);
      assert(JSON.stringify(look.header) === JSON.stringify(["‹ back", "b.py", "edit"]), `header: ${look.header}`);
    });

    await check("the file's text can be selected", async () => {
      const selected = await page.evaluate(async () => {
        const line = document.querySelector("#file-body .cm-line");
        getSelection().selectAllChildren(line);
        await new Promise((r) => setTimeout(r, 300));
        return { text: getSelection().toString(), userSelect: getComputedStyle(line).webkitUserSelect || getComputedStyle(line).userSelect };
      });
      assert(selected.text.includes("def hello():"), `selection is ${JSON.stringify(selected.text)}`);
      assert(selected.userSelect !== "none", "user-select is none");
      await page.evaluate(() => getSelection().removeAllRanges());
    });

    await check("pinching the file grows its font, and the size is the terminal's setting", async () => {
      const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#file-body .cm-content")).fontSize));
      await page.evaluate(() => setFontSize(13));  // the terminal's pinch check may have left it at the largest
      const before = await size();
      await pinchOut(page, 40, "#file-body");
      const after = await size();
      assert(after > before, `font size went from ${before} to ${after}`);
      assert(await page.evaluate(() => localStorage.getItem("tmux-phone.fontSize")) === String(after), "the size was not saved");
      assert(await page.evaluate(() => term.options.fontSize) === after, "the terminal's size is not the same");
    });

    await check("[edit] makes it editable and focuses it; typing, then [save], changes the file on disk", async () => {
      await page.tap("#file-edit");
      assert((await page.textContent("#file-edit")) === "save", "the button does not say save");
      const focus = await page.evaluate(() => ({ editable: document.querySelector("#file-body .cm-content").getAttribute("contenteditable"),
                                                 focused: document.activeElement.classList.contains("cm-content") }));
      assert(focus.editable === "true" && focus.focused, `after [edit]: ${JSON.stringify(focus)}`);
      await page.keyboard.type("# phone edit\n");
      await waitFor(async () => (await fileText()).startsWith("# phone edit\n"), 3000, `the typed line (${JSON.stringify(await fileText())})`);
      await page.tap("#file-edit");
      await waitFor(() => fs.readFileSync(bpy, "utf8") === "# phone edit\ndef hello():\n    return 'hi'  # greet\n", 5000,
                    `the file on disk (is ${JSON.stringify(fs.readFileSync(bpy, "utf8"))})`);
      await page.waitForSelector('#file-edit:text-is("edit")');
      assert(await page.evaluate(() => document.querySelector("#file-body .cm-content").getAttribute("contenteditable")) === "false",
             "still editable after the save");
    });

    await check("a save is refused if the file changed on disk, and the disk's version stays", async () => {
      await page.tap("#file-edit");
      await page.keyboard.type("phone change ");
      fs.writeFileSync(bpy, "changed on the Mac\n");
      await page.tap("#file-edit");
      await page.waitForSelector('#toast:not(.hidden):has-text("changed on disk")', { timeout: 5000 });
      assert(fs.readFileSync(bpy, "utf8") === "changed on the Mac\n", `the file is ${JSON.stringify(fs.readFileSync(bpy, "utf8"))}`);
      assert((await page.textContent("#file-edit")) === "save", "the button left edit mode");
      assert((await fileText()).includes("phone change "), "the phone's changes are gone from the screen");
    });

    await check("leaving with unsaved changes asks first: cancel stays, OK goes to the folder", async () => {
      let message = "";
      page.once("dialog", (d) => { message = d.message(); d.dismiss(); });
      await page.tap("#files-back");
      await sleep(300);
      assert(/without saving/.test(message), `the confirm said: ${JSON.stringify(message)}`);
      assert(await page.locator("#file-body .cm-content").isVisible(), "cancel left the file");
      page.once("dialog", (d) => d.accept());
      await page.tap("#files-back");
      await page.waitForSelector('#folder:not(.hidden) .entry:text-is("b.py")');
      assert(fs.readFileSync(bpy, "utf8") === "changed on the Mac\n", "leaving wrote the file");
    });

    await check("a big file and a binary file show a one-line note instead of their text", async () => {
      await tapEntry("Big.log");
      await page.waitForSelector('#file-note:not(.hidden):has-text("too big")');
      assert(await page.locator("#file-edit").isHidden(), "[edit] shows for a big file");
      await page.tap("#files-back");
      await tapEntry("nul.dat");
      await page.waitForSelector('#file-note:not(.hidden):has-text("binary")');
      await page.tap("#files-back");
      await page.waitForSelector('#folder:not(.hidden) .entry:text-is("b.py")');
      await page.tap("#files-back");
      await page.waitForSelector("#pane:not(.hidden)");
    });

    await check("the save route checks the Origin, like every POST", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/file`, { method: "POST",
        headers: { "Tailscale-User-Login": LOGIN, Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ path: bpy, text: "evil", mtime: "0" }) });
      assert(r.status === 403, `got ${r.status}`);
    });

    const hasNvim = (() => { try { execFileSync("nvim", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
    await check("in a pane running nvim, [files] opens nvim's file, and a save reloads it in nvim", async () => {
      if (!hasNvim) return console.log("  (nvim not installed, skipped)");
      const atxt = path.join(proj, "a.txt");
      const vim = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "test:", "-n", "vim", "-c", proj,
                       "nvim", "--clean", "a.txt").trim();
      try {
        // nvim's first line, asked through the socket nvim opened by itself, which the server must find the same way.
        const firstLine = () => {
          try {
            const child = execFileSync("pgrep", ["-P", paneInfo(vim, "pane_pid")], { encoding: "utf8" }).trim();
            const tmp = process.env.TMPDIR || "/tmp";
            const sock = fs.readdirSync(tmp).filter((d) => d.startsWith("nvim.")).flatMap((d) =>
              fs.readdirSync(path.join(tmp, d)).map((r) => path.join(tmp, d, r, `nvim.${child}.0`))).find((f) => fs.existsSync(f));
            return execFileSync("nvim", ["--server", sock, "--remote-expr", "getline(1)"], { encoding: "utf8" });
          } catch { return null; }
        };
        await waitFor(() => firstLine() === "plain text", 10000, "nvim to open a.txt");
        await page.tap("#back");
        await page.tap(`button[data-pane="${vim.slice(1)}"]`);
        await page.waitForSelector("#pane:not(.hidden)");
        await page.tap("#files-open");
        await page.waitForSelector("#file-body .cm-content");
        assert((await page.textContent("#files-title")) === "a.txt", `title ${await page.textContent("#files-title")}`);
        await page.tap("#file-edit");
        await page.keyboard.type("from the phone\n");
        await page.tap("#file-edit");
        await waitFor(() => fs.readFileSync(atxt, "utf8") === "from the phone\nplain text\n", 5000, "the save on disk");
        await waitFor(() => firstLine() === "from the phone", 5000, "nvim to reload the file");
        await page.tap("#files-back");
        await waitFor(async () => (await page.textContent("#files-title")).endsWith(proj), 5000,
                      `the file's folder after [‹ back] (title ${await page.textContent("#files-title")})`);
        await page.tap("#files-back");
      } finally {
        tmux("kill-pane", "-t", vim);
        await page.goto("/");  // back to the list from wherever the check stopped
        await page.waitForSelector(`button[data-pane="${vim.slice(1)}"]`, { state: "detached" });
        await page.tap(`button[data-pane="${paneId}"]`);
        await page.waitForSelector("#pane:not(.hidden)");
      }
    });

    const windowId = paneInfo(pane, "window_id").slice(1);
    const tapAct = (act, id) => page.tap(`#list-body [data-act="${act}"]${id ? `[data-id="${id}"]` : ""}`);
    const renames = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/rename")) renames.push(r.url()); });

    await check("[edit] puts each row's buttons at its right, on the same line; [+ window] follows the last window", async () => {
      await page.tap("#back");
      await page.tap("#edit");
      assert((await page.textContent("#edit")) === "done", "the toggle does not say done");
      const rows = await page.evaluate(() => [...document.querySelectorAll("#list-body .session-row, #list-body .window-name, #list-body .pane .top")]
        .map((row) => {
          const r = row.getBoundingClientRect(), acts = row.querySelector(".acts");
          const a = acts && acts.getBoundingClientRect(), n = row.querySelector(".name").getBoundingClientRect();
          return { labels: acts ? [...acts.querySelectorAll("button")].map((b) => b.textContent) : null,
                   sameLine: a && a.top < n.bottom && a.bottom > n.top,
                   right: a && Math.abs(a.right - (r.right - parseFloat(getComputedStyle(row).paddingRight))) <= 1 };
        }));
      const want = [["rename", "x"], ["rename", "+ pane", "x"], ["rename", "x"]];
      assert(rows.length === 3 && rows.every((r, i) => JSON.stringify(r.labels) === JSON.stringify(want[i]) && r.sameLine && r.right),
             `rows: ${JSON.stringify(rows)}`);
      assert(!(await page.locator("#list-body .pane .line button").count()), "the last-line text has buttons");
      const order = await page.evaluate(() => [...document.querySelectorAll("#list-body [data-act]")].map((b) => b.textContent));
      assert(order.indexOf("+ session") === 2 && order.at(-1) === "+ window", `button order: ${order}`);
    });

    await check("in edit mode the 3 s refresh keeps the rows, and a tap on a row opens nothing", async () => {
      await sleep(1000);  // the list's own load after [back] and [edit]
      await page.evaluate(() => { document.querySelector("#list-body .pane").__kept = true; });
      await sleep(3500);  // one list refresh
      assert(await page.evaluate(() => document.querySelector("#list-body .pane").__kept), "the refresh rebuilt the rows");
      await page.tap(`#list-body [data-pane="${paneId}"] .line`);
      await sleep(500);
      assert(await page.locator("#list").isVisible(), "the tap opened the pane");
    });

    await check("[rename] on a window renames it in tmux and in the list, through a list refresh; Enter sends one request", async () => {
      await tapAct("rename-window", windowId);
      const input = page.locator("input.rename");
      assert((await input.inputValue()) === paneInfo(pane, "window_name"), `prefilled with ${await input.inputValue()}`);
      assert(await input.evaluate((el) => el === document.activeElement), "the input is not focused");
      await input.fill("renamed #win");
      await sleep(3500);  // one list refresh
      assert((await page.locator("input.rename").count()) === 1 && (await input.inputValue()) === "renamed #win",
             "the list refresh threw away the typing");
      renames.length = 0;
      await page.keyboard.press("Enter");
      await waitFor(() => paneInfo(pane, "window_name") === "renamed #win", 5000, `window_name (now ${paneInfo(pane, "window_name")})`);
      await waitFor(async () => (await page.textContent("#list-body")).includes("renamed #win"), 5000, "the new name in the list");
      await sleep(500);
      assert(renames.length === 1, `${renames.length} rename requests`);
    });

    await check("[rename] on a pane saves when the box loses focus", async () => {
      await tapAct("rename-pane", paneId);
      await page.locator("input.rename").fill("my pane");
      await page.locator("input.rename").evaluate((el) => el.blur());  // iOS's Done, or tapping away
      await waitFor(() => paneInfo(pane, "pane_title") === "my pane", 5000, `pane_title (now ${paneInfo(pane, "pane_title")})`);
    });

    await check("Escape cancels a rename", async () => {
      await tapAct("rename-pane", paneId);
      await page.locator("input.rename").fill("not saved");
      renames.length = 0;
      await page.keyboard.press("Escape");
      await sleep(1000);
      assert(paneInfo(pane, "pane_title") === "my pane" && !renames.length, `pane_title is ${paneInfo(pane, "pane_title")}, ${renames.length} requests`);
    });

    await check("a bad name is refused", async () => {
      const status = await page.evaluate((id) => fetch(`/api/panes/${id}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a\u001bb" }) }).then((r) => r.status), paneId);
      assert(status === 400, `got ${status}`);
      assert(paneInfo(pane, "pane_title") === "my pane", "the title changed");
    });

    let added = null;
    await check("[+ pane] adds a pane to the window and opens it on the phone", async () => {
      const before = Number(paneInfo(pane, "window_panes"));
      await tapAct("add-pane", windowId);
      await page.waitForSelector("#pane:not(.hidden)");
      assert(Number(paneInfo(pane, "window_panes")) === before + 1, `window_panes is ${paneInfo(pane, "window_panes")}, was ${before}`);
      added = await page.evaluate(() => current);
      assert(added && added !== paneId, `the phone shows pane ${added}`);
      assert(tmux("display-message", "-p", "-t", "test", "#{pane_id}").trim() === `%${added}`, "tmux's active pane is not the new one");
    });

    await check("a pane in a split window opens zoomed; [desktop panes] shows the split, [one pane] zooms back", async () => {
      const zoomed = () => paneInfo(`%${added}`, "window_zoomed_flag");
      assert(zoomed() === "1", "the new pane is not zoomed");
      await page.tap("#split");
      await waitFor(async () => zoomed() === "0" && await page.textContent("#split") === "one pane", 5000, "the split view");
      await page.tap("#split");
      await waitFor(async () => zoomed() === "1" && await page.textContent("#split") === "desktop panes", 5000, "one pane again");
    });

    await check("[x] on a pane closes it after a confirm", async () => {
      assert(added, "no pane was added");
      await page.tap("#back");
      page.once("dialog", (d) => d.accept());
      await tapAct("close-pane", added);
      await waitFor(() => !tmux("list-panes", "-a", "-F", "#{pane_id}").includes(`%${added}`), 5000, "the pane to close");
      await page.waitForSelector(`[data-act="close-pane"][data-id="${added}"]`, { state: "detached" });
    });

    await check("[+ window] opens a new window; [x] on a window kills it after a confirm naming its panes", async () => {
      await tapAct("new-window");
      await page.waitForSelector("#pane:not(.hidden)");
      const w = paneInfo(`%${await page.evaluate(() => current)}`, "window_id");
      tmux("rename-window", "-t", w, "doomed");
      await page.tap("#back");
      await page.waitForSelector('#list-body .window-name .name:text-is("doomed")', { timeout: 5000 });
      let message = "";
      page.once("dialog", (d) => { message = d.message(); d.accept(); });
      await tapAct("close-window", w.slice(1));
      await waitFor(() => !tmux("list-windows", "-a", "-F", "#{window_id}").split("\n").includes(w), 5000, "the window to close");
      assert(/"doomed"/.test(message) && /1 pane\b/.test(message), `the confirm said: ${message}`);
      await page.waitForSelector(`[data-act="close-window"][data-id="${w.slice(1)}"]`, { state: "detached" });
    });

    await check("[done] while renaming saves the name, then leaves edit mode", async () => {
      await tapAct("rename-pane", paneId);
      await page.locator("input.rename").fill("done-saved");
      await page.tap("#edit");
      await waitFor(() => paneInfo(pane, "pane_title") === "done-saved", 5000, `pane_title (now ${paneInfo(pane, "pane_title")})`);
      assert((await page.textContent("#edit")) === "edit", "the toggle does not say edit");
      assert(!(await page.locator("#list-body [data-act]").count()), "edit mode's buttons still show");
      await page.waitForSelector(`button[data-pane="${paneId}"]`);
    });

    // A new version: index.html changes on the Mac. The page marks itself, so a reload shows as the mark gone.
    const deploy = () => fs.appendFileSync(appIndex, `\n<!-- deploy ${Date.now()} -->\n`);
    const mark = () => page.evaluate(() => { window.__before = true; });
    const reloaded = async () => !(await page.evaluate(() => window.__before).catch(() => true));

    await check("a new version reloads the page by itself and reopens the pane it was on", async () => {
      await page.tap(`button[data-pane="${paneId}"]`);
      await page.waitForSelector("#pane:not(.hidden)");
      await mark();
      deploy();
      await waitFor(reloaded, 10000, "the page to reload");
      await page.waitForSelector("#pane:not(.hidden)", { timeout: 10000 });
      assert(await page.evaluate(() => current) === paneId, `the phone shows pane ${await page.evaluate(() => current)}`);
      await waitFor(async () => (await screenText(page)).includes(PROMPT.trim()), 10000, "the terminal to show the pane");
    });

    await check("a new version does not reload while recording; it does once the recording ends", async () => {
      await mark();
      await page.evaluate("recorder = { stop() {} }");  // stands in for a recording; WebKit here has no mic
      deploy();
      await sleep(4000);  // more than one poll
      assert(!(await reloaded()), "the page reloaded during the recording");
      await page.evaluate("recorder = null");
      await waitFor(reloaded, 10000, "the page to reload after the recording");
      await page.waitForSelector("#pane:not(.hidden)", { timeout: 10000 });
    });

    await check("with the keyboard up (a shorter visible area) the key bar stays on screen and the terminal refits", async () => {
      const full = page.viewportSize();
      const rows = () => Number(tmux("list-clients", "-F", "#{client_height}").trim().split("\n")[0]);
      const rows0 = rows();
      await page.setViewportSize({ width: full.width, height: Math.round(full.height / 2) });
      try {
        await waitFor(() => rows() < rows0, 5000, `the tmux client to get shorter than ${rows0} rows (now ${rows()})`);
        const bar = await page.locator("#keys .bar").boundingBox();
        const visible = await page.evaluate(() => visualViewport.height);
        assert(bar && bar.y >= 0 && bar.y + bar.height <= visible + 1, `key bar at ${JSON.stringify(bar)}, visible height ${visible}`);
        assert(await page.locator("#pane-header").isVisible(), "the header is not visible");
      } finally {
        await page.setViewportSize(full);
      }
    });

    await check("a new version does not reload while a name is being typed", async () => {
      await page.tap("#back");
      await page.tap("#edit");
      await tapAct("rename-pane", paneId);
      await mark();
      deploy();
      await sleep(4000);
      assert(!(await reloaded()), "the page reloaded during the rename");
      await page.keyboard.press("Escape");
      await waitFor(reloaded, 10000, "the page to reload after the rename");
      await page.waitForSelector("#edit:text-is(\"edit\")");
      await page.waitForSelector(`button[data-pane="${paneId}"]`);
    });

    await check("a new version waits while a file has unsaved changes, then reloads back onto the file", async () => {
      await page.tap(`button[data-pane="${paneId}"]`);
      await page.waitForSelector("#pane:not(.hidden)");
      await page.tap("#files-open");
      await page.tap('#folder .entry:text-is("b.py")');
      await page.waitForSelector("#file-body .cm-content");
      await page.tap("#file-edit");
      await page.keyboard.type("unsaved ");
      await mark();
      deploy();
      await sleep(4000);
      assert(!(await reloaded()), "the page reloaded with unsaved changes");
      await page.tap("#file-edit");
      await waitFor(reloaded, 10000, "the page to reload after the save");
      await page.waitForSelector("#files:not(.hidden) #file-body .cm-content", { timeout: 10000 });
      assert((await page.textContent("#files-title")) === "b.py", `the file screen shows ${await page.textContent("#files-title")}`);
      assert(fs.readFileSync(path.join(fs.realpathSync(base), "project-folder/b.py"), "utf8").startsWith("unsaved "), "the save did not land");
      await page.tap("#files-back");
      await page.tap("#files-back");
      await page.tap("#back");
      await page.waitForSelector(`button[data-pane="${paneId}"]`);
    });

    await check("one session: no session row, and _phone is never listed", async () => {
      await page.waitForSelector("#list:not(.hidden)");
      assert(!(await page.locator("#sessions").count()), "the session row shows with one session");
      assert(!(await pageSessions(page)).some((s) => s.name === "_phone"), "_phone is in the list");
    });

    await check("a session made on the Mac shows in the row; the phone stays on its session", async () => {
      tmux("new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "sh");
      tmux("send-keys", "-t", "=work:", "clear; echo work-marker", "Enter");
      await page.waitForSelector('#sessions button[data-session]:text-is("work")', { timeout: 5000 });
      assert(await page.locator('#sessions button.current:text-is("test")').count(), "test is not the highlighted session");
      assert(viewerGroupMate() === "test", `_phone is grouped with ${viewerGroupMate()}`);
    });

    await check("tapping another session shows its windows in the list and its pane in the terminal", async () => {
      const workPane = tmux("display-message", "-p", "-t", "=work:", "#{pane_id}").trim().slice(1);
      await page.tap('#sessions button:text-is("work")');
      await page.waitForSelector(`button[data-pane="${workPane}"]`, { timeout: 5000 });
      assert(!(await page.locator(`button[data-pane="${paneId}"]`).count()), "test's pane is still listed");
      assert(await page.locator('#sessions button.current:text-is("work")').count(), "work is not highlighted");
      assert(viewerGroupMate() === "work", `_phone is grouped with ${viewerGroupMate()}`);
      await page.tap(`button[data-pane="${workPane}"]`);
      await waitFor(async () => (await screenText(page)).includes("work-marker"), 10000, "'work-marker' in the terminal");
      assert(tmux("show-options", "-v", "-t", "=work:", "status").trim() === "" &&
             tmux("show-options", "-v", "-t", "=test:", "status").trim() === "", "a Mac session's status option was changed");
      await page.tap("#back");
    });

    await check("a reload keeps the chosen session", async () => {
      await page.reload();
      await page.waitForSelector('#sessions button.current:text-is("work")', { timeout: 5000 });
    });

    let made = null;
    await check("[new session] makes a real session in tmux ls and switches to it", async () => {
      const before = realSessions();
      await page.tap("#edit");
      await tapAct("new-session");
      made = await waitFor(() => realSessions().find((n) => !before.includes(n)), 5000, "a new session in tmux ls");
      assert(/^\d+$/.test(made), `the new session is named ${made}, not tmux's number`);
      await waitFor(async () => (await currentName(page)) === made, 5000, `the phone on ${made} (is ${await currentName(page)})`);
      assert(viewerGroupMate() === made, `_phone is grouped with ${viewerGroupMate()}`);
    });

    await check("[rename] on a session renames it; a name with . is refused", async () => {
      const id = (await pageSessions(page)).find((s) => s.name === "work").id;
      await tapAct("rename-session", id);
      await page.locator("input.rename").fill("my work");
      await page.keyboard.press("Enter");
      await waitFor(() => realSessions().includes("my work"), 5000, `the name in tmux (${realSessions()})`);
      const status = await page.evaluate((id) => fetch(`/api/sessions/${id}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.b" }) }).then((r) => r.status), id);
      assert(status === 400, `got ${status}`);
    });

    await check("[x] on the phone's session closes it after a confirm naming its windows; the phone moves on", async () => {
      assert(made, "no session was made");
      const id = (await pageSessions(page)).find((s) => s.name === made).id;
      let message = "";
      page.once("dialog", (d) => { message = d.message(); d.accept(); });
      await tapAct("close-session", id);
      await waitFor(() => !realSessions().includes(made), 5000, `${made} to close`);
      assert(/1 window\b/.test(message), `the confirm said: ${message}`);
      await waitFor(async () => ["test", "my work"].includes(await currentName(page)), 5000, `the phone on another session (${await currentName(page)})`);
      assert(viewerGroupMate() === await currentName(page), `_phone is grouped with ${viewerGroupMate()}`);
      await page.tap("#edit");
    });

    await check("with no sessions the phone makes a real one; a later Mac session shows without the phone moving", async () => {
      tmux("kill-server");
      const made0 = await waitFor(() => { try { return realSessions()[0]; } catch { return null; } }, 15000, "the phone to make a session");
      assert(/^\d+$/.test(made0) && realSessions().length === 1, `sessions: ${realSessions()}`);
      await waitFor(async () => (await currentName(page)) === made0, 10000, `the phone on ${made0}`);
      tmux("new-session", "-d", "-s", "mac", "sh");
      await page.waitForSelector('#sessions button:text-is("mac")', { timeout: 5000 });
      await sleep(4000);
      assert((await currentName(page)) === made0 && viewerGroupMate() === made0, `the phone moved to ${await currentName(page)}`);
      assert(!(await pageSessions(page)).some((s) => s.name === "_phone"), "_phone is in the list");
    });

    await check("without a chosen session, the phone takes the most recently used one", async () => {
      // A client attaches to mac for a moment, as the Mac would, so mac is the most recently used.
      // stdin is a pipe that stays open (script refuses node's socket pipes, and at stdin's end it would type ^D
      // into mac's shell and end the session).
      const client = spawn("sh", ["-c", "sleep 30 | script -q /dev/null tmux attach -t =mac"],
                           { env: { ...env, TERM: "xterm-256color" }, stdio: "ignore", detached: true });
      try {
        await waitFor(() => tmux("list-clients", "-t", "=mac", "-F", "#{client_name}").trim(), 5000, "a client on mac");
        tmux("detach-client", "-s", "=mac");
      } finally {
        try { process.kill(-client.pid, "SIGKILL"); } catch {}
      }
      tmux("kill-session", "-t", "=_phone");
      await waitFor(async () => (await currentName(page)) === "mac", 10000, `the phone on mac (is ${await currentName(page)})`);
      assert(viewerGroupMate() === "mac", `_phone is grouped with ${viewerGroupMate()}`);
    });

    await check("[theme] sets the terminal's and the page's colors, and keeps them after a reload", async () => {
      if (await page.isVisible("#back")) await page.tap("#back");
      await page.tap("#theme-open");
      await page.tap('[data-theme="gruvbox-dark-hard"]');
      const colors = () => page.evaluate(() => [getComputedStyle(document.body).backgroundColor, term.options.theme.background,
                                                term.options.theme.brightRed, document.querySelector(".theme-row.current").dataset.theme]);
      const want = "rgb(29, 32, 33),#1d2021,#fb4934,gruvbox-dark-hard";
      assert(String(await colors()) === want, `colors are ${await colors()}`);
      await page.reload();
      await page.tap("#theme-open");
      assert(String(await colors()) === want, `after a reload, colors are ${await colors()}`);
      await page.tap("#themes-back");
      assert(await page.isVisible("#list-body"), "[‹ back] did not go back to the list");
    });

    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  failures.push("setup");
  console.log(`✗ setup: ${e.stack || e.message}`);
} finally {
  await stopServer();
  try { tmux("kill-server"); } catch {}
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\nserver log:\n${serverLog.trim().split("\n").slice(-40).join("\n")}`);
  console.log(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
