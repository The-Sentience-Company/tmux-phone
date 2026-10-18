#!/usr/bin/env node
// Drives the phone page in WebKit as an iPhone, against a private copy of the app.
//
// It never touches your real tmux: the server runs with its own HOME and TMUX_TMPDIR, so every
// tmux call, ttyd's `tmux attach` included, talks to a private tmux server made here.
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

// Short base path: tmux and ttyd sockets live under it, and Unix socket paths max out near 104 bytes.
const base = fs.mkdtempSync("/tmp/tmux-phone-test-");
const home = path.join(base, "home");
const state = path.join(home, ".local/state/tmux-phone");
const tmuxDir = path.join(base, "tmux");
fs.mkdirSync(path.join(state, "models"), { recursive: true });
fs.mkdirSync(tmuxDir);

// Env for the server and for every tmux call here. TMUX is dropped, or tmux would use the socket of the
// session this test may be running in.
const env = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxDir, PS1: PROMPT, ENV: "" };
for (const k of ["TMUX", "TMUX_PANE", "XDG_CONFIG_HOME"]) delete env[k];

const tmux = (...args) => execFileSync("tmux", args, { env, encoding: "utf8" });
const paneInfo = (pane, field) => tmux("display-message", "-p", "-t", pane, `#{${field}}`).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  server = spawn("python3", [path.join(REPO, "server.py")], {
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

async function main() {
  assert(fs.existsSync(MODEL), `whisper model missing at ${MODEL}; run ./install.sh once`);
  fs.symlinkSync(MODEL, path.join(state, "models/ggml-large-v3-turbo-q5_0.bin"));

  // A private tmux server with one `sh` window and 200 lines of history to scroll back through.
  tmux("new-session", "-d", "-s", "test", "-n", "phone", "-x", "80", "-y", "24", "sh");
  const pane = tmux("display-message", "-p", "-t", "test:phone", "#{pane_id}").trim();
  const paneId = pane.slice(1);
  tmux("send-keys", "-t", pane, "clear; i=1; while [ $i -le 200 ]; do echo history line $i; i=$((i+1)); done", "Enter");
  await waitFor(() => tmux("capture-pane", "-p", "-t", pane).includes("history line 200"), 5000, "the history to print");

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
    await page.goto("/");
    await page.tap(`button[data-pane="${paneId}"]`);

    await check("opening the pane shows its text in the terminal", async () => {
      await waitFor(async () => (await screenText(page)).includes("history line 200"), 10000,
                    "'history line 200' in the terminal");
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

    await check("the terminal comes back by itself after the server restarts", async () => {
      await stopServer();
      await startServer(port, whisperPort);
      // A line printed after the restart can only show up over a new connection.
      const marker = `after restart ${Date.now()}`;
      tmux("send-keys", "-t", pane, `echo ${marker}`, "Enter");
      await waitFor(async () => (await screenText(page)).includes(`\n${marker}`), 10000, `'${marker}' in the terminal`);
      assert(!(await page.evaluate(() => window.__sawReconnectPrompt)), `the page showed "${RECONNECT_PROMPT}"`);
    });

    await check("a photo pastes its saved path into the pane without pressing Enter", async () => {
      tmux("send-keys", "-t", pane, "clear", "Enter");
      await waitFor(() => tmux("capture-pane", "-p", "-t", pane).trim() === PROMPT.trim(), 5000, "a clear prompt");
      // A 1x1 PNG.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
      await page.setInputFiles("#file", { name: "dot.png", mimeType: "image/png", buffer: png });
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
    });

    await check("the pane view has no message box and no Send button", async () => {
      assert(await page.locator("#pane").isVisible(), "the pane view is not showing");
      // xterm's own hidden textarea takes the keyboard; it is not a message box.
      const boxes = await page.locator("#pane textarea:not(.xterm-helper-textarea)").count();
      const sends = await page.locator("#pane").getByRole("button", { name: /^send$/i }).count() + await page.locator("#send").count();
      assert(!boxes && !sends, `found ${boxes} textarea(s) and ${sends} Send button(s)`);
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
