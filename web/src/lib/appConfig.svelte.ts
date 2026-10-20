// 服务端给的配置（/api/config）：新建 pane 的启动命令、开了哪些模块
export type Preset = { label: string; command: string }
export const appConfig = $state({
  presets: [] as Preset[],
  modules: { preview: true, openUrl: false, cursor: false, screen: false, mac: false } as Record<string, boolean>,
  loaded: false,
})
export async function loadAppConfig() {
  try {
    const r = await fetch('api/config', { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    if (Array.isArray(d.presets)) appConfig.presets = d.presets.filter((p: Preset) => p && typeof p.command === 'string' && typeof p.label === 'string')
    if (d.modules && typeof d.modules === 'object') appConfig.modules = d.modules
    appConfig.loaded = true
  } catch {}
}
