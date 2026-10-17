// 快捷键栏的默认键位；用户可以隐藏、调顺序、加宏（存在手机本地）
const ESC = '\x1b'
export type Key = { label: string; seq: string; repeat?: boolean; hidden?: boolean; macro?: boolean; enter?: boolean; pinned?: boolean }

/** 默认放在第一行的键（其余收在「⋯」展开的面板里）。Claude Code 里滚动和点选已经能用手势，方向键只留上下 */
export const DEFAULT_PINNED = new Set(['\x1b', '\t', '\x1b[Z', '\x1b[A', '\x1b[B', '\r', '\x1b\r', '\x03'])
export const isPinned = (k: Key) => k.pinned ?? DEFAULT_PINNED.has(k.seq)

export const DEFAULT_KEYS: Key[] = [
  { label: 'Esc', seq: ESC }, { label: 'Tab', seq: '\t' }, { label: '⇧⇥', seq: `${ESC}[Z` },
  { label: '↑', seq: `${ESC}[A`, repeat: true }, { label: '↓', seq: `${ESC}[B`, repeat: true },
  { label: '←', seq: `${ESC}[D`, repeat: true }, { label: '→', seq: `${ESC}[C`, repeat: true },
  { label: '⏎', seq: '\r' }, { label: '⇧⏎', seq: '\x1b\r' }, { label: '⌫', seq: '\x7f', repeat: true },
  { label: 'Ctrl', seq: 'ctrl' }, { label: '⇧', seq: 'shift' }, { label: '⌥', seq: 'alt' },
  { label: '^C', seq: '\x03' }, { label: '^D', seq: '\x04' }, { label: '^Z', seq: '\x1a' }, { label: '^R', seq: '\x12' }, { label: '^L', seq: '\x0c' },
  { label: 'y', seq: 'y' }, { label: 'n', seq: 'n' }, { label: '1', seq: '1' }, { label: '2', seq: '2' }, { label: '3', seq: '3' },
  { label: '/', seq: '/' }, { label: '空格', seq: ' ' },
  { label: 'PgUp', seq: `${ESC}[5~` }, { label: 'PgDn', seq: `${ESC}[6~` },
]

/** 用户自定义过键位时，把后来新增的默认键插到它在默认布局里的位置（紧跟在默认顺序里它前面那个键后面），按序列判断不会重复 */
export function withNewDefaults(list: Key[]): Key[] {
  const out = [...list]
  DEFAULT_KEYS.forEach((k, i) => {
    if (out.some((x) => x.seq === k.seq)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.findIndex((x) => x.seq === DEFAULT_KEYS[j].seq)
      if (idx >= 0) { at = idx + 1; break }
    }
    out.splice(at, 0, k)
  })
  return out
}
