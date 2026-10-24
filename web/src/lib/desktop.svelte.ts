// 电脑版：宽屏（≥1024px）+ 鼠标。会话列表常驻左边、终端直接用键盘打字、远控用真鼠标键盘；手机和 iPad 触屏照旧。
// 和 app.css 里的 desk: 变体是同一个条件。窗口拉宽拉窄时跟着变（有的浏览器 matchMedia 的 change 不一定来，resize 也看一下）
const Q = '(min-width: 1024px) and (pointer: fine)'
const mq = typeof matchMedia === 'function' ? matchMedia(Q) : null
export const desk = $state({ on: !!mq?.matches })
const check = () => { const v = !!mq?.matches; if (desk.on !== v) desk.on = v }
mq?.addEventListener('change', check)
if (typeof window !== 'undefined') window.addEventListener('resize', check)
