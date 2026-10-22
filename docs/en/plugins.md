# pane-remote plugin platform

[中文](../plugins.md) | English

pane-remote can run plugins on the phone (optional module `plugins`, on by default; after `pane-remote disable plugins` the `/api/plugins` endpoints return 404, while the built-in Preview, This Mac and Screen keep working): a global floating button → bottom drawer (input box + plugin list) → the plugin opens in the foreground, covering the shell. The plugin format and API follow whatevertools (npm [`@whatevertools/core`](https://www.npmjs.com/package/@whatevertools/core), uTools compatible); the platform adapter is named `pane-remote`.

Where the code lives:

| Path | Role |
|---|---|
| `platform/` | Platform core (runs in the server): plugin catalog, static files, permissions, audit, capability table and RPC dispatch |
| `platform/runtime.js` | Runtime injected into every plugin page: `window.whatevertools` and a subset of `window.utools` |
| `web/src/lib/plugins/` | Phone front end: floating button, drawer, containers, lifecycle, permission prompts |
| `plugins/<id>/` | Plugin folders (scanned by the server; changes need no restart) |
| `host/` (pane-host on the computer) | Implements the computer-side capabilities: AI, the computer's clipboard, opening URLs on the computer, read-only files (see [host.md](host.md)) |

Computer-side capabilities go over the server's long-lived connection to pane-host (`server/host-client.mjs`; `server/server.mjs` hands it to `createPlatform` as `host`). When pane-host is offline these calls fail with `EWTHOSTDOWN`; everything else keeps working.

`platform/` depends on `@whatevertools/core`, `@whatevertools/compat-utools`, `@whatevertools/db-file` (0.2.x) and `pinyin-pro` from npm. They are listed in the root `package.json`, so `install.sh` (`npm ci --omit=dev`) installs them. Without them the server still starts, just without plugins (the log has a `plugins: platform disabled` line).

## Plugin format

Two manifest formats, same as whatevertools:

- **uTools format**: `plugin.json` (`main`, `logo`, `features`, `preload`…), optionally with a `whatevertools.json` next to it for identity and permission reasons; it doesn't affect publishing to uTools.
- **Native format**: `whatevertools.json` with a `main` field.

The folder name is the plugin id (static file paths, permissions and data are keyed by it); if the manifest's id differs, the folder name wins.

pane-remote specific settings go under `paneRemote` in `whatevertools.json`:

```json
{
  "id": "hello",
  "permissions": {
    "notification": { "reason": "Notify you when you tap Notify" }
  },
  "paneRemote": {
    "requires": ">=0.2.0",
    "keepAlive": 300,
    "storage": ["demo"],
    "mac": { "clipboard": false, "openExternal": false }
  }
}
```

| Field | Meaning |
|---|---|
| `requires` | Required plugin API version range (`0.2.0`, `>=0.2.0`, `^0.2.0`, `~0.2.1`; space-separated parts must all hold). Plugins that don't match are not loaded and are listed as catalog problems. The current version is `whatevertools.platform.info().api` or `api` in `GET /api/plugins` |
| `keepAlive` | Seconds in the background before the plugin goes to sleep (30–3600, default 300) |
| `storage` | Shared storage groups it may join (`platform.storage`); undeclared groups are refused |
| `mac.clipboard` | `true`: `copyText` / `clipboard.writeText` write the **computer's** clipboard (default: the phone's) |
| `mac.openExternal` | `true`: `shellOpenExternal` / `shell.openExternal` open on the **computer** (default: on the phone) |

The reasons in `permissions` are shown in permission prompts; declaring a permission does not grant it.

**Versions**: `platform.info()` returns `{ name, version, api }`. `version` is the pane-remote system version (also returned by `utools.getAppVersion()`); `api` is the plugin API version, bumped only when the plugin-facing API changes (minor for additions, major for changes / removals). Prefer `supports()` to check whether an API is usable; `requires` is only a coarse filter.

Samples:

- `plugins/hello/` (plugin.json + index.html): dbStorage, notifications, copy, incident reports, shared storage, asking on the phone.
- `plugins/ai-demo/` (whatevertools.json + index.html): pick a model and reasoning level with `utools.allAiModels()`, streamed answers with `utools.ai(…, onChunk)`, stop (abort), attach a photo (downscaled in the page to a JPEG with a 1280 px long edge).

## Entry matching

The drawer's input box matches the `cmds` declared by plugins using the whatevertools rules:

- **text** (string): prefix > contains > subsequence; Chinese commands also match full pinyin and initials (the server computes pinyin and sends it with the list, so the front end ships no pinyin library)
- **regex**: `"/.../flags"`, with `minLength` / `maxLength`; match-everything regexes are ignored, as in uTools
- **over**: any text, with an `exclude` regex, default length 1–10000

Enter opens the best-scoring entry with the input as entry data (`onPluginEnter` receives `{ code, type, payload }`). img / files / window entries don't apply on a phone and never match.

## Containers

| Container | Used for | Isolation |
|---|---|---|
| **iframe** (default) | Every plugin in `plugins/` | `sandbox="allow-scripts allow-forms"` **without** `allow-same-origin`: the plugin page has an opaque origin and can't touch the shell's localStorage, cookies or APIs |
| **inner-view** | Built-in views compiled into the front end: Preview, This Mac, Screen | Same page, mounted in a Shadow DOM (separate DOM; the shell's stylesheets are adopted by default). The allow-list is the front end's `registerInnerView` registry; folder plugins can't declare themselves inner-view |

Security boundary for iframe plugins:

- Plugin files are served under their own sub-path `/plugins/<id>/` with a CSP: `sandbox allow-scripts allow-forms` (still sandboxed if opened directly), `frame-ancestors 'self'` (only this site may embed it), `form-action 'none'`. `fetch` in the page can reach the internet (as in whatevertools; the `network` permission only covers Node modules).
- Requests from plugin pages carry `Origin: null`; the server answers 403 to any such request under `/api/`. Plugins can only call the platform via postMessage, and **the plugin is identified by which iframe the message came from**, not by what the plugin claims.
- Loading its own module scripts or fetching its own files is also cross-origin for a plugin page: `Access-Control-Allow-Origin: null` is only returned when the `Referer` is a page of the same plugin (a sandboxed iframe on another site is also `Origin: null`, but its Referer won't match).

inner-view API (`web/src/lib/plugins/inner-view.ts`):

```ts
registerInnerView({
  id: 'screen',
  name: 'Screen',
  description: 'View and control the computer screen',
  icon: MonitorSmartphone,          // icon component for the drawer (or a logo image URL)
  cmds: [{ label: '看屏幕', py: 'kanpingmu', pyi: 'kpm' }, 'vnc'],   // no pinyin library in the front end: write pinyin / initials here
  keepAlive: 1800,                  // seconds in the background before sleeping
  header: false,                    // no platform header (full-screen views draw their own); change at runtime with ctx.header(show)
  available: () => !!appConfig.modules.screen,   // hidden from the drawer when unavailable (opening the address still works)
  mount(root: ShadowRoot, ctx) {    // ctx: action / onEnter / onLeave / header(show) / background() / close()
    // render into root; return a cleanup function (called on sleep / close)
    return () => {}
  },
})
```

The shell's stylesheets (Tailwind) are copied once and adopted into each shadow root (`adoptedStyleSheets`, shared by all inner-views), so view components use the same classes; `pageStyles: false` turns it off. Inside a shadow root `document.activeElement` only sees the host element; ask `el.getRootNode().activeElement`.

### Built-in plugins

Registered in `web/src/lib/plugins/builtin.svelte.ts` (the first screen only carries the registration and icons; components download when opened). Components get a reactive `active` prop (true in the foreground) and decide how to throttle in the background; state to restore after sleeping is kept in localStorage by the component.

| id | Name | Component | keepAlive | Background | Restored after sleep |
|---|---|---|---|---|---|
| `preview` | Preview | `lib/preview/PreviewView.svelte` | 10 min | Connection stays; withholds the ack so the computer doesn't capture the next frame, catches up when back | Source and desktop mode; if all tabs on the computer are gone (Chrome is reclaimed after 20 idle minutes) the last page is reopened (`previewLast:<source>`). In full screen the plugin header hides too |
| `mac` | This Mac | `lib/mac/MacPanel.svelte` | default | Stops sampling performance | Existing keys (performance expanded, read-aloud settings) |
| `screen` | Screen | `lib/screen/ScreenView.svelte` (noVNC) | 30 min | WebSocket / VNC connection stays; stops requesting frames from the transcoding proxy (it only sends a frame when the phone asks), requests one incremental frame when back, no reconnect | Display, sharpness, input mode, rotation (existing keys); the window being viewed, zoom and position (`screenView`, valid for 2 hours; not restored after Disconnect). Disconnects on sleep; the proxy keeps the unlocked session |

The three built-in plugins follow the modules `preview`, `mac` and `screen`: a module that is off on the server doesn't show up in the drawer (`modules` from `/api/config`). The Screen view's top-left button means "send to background"; Disconnect and Lock & leave are in its More menu. The top bar's More menu has a Plugins item that opens the drawer; the "Open in preview" push navigates to `#/plugin/preview` (opened by the plugin layer).

## Lifecycle

| State | Meaning |
|---|---|
| Foreground | Visible, only one at a time; the address is `#/plugin/<id>` |
| Background | Hidden but not unloaded: the container is `invisible` + `inert` and the plugin gets `onPluginOut`; the floating button shows the background count |
| Sleeping | In the background longer than `keepAlive` (default 5 min), or the app hidden for over 2 min: the page is unloaded and only a record is kept; opening it again reloads it (when the app comes back, the plugin that was in the foreground reloads automatically) |
| Closed | The record is gone too; "this time only" grants expire |

At most 3 plugin pages stay mounted; beyond that the least recently used goes to sleep. Data (db / dbStorage) lives on the server and survives sleep, reloads and switching phones.

Front-end API (`web/src/lib/plugins/index.ts`): `openPlugin(id, payload?)`, `closePlugin(id)`, `backgroundPlugin(id)`, `sleepPlugin(id)`. The address `#/plugin/<id>` and the foreground plugin stay in sync both ways: opening the address brings the plugin to the foreground; a plugin coming to the foreground updates the address; backgrounding / closing returns to the view you came from (replacing the current history entry rather than going back, so a cold start doesn't exit the app); leaving the plugin address (back gesture, a push opening a session, picking another session) sends the foreground plugin to the background.

## Permissions

Uses whatevertools core's `PermissionManager` (Chrome style):

- Ask by default; the plugin's own database (`storage`) and incident reports (`platform.incident`) are granted by default
- The prompt appears on the phone that made the call: **This time / Always allow / Deny / Later**
- Later (or dismissing) counts as a denial this time; 3 in a row turn into Deny (counted across reopenings)
- "This time" lasts for this opening of the plugin and expires when it is closed
- Decisions are stored per plugin in `plugins/permissions.json` in the server's data folder; the shield button in the plugin header lets you set each item to allow / ask / deny, or reset all
- If nobody answers within 5 minutes the call fails and nothing is recorded

pane-remote specific permissions:

| id | Default | Meaning |
|---|---|---|
| `platform.incident` | granted | Record problems the plugin finds in the incident reports |
| `platform.storage` | ask (per group) | Read and write a shared storage group; Always allow only covers the group asked about |
| `platform.agent` | ask | Ask questions on the phone, send pushes |

## Capability table and support

Every capability call: look up the capability table → check permission (asking the phone if needed) → write an audit entry → hand over to the implementer:

| Implementer | Covers |
|---|---|
| Server | Database, pushes, incident reports, shared storage, asking on the phone |
| Front end (web) | Copy, open links, open another plugin: the server checks permission and replies `$delegate`, the front end does it |
| Plugin page (local) | Lifecycle, platform info, synchronous db / dbStorage reads and writes (local replica) |
| Computer (pane-host) | Wired up: AI (`ai.chat` / `ai.models` / `platform.ai.complete`), clipboard text, opening URLs, read-only files (`platform.fs.*`). Offline pane-host → `EWTHOSTDOWN`. Not wired up yet (screenshots, keyboard/mouse, child processes, shellOpenPath, clipboard files/images…) → `EWTUNSUPPORTED` with the reason in the error |

Audit: one line per call (plugin, method, result ok / denied / unsupported / error / delegated / cancelled, implementer, duration, no arguments), the last 500 in memory, also written to `plugins/audit.jsonl` (rotated at 2 MB). See `GET /api/plugins/audit[?plugin=]`.

Support table summary (the full one is `GET /api/plugins/support`, one row for every item in the whatevertools spec):

| API (uTools names) | support | Implementer | Notes |
|---|---|---|---|
| `onPluginEnter` / `onPluginOut` / `onPluginReady` / `outPlugin` | emulated | plugin page | |
| `db.put/get/remove/bulkDocs/allDocs` | emulated | plugin page + server | Synchronous on a local replica, changes pushed to the server within 50 ms, conflicts settled by rev (like CouchDB) |
| `db.postAttachment` | emulated | server | Returns a Promise (synchronous in uTools) |
| `db.getAttachment` | partial | server | The synchronous version only reads attachments already read in this session; use `db.promises.getAttachment` |
| `dbStorage.setItem/getItem/removeItem` | emulated | plugin page + server | |
| `showNotification` | emulated | server | In-page toast while pane-remote is open on the phone, otherwise a push |
| `copyText` | emulated | front end / computer | Writes the **phone's** clipboard by default; the computer's when `paneRemote.mac.clipboard` is true |
| `shellOpenExternal` | emulated | front end / computer | http(s) only; opens on the phone by default, on the computer when `paneRemote.mac.openExternal` is true |
| `ai` / `allAiModels` | emulated | computer | Claude Code / Codex / cursor-agent signed in on the computer, see AI below |
| `registerTool` | partial | plugin page | Only for `ai` tool calls; exposing tools to outside agents via MCP isn't done |
| `redirect` | partial | front end | Opens another plugin by id or command |
| `getFeatures`, `isDarkColors`, `getAppName`, `getAppVersion`, `isMacOS`, … | emulated | plugin page | `isMacOS/isWindows/isLinux` are all false (the plugin runs on the phone) |
| `setExpandHeight` | mock | plugin page | Plugins always fill the screen |
| `shellOpenPath`, `showOpenDialog`, `getPath`, `getPluginTempPath`, `copyImage`, `copyFile`, `getCopiedFiles`, `screenCapture`, `simulate*`, `hideMainWindowPaste*`, `readCurrentFolderPath`, `getNativeId`, `getUser`, `runFFmpeg`, `ubrowser` | none | computer (not yet) | |
| `sharp`, `requestSchedule`, `setFeature`, panel input box, `findInPage`, payments | none | — | |
| Node modules via `require('fs')` etc. (preload) | none | — | preload still runs as a `<script>`; `require` throws a clear error. Use `platform.fs` for files on the computer |

Plugins can check with `whatevertools.supports(name)` first (false for unsupported, old names work). Unsupported APIs still exist as functions and throw `code: 'EWTUNSUPPORTED'`.

## platform.* API (pane-remote only)

All under `window.whatevertools.platform` (same as `getApi().platform`):

```js
const wt = window.whatevertools

wt.platform.info()                       // { name: 'pane-remote', version, plugin }

// Incident reports: go into pane-remote's incident reports (source plugin:<id>, deduplicated by fingerprint, pushed by the usual rules)
await wt.platform.incident.report({ title: 'Sync failed', detail: '…', severity: 'normal' /* high|normal|low */ })
// Uncaught errors, unhandled rejections and console.error in the plugin page are reported automatically (at most 20 per load; the server also limits each plugin to 30 per minute)

// Shared storage: shared by every plugin that declares the same group in paneRemote.storage (stored on the server, each value ≤ 256 KB, ≤ 2000 keys per group)
await wt.platform.storage.set('demo', 'hits', 1)
await wt.platform.storage.get('demo', 'hits')     // null if missing
await wt.platform.storage.remove('demo', 'hits')
await wt.platform.storage.keys('demo')

// Ask you on the phone (same card as the agents' ask_phone; pushed when you're not looking, answerable from the push; POST /api/agent/answer works too)
const r = await wt.platform.agent.ask({ question: 'Continue?', options: ['Yes', 'No'], timeout: 600, confirm: false })
// → { answered: true, answer: 'Yes', text: '' } / { answered: true, answer: '', text: 'free-form answer' } / { answered: false, reason: 'timeout' }

// Push (rate limited like notify_phone: one per plugin every 20 s, 20 per hour in total)
await wt.platform.agent.notify({ title: 'Export done', body: '3 files' })   // → { sent: true } / { sent: false, reason: 'rate-limited' }

// Methods added later can be called without a runtime update
await wt.platform.call('platform.xxx', { … })
```

## AI

Models come from the Claude Code / Codex / cursor-agent signed in on the computer (`host/ai`, via pane-host). Needs the `ai` permission (ask by default) and uses that account's quota.

```js
const models = await utools.allAiModels()      // = whatevertools.ai.models()
// [{ id: 'claude/sonnet', label, icon, provider: 'claude', vision: true | 'bridged' | false,
//    efforts: ['low','medium','high','xhigh','max'], defaultEffort?, tier: 'fast'|'balanced'|'strong', structured, tools }, …]

// Streaming: with onChunk it resolves undefined; without, it resolves the full { role: 'assistant', content }
const p = utools.ai({ model: 'claude/sonnet@high', messages: [{ role: 'user', content: [
  { type: 'text', text: 'What does this picture say?' },
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,…' } },   // ≤ 10 MB per image, ≤ 15 MB per request
] }] }, (chunk) => { /* { role, content: delta, reasoning_content? } */ })
p.abort()   // cancel: the agent process on the computer is killed, p rejects with code: 'aborted'

// Tools: OpenAI function format; when the agent calls one, the function registered with registerTool runs (or a same-named function on window, uTools style)
utools.registerTool('add', ({ a, b }) => ({ sum: a + b }))
await utools.ai({ model: 'claude/haiku', messages, tools: [{ type: 'function', function: { name: 'add', description: 'Add', parameters: { … } } }] })

// Detailed version (pane-remote only): structured output, reasoning level, usage and timing
const r = await whatevertools.platform.ai.complete({ model: 'claude/haiku', messages, responseFormat: { type: 'object', … }, reasoning: 'low' }, { onChunk, signal })
// → { text, structured, reasoning, model, provider, usage: { inputTokens, outputTokens, … }, ttftMs, ms, totalMs, toolCalls, bridge? }
```

- Model ids: `<provider>/<model>[@effort]`; an effort not in `efforts` is an error. Models with `vision: 'bridged'` (cursor) first turn images into text with a vision model.
- Error codes: `aborted`, `EWTHOSTDOWN` (pane-host offline), `EAI_AUTH` (that agent isn't signed in on the computer), `EAI_MODEL`, `EAI_TIMEOUT`, `EAI_TOOLS`, `EAI_STRUCTURED`, `EAI_PROVIDER`… (`EAI_` + the host/ai code).
- When a plugin page sleeps or closes, its running AI calls are cancelled.
- Path: plugin page `call {stream: true}` → front end → server WS (`chunk`, `tool` calls back into the plugin page, the front end replies `tool-result`, `cancel`) → pane-host's `ai.complete` stream (tool calls are requests inside the stream; the server answers with `reply`, see [host.md](host.md)).
- No signed-in agent on the computer → the model list is empty.

## The computer's clipboard, opening on the computer

```js
await whatevertools.platform.mac.clipboard.readText()       // permission clipboard.read
await whatevertools.platform.mac.clipboard.writeText('…')   // permission clipboard.write
await whatevertools.platform.mac.openUrl('https://…')       // permission shell.external (asked per URL)
```

Or set `paneRemote.mac.clipboard` / `paneRemote.mac.openExternal` in the manifest to route the standard `copyText` / `shellOpenExternal` to the computer.

Opening URLs on the computer uses `/usr/bin/open`, **not** the `open` wrapper installed by the "open URLs on the phone" module (which would send the URL back to the phone while you're using it). Use the default `shellOpenExternal` to open on the phone, and `platform.mac.*` only when you want the computer's browser.

## Read-only files on the computer (platform.fs)

```js
await whatevertools.platform.fs.roots()                 // [{ root: 'private', path, exists }, { root: '~/Documents/notes', … }]
await whatevertools.platform.fs.list('')                // relative paths = the plugin's private folder ~/.local/share/pane-remote/plugins-data/<id>/
await whatevertools.platform.fs.readText('notes/a.md')  // up to 10 MB; { maxBytes } reads just the start
await whatevertools.platform.fs.read('~/Documents/notes/a.png')   // Uint8Array
await whatevertools.platform.fs.stat('/Users/me/Documents/notes/a.md', { root: '~/Documents/notes' })
```

- Read-only: no write, delete or rename.
- Private folder: permission `fs.plugin` (granted by default), created on the computer on first use (0700).
- Other folders: added by you under the plugin header's shield → "Folders on the computer it can read" (absolute or `~/…`, not the whole home folder or `/`, at most 20 per plugin); the first read asks `fs.read` once per folder (Always allow covers only that folder). Plugins can't add folders themselves.
- The server first maps the path (normalized to `~/…`, `..` removed) to its root and checks permission; pane-host then checks that the real path (after following symlinks) is inside that root. `.ssh`, `.gnupg`, keychains and `~/.config/pane-remote` are never readable.

### agent.tools (interface only, not implemented)

Plugins expose tools via MCP to the agent in a pane (Claude Code / Codex / cursor-agent):

```js
await wt.platform.agent.tools.register({
  name: 'stitch_images',                 // the agent sees plugin_<plugin id>_<name>
  description: 'Stitch several images into one',
  inputSchema: { type: 'object', properties: { … }, required: [ … ] },
  outputSchema: { … },                   // optional
}, async (input, ctx) => {               // ctx: { agent, pane, signal }
  return { files: [ … ] }
})
await wt.platform.agent.tools.unregister('stitch_images')
```

Design: tools can also be declared statically in the manifest's `tools`; needs the `mcp` permission; path: the agent calls the injected MCP server (`agent/plugin/mcp.mjs`) → via bridge / pane-host to the server → the phone where the plugin is online (WS) → plugin iframe → result back the same way. Every call is audited; calls can require confirmation on the phone.

## Server endpoints

| Endpoint | Meaning |
|---|---|
| `GET /api/plugins` | Plugin list (manifests + commands with pinyin) |
| `GET /api/plugins/support` | Support table |
| `GET/POST /api/plugins/permissions` | A plugin's permission decisions; change one / reset all |
| `GET /api/plugins/audit` | Recent call audit |
| `GET /api/plugins/asks` | Unanswered questions from plugins |
| `GET/POST /api/plugins/fs-dirs` | Folders on the computer a plugin may read: `?plugin=` to read; `{plugin, dirs}` replaces the whole list |
| `GET /plugins/_runtime.js`, `/plugins/<id>/…` | Runtime and plugin files (the runtime and startup data are injected into HTML) |
| `WS /api/platform/ws?client=<id>` | Front end ↔ platform: `call`/`result`, `prompt`/`prompt-answer`, `asks`, `vis`, `session-end`; streaming calls (`call` with `stream: true`) add `chunk`, `tool`/`tool-result`, `cancel`; reconnecting with the same client id replays results and prompts from while disconnected |

`POST /api/agent/answer` also answers plugin questions (handled by the platform when the id belongs to a plugin question). Pushes carry `plugin: <id>` and open `#/plugin/<id>`.

## Known limitations

- Pages built with `wt pack --target web` (which bundle the full whatevertools browser runtime) need IndexedDB / localStorage, which plugin iframes don't have without `allow-same-origin`, so they don't run.
- Node modules in preload (`require('node:fs')`, `electron`, …) aren't supported; use `platform.fs` for files on the computer.
- `utools.sharp`, `getPluginTempPath` and exposing tools via MCP (`agent.tools`) aren't available yet.
