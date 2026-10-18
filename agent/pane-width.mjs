// 从手机调某个 pane 在电脑上的宽度（电脑上图方便把它拖窄了，手机上看就挤成一条）。给 bridge 的 width 命令用。
//   node pane-width.mjs <pane> <列数>  -- <wezterm cli 命令…>   把这个 pane 调到大约这么宽（相邻 pane 至少留 MIN 列）
//   node pane-width.mjs <pane> eq      -- <wezterm cli 命令…>   按拆分树均分它所在的标签页（每块按叶子数比例分）
// 调完把这个标签页原来激活的 pane 还原，电脑上的焦点不变。输出调完后的列数。
//
// WezTerm 20240203 的坑（持久化模式下尤其明显）：
// - adjust-pane-size 不认 --pane-id，只调标签页当前激活的 pane，所以每步先 activate-pane
// - Left / Right 动的是离这个 pane 最近的那条祖先分隔线，挤的是哪个 pane 要看拆分树
// - 要的列数比被挤的 pane 能让的多时，mux 不会截断，而是把整个标签页撑宽，调回来也缩不回去，
//   电脑上就是最右边的 pane 跑到窗口外面
// 所以调宽度不推算，小步试探：每步最多「标签页里最窄的 pane 还能让出的列数」，量一下，变远了 / 挤到别人了就原路调回去
import { execFileSync } from 'node:child_process'

const MIN = 12 // 别的 pane 最少留这么多列

const sep = process.argv.indexOf('--')
const [paneArg, spec] = process.argv.slice(2, sep)
const [bin, ...base] = process.argv.slice(sep + 1)
if (sep < 0 || !bin || !/^\d+$/.test(paneArg || '')) { console.error('usage: pane-width.mjs <pane> <cols|eq> -- <wezterm cli…>'); process.exit(2) }
const pid = Number(paneArg)

const cli = (...args) => execFileSync(bin, [...base, ...args], { encoding: 'utf8', timeout: 10000 })
const panes = () => JSON.parse(cli('list', '--format', 'json'))
const tabOf = (id, ps) => ps.find((p) => p.pane_id === id)?.tab_id
const width = (id) => panes().find((p) => p.pane_id === id).size.cols
/** 标签页里每个 pane 的列数，外加 total：整个标签页的宽度 */
function widths(tab) {
  const ps = panes().filter((p) => p.tab_id === tab)
  const out = Object.fromEntries(ps.map((p) => [p.pane_id, p.size.cols]))
  out.total = Math.max(...ps.map((p) => p.left_col + p.size.cols))
  return out
}
function adjust(id, dir, amount) {
  cli('activate-pane', '--pane-id', String(id))
  cli('adjust-pane-size', '--pane-id', String(id), '--amount', String(amount), dir)
}
const ids = (w) => Object.keys(w).filter((k) => k !== 'total').map(Number)

/** 同一标签页里左右相邻（行有重叠）的 pane，近的在前 */
function neighbors(id, ps) {
  const me = ps.find((p) => p.pane_id === id)
  const l = me.left_col, r = l + me.size.cols, t = me.top_row, b = t + me.size.rows
  return ps
    .filter((p) => p.tab_id === me.tab_id && p.pane_id !== id && p.top_row + p.size.rows > t && p.top_row < b)
    .map((p) => [Math.min(Math.abs(p.left_col - r), Math.abs(p.left_col + p.size.cols - l)), p.pane_id])
    .sort((x, y) => x[0] - y[0])
    .map((x) => x[1])
}

function setWidth(id, target, protect = [], depth = 0) {
  const ps = panes()
  const tab = tabOf(id, ps)
  const cands = [id, ...neighbors(id, ps)]
  const dead = new Set() // 试过没用的「候选:方向」，后面不再试
  for (let round = 0; round < 40; round++) {
    let progressed = false
    for (const c of cands) {
      for (const d of ['Right', 'Left']) {
        if (dead.has(`${c}:${d}`)) continue
        const before = widths(tab)
        const want = target - before[id]
        if (want === 0) return before[id]
        // 连它自己也算：方向反了挤的就是它。只剩 1 列的不能再碰；已经到 MIN 的只拿 1 列试探（挤到它就撤回）
        const all = ids(before).map((k) => before[k])
        if (Math.min(...all) <= 1) return before[id]
        const step = Math.min(Math.abs(want), Math.max(1, Math.min(...all) - MIN))
        const back = d === 'Right' ? 'Left' : 'Right'
        adjust(c, d, step)
        const after = widths(tab)
        const moved = Math.max(...ids(before).map((k) => Math.abs((after[k] ?? 0) - before[k])))
        const squeezed = ids(before).some((o) => o !== id && (after[o] ?? MIN) < (protect.includes(o) ? before[o] : Math.min(MIN, before[o])))
        if (Math.abs(target - after[id]) < Math.abs(want) && !squeezed && after.total === before.total) {
          progressed = true
        } else {
          if (moved) adjust(c, back, moved)
          if (step === 1 || Math.abs(target - after[id]) >= Math.abs(want)) dead.add(`${c}:${d}`)
        }
      }
    }
    if (!progressed) break
  }
  const cur = width(id)
  if (depth === 0 && cur < target) {
    // 卡住了：多半是 WezTerm 要先挤的那个邻居已经到 MIN（中间那个还很宽，但这条分隔线挤的是边上那个）。
    // 先让卡住的邻居从它自己的邻居那里借点宽度（不许动这个 pane），再试一次
    const ws = widths(tab)
    const stuck = ids(ws).filter((o) => o !== id && ws[o] <= MIN)
    for (const o of stuck) setWidth(o, ws[o] + target - cur, [id], 1)
    if (stuck.length) return setWidth(id, target, [], 1)
  }
  return cur
}

// ---------- 均分：按拆分树，每块按叶子数比例分，几轮收敛 ----------
function build(rects) {
  if (rects.length === 1) return { leaf: rects[0] }
  for (const [axis, pos, size] of [['v', 'left', 'w'], ['h', 'top', 'h']]) {
    const lo = Math.min(...rects.map((r) => r[pos]))
    const hi = Math.max(...rects.map((r) => r[pos] + r[size]))
    for (const cut of [...new Set(rects.map((r) => r[pos] + r[size]))].sort((a, b) => a - b)) {
      if (!(lo < cut && cut < hi)) continue
      const a = rects.filter((r) => r[pos] + r[size] <= cut)
      const b = rects.filter((r) => r[pos] >= cut)
      if (a.length && b.length && a.length + b.length === rects.length) return { type: axis, pos: cut, a: build(a), b: build(b) }
    }
  }
  return { leaf: rects[0] }
}
const leaves = (n) => (n.leaf ? 1 : leaves(n.a) + leaves(n.b))
// 靠在这条分割线上的叶子：竖线取左半边最右的，横线取上半边最下的
function edgeLeaf(n, axis) { while (!n.leaf) n = n.type === axis ? n.b : n.a; return n.leaf }
function plan(node, l, t, w, h, out) {
  if (node.leaf) return
  const ca = leaves(node.a), cb = leaves(node.b)
  if (node.type === 'v') {
    const tw = Math.floor((w * ca) / (ca + cb))
    const delta = l + tw - node.pos
    if (delta) out.push([edgeLeaf(node.a, 'v').id, delta > 0 ? 'Right' : 'Left', Math.abs(delta)])
    plan(node.a, l, t, tw, h, out); plan(node.b, l + tw, t, w - tw, h, out)
  } else {
    const th = Math.floor((h * ca) / (ca + cb))
    const delta = t + th - node.pos
    if (delta) out.push([edgeLeaf(node.a, 'h').id, delta > 0 ? 'Down' : 'Up', Math.abs(delta)])
    plan(node.a, l, t, w, th, out); plan(node.b, l, t + th, w, h - th, out)
  }
}
function equalize(id) {
  for (let round = 0; round < 3; round++) {
    const ps = panes()
    const tab = tabOf(id, ps)
    const rects = ps.filter((p) => p.tab_id === tab).map((p) => ({ id: p.pane_id, left: p.left_col, top: p.top_row, w: p.size.cols, h: p.size.rows }))
    if (rects.length < 2) return
    const steps = []
    plan(build(rects), 0, 0, Math.max(...rects.map((r) => r.left + r.w)), Math.max(...rects.map((r) => r.top + r.h)), steps)
    if (!steps.length) return
    for (const [p, dir, amount] of steps) adjust(p, dir, amount)
  }
}

const ps = panes()
const tab = tabOf(pid, ps)
if (tab === undefined) { console.error('pane not found'); process.exit(2) }
const active = ps.find((p) => p.tab_id === tab && p.is_active)?.pane_id
try {
  if (spec === 'eq') equalize(pid)
  else if (/^\d+$/.test(spec || '') && Number(spec) >= MIN && Number(spec) <= 999) setWidth(pid, Number(spec))
  else { console.error('bad width'); process.exit(2) }
} finally {
  if (active !== undefined) cli('activate-pane', '--pane-id', String(active)) // 焦点还给原来的 pane
}
console.log(width(pid))
