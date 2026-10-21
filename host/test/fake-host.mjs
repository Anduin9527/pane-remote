// 测试用的假 Host：画面文字每 200ms 变一次；会话记录是 FAKE_TRANSCRIPT 指向的文件，每行 {"id","text"} 一条用户消息
import fs from 'node:fs'
import path from 'node:path'
import { STATE } from '../paths.mjs'

export function createHost() {
  const file = process.env.FAKE_TRANSCRIPT
  return {
    platform: 'fake',
    terminals: {
      list: async () => [{ pane: 1, tab: 1, window: 1, workspace: 'pane-remote-test', title: 'fake', tabTitle: '', cwd: '~', dir: '/tmp', cols: 80, rows: 24, active: true, cursor: { x: 0, y: 0, visible: true } }],
      text: async (pane) => { if (pane !== 1) throw new Error('pane gone'); return `tick ${Math.floor(Date.now() / 200)}` },
    },
    agents: {
      session: async () => (file ? { agent: 'claude', transcript: file } : {}),
      messages: async (s, n) => {
        let lines = []
        try { lines = fs.readFileSync(s.transcript, 'utf8').split('\n').filter(Boolean) } catch {} // ignore: 测试里文件可能还没写
        return lines.map((l) => JSON.parse(l)).map((d) => ({ id: d.id, role: 'user', ts: '', parts: [{ type: 'text', text: d.text }] })).slice(-n)
      },
      watchFiles: (s) => (s?.transcript ? [s.transcript] : []),
    },
    // 剪贴板在内存里；打开的网址记进 FAKE_OPENED 文件（测试读它确认），不碰真的剪贴板和浏览器
    desktop: {
      clipboard: { text: 'fake clipboard', readText() { return Promise.resolve(this.text) }, writeText(t) { this.text = String(t); return Promise.resolve(true) } },
      openUrl: async (url) => { if (process.env.FAKE_OPENED) fs.appendFileSync(process.env.FAKE_OPENED, url + '\n'); return true },
    },
    events: { log: path.join(STATE, 'events.jsonl') },
  }
}
