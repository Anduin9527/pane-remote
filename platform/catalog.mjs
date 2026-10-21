// 插件目录：扫描 plugins/<id>/，用 whatevertools 的描述文件加载器认 whatevertools.json（原生格式）或 plugin.json（uTools 格式）。
// 每次列表都重新扫（插件不多，文件小）；目录的 mtime 没变就用缓存。
// 给前端的列表里，功能指令（text 类型）预先算好拼音全拼和首字母，前端匹配时不用带拼音库。
import fs from 'node:fs'
import path from 'node:path'
import { loadManifest, nativeManifestLoader } from '@whatevertools/core'
import { utoolsManifestLoader } from '@whatevertools/compat-utools'
import { pinyin } from 'pinyin-pro'

const LOADERS = [nativeManifestLoader, utoolsManifestLoader]
const FILES = [...new Set(LOADERS.flatMap((l) => l.files))]
const DEFAULT_KEEPALIVE = 300 // 秒：后台超过这么久就睡眠

const pinyinCache = new Map()
function pinyinOf(label) {
  if (!/[一-鿿]/.test(label)) return null
  let v = pinyinCache.get(label)
  if (v === undefined) {
    try {
      const full = pinyin(label, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase().replace(/\s+/g, '')
      const initials = pinyin(label, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase().replace(/\s+/g, '')
      v = { full, initials }
    } catch { v = null }
    if (pinyinCache.size > 5000) pinyinCache.clear()
    pinyinCache.set(label, v)
  }
  return v
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** 一个目录 → 描述（加载器的结果）+ pane-remote 自己的扩展字段（whatevertools.json 的 paneRemote） */
export function loadPlugin(dir) {
  const files = {}
  for (const f of FILES) { const j = readJson(path.join(dir, f)); if (j !== undefined) files[f] = j }
  const m = loadManifest(LOADERS, { dir, files })
  const extra = files['whatevertools.json']?.paneRemote || {}
  const keepAlive = Number.isFinite(extra.keepAlive) ? Math.max(30, Math.min(3600, extra.keepAlive)) : DEFAULT_KEEPALIVE
  return {
    ...m,
    // 目录里的插件一律跑在 iframe 里；inner-view（同页 Shadow DOM）只给编进前端的平台自带视图用，白名单在前端（plugins/inner-view.ts）
    container: 'iframe',
    keepAlive,
    // 插件可以加入的共享存储组（platform.storage）：只认描述文件里写了的
    storageGroups: Array.isArray(extra.storage) ? extra.storage.filter((g) => typeof g === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(g)) : [],
    // 改用 Mac 做的能力：clipboard（clipboard.writeText 写 Mac 的剪贴板）、openExternal（shell.openExternal 在 Mac 上打开）
    mac: { clipboard: extra.mac?.clipboard === true, openExternal: extra.mac?.openExternal === true },
  }
}

export function createCatalog(rootDir) {
  let cache = { key: '', plugins: new Map(), problems: [] }
  function scan() {
    let names = []
    try { names = fs.readdirSync(rootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() } catch {}
    // 目录和各插件描述文件的 mtime 拼成缓存键
    const key = names.map((n) => { const d = path.join(rootDir, n); return n + ':' + FILES.map((f) => { try { return fs.statSync(path.join(d, f)).mtimeMs } catch { return 0 } }).join(',') }).join('|')
    if (key === cache.key) return cache
    const plugins = new Map()
    const problems = []
    for (const n of names) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(n)) continue
      try {
        const m = loadPlugin(path.join(rootDir, n))
        // 目录名就是插件 id（静态文件路径 /plugins/<目录名>/ 和权限、数据都按它存），描述文件里的 id 不一致时以目录名为准
        if (m.id !== n) m.declaredId = m.id
        m.id = n
        plugins.set(n, m)
      } catch (e) { problems.push({ dir: n, error: e.problems ? e.problems.join('; ') : e.message }) }
    }
    if (problems.length) console.log(`plugins: skipped ${problems.map((p) => `${p.dir} (${p.error})`).join(', ')}`)
    cache = { key, plugins, problems }
    return cache
  }
  return {
    dir: rootDir,
    get: (id) => scan().plugins.get(id),
    all: () => [...scan().plugins.values()],
    problems: () => scan().problems,
    /** 给前端的列表 */
    list() {
      return this.all().map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        logo: m.logo ? `plugins/${m.id}/${m.logo}` : '',
        main: `plugins/${m.id}/${m.main}`,
        container: m.container,
        keepAlive: m.keepAlive,
        format: m.format,
        permissions: m.permissions,
        features: m.features.map((f) => ({
          code: f.code,
          description: f.description || '',
          cmds: f.cmds.map((c) => {
            const cmd = typeof c === 'string' ? { type: 'text', label: c } : c
            const py = cmd.type === 'text' ? pinyinOf(cmd.label) : null
            return py ? { ...cmd, py: py.full, pyi: py.initials } : cmd
          }),
        })),
      }))
    },
  }
}
