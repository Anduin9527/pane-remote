// 对话消息列表的增量：{drop, keep, tail} = 旧列表去掉前 drop 条、再留 keep 条，后面接上 tail。
// 只按内容比（序列化后相等），不靠消息 id（Codex 的 id 是按下标编的，窗口一滑就全变）。
// 最后一条助手消息会随工具结果不断变长：那一条落在 tail 里整条重发，其余不动。对不上就回 null（发全量）
export function diff(prev, next, prevKeys = prev.map(key), nextKeys = next.map(key)) {
  if (!prev.length || !next.length) return null
  // 新列表第一条在旧列表里的位置 = 窗口往前滑了几条
  let drop = prevKeys.indexOf(nextKeys[0])
  if (drop < 0) return null
  let keep = 0
  while (keep < nextKeys.length && drop + keep < prevKeys.length && prevKeys[drop + keep] === nextKeys[keep]) keep++
  return { drop, keep, tail: next.slice(keep) }
}

export function apply(list, d) {
  if (d.drop + d.keep > list.length) return null // 和手里的对不上：调用方要全量
  return list.slice(d.drop, d.drop + d.keep).concat(d.tail)
}

export const key = (m) => JSON.stringify(m)
