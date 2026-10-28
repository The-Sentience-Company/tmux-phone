# tmux-phone

Use your Mac's tmux session from your phone. It's a web page served over Tailscale with named buttons, so you don't need tmux key combos.

It's for checking on and replying to Claude Code agents running in tmux panes. It borrows ideas and code from [cmux-phone](https://github.com/The-Sentience-Company/cmux-phone), which does the same for cmux.

## What it does

- **Pane list:** every tmux pane, drawn as a tree under its window (`├─`, `└─`). Each shows its title, its last line, and a status for Claude Code, Codex and Cursor panes at the right of its title (`needs you` / `working` / `idle`, plain text). Refreshes every 3 s.
- **Open a pane:** tap it. The phone switches to it and zooms it if its window is split. The screen is the real terminal: a small xterm.js client on the page, talking to ttyd, which attaches to the phone's own tmux session (see below). Type straight into it. It reconnects by itself if the connection drops.
- **Own session:** the phone attaches to a hidden tmux session named `_phone`, grouped with one real session (see Sessions): same windows and panes, but its own current window. Switching windows on the phone does not move the Mac, and a window made on either shows on both. `_phone` is never in the session list. Zoom belongs to the window, so a pane the phone zooms is zoomed on the Mac too, until you use the Mac (see below). When you come back to the phone, or type on it after the Mac, tmux zooms the pane again.
- **Strip:** the strip at the very bottom of the screen is the iPhone home-indicator area. Under a dim line, below the key bar and below the list, it names the open pane's window as `2: agent`, or in the list the phone's session as `session 0`. The phone's tmux session has tmux's status line turned off.
- **Buttons:** `[desktop panes]` in the pane view shows the window split as on the Mac; `[one pane]` zooms back. It resets to one pane when you open a pane or come back to the phone. Close pane in the pane view.
- **Files:** `[files]` in the pane view opens the pane's folder (`..`, folders, then files, hidden ones too), or the file open in the pane's nvim. A file opens read-only with highlighting and line numbers, so it scrolls and selects like a web page. `[edit]` brings up the keyboard, `[save]` writes it, unless the file changed on disk since it was opened. An nvim on the Mac with that file open reloads it. Images (png, jpg, gif, webp, heic), videos (mp4, mov, m4v) and PDFs show as themselves: an image opens fitted to the screen, and pinch or double-tap zooms it; a video plays inline; a PDF shows in the browser's viewer. Other files over 2 MB, binary and non-UTF-8 files show one line instead. Pinch sets the font size, the same one the terminal uses. CodeMirror 6 is bundled from `vendor-src/` (`npm ci && npm run build`).
- **For you:** agents drop screenshots, videos and docs for you in `~/notes/sentience/agent-comapny/for-ahmet/`. The list starts with a `for you` block: the newest five files and every one you haven't opened, marked `new`. Tap one to open it in the file screen; that marks it seen until the file changes again. `[notify]` on the list (home-screen app only) turns on a push notification for each new file; tapping it opens the file. The server signs pushes with its own key (`vapid.pem` in the state folder, made with `openssl`). On the Mac, a new file also shows a Ghostty notification, and `prefix F` opens a popup listing them (fzf); Enter opens one with `peek`.
- **Edit:** `[edit]` on the list puts each row's buttons at its right, cutting the name to make room: a session `[rename] [x]`, a window `[rename] [+ pane] [x]`, a pane `[rename] [x]` on its title line. `[+ session]` follows the last session, `[+ window]` the last window. `[x]` asks first. Tapping a row opens nothing. Rename is inline: Enter or tapping away saves, Escape cancels. `[+ pane]` splits side by side if the window is wide, else one above the other, and opens the new pane. The list does not redraw on its 3 s refresh while in edit mode, so a tap is never lost. Window names stick (renaming turns off tmux's automatic-rename for that window). Claude Code sets its own pane title, so it may rename a renamed Claude pane back.
- **Pane titles:** if tmux draws a pane title row (`pane-border-status top` or `bottom`) next to the open pane, the phone hides that row. It goes by tmux's option and the pane's position, never by what is on screen. tmux still gets the full row count.
- **Zoom:** pinch the terminal to change its font size (8 to 20). tmux re-fits to the new size. The size is kept for next time.
- **Scroll:** swipe on the terminal. It works like the mouse wheel on the Mac: in Claude Code it scrolls the conversation, in a shell it scrolls the pane's history. The text follows the finger: the page sends one wheel event per row height times the lines one event scrolls (5 in tmux's copy mode, 1 in Claude Code). While scrolled back, `[↓ bottom]` shows at the bottom right of the terminal; tap it to go back to the bottom. Typing, a key bar key, or a paste hides it.
- **Photo:** tap it to open the photo picker. The picked image is pasted into the pane's input. Claude Code shows it as `[Image #N]`.
- **Paste:** `[paste]` pastes the iPhone clipboard into the pane, without Enter; iOS shows its own Paste button to tap first. An image (e.g. a screenshot after "Copy and Delete") goes in like a photo. Text goes in as one bracketed tmux paste (`load-buffer`, then `paste-buffer -p`), so multi-line text is not submitted line by line. Long-press on the terminal is taken by scrolling, so this is the only way to paste text.
- **Key bar:** one scrolling row in three groups: `[mic] [photo] [paste] [enter] │ [ctrl] [alt] │ [esc] [↑] [↓] [←] [→] [1] [2] [3] [tab] [shift-tab] [ctrl-c] [model]`. Mic and photo are icons; the rest are words. model is alt+p. Bouncing dots mean a recording, photo or paste is being sent. Tapping the bar keeps the keyboard open.
- **Ctrl and Alt:** tap one, then type a key on the phone's keyboard: Ctrl then b is tmux's prefix, so every tmux command works. It turns off after one key; tap it again to turn it off sooner.
- **Updates:** the page reloads itself when `index.html` or `server.py` changes on the Mac, and reopens the pane you were on. It waits while you record, send a photo or paste, or rename. The server hashes both files into a version; the page checks it on every 3 s poll, in the list and in a pane.
- **Awake:** plugged in, the Mac stays awake while tmux-phone runs (`caffeinate -s`); the display can still sleep. On battery or with the lid closed it still sleeps.
- **Keyboard:** the page is pinned to the area above the iOS keyboard, so the header, the terminal (refit, so tmux reflows) and the key bar all stay visible.
- **Look:** a terminal look throughout: monospace, square, `[bracketed]` header buttons.
- **Theme:** `[theme]` on the list opens the themes, each row drawn in its own colors. A tap sets it at once, for the terminal's 16 colors and the page around it. Monokai is the default. Also gruvbox-dark-hard, gruvbox-dark, the four Cursor dark and light themes, dracula, catppuccin-mocha, tokyo-night, nord, one-dark, solarized-dark, and xterm (the old black look). Kept in this browser, like the font size. Apps that draw in their own 24-bit colors keep them.
- **Dictation:** tap mic, talk, tap it again (it shows the time while recording). Whisper large-v3-turbo transcribes it on the Mac in about a second and pastes the text into the pane. Nothing is submitted until you press Enter. The audio never leaves the Mac.

## Sessions

The list shows the windows of one real tmux session, the phone's target. With more than one session, a row at the top reads `session: [0] [work] [scratch]`, the target in reverse video. Tap another to switch: the server makes `_phone` again, grouped with that session, and the terminal reconnects to it. The target is the session `_phone` is grouped with, so it is kept across page reloads and server restarts.

- **Default:** the most recently used real session.
- **None at all:** the phone makes a real session with tmux's numbered name (`tmux new-session -d`). It is an ordinary session: the Mac sees it in `tmux ls` and can attach to it.
- **More later:** a session made on the Mac shows in the row. The phone never switches away from, or kills, a session that still exists.
- **Target gone:** if the target session is closed, the phone moves to the most recently used real session, or makes one if there is none.
- **Edit mode:** sessions show one per row, the phone's in reverse video, each with `[rename] [x]`; switch sessions outside edit mode. `[+ session]` makes a real session and switches the phone to it. `[x]` asks first and says how many windows close with it. A session name can't have `.` or `:` (tmux uses them in targets), or be `_phone`.
- **Upgrade:** older versions named the viewer `phone`. On start, the server kills a `phone` session that is grouped with another session, as it only showed that session's windows. A `phone` session standing alone holds real work, so it stays and shows in the list as `phone`.

tmux resizes a window to fit the phone while the phone is the last one typed into it. It resizes back when you use the Mac again, and the Mac's layout comes back as it was: pane sizes, active pane and zoom. Just before the phone can shrink a window, the server keeps its layout in window options (`@phone_layout`, `@phone_active`, `@phone_zoomed`); two tmux hooks, `client-active[42]` and `window-resized[42]`, save it and put it back. Three more at index 43 (`client-active`, `client-attached`, `session-window-changed`) zoom the phone's pane. If a pane was added or closed in between, the layout can't be put back, and tmux shows the error on the Mac.

## Install

Needs macOS, Homebrew, and the Tailscale app signed in on both the Mac and the phone.

```
brew install tmux ttyd
brew install whisper-cpp ffmpeg   # for dictation; leave out to go without the mic
./install.sh
```

The installer:
- names any missing tool, with the `brew install` line to get it
- lets in only the Tailscale login this Mac is signed in with
- downloads the speech model (574 MB) to `~/.local/state/tmux-phone/models`, if whisper-cpp and ffmpeg are installed. Without them dictation is off and the mic is hidden; install them and re-run to turn it on.
- installs the launchd service `com.tmux-phone`, which starts at login and restarts if it crashes
- publishes it with `tailscale serve`

The first time, Tailscale may print a link to turn on Serve for your tailnet. Open it, enable Serve, and the installer continues.

On the phone, open the URL it prints. Then tap Share → Add to Home Screen.

Re-run `./install.sh` after changing the code, or restart the service:

```
launchctl kickstart -k gui/$(id -u)/com.tmux-phone
```

Logs: `~/.local/state/tmux-phone/server.log`.

## Smoke test

`install.sh` ends by running `./smoke_test.py <url>` against the live install, through the tailnet URL. Run it on its own after any change. Each check confirms the result you would see, not a step on the way:
- the pane list matches the target session's panes in tmux, and `_phone` is not in the session list
- the terminal stream shows the screen you're on
- dictation returns the spoken words
- other websites get 403

It only reads. Apart from the server making `_phone` if it is missing, it never creates, switches, types into or resizes anything in your tmux, so it doesn't cover opening, pasting, photos or scrolling.

## Security

Anyone who gets in has a full shell on the Mac, so:

- **Tailnet only:** `tailscale serve` answers only devices on your tailnet. Never use `tailscale funnel`.
- **One login:** the server accepts only the Tailscale login given to `install.sh`. It checks the `Tailscale-User-Login` header that `tailscale serve` adds.
- **Same origin only:** POSTs and the terminal websocket must come from the app's own origin, so another web page open on the phone can't type into your terminal.
- **Local only:** the server listens on `127.0.0.1:8766`, ttyd on a Unix socket only the server reaches, whisper-server on `127.0.0.1:8767`.

## Assumptions

- One tmux server on the default socket. The list shows one session's panes at a time; switch with the session row.
- tmux has `set -g mouse on`. A swipe is sent as mouse wheel input, which tmux acts on only with the mouse on.
- A pane counts as a coding agent if a process in its foreground is named `claude` (Claude Code), `codex` (OpenAI Codex CLI) or `agent` / `cursor-agent` (Cursor CLI). tmux names the last two `node`, so the server asks `ps`. The status labels read the agent's screen:
  - **Claude Code:** `needs you` when the `❯` input box is gone, `working` while the spinner line (`✻ Thinking…`) shows.
  - **Codex:** `needs you` when the hint under its `›` line says `to confirm`, `to submit answer` or `enter continue`; `working` while `Working (5s • esc to interrupt)` shows.
  - **Cursor:** `needs you` when the `→` input box between its `▄` and `▀` bars is gone; `working` while that line ends in `ctrl+c to stop`.

  The last line is the start of the agent's latest reply, or for Cursor the last line above its input box. A UI change in any of them can break this. `python3 tests/agent_screens_test.py` checks the parser against screens captured from Codex and Cursor.

## Uninstall

```
launchctl bootout gui/$(id -u)/com.tmux-phone
rm ~/Library/LaunchAgents/com.tmux-phone.plist
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
rm -rf ~/.local/state/tmux-phone
```
