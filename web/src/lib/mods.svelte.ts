// 修饰键 ⇧ / ⌥：按一下亮起，只作用于下一次按键或点击，用完自动熄灭
export const mods = $state({ shift: false, alt: false })

const ARROW = /^\x1b\[([ABCD])$/
/** 按键序列套上修饰键：方向键 → CSI 1;N X，⇧⏎ → 换行（ESC CR），⇧Tab → CSI Z，⌥ 其他键 → 前面加 ESC */
export function withMods(seq: string): string {
  const { shift, alt } = mods
  if (!shift && !alt) return seq
  mods.shift = mods.alt = false
  const m = seq.match(ARROW)
  if (m) return `\x1b[1;${1 + (shift ? 1 : 0) + (alt ? 2 : 0)}${m[1]}`
  if (shift && seq === '\r') return '\x1b\r'
  if (shift && seq === '\t') return '\x1b[Z'
  return alt ? `\x1b${seq}` : seq
}
/** 鼠标点击的修饰位（SGR：⇧ +4，⌥ +8） */
export function mouseMods(): number {
  const bits = (mods.shift ? 4 : 0) + (mods.alt ? 8 : 0)
  mods.shift = mods.alt = false
  return bits
}
