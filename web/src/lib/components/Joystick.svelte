<script lang="ts">
  // 方向摇杆：按住往某个方向拖，连续发方向键；拖得越远发得越快（像 Termius 的空格滑动）
  import Move from '@lucide/svelte/icons/move'
  import { sendRaw } from '$lib/api'
  import { ui } from '$lib/session.svelte'
  import { cn } from '$lib/utils'

  const ARROWS = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' } as const
  let active = $state(false)
  let dir = $state<keyof typeof ARROWS | null>(null)
  let ox = 0, oy = 0, dist = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined
  let pressing = false

  function tick() {
    if (!dir) return
    sendRaw(ui.current, ARROWS[dir])
    // 14px 起步约 4 次/秒，拖到 90px 以外约 20 次/秒
    const gap = Math.max(50, 260 - (dist - 14) * 2.8)
    timer = setTimeout(tick, gap)
  }
  // 按住 150ms 才生效：手指只是扫过去不会发方向键
  function down(e: PointerEvent) {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pressing = true
    ox = e.clientX; oy = e.clientY
    armTimer = setTimeout(() => { if (pressing) { active = true; navigator.vibrate?.(8) } }, 150)
  }
  function move(e: PointerEvent) {
    if (pressing && !active && Math.hypot(e.clientX - ox, e.clientY - oy) > 12) { up(); return } // 还没生效就拖走了：当成误触
    if (!active) return
    const dx = e.clientX - ox, dy = e.clientY - oy
    dist = Math.hypot(dx, dy)
    const next = dist < 14 ? null : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up'
    if (next !== dir) {
      clearTimeout(timer)
      dir = next
      if (dir) tick()
    }
  }
  function up() {
    clearTimeout(armTimer)
    pressing = false
    active = false
    dir = null
    clearTimeout(timer)
  }
</script>

<button
  type="button"
  aria-label="方向摇杆：按住拖动"
  class={cn('relative grid h-9 w-11 flex-none touch-none place-items-center rounded-lg border bg-secondary text-muted-foreground select-none', active && 'border-primary bg-primary/15 text-primary')}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <Move class="size-4" />
  {#if dir}<span class="absolute -top-6 rounded bg-primary px-1.5 text-xs leading-5 text-primary-foreground">{{ up: '↑', down: '↓', left: '←', right: '→' }[dir]}</span>{/if}
</button>
