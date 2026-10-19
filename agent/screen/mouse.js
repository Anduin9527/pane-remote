// 转码代理校准用：stdin 每来一行，就在 stdout 回一行当前鼠标位置（全局坐标，点，左下角原点）
ObjC.import('AppKit')
const inp = $.NSFileHandle.fileHandleWithStandardInput
const out = $.NSFileHandle.fileHandleWithStandardOutput
for (;;) {
  const d = inp.availableData
  if (d.length === 0) break
  const p = $.NSEvent.mouseLocation
  out.writeData($(`${p.x},${p.y}\n`).dataUsingEncoding($.NSUTF8StringEncoding))
}
