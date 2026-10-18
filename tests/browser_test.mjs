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

// Two fingers spreading apart vertically from the middle of the terminal. The first finger moves down,
// so a page that took it for a one-finger swipe would send wheel-up and scroll the pane back.
async function pinchOut(page, px) {
  await page.evaluate(async (px) => {
    const box = document.querySelector(".xterm").getBoundingClientRect();
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
  }, px);
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

    await check("the phone's terminal has no tmux status row; the Mac session's status line is unchanged", async () => {
      assert(tmux("show-options", "-v", "-t", "=phone:", "status").trim() === "off", "session phone has its status line on");
      assert(tmux("show-options", "-v", "-t", "=test:", "status").trim() === "", "the Mac session's status option was changed");
      // tmux's default status line starts with [session name].
      const screen = await screenText(page);
      assert(!/\[(phone|test)\]/.test(screen), `the terminal shows a status line:\n${screen}`);
    });

    await check("the status strip sits below the key bar and shows the windows, the current one marked *, and live", async () => {
      await waitFor(async () => /(^| )\d+:phone\*( |$)/.test(await page.textContent("#sl-windows")), 5000,
                    `the current window marked in the strip (shows ${await page.textContent("#sl-windows")})`);
      assert((await page.textContent("#sl-state")) === "live", `state shows ${await page.textContent("#sl-state")}`);
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
      await waitFor(() => currentWindow("phone") === otherWindow, 5000, `phone's current window ${otherWindow} (is ${currentWindow("phone")})`);
      assert(currentWindow("test") === macWindow, `the Mac's current window moved to ${currentWindow("test")}`);
      await waitFor(async () => /(^| )\d+:other\*( |$)/.test(await page.textContent("#sl-windows")), 5000,
                    `'other*' in the strip (shows ${await page.textContent("#sl-windows")})`);
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
      await waitFor(async () => (await page.textContent("#sl-state")).includes("reconnecting"), 10000,
                    `'reconnecting' in the strip (shows ${await page.textContent("#sl-state")})`);
      await startServer(port, whisperPort);
      // A line printed after the restart can only show up over a new connection.
      const marker = `after restart ${Date.now()}`;
      tmux("send-keys", "-t", pane, `echo ${marker}`, "Enter");
      await waitFor(async () => (await screenText(page)).includes(`\n${marker}`), 10000, `'${marker}' in the terminal`);
      assert(!(await page.evaluate(() => window.__sawReconnectPrompt)), `the page showed "${RECONNECT_PROMPT}"`);
      await waitFor(async () => (await page.textContent("#sl-state")) === "live", 5000,
                    `'live' in the strip (shows ${await page.textContent("#sl-state")})`);
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
      assert((await page.textContent("#sl-state")).includes("CTRL"), `the strip shows ${await page.textContent("#sl-state")}`);
      await page.keyboard.type("c");
      await waitFor(() => paneInfo(pane, "pane_current_command") === shell, 3000,
                    `sleep to stop (pane runs ${paneInfo(pane, "pane_current_command")})`);
      assert(!(await page.locator('[data-mod="ctrl"].armed').count()), "Ctrl is still armed after one key");
      assert(!(await page.textContent("#sl-state")).includes("CTRL"), "the strip still shows CTRL");
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

    await check("[photo] then [paste] pastes the clipboard image's saved path without pressing Enter", async () => {
      await page.tap("#attach");
      assert(await page.locator("#paste-photo").isVisible() && await page.locator("#library").isVisible(), "the photo menu did not open");
      await expectPastedPath(() => page.tap("#paste-photo"));
      assert(!(await page.locator("#photo-menu").isVisible()), "the photo menu is still open");
      await page.tap("#attach");
      await page.tap('[data-key="1"]');  // a tap elsewhere closes it
      assert(!(await page.locator("#photo-menu").isVisible()), "a tap outside did not close the menu");
      tmux("send-keys", "-t", pane, "C-u");
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

    const windowId = paneInfo(pane, "window_id").slice(1);
    await check("[edit] then [rename] on a window renames it in tmux and in the list, through a list refresh", async () => {
      await page.tap("#back");
      await page.tap("#edit");
      assert((await page.textContent("#edit")) === "done", "the toggle does not say done");
      await page.tap(`[data-act="rename-window"][data-id="${windowId}"]`);
      const input = page.locator("input.rename");
      assert((await input.inputValue()) === paneInfo(pane, "window_name"), `prefilled with ${await input.inputValue()}`);
      assert(await input.evaluate((el) => el === document.activeElement), "the input is not focused");
      await input.fill("renamed #win");
      await sleep(3500);  // one list refresh
      assert((await page.locator("input.rename").count()) === 1 && (await input.inputValue()) === "renamed #win",
             "the list refresh threw away the typing");
      await page.keyboard.press("Enter");
      await waitFor(() => paneInfo(pane, "window_name") === "renamed #win", 5000, `window_name (now ${paneInfo(pane, "window_name")})`);
      await waitFor(async () => (await page.textContent("#list-body")).includes("renamed #win"), 5000, "the new name in the list");
    });

    await check("[rename] on a pane renames its title; tapping the row in edit mode opens nothing", async () => {
      await page.tap(`[data-act="rename-pane"][data-id="${paneId}"]`);
      await page.locator("input.rename").fill("my pane");
      await page.keyboard.press("Enter");
      await waitFor(() => paneInfo(pane, "pane_title") === "my pane", 5000, `pane_title (now ${paneInfo(pane, "pane_title")})`);
      await page.tap("#list-body .pane .line");
      await sleep(500);
      assert(await page.locator("#list").isVisible(), "the tap opened the pane");
    });

    await check("a bad name is refused", async () => {
      const status = await page.evaluate((id) => fetch(`/api/panes/${id}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a\u001bb" }) }).then((r) => r.status), paneId);
      assert(status === 400, `got ${status}`);
      assert(paneInfo(pane, "pane_title") === "my pane", "the title changed");
    });

    let added = null;
    await check("[new pane] adds a pane to the window and opens it on the phone", async () => {
      const before = Number(paneInfo(pane, "window_panes"));
      await page.tap(`[data-act="add-pane"][data-id="${windowId}"]`);
      await page.waitForSelector("#pane:not(.hidden)");
      assert(Number(paneInfo(pane, "window_panes")) === before + 1, `window_panes is ${paneInfo(pane, "window_panes")}, was ${before}`);
      added = await page.evaluate(() => current);
      assert(added && added !== paneId, `the phone shows pane ${added}`);
      assert(tmux("display-message", "-p", "-t", "test", "#{pane_id}").trim() === `%${added}`, "tmux's active pane is not the new one");
    });

    await check("[close] on a pane closes it after a confirm; [done] leaves edit mode", async () => {
      assert(added, "no pane was added");
      await page.tap("#back");
      page.once("dialog", (d) => d.accept());
      await page.tap(`[data-act="close-pane"][data-id="${added}"]`);
      await waitFor(() => !tmux("list-panes", "-a", "-F", "#{pane_id}").includes(`%${added}`), 5000, "the pane to close");
      await page.waitForSelector(`[data-act="close-pane"][data-id="${added}"]`, { state: "detached" });
      await page.tap("#edit");
      assert((await page.textContent("#edit")) === "edit", "the toggle does not say edit");
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
      await page.tap(`[data-act="rename-pane"][data-id="${paneId}"]`);
      await mark();
      deploy();
      await sleep(4000);
      assert(!(await reloaded()), "the page reloaded during the rename");
      await page.keyboard.press("Escape");
      await waitFor(reloaded, 10000, "the page to reload after the rename");
      await page.waitForSelector(`button[data-pane="${paneId}"]`);
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
