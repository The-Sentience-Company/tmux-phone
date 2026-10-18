# tmux-phone

Use your Mac's tmux session from your phone. It's a web page served over Tailscale with named buttons, so you don't need tmux key combos.

It's for checking on and replying to Claude Code agents running in tmux panes. It borrows ideas and code from [cmux-phone](https://github.com/The-Sentience-Company/cmux-phone), which does the same for cmux.

## What it does

- **Pane list:** every tmux pane, grouped by window. Each shows its title, its last line, and a status for Claude Code panes (Needs you / Working / Idle). Refreshes every 3 s.
- **Open a pane:** tap it. The phone switches to it and zooms it if its window is split. The screen is the real terminal (ttyd running `tmux attach`).
- **Buttons:** Close pane, New window. Splitting is left to the Mac, since a phone shows one pane at a time.
- **Scroll:** swipe on the terminal to scroll back through the pane.
- **Photos:** attach photos to a message. Claude Code receives them as `[Image #N]`.
- **Key bar:** Esc, Enter, arrows, 1/2/3, Tab, ⇧Tab, Model (alt+p), Ctrl-C.
- **Message box:** pastes the text into the pane, then presses Enter.
- **Dictation:** tap Mic, talk, tap Stop. Whisper large-v3-turbo transcribes it on the Mac in about a second. The audio never leaves the Mac.

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
- the pane list matches tmux
- the terminal stream shows the screen you're on
- dictation returns the spoken words
- other websites get 403

It only reads. It never creates, switches, types into or resizes anything in your tmux, so it doesn't cover opening, sending, photos or scrolling.

## Security

Anyone who gets in has a full shell on the Mac, so:

- **Tailnet only:** `tailscale serve` answers only devices on your tailnet. Never use `tailscale funnel`.
- **One login:** the server accepts only the Tailscale login given to `install.sh`. It checks the `Tailscale-User-Login` header that `tailscale serve` adds.
- **Same origin only:** POSTs and the terminal websocket must come from the app's own origin, so another web page open on the phone can't type into your terminal.
- **Local only:** the server listens on `127.0.0.1:8766`, ttyd on a Unix socket only the server reaches, whisper-server on `127.0.0.1:8767`.

## Assumptions

- One tmux server on the default socket. The terminal attaches to the most recently used session.
- A pane counts as Claude Code if its foreground process is named `claude`. The status chips read Claude Code's screen: the `❯` input box and the spinner line. A Claude Code UI change can break them.

## Uninstall

```
launchctl bootout gui/$(id -u)/com.tmux-phone
rm ~/Library/LaunchAgents/com.tmux-phone.plist
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
rm -rf ~/.local/state/tmux-phone
```
