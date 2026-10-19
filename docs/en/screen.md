# Screen module

[中文](../screen.md) | English

View and control the Mac's screen from your phone: a whole display, or just one window. The picture comes from macOS's built-in Screen Sharing; no third-party remote desktop software is needed. macOS only, off by default.

```bash
pane-remote enable screen                 # installs the mousectl helper and lists the manual steps
pane-remote enable screen --create-cert   # same, plus a local self-signed certificate to sign mousectl (see "Signing certificate")
```

Once enabled, a screen icon appears in the phone's top bar. Tap it and sign in with your Mac username and password.

## What it does

- **One display**: with several displays, chips at the top switch between them (★ is the main display). "Data saver" sends at point resolution (4× fewer pixels), "Sharp" sends actual pixels
- **One window**: the "Window" button lists every capturable window (including ones on other desktops or parked by Stage Manager), with search. Only that window is captured and it stays in the background; the first tap brings it forward, and "Switch back" restores the previous front app
- **Launch apps in the background**: below the windows are apps without windows. "Open in background" doesn't steal focus, and the new window is picked automatically once it appears. Menu-bar-only apps show "Summon" instead: Spotlight uses its shortcut from System Settings, uTools uses the show hotkey from its own settings, and other apps get their menu bar icon clicked
- **Direct touch mode**: tap = click, long-press = right-click, long-press and drag = drag with the left button, one-finger slide = scroll, two fingers = zoom / pan (on the phone only; the Mac is unaffected)
- **Trackpad mode**: slide to move the pointer, tap = click at the pointer, two-finger slide = scroll, pinch = zoom (the view follows the pointer)
- **Typing**: the keyboard button opens an input field; text is sent as a whole (CJK and IME output included). ⌘ ⌥ ⌃ ⇧ apply to the next key, so tapping ⌘ then typing c copies. Esc, Tab and arrow keys are there too
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
transcoding proxy (agent/screen/proxy.mjs, on the Mac) ──── pointer, keys, text, window frames ──── mousectl (LaunchAgent, unix socket)
   │ RFB, 127.0.0.1:5900
   ▼
macOS Screen Sharing
```

Window list, app list and launching go through plain HTTP endpoints (`GET /api/screen/displays|windows|apps`, `POST /api/screen/launch|summon`), which in turn ask mousectl via the bridge.

## Why a transcoding proxy

Forwarding Screen Sharing's stream to the phone as-is doesn't work:

- **Too big**: Apple's Screen Sharing only offers ZRLE, which barely compresses photos and wallpapers; the first frame of a 4K display is over 10 MB, which takes half a minute through a small relay server in relay mode
- **Canvas limits**: with several displays Apple stitches them into one huge framebuffer, which exceeds the phone browser's canvas limit and just renders black
- **Lag**: on a slow phone connection data piles up in transit and input gets slower and slower

So the Mac decodes the picture, keeps only the selected display (or window), scales it to point resolution by default and sends JPEG (noVNC's Tight encoding). The first frame is a few hundred KB. A frame is only sent when the phone asks for one, and only the changed regions; on a slow network frames are simply skipped instead of queueing up.

The handshake and authentication pass through unchanged (ARD authentication, credentials encrypted on the phone), with two compatibility fixes: the version string (Apple says 003.889, noVNC answers 003.008, which Apple rejects) and a reason added to authentication failures. Switching display, quality or window uses a few custom messages (250 / 252 / 253), without signing in again.

## macOS quirks we hit

- **Multi-display offsets**: a display's position inside the stitched framebuffer can't be derived from the system's screen coordinates; with negative coordinates Apple shifts some displays sideways. Vertical positions can be computed, horizontal ones must be measured: on the first connection the proxy moves the pointer through Screen Sharing into each display's row and reads back the system's cursor x coordinate (coordinates only, no pixels). The result is cached per display layout in `~/.cache/pane-remote/screen-layout.json`
- **Apple's injected pointer is confined to one row of displays**: with several displays Screen Sharing can only place the cursor's y coordinate within one row, so other displays can't be clicked. mousectl posts system mouse events directly instead; Screen Sharing is only the fallback when mousectl is missing
- **IME trouble**: CJK sent as key codes arrives out of order, and an active Chinese input method swallows Latin letters. So all text is put on the clipboard by mousectl and pasted with ⌘V, and your previous clipboard is restored shortly afterwards
- **Cold sessions stream black**: the first login after the Screen Sharing process cold-starts streams black for the whole session (requesting frames again doesn't help); logging in again right away works. If the picture stays fully black for the first 15 seconds, the proxy asks the phone to reconnect once with the password just typed. The phone keeps that password in memory only, for at most 20 seconds
- **No live frames for windows on other Spaces**: ScreenCaptureKit delivers no live frames for windows on another desktop or parked by Stage Manager. mousectl falls back to periodic snapshots, then the proxy brings the window forward and captures it again (the phone shows a note)
- **Hidden pre-created windows**: some apps create hidden windows that look normal in the system window list; they are filtered out using the app's own accessibility window list
- **Background windows can't receive clicks**: clicks can't be delivered to a window that isn't frontmost, so in window mode the first press brings the window forward. Keys and text can go straight to that app's process before that, without stealing focus

## Required permissions

| Where | For | Used for |
|---|---|---|
| System Settings → General → Sharing → Screen Sharing | turn on, allow access for your own account only | picture and sign-in |
| System Settings → Privacy & Security → Accessibility | mousectl | clicks, drags, scrolling, keys, pasting text, bringing windows forward |
| System Settings → Privacy & Security → Screen & System Audio Recording | mousectl | single-window view, window list |

The Xcode command line tools are also needed (`xcode-select --install`): mousectl is compiled on your Mac with `swiftc`.

`pane-remote doctor` checks whether Screen Sharing is on (port 5900), whether mousectl is running and whether sharp (used for transcoding) loads.

## Signing certificate

macOS ties Accessibility and Screen Recording grants to the program's signature. The ad-hoc signature the compiler applies changes on every build, so each rebuild of mousectl after an update drops the grants and you have to turn them on again.

`--create-cert` creates a self-signed code-signing certificate named `pane-remote local signing` in the login keychain (the private key stays on this Mac; temporary files are deleted right away). From then on `install-mousectl.sh` signs with it and grants survive rebuilds. Grant the permissions once more after creating it. The first signing may ask whether codesign may use the key; choose "Always Allow".

Without the certificate, the install script only compiles mousectl when it doesn't exist yet, so grants aren't dropped needlessly.

## Limitations

- The lock screen's password field may reject pasted text; then you have to unlock at the Mac (or keep it from locking)
- Typing briefly uses the clipboard (the previous content comes back within a second); something you copy on the Mac during that moment may be overwritten
- Minimized windows can't be captured (the view falls back to the display with a note)
- It depends on Screen Sharing's behavior and macOS details (multi-display offsets, shortcut flags); OS updates may need adjustments
- To turn it off: `pane-remote disable screen`, which also stops and removes mousectl

## Privacy

- **The server never sees your password**: sign-in uses Screen Sharing's own ARD authentication; credentials are encrypted on the phone with a Diffie-Hellman negotiated key, and the server, relay server and proxy just pass them through
- The proxy only handles the pixels it forwards (the selected display or window) and stores no frames; its logs contain only numbers such as sizes, byte counts and average brightness
- The display layout cache (`~/.cache/pane-remote/screen-layout.json`) holds coordinates only
- As with the rest of pane-remote, this assumes you are the only user of this Mac: mousectl's socket is readable and writable only by your account, but anything running as you can use it to send mouse and keyboard events
