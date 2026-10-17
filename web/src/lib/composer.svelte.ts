// 手机输入框的内容放在这里，别的组件（电脑输入框同步、推荐）能往里塞文字
export const composer = $state({
  text: '',
  /** 发送前先删掉电脑上 Claude 输入框里的这么多个字符（把电脑上打了一半的内容接到手机上编辑时用） */
  eraseFirst: 0,
  focusTick: 0,
})

// 每个 pane 各自的草稿，存在手机本地：突然切到别的 pane、甚至关掉 App，回来内容还在
const KEY = 'drafts'
let drafts: Record<string, string> = {}
try { drafts = JSON.parse(localStorage.getItem(KEY) || '{}') } catch {}
let currentPane: string | null = null
function persist() { try { localStorage.setItem(KEY, JSON.stringify(drafts)) } catch {} }

/** 切 pane：先把当前草稿记到原来的 pane 名下，再换成新 pane 的草稿 */
export function switchDraft(pane: string | null) {
  if (pane === currentPane) return
  if (currentPane) { if (composer.text) drafts[currentPane] = composer.text; else delete drafts[currentPane] }
  currentPane = pane
  composer.text = (pane && drafts[pane]) || ''
  composer.eraseFirst = 0
  persist()
}
/** 输入时随手存（防抖），发送后清掉 */
let t: ReturnType<typeof setTimeout> | undefined
export function saveDraft() {
  clearTimeout(t)
  t = setTimeout(() => {
    if (!currentPane) return
    if (composer.text) drafts[currentPane] = composer.text; else delete drafts[currentPane]
    persist()
  }, 300)
}
