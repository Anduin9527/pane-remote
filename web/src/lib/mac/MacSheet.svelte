<script lang="ts">
  // mac 模块（可选，pane-remote enable mac）：这台电脑的性能、用它的扬声器念一段话。
  // 性能只在面板开着、而且「性能」展开时采（电脑上每次要采样 2 秒左右 CPU），每 5 秒一次；
  // 念的话交给电脑上的 say（agent/mac/say.mjs），嗓音 / 语速 / 音量记在手机上
  import * as Drawer from '$lib/components/ui/drawer'
  import { toast } from 'svelte-sonner'
  import Gauge from '@lucide/svelte/icons/gauge'
  import Megaphone from '@lucide/svelte/icons/megaphone'
  import Square from '@lucide/svelte/icons/square'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { postJson } from '$lib/api'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false) }: { open?: boolean } = $props()

  const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
  const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }
  /** GET api/mac/<动作>，出错抛带服务端原因的 Error */
  async function getJson<T>(action: string): Promise<T> {
    const r = await fetch(`api/mac/${action}`, { cache: 'no-store' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(tr(d.error) || `HTTP ${r.status}`)
    return d as T
  }

  // ---------- 性能 ----------
  type Proc = { pid: number; name: string; app: string; cpu: number; mem: number }
  type Perf = { cores: number; cpu: { user: number; sys: number; idle: number }; load: number[]; mem: { total: number; used: number; wired: number; compressed: number; unused: number; freePct: number | null }; swap: { total: number; used: number }; topCpu: Proc[]; topMem: Proc[] }
  let perfOpen = $state(lsGet('macPerfOpen', '1') === '1')
  let perf = $state<Perf | null>(null)
  let perfErr = $state('')
  let perfBusy = false
  async function loadPerf() {
    if (perfBusy) return
    perfBusy = true
    try { perf = await getJson<Perf>('perf'); perfErr = '' } catch (e) { perfErr = (e as Error).message } finally { perfBusy = false }
  }
  function togglePerf() { perfOpen = !perfOpen; lsSet('macPerfOpen', perfOpen ? '1' : '0') }
  $effect(() => {
    if (!open || !perfOpen) return
    loadPerf()
    const timer = setInterval(loadPerf, 5000)
    return () => clearInterval(timer)
  })
  const gb = (n: number) => (n >= 1 << 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.round(n / 2 ** 20)} MB`)
  const perfLists = $derived(perf ? [{ title: t('占 CPU 最多'), list: perf.topCpu, cpu: true }, { title: t('占内存最多'), list: perf.topMem, cpu: false }] : [])
  // 内存压力：memory_pressure 报的可用比例（系统自己的口径）
  const pressure = (p: Perf) => (p.mem.freePct == null ? '' : p.mem.freePct >= 50 ? t('正常') : p.mem.freePct >= 20 ? t('偏紧') : t('紧张'))

  // ---------- 念出来 ----------
  type Voice = { name: string; lang: string; sample: string }
  let sayText = $state('')
  let voices = $state<Voice[]>([])
  let voice = $state(lsGet('macSayVoice', ''))
  let rate = $state(Number(lsGet('macSayRate', '180')) || 180)
  let sayVol = $state(lsGet('macSayVol', '')) // 念的时候临时用的音量；空 = 不改
  let saying = $state(false)
  let sayTimer: ReturnType<typeof setTimeout> | undefined
  const PRESETS = ['我马上回来', '请稍等一下', '开饭了', '有人在吗？', '该休息一下了']
  const voiceLabel = (v: Voice) => v.name.replace(/\s*\(.*\)\s*$/, '')
  const voiceGroups = $derived.by(() => {
    const g: [string, Voice[]][] = [[t('中文（大陆）'), []], [t('中文（台湾 / 香港）'), []], ['English', []], [t('其它语言'), []]]
    for (const v of voices) g[v.lang === 'zh_CN' ? 0 : v.lang.startsWith('zh_') ? 1 : v.lang.startsWith('en_') ? 2 : 3][1].push(v)
    return g.filter(([, l]) => l.length)
  })
  let voicesState = $state<'idle' | 'loading' | 'failed'>('idle')
  // 读不到（比如刚好碰上服务重启）不会一直空着：点开下拉框会再读
  async function loadVoices() {
    if (voices.length || voicesState === 'loading') return
    voicesState = 'loading'
    try {
      voices = (await getJson<{ voices: Voice[] }>('voices')).voices
      // 没选过（或选的已经没了）：默认婷婷，没有就第一个普通话嗓音
      if (!voices.some((v) => v.name === voice)) voice = (voices.find((v) => v.lang === 'zh_CN' && v.name.startsWith('Tingting')) || voices.find((v) => v.lang === 'zh_CN'))?.name || ''
      voicesState = 'idle'
    } catch { voicesState = 'failed' }
  }
  $effect(() => { if (open) loadVoices() })
  async function speak(text = sayText) {
    if (!text.trim()) return
    lsSet('macSayVoice', voice); lsSet('macSayRate', String(rate)); lsSet('macSayVol', sayVol)
    saying = true
    clearTimeout(sayTimer)
    try { await postJson('api/mac/say', { text, voice, rate, volume: sayVol === '' ? null : Number(sayVol) }) } catch (e) { saying = false; toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) })); return }
    // say 在电脑上后台念，这里大概估个时长让「停」按钮亮着（中文约每秒 4～5 个字）
    sayTimer = setTimeout(() => (saying = false), Math.min(30000, 1500 + (text.length / 4.5) * 1000 * (180 / rate)))
  }
  async function stopSay() { saying = false; clearTimeout(sayTimer); try { await postJson('api/mac/say-stop', {}) } catch {} }

  const box = 'mb-3 rounded-xl border p-3'
  const btn = 'flex h-10 items-center justify-center gap-1.5 rounded-lg border text-[13px] active:bg-accent disabled:opacity-50'
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>{t('这台电脑')}</Drawer.Title></Drawer.Header>
    <div class="p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]">
      <!-- 性能 -->
      <div class={box}>
        <button class="flex w-full items-center gap-1.5 text-[13px]" onclick={togglePerf}>
          <Gauge class="size-4" />{t('性能')}
          {#if perf && perfOpen}<span class="ml-auto text-xs text-muted-foreground">CPU {Math.round(perf.cpu.user + perf.cpu.sys)}% · {t('内存')} {gb(perf.mem.used)}</span>{/if}
          <ChevronDown class={cn('size-4 text-muted-foreground transition-transform', !(perf && perfOpen) && 'ml-auto', perfOpen && 'rotate-180')} />
        </button>
        {#if perfOpen}
          {#if perf}
            <div class="mt-3 grid gap-3 text-[13px]">
              <div>
                <div class="mb-1 flex justify-between gap-2 text-xs text-muted-foreground"><span>CPU · {t('{n} 核', { n: perf.cores })} · {t('负载')} {perf.load.map((x) => x.toFixed(1)).join(' / ')}</span><span class="text-right">{t('用户 {u}% · 系统 {s}%', { u: perf.cpu.user.toFixed(0), s: perf.cpu.sys.toFixed(0) })}</span></div>
                <div class="flex h-2 overflow-hidden rounded-full bg-secondary"><div class="bg-primary" style:width="{perf.cpu.user}%"></div><div class="bg-orange-400" style:width="{perf.cpu.sys}%"></div></div>
              </div>
              <div>
                <div class="mb-1 flex justify-between gap-2 text-xs text-muted-foreground"><span>{t('内存')} {gb(perf.mem.used)} / {gb(perf.mem.total)}{pressure(perf) ? ` · ${t('压力')} ${pressure(perf)}` : ''}</span><span class="text-right">{t('压缩 {c} · 交换 {s}', { c: gb(perf.mem.compressed), s: gb(perf.swap.used) })}</span></div>
                <div class="h-2 overflow-hidden rounded-full bg-secondary"><div class={cn('h-full', perf.mem.freePct != null && perf.mem.freePct < 20 ? 'bg-red-500' : perf.mem.freePct != null && perf.mem.freePct < 50 ? 'bg-orange-400' : 'bg-primary')} style:width="{perf.mem.total ? Math.min(100, (perf.mem.used / perf.mem.total) * 100) : 0}%"></div></div>
              </div>
              <div class="grid grid-cols-2 gap-3 text-xs">
                {#each perfLists as g (g.title)}
                  <div class="min-w-0">
                    <p class="mb-1 text-muted-foreground">{g.title}</p>
                    {#each g.list as p (p.pid)}
                      <div class="flex items-baseline gap-1.5 py-0.5"><span class="min-w-0 flex-1 truncate" title={p.app && p.app !== p.name ? `${p.name} · ${p.app}` : p.name}>{p.name}{#if p.app && p.app !== p.name}<span class="text-muted-foreground"> · {p.app}</span>{/if}</span><span class="flex-none text-muted-foreground tabular-nums">{g.cpu ? `${p.cpu.toFixed(0)}%` : gb(p.mem)}</span></div>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <p class="mt-2 text-xs text-muted-foreground">{perfErr ? t('连不上：{msg}', { msg: perfErr }) : t('读取中…（第一次要两三秒）')}</p>
          {/if}
        {/if}
      </div>

      <!-- 念出来 -->
      <div class={box}>
        <div class="mb-2 flex items-center gap-1.5 text-[13px]"><Megaphone class="size-4" />{t('念出来')}<span class="ml-auto text-xs text-muted-foreground">{t('用电脑的扬声器念出来')}</span></div>
        <textarea class="h-16 w-full resize-none rounded-lg border bg-background p-2 text-sm" placeholder={t('要念的话')} bind:value={sayText} maxlength="2000"></textarea>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          {#each PRESETS as p (p)}<button class="h-7 rounded-full border px-2.5 text-xs active:bg-accent" onclick={() => speak(t(p))}>{t(p)}</button>{/each}
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2 text-xs">
          <span class="-mb-1 text-muted-foreground">{t('音色')}</span><span class="-mb-1 text-muted-foreground">{t('语速')}</span>
          <select class="h-9 min-w-0 rounded-lg border bg-background px-2" bind:value={voice} aria-label={t('音色')} onfocus={loadVoices} onpointerdown={loadVoices}>
            {#if !voices.length}<option value={voice}>{voicesState === 'failed' ? t('读不到，点一下重试') : t('读取中…')}</option>{/if}
            {#each voiceGroups as [g, list] (g)}<optgroup label={g}>{#each list as v, i (`${v.name}#${i}`)}<option value={v.name}>{voiceLabel(v)}{v.lang.startsWith('zh_') && v.lang !== 'zh_CN' ? ` · ${v.lang === 'zh_HK' ? t('粤语') : t('台湾')}` : ''}</option>{/each}</optgroup>{/each}
          </select>
          <select class="h-9 min-w-0 rounded-lg border bg-background px-2" bind:value={rate} aria-label={t('语速')}>
            <option value={130}>{t('慢')}</option><option value={180}>{t('正常')}</option><option value={240}>{t('快')}</option>
          </select>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <label class="flex items-center gap-1.5 text-xs text-muted-foreground">{t('音量')}
            <select class="h-8 rounded-lg border bg-background px-1.5 text-xs text-foreground" bind:value={sayVol}>
              <option value="">{t('不改')}</option>
              {#each [20, 35, 50, 65, 80, 100] as v (v)}<option value={String(v)}>{v}%</option>{/each}
            </select>
          </label>
          {#if saying}<button class={cn(btn, 'ml-auto w-20')} onclick={stopSay}><Square class="size-3.5" />{t('停')}</button>{/if}
          <button class={cn(btn, !saying && 'ml-auto', 'w-24 border-primary bg-primary text-primary-foreground active:bg-primary/90')} disabled={!sayText.trim()} onclick={() => speak()}><Megaphone class="size-4" />{t('念')}</button>
        </div>
        <p class="mt-2 text-[11px] text-muted-foreground">{t('音量只在念的时候改，念完调回原来的')}</p>
      </div>
    </div>
  </Drawer.Content>
</Drawer.Root>
