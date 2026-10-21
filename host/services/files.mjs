// 插件的只读文件访问（platform.fs）。服务端查过权限后告诉这里用哪个根目录，这里再按真实路径（realpath，跟随符号链接后）核对一遍：
//   root: 'private' = 插件私有目录 ~/.local/share/pane-remote/plugins-data/<plugin>/（第一次用到时建，0700）
//         或者用户在手机设置里给这个插件加的目录（绝对路径或 ~/…，服务端只会传用户加过的）
//   path: 相对根目录的路径，或者绝对路径 / ~/…（必须落在根目录里）
// 不管根目录是什么，钥匙串、ssh、gnupg、pane-remote 自己的配置一律不给读。只读：没有写、删、改名。
//   fs.roots {plugin, dirs}          → [{root, path, exists}]
//   fs.list  {plugin, root, path?}   → [{name, type: file|dir|link|other, size, mtime}]（最多 2000 项）
//   fs.stat  {plugin, root, path}    → {name, type, size, mtime}
//   fs.read  {plugin, root, path, encoding?: 'utf8'|'base64', maxBytes?} → {data, encoding, size, truncated}
import fs from 'node:fs/promises'
import path from 'node:path'
import { HOME } from '../paths.mjs'

export const PLUGINS_DATA = process.env.PANE_HOST_PLUGINS_DATA || path.join(HOME, '.local/share/pane-remote/plugins-data')
const MAX_READ = 10 << 20
const DENY = [/(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /\/Library\/Keychains(\/|$)/, /\/\.config\/pane-remote(\/|$)/]

const err = (msg, code = 'EBADARG') => Object.assign(new Error(msg), { code })
const expand = (p) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
const pluginId = (id) => { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(id || ''))) throw err('bad plugin id'); return String(id) }

async function rootDir(plugin, root) {
  if (root === 'private') {
    const dir = path.join(PLUGINS_DATA, pluginId(plugin))
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    return fs.realpath(dir)
  }
  const r = expand(String(root || ''))
  if (!path.isAbsolute(r)) throw err('根目录要是绝对路径或 ~/…')
  try { return await fs.realpath(r) } catch { throw err(`目录不存在：${root}`, 'ENOENT') }
}

/** 解析出真实路径，确认在根目录里、不在禁区 */
async function resolve(plugin, root, p = '') {
  const base = await rootDir(plugin, root)
  const raw = String(p || '')
  const abs = raw.startsWith('/') || raw.startsWith('~') ? expand(raw) : path.join(base, raw)
  let real
  try { real = await fs.realpath(abs) } catch { throw err(`没有这个文件：${raw || '.'}`, 'ENOENT') }
  if (real !== base && !real.startsWith(base + path.sep)) throw err('路径不在允许的目录里', 'EWTPERM')
  if (DENY.some((re) => re.test(real))) throw err('这个位置不允许读', 'EWTPERM')
  return real
}

const typeOf = (st) => (st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'other')

export function createFilesService() {
  return {
    calls: {
      'fs.roots': async ({ plugin, dirs }) => {
        const out = [{ root: 'private', path: await rootDir(plugin, 'private'), exists: true }]
        for (const d of (Array.isArray(dirs) ? dirs : []).slice(0, 50)) {
          const p = expand(String(d))
          out.push({ root: String(d), path: p, exists: await fs.stat(p).then((s) => s.isDirectory(), () => false) })
        }
        return out
      },
      'fs.list': async ({ plugin, root, path: p }) => {
        const dir = await resolve(plugin, root, p)
        const ents = (await fs.readdir(dir, { withFileTypes: true })).slice(0, 2000)
        return Promise.all(ents.map(async (e) => {
          const st = await fs.lstat(path.join(dir, e.name)).catch(() => null) // ignore: 列目录时文件刚被删，按 other 列出
          return { name: e.name, type: st ? typeOf(st) : 'other', size: st?.size ?? 0, mtime: st ? Math.round(st.mtimeMs) : 0 }
        }))
      },
      'fs.stat': async ({ plugin, root, path: p }) => {
        const f = await resolve(plugin, root, p)
        const st = await fs.stat(f)
        return { name: path.basename(f), type: typeOf(st), size: st.size, mtime: Math.round(st.mtimeMs) }
      },
      'fs.read': async ({ plugin, root, path: p, encoding, maxBytes }) => {
        const f = await resolve(plugin, root, p)
        const st = await fs.stat(f)
        if (!st.isFile()) throw err('不是文件')
        const limit = Math.min(MAX_READ, Number(maxBytes) > 0 ? Number(maxBytes) : MAX_READ)
        const fh = await fs.open(f, 'r')
        try {
          const buf = Buffer.alloc(Math.min(limit, st.size))
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          const enc = encoding === 'base64' ? 'base64' : 'utf8'
          return { data: buf.subarray(0, bytesRead).toString(enc), encoding: enc, size: st.size, truncated: st.size > bytesRead }
        } finally { await fh.close() }
      },
    },
  }
}
