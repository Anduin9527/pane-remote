# Screen module

[中文](../screen.md) | English

View and control the Mac's screen from your phone: a whole display, or just one window. Sign-in and the fallback use macOS's built-in Screen Sharing, and the picture is captured by a small helper on the Mac, mousectl, through the system's ScreenCaptureKit; no third-party remote desktop software is needed. macOS only, off by default.

```bash
pane-remote enable screen                 # installs the mousectl helper and lists the manual steps
pane-remote enable screen --create-cert   # same, plus a local self-signed certificate to sign mousectl (see "Signing certificate")
```

Once enabled, a screen icon appears in the phone's top bar. Tap it and sign in with your Mac username and password.

## What it does

The header is a single row: close and the source dropdown (displays / current window / choose a window…) on the left; keyboard, input mode (direct touch / trackpad) and More (quality, open keyboard on text fields, sideways, fit whole screen, resize window, switch back to the previous front app) on the right.

- **One display**: pick it in the source dropdown (★ is the main display). Quality "Data saver" sends at point resolution (4× fewer pixels), "Sharp" sends actual pixels
- **One window**: "Choose a window…" lists every capturable window (including ones on other desktops or parked by Stage Manager, even when Stage Manager has shrunk a background-launched window to a tiny thumbnail), with search. Only that window is captured and it stays in the background; the first tap brings it forward, and More → "Switch back to the previous front app" restores the previous front app
- **Close windows, quit apps**: each window in the list has a ×, which presses that window's own close button (same as clicking the red button on the Mac; the app shows its own save prompt if needed). Each app has "Quit" (a normal quit, so the app can save), which needs a second tap within 3 seconds; "Force quit" only appears if the app is still running 3 seconds after a normal quit, and also needs two taps. System processes such as Finder, the Dock and Spotlight can't be quit
- **Resize windows** (in window view, More → "Resize window"): drag the right, bottom or corner handle; the phone draws the target outline and the window is resized once when you let go. Presets: "Fit phone" (as large as possible at the phone's aspect ratio, centered), "Fill", "Left half", "Right half" (all within the window's display minus the menu bar and Dock)
- **Launch apps in the background**: below the windows are apps without windows. "Open in background" doesn't steal focus, and the new window is picked automatically once it appears. Menu-bar-only apps show "Summon" instead: Spotlight uses its shortcut from System Settings, uTools uses the show hotkey from its own settings, and other apps get their menu bar icon clicked
- **Direct touch mode**: tap = click, long-press = right-click, long-press and drag = drag with the left button, one-finger slide = scroll, two fingers = zoom / pan (on the phone only; the Mac is unaffected)
- **Trackpad mode**: slide to move the pointer, tap = click at the pointer, two-finger slide = scroll, pinch = zoom (the view follows the pointer)
- **Typing**: the keyboard button opens an input field; text is sent as a whole (CJK and IME output included). The key bar works like the terminal's: one row of the most used keys (⌘, Esc, Tab, Return, Delete, left / right, ⌘C, ⌘V) and the rest (⌥ ⌃ ⇧, up / down, ⌦, Home / End / PgUp / PgDn, ⌘X / A / Z / ⇧Z / S / F / W / T, ⌘Tab, ⌘Space) behind "⋯". Modifiers apply to the next key, so tapping ⌘ then typing c copies. The key bar and input field follow the phone keyboard instead of hiding behind it
- **Open keyboard on text fields** (in More, off by default): tapping a text field on the Mac opens the phone keyboard and moves the text cursor above it (see "How auto keyboard decides")
- **Typing on the lock screen**: while the Mac is locked, text and keys go through Screen Sharing (see "Lock screen"), so you can type the password in the picture to unlock
- **Multi-finger gestures** (like a Mac trackpad, sent as system shortcuts): three / four-finger swipe up = Mission Control, down = App Exposé, left / right = switch Spaces, spread / pinch = Show Desktop, three-finger tap = Look Up
- **Sideways**: rotate the whole UI 90° while holding the phone upright, handy for wide displays

## Architecture

```
phone noVNC (web/src/lib/screen/ScreenView.svelte)
   │ WebSocket /api/screen/vnc?view=display,sharp
   ▼
pane-remote server (server/screen.mjs, only moves bytes)
   │ bridge "screen" command (run directly in local mode, over the SSH reverse tunnel in relay mode)
   ▼
transcoding proxy (agent/screen/proxy.mjs, on the Mac) ── frames (display / window), pointer, keys, text, focus, window size ── mousectl (LaunchAgent, unix socket)
   │ RFB, 127.0.0.1:5900: sign-in; the picture when mousectl can't capture; keys on the lock screen
   ▼
macOS Screen Sharing
```

Window list, app list, launching, closing windows and quitting apps go through plain HTTP endpoints (`GET /api/screen/displays|windows|apps`, `POST /api/screen/launch|summon|close|quit`), which in turn ask mousectl via the bridge.

## Where the picture comes from

Whole displays and single windows take the same path: mousectl captures them with ScreenCaptureKit (a display is `w stream s<index>`, pointer included; a window is `w stream <window id>`), and the proxy diffs consecutive frames itself to find what really changed. The Screen Sharing connection is still kept: sign-in goes through it, and it supplies the picture when mousectl is missing, too old or can't capture.

Why not use Screen Sharing's picture directly: in testing, Apple's Screen Sharing showed two problems:

- **No incremental updates**: sometimes it stops pushing changes after the first frame, so the picture looks frozen (with both the old and the new proxy, so the problem is on the Screen Sharing side)
- **Cold black sessions**: the first login after the Screen Sharing process cold-starts streams black for the whole session (see below)

If a display capture ends unexpectedly (for example mousectl restarts), it is retried after a second, up to 3 times; after that the session uses Screen Sharing. If no picture arrives within 4 seconds of connecting (an old mousectl that doesn't know the display command, or no Screen Recording permission), the session switches to Screen Sharing right away.

## Why a transcoding proxy

Forwarding Screen Sharing's stream to the phone as-is doesn't work:

- **Too big**: Apple's Screen Sharing only offers ZRLE, which barely compresses photos and wallpapers; the first frame of a 4K display is over 10 MB, which takes half a minute through a small relay server in relay mode
- **Canvas limits**: with several displays Apple stitches them into one huge framebuffer, which exceeds the phone browser's canvas limit and just renders black
- **Lag**: on a slow phone connection data piles up in transit and input gets slower and slower

So the Mac decodes the picture, keeps only the selected display (or window), scales it to point resolution by default and sends JPEG (noVNC's Tight encoding). The first frame is a few hundred KB. A frame is only sent when the phone asks for one, and only the changed regions; on a slow network frames are simply skipped instead of queueing up.

The handshake and authentication pass through unchanged (ARD authentication, credentials encrypted on the phone), with two compatibility fixes: the version string (Apple says 003.889, noVNC answers 003.008, which Apple rejects) and a reason added to authentication failures. Switching display, quality or window, restoring the front app, resizing a window and probing for text fields use a few custom messages (250 / 252 / 253 / 247 / 254), without signing in again; the proxy's replies ride on DesktopName (`[w]` window view, `[x]` reason for falling back to the display, `[r]` please reconnect, `[k]` text field probe result, `[z]` resize result).

## How auto keyboard decides

On message 254 the proxy asks mousectl for two read-only signals; neither touches the app itself or reads what is in a text field:

- **Whether the system pointer is an I-beam**: apps switch to it over text fields, including apps whose content isn't exposed to Accessibility (WeChat, Electron apps and the like)
- **The role of the focused control in Accessibility** (text field, text area, search field, combo box) and the text cursor position, available in native apps

iOS only lets a page open the keyboard synchronously inside the tap gesture, and a network round trip is too late. So the phone probes as soon as a finger touches down (the proxy moves the pointer there without clicking and checks its shape once the app has updated it); if the answer is back by the time the finger lifts and it is a text field, the keyboard opens right there. Otherwise it probes again after the click and, if it is a text field, shows a floating "⌨ Type" button next to it that opens the keyboard. With the keyboard up, the view zooms to the screen width and keeps the text cursor (or the tapped point) above the keyboard. It is off in the sideways view.

The "front app" always comes from Accessibility (`AXFocusedApplication`), falling back to the owner of the topmost normal window: `NSWorkspace.frontmostApplication` never updates in the run-loop-less mousectl agent, which made "switch back" remember the wrong app.

## Resizing, closing windows, quitting apps

- **Resize**: mousectl `w place` sets the window's position and size directly through Accessibility (`AXPosition` / `AXSize`), without dragging edges or activating the window. When growing it moves the window first so the app doesn't clip it at the screen edge. Windows that can't be resized say so
- **Close**: presses the close button the window exposes in Accessibility (`AXCloseButton`), same as the red button
- **Quit**: `NSRunningApplication.terminate()` (normal) / `forceTerminate()` (force); mousectl refuses system processes (Finder, Dock, loginwindow, Control Center and so on)

## macOS quirks we hit

- **Multi-display offsets**: a display's position inside the stitched framebuffer can't be derived from the system's screen coordinates; with negative coordinates Apple shifts some displays sideways. Vertical positions can be computed, horizontal ones must be measured: on the first connection the proxy moves the pointer through Screen Sharing into each display's row and reads back the system's cursor x coordinate (coordinates only, no pixels). The result is cached per display layout in `~/.cache/pane-remote/screen-layout.json`
- **Apple's injected pointer is confined to one row of displays**: with several displays Screen Sharing can only place the cursor's y coordinate within one row, so other displays can't be clicked. mousectl posts system mouse events directly instead; Screen Sharing is only the fallback when mousectl is missing
- **IME trouble**: CJK sent as key codes arrives out of order, and an active Chinese input method swallows Latin letters. So all text is put on the clipboard by mousectl and pasted with ⌘V, and your previous clipboard is restored shortly afterwards
- **Cold sessions stream black**: the first login after the Screen Sharing process cold-starts streams black for the whole session (requesting frames again doesn't help); logging in again right away works. The system log shows that after sign-in Screen Sharing wakes the main display; if the display was in a low-power state, the displays reconfigure and its capture never starts for that session. Display pictures now come from mousectl by default, which avoids this; when the picture falls back to Screen Sharing there is still a safety net: for the first 15 seconds the proxy holds back fully black frames (the phone says Screen Sharing is starting), and if the picture stays black it asks the phone to reconnect once with the password just typed (`[r]`). The phone keeps that password in memory only, for at most 20 seconds. Waking the display with `caffeinate -u` before connecting was tried: the first frame arrived but then the picture stopped updating, which is worse than black, so it is off by default (the environment variable `VNC_PROXY_WAKE=1` turns it on, for troubleshooting only)
- **Stale snapshots after bringing a window forward**: occasionally a window still yields only snapshots after it is brought forward, and those snapshots are old, so the view looks frozen. The proxy restarts live capture every 3 seconds, up to 3 times, and pressing the picture while it shows snapshots raises the window and restarts capture again
- **No live frames for windows on other Spaces**: ScreenCaptureKit delivers no live frames for windows on another desktop or parked by Stage Manager. mousectl falls back to periodic snapshots, then the proxy brings the window forward and captures it again (the phone shows a note)
- **Hidden pre-created windows**: some apps create hidden windows that look normal in the system window list; they are filtered out using the app's own accessibility window list
- **Background windows can't receive clicks**: clicks can't be delivered to a window that isn't frontmost, so in window mode the first press brings the window forward. Keys and text can go straight to that app's process before that, without stealing focus

## Lock screen

- **Typing goes through Screen Sharing while locked**: the lock screen's password field is secure input; it rejects paste and ignores key events posted by user processes such as mousectl, but keys injected by Screen Sharing (a system service) get through. The proxy checks `IOConsoleLocked` every second and, while locked, sends typed text character by character and keys as they are through Screen Sharing; after unlocking it switches back to mousectl
- **Faster display snapshots while locked**: the lock screen is protected, so ScreenCaptureKit gives no live frames there, only snapshots; for a whole display those are taken about 8 times a second (window snapshots stay at about 3), so typing doesn't look laggy
- **The unlocked session is kept for an hour after you leave**: when you unlock the Mac through Screen Sharing from the phone, macOS locks it again as soon as that connection ends (Apple's security behavior). So when the phone disconnects, the proxy keeps that connection open (up to an hour; `VNC_PROXY_HOLD_MS` changes it, 0 turns it off) and keeps the display awake with `caffeinate -d -u` so the Mac doesn't idle-lock. The next phone still signs in with Apple as usual (on a fresh connection that is closed right after); only then does it rejoin the kept session through `~/.cache/pane-remote/screen-hold.sock` (owner-only), so you don't type the Mac's password again. If the Mac gets locked meanwhile, or the hour runs out, the session is let go and the Mac locks as usual. Logs from that period go to `~/.cache/pane-remote/screen-hold.log`
- **Lock and leave**: in the More menu, tap twice to lock the Mac right away (⌃⌘Q) and disconnect without keeping the session

## Required permissions

| Where | For | Used for |
|---|---|---|
| System Settings → General → Sharing → Screen Sharing | turn on, allow access for your own account only | picture and sign-in |
| System Settings → Privacy & Security → Accessibility | mousectl | clicks, drags, scrolling, keys, pasting text, bringing windows forward, resizing and closing windows, the focus probe for auto keyboard |
| System Settings → Privacy & Security → Screen & System Audio Recording | mousectl | display and single-window pictures, window list |

The Xcode command line tools are also needed (`xcode-select --install`): mousectl is compiled on your Mac with `swiftc`.

`pane-remote doctor` checks whether Screen Sharing is on (only whether something listens on port 5900; it doesn't connect, since each connection makes Screen Sharing accept a session), whether mousectl is running and whether sharp (used for transcoding) loads.

## Signing certificate

macOS ties Accessibility and Screen Recording grants to the program's signature. The ad-hoc signature the compiler applies changes on every build, so each rebuild of mousectl after an update drops the grants and you have to turn them on again.

`--create-cert` creates a self-signed code-signing certificate named `pane-remote local signing` in the login keychain (the private key stays on this Mac; temporary files are deleted right away). From then on `install-mousectl.sh` signs with it and grants survive rebuilds. Grant the permissions once more after creating it. When `pane-remote update` brings mousectl changes, it rebuilds and re-signs with the certificate if there is one (grants survive); without it, the old mousectl is kept and update tells you. With an old mousectl that doesn't know the new commands, whole displays fall back to Screen Sharing for the picture and resizing, closing windows and auto keyboard don't work; everything else does. The first signing may ask whether codesign may use the key; choose "Always Allow".

Without the certificate, the install script only compiles mousectl when it doesn't exist yet, so grants aren't dropped needlessly.

## Limitations

- Typing briefly uses the clipboard (the previous content comes back within a second); something you copy on the Mac during that moment may be overwritten
- Minimized windows can't be captured (the view falls back to the display with a note)
- Auto keyboard guesses from the pointer shape and Accessibility, so apps that draw their own pointer may be misjudged; because of the iOS limitation you sometimes need to tap the "⌨ Type" button
- It depends on Screen Sharing's behavior and macOS details (multi-display offsets, shortcut flags); OS updates may need adjustments
- To turn it off: `pane-remote disable screen`, which also stops and removes mousectl

## Privacy

- **The server never sees your password**: sign-in uses Screen Sharing's own ARD authentication; credentials are encrypted on the phone with a Diffie-Hellman negotiated key, and the server, relay server and proxy just pass them through
- The proxy only handles the pixels it forwards (the selected display or window) and stores no frames; its logs contain only numbers such as sizes, byte counts and average brightness
- The text field probe only reads the focused control's role, the text cursor position and the pointer shape, never the field's content; logs record only the outcome (text field or not, and which signal said so)
- The display layout cache (`~/.cache/pane-remote/screen-layout.json`) holds coordinates only
- As with the rest of pane-remote, this assumes you are the only user of this Mac: mousectl's socket is readable and writable only by your account, but anything running as you can use it to send mouse and keyboard events
