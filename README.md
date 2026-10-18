# tmux-phone

Use your Mac's tmux session from your phone. It's a web page served over Tailscale with named buttons, so you don't need tmux key combos.

It's for checking on and replying to Claude Code agents running in tmux panes. It borrows ideas and code from [cmux-phone](https://github.com/The-Sentience-Company/cmux-phone), which does the same for cmux.

## What it does

- **Pane list:** every tmux pane, grouped by window. Each shows its title, its last line, and a status for Claude Code panes (`[needs you]` / `[working]` / `[idle]`). Refreshes every 3 s.
- **Open a pane:** tap it. The phone switches to it and zooms it if its window is split. The screen is the real terminal: a small xterm.js client on the page, talking to ttyd, which attaches to the phone's own tmux session (see below). Type straight into it. It reconnects by itself if the connection drops.
- **Own session:** the phone attaches to a hidden tmux session named `_phone`, grouped with one real session (see Sessions): same windows and panes, but its own current window. Switching windows on the phone does not move the Mac, and a window made on either shows on both. `_phone` is never in the session list. Zoom belongs to the window, so a pane the phone zooms is zoomed on the Mac too, until you go back to the list.
- **Clock:** the strip at the very bottom of the screen is the iPhone home-indicator area. It shows the time as `HH:MM` at its top, under a dim line, below the key bar and below the list. The phone's tmux session has tmux's status line turned off.
- **Buttons:** Close pane in the pane view.
- **Edit:** `[edit]` on the list adds `[rename]` and `[close]` to each session (see Sessions), and `[rename]` and `[new pane]` to each window, `[rename]` and `[close]` to each pane, and a `[new window]` row at the bottom. Rename is inline: Enter saves, Escape or tapping away cancels. `[new pane]` splits side by side if the window is wide, else one above the other, and opens the new pane. Window names stick (renaming turns off tmux's automatic-rename for that window). Claude Code sets its own pane title, so it may rename a renamed Claude pane back.
- **Zoom:** pinch the terminal to change its font size (8 to 20). tmux re-fits to the new size. The size is kept for next time.
- **Scroll:** swipe on the terminal. It works like the mouse wheel on the Mac: in Claude Code it scrolls the conversation, in a shell it scrolls the pane's history. The text follows the finger: the page sends one wheel event per row height times the lines one event scrolls (5 in tmux's copy mode, 1 in Claude Code). While scrolled back, `[↓ bottom]` shows at the bottom right of the terminal; tap it to go back to the bottom. Typing, a key bar key, or a paste hides it.
- **Photo:** tap it for `[paste] [library]` just above the key bar. `[paste]` takes the image on the clipboard (e.g. a screenshot after "Copy and Delete"); iOS shows its own Paste button to tap first. `[library]` opens the photo picker. Either way the image is pasted into the pane's input. Claude Code shows it as `[Image #N]`.
- **Key bar:** one scrolling row in three groups: `[mic] [photo] [enter] │ [ctrl] [alt] │ [esc] [↑] [↓] [←] [→] [1] [2] [3] [tab] [shift-tab] [ctrl-c] [model]`. Mic and photo are icons; the rest are words. model is alt+p. Bouncing dots mean a recording or photo is being sent. Tapping the bar keeps the keyboard open.
- **Ctrl and Alt:** tap one, then type a key on the phone's keyboard: Ctrl then b is tmux's prefix, so every tmux command works. It turns off after one key; tap it again to turn it off sooner.
- **Updates:** the page reloads itself when `index.html` or `server.py` changes on the Mac, and reopens the pane you were on. It waits while you record, send a photo, rename, or have the photo menu open. The server hashes both files into a version; the page checks it on every 3 s poll, in the list and in a pane.
- **Awake:** plugged in, the Mac stays awake while tmux-phone runs (`caffeinate -s`); the display can still sleep. On battery or with the lid closed it still sleeps.
- **Keyboard:** the page is pinned to the area above the iOS keyboard, so the header, the terminal (refit, so tmux reflows) and the key bar all stay visible.
- **Look:** a terminal look throughout: black, monospace, square, `[bracketed]` header buttons.
- **Dictation:** tap mic, talk, tap it again (it shows the time while recording). Whisper large-v3-turbo transcribes it on the Mac in about a second and pastes the text into the pane. Nothing is submitted until you press Enter. The audio never leaves the Mac.

## Sessions

The list shows the windows of one real tmux session, the phone's target. With more than one session, a row at the top reads `session: [0] [work] [scratch]`, the target in reverse video. Tap another to switch: the server makes `_phone` again, grouped with that session, and the terminal reconnects to it. The target is the session `_phone` is grouped with, so it is kept across page reloads and server restarts.

- **Default:** the most recently used real session.
- **None at all:** the phone makes a real session with tmux's numbered name (`tmux new-session -d`). It is an ordinary session: the Mac sees it in `tmux ls` and can attach to it.
- **More later:** a session made on the Mac shows in the row. The phone never switches away from, or kills, a session that still exists.
- **Target gone:** if the target session is closed, the phone moves to the most recently used real session, or makes one if there is none.
- **Edit mode:** each session gets `[rename]` and `[close]`, and the row ends with `[new session]`, which makes a real session and switches the phone to it. `[close]` asks first and says how many windows close with it. A session name can't have `.` or `:` (tmux uses them in targets), or be `_phone`.
- **Upgrade:** older versions named the viewer `phone`. On start, the server kills a `phone` session that is grouped with another session, as it only showed that session's windows. A `phone` session standing alone holds real work, so it stays and shows in the list as `phone`.

tmux resizes to fit the phone while it's attached. It resizes back when you use the Mac again.

## Install

Needs macOS, Homebrew, and the Tailscale app signed in on both the Mac and the phone.

```
brew install tmux ttyd whisper-cpp ffmpeg
./install.sh you@example.com     # your Tailscale login
```

The installer:
- downloads the speech model (574 MB) to `~/.local/state/tmux-phone/models`
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
- A pane counts as Claude Code if its foreground process is named `claude`. The status chips read Claude Code's screen: the `❯` input box and the spinner line. A Claude Code UI change can break them.

## Uninstall

```
launchctl bootout gui/$(id -u)/com.tmux-phone
rm ~/Library/LaunchAgents/com.tmux-phone.plist
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
rm -rf ~/.local/state/tmux-phone
```
