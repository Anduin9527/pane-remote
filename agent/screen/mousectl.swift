// 转码代理的鼠标助手：常驻在登录会话里（LaunchAgent），听一个只有自己能读写的 unix socket，
// 每行一条：
//   `p <x> <y> <mask>`  按 VNC 按键位图在全局坐标（点，左上角原点）移动/按下/松开/滚动
//   `k <keycode> <flags> <1|0>`  按下/松开一个键（macOS 虚拟键码 + CGEventFlags）
//   `t <base64 UTF-8>`  在光标处输入一段文字：放进剪贴板再 ⌘V，打完一阵子再把原来的剪贴板放回去
//   `q`  回一行当前光标位置
//   `f`  回一行 JSON：系统焦点在什么控件上（只读辅助功能查询，不读文字内容）：app、角色、能不能编辑、输入光标在屏幕上的位置、是不是安全输入（密码框）
// 按窗口看（需要「屏幕录制」授权）：
//   `w list` / `w apps`  回一行 JSON：能录的窗口（含别的桌面上的）/ 装了的 app
//   `w launch <bundleId>`  后台启动，不抢前台；回 ok
//   `w tray <bundleId>`  点一下这个 app 的菜单栏图标
//   `w close <windowID>`  按窗口自己的关闭按钮（跟点红叉一样，app 要问保存会弹它自己的框）
//   `w place <windowID> <size|fill|left|right|aspect|check> [a] [b]`  用辅助功能直接设窗口位置 / 大小（不拖、不切前台）：
//       size = 宽 a × 高 b（点，左上角不动）；fill / left / right = 占满 / 左半 / 右半个所在显示器的可用区域；aspect = 按 a:b 的比例尽量大、居中；check = 只看能不能改
//       回一行 `ok <x> <y> <宽> <高>` 或 `error: …`
//   `w quit <bundleId> <0|1>`  退出 app：0 = 正常退出（app 能保存），1 = 强制退出
//   `w stream <windowID|s屏序号> <0|1>`  这条连接从此变成二进制画面流：只录这个窗口（或整块显示器），1 = 按像素（清晰）、0 = 按点
//       [1, W u16, H u16] 画面尺寸   [2, x, y, w, h (u16), w*h*4 字节 BGRA] 变了的区域
//       [3, x i32, y i32, w u16, h u16] 窗口在屏幕上的位置（点）   [4] 窗口没了
//       [5, 1|0] 窗口不在屏幕上，退成定时截图（画面可能是空白、不更新）/ 又有实时画面了
//   `a <windowID>`  把窗口切到前台（取消最小化、提到最上），回一行原来前台 app 的 pid
//   `r <pid>`  把这个 app 切回前台
//   `T <pid> <base64>` / `K <pid> <keycode> <flags> <1|0>`  不切前台，直接往这个 app 发文字 / 按键
// 苹果屏幕共享在多屏排布下只能把光标移到其中一排屏，所以鼠标改由这里直接发系统事件（需要「辅助功能」授权）。
// 文字也不走屏幕共享：中文按键码发过去顺序会乱，而且 Mac 开着中文输入法时英文字母会被它截走；粘贴不受输入法影响。
// 所有操作排进同一个串行队列，键、字、点击的先后不会乱。
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import Carbon

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSHomeDirectory() + "/.cache/pane-remote/mouse.sock"
let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
FileHandle.standardError.write("mousectl trusted=\(AXIsProcessTrustedWithOptions(opts))\n".data(using: .utf8)!)

let src = CGEventSource(stateID: .hidSystemState)
_ = NSApplication.shared // NSCursor 的标准指针图要有 NSApplication 才拿得到
var last: UInt8 = 0
var lastDown = (t: 0.0, p: CGPoint.zero, n: Int64(0))
let buttons: [(bit: UInt8, b: CGMouseButton, down: CGEventType, up: CGEventType, drag: CGEventType)] = [
  (1, .left, .leftMouseDown, .leftMouseUp, .leftMouseDragged),
  (4, .right, .rightMouseDown, .rightMouseUp, .rightMouseDragged),
  (2, .center, .otherMouseDown, .otherMouseUp, .otherMouseDragged),
]

func post(_ type: CGEventType, _ p: CGPoint, _ b: CGMouseButton, clicks: Int64 = 0) {
  guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: b) else { return }
  if clicks > 0 { e.setIntegerValueField(.mouseEventClickState, value: clicks) }
  e.post(tap: .cghidEventTap)
}

func scroll(_ dy: Int32, _ dx: Int32) {
  CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
}

func pointer(_ x: Double, _ y: Double, _ mask: UInt8) {
  let p = CGPoint(x: x, y: y)
  let held = buttons.first { last & $0.bit != 0 && mask & $0.bit != 0 }
  if let h = held { post(h.drag, p, h.b) } else { post(.mouseMoved, p, .left) }
  for b in buttons {
    if mask & b.bit != 0 && last & b.bit == 0 {
      // 连击：0.4 秒内、离上次按下 6 点以内算同一串（双击选词、三击选行要靠这个）
      let now = Date().timeIntervalSince1970
      let n: Int64 = now - lastDown.t < 0.4 && hypot(p.x - lastDown.p.x, p.y - lastDown.p.y) < 6 ? lastDown.n + 1 : 1
      lastDown = (now, p, n)
      post(b.down, p, b.b, clicks: n)
    } else if mask & b.bit == 0 && last & b.bit != 0 {
      post(b.up, p, b.b, clicks: lastDown.n)
    }
  }
  // 滚轮：VNC 用 4/5/6/7 号键的按下表示上/下/左/右滚一格
  let press = mask & ~last
  if press & 8 != 0 { scroll(60, 0) }
  if press & 16 != 0 { scroll(-60, 0) }
  if press & 32 != 0 { scroll(0, 60) }
  if press & 64 != 0 { scroll(0, -60) }
  last = mask
}

func key(_ code: UInt16, _ flags: UInt64, _ down: Bool) {
  guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
  e.flags = CGEventFlags(rawValue: flags)
  e.post(tap: .cghidEventTap)
}

// 剪贴板：一串文字打完 0.8 秒没有新的，再把用户原来的剪贴板放回去
let pb = NSPasteboard.general
var saved: [[(NSPasteboard.PasteboardType, Data)]]? = nil
var ours = 0, gen = 0
func paste(_ text: String) {
  if saved == nil {
    saved = (pb.pasteboardItems ?? []).map { it in it.types.compactMap { t in it.data(forType: t).map { (t, $0) } } }
  }
  pb.clearContents()
  pb.setString(text, forType: .string)
  ours = pb.changeCount
  key(9, CGEventFlags.maskCommand.rawValue, true)
  key(9, CGEventFlags.maskCommand.rawValue, false)
  usleep(150_000) // 等前台 app 把这次读走，再动剪贴板
  gen += 1
  let g = gen
  queue.asyncAfter(deadline: .now() + 0.8) {
    guard g == gen, let items = saved else { return }
    saved = nil
    if pb.changeCount != ours { return } // 这期间用户自己复制了东西，就别覆盖
    pb.clearContents()
    pb.writeObjects(items.map { pairs in let it = NSPasteboardItem(); for (t, d) in pairs { it.setData(d, forType: t) }; return it })
  }
}

let queue = DispatchQueue(label: "mousectl")
final class Batch { var text = "" }
var batch: Batch? = nil // 正在攒的一段文字；中间插进别的操作就另起一段，保证先后

// ---------- 按窗口看 ----------
@_silgen_name("_AXUIElementGetWindow") func _AXUIElementGetWindow(_ e: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func writeAll(_ c: Int32, _ d: [UInt8]) -> Bool {
  var off = 0
  while off < d.count {
    let n = d.withUnsafeBytes { write(c, $0.baseAddress! + off, d.count - off) }
    if n <= 0 { return false }
    off += n
  }
  return true
}
func reply(_ c: Int32, _ s: String) { _ = writeAll(c, Array((s + "\n").utf8)) }
func json(_ v: Any) -> String { String(data: (try? JSONSerialization.data(withJSONObject: v)) ?? Data("null".utf8), encoding: .utf8)! }
/** 等一个 async 结果（连接线程里用） */
func await_<T>(_ f: @escaping () async throws -> T) -> Result<T, Error> {
  let sem = DispatchSemaphore(value: 0)
  var r: Result<T, Error>!
  Task.detached { do { r = .success(try await f()) } catch { r = .failure(error) }; sem.signal() }
  sem.wait()
  return r
}
func shareable() -> Result<SCShareableContent, Error> { await_ { try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) } }
// 各 app 的自动填充、打开面板服务这些隐藏小窗口不列
let spotlightHost = "com.apple.campo"
let hiddenBundles: Set<String> = ["com.apple.WindowManager", "com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.UserNotificationCenter"]
func windowList() -> String {
  switch shareable() {
  case .failure(let e): return json(["error": e.localizedDescription])
  case .success(let content):
    let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { $0[kCGWindowNumber as String] as? CGWindowID })
    // 用辅助功能问 app 自己有哪些窗口（顺便拿标题：飞书这类 Electron 主窗口没有系统标题）
    var axCache = [pid_t: [CGWindowID: String]]()
    func axWindows(_ pid: pid_t) -> [CGWindowID: String] {
      if let c = axCache[pid] { return c }
      var m = [CGWindowID: String]()
      var v: CFTypeRef?
      AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v)
      for e in v as? [AXUIElement] ?? [] {
        var wid: CGWindowID = 0
        guard _AXUIElementGetWindow(e, &wid) == .success else { continue }
        var t: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &t)
        m[wid] = t as? String ?? ""
      }
      axCache[pid] = m
      return m
    }
    var titles = [CGWindowID: String]()
    let wins = content.windows.filter { w in
      // 0 是普通窗口，1–19 是浮动面板（uTools 这类置顶搜索框在 9）；20 往上是程序坞、菜单栏这些系统界面
      // 例外：Spotlight 的搜索框归 com.apple.campo（显示名 Siri），在 23 层，高度只有 57
      if w.owningApplication?.bundleIdentifier == spotlightHost { return w.windowLayer < 30 && w.frame.width >= 300 && on.contains(w.windowID) }
      guard let a = w.owningApplication, w.windowLayer >= 0, w.windowLayer < 20, w.frame.width >= 30, w.frame.height >= 30 else { return false }
      if hiddenBundles.contains(a.bundleIdentifier) || a.applicationName.hasPrefix("AutoFill") || a.applicationName.contains("Open and Save Panel") { return false }
      // 当前桌面上看得见的直接算；不在的必须是 app 自己报的窗口（台前调度收起、别的桌面上的它会报），
      // 否则是关掉后只是藏起来的窗口（QQ、微信点关闭并不销毁窗口）或后台缓冲，截出来是空白
      let ax = axWindows(a.processID)
      let t = (w.title ?? "") != "" ? w.title! : ax[w.windowID] ?? ""
      // app 自己报的窗口不管多小都算（台前调度把后台打开的窗口缩成 40×100 左右的缩略图）；没报的要够大，挡掉各种小浮层
      if ax[w.windowID] != nil || (on.contains(w.windowID) && w.frame.width >= 160 && w.frame.height >= 120) { titles[w.windowID] = t; return true }
      return false
    }
    return json(["windows": wins.map { w in
      let sp = w.owningApplication!.bundleIdentifier == spotlightHost
      return [
      "id": w.windowID, "pid": w.owningApplication!.processID, "app": sp ? "Spotlight" : w.owningApplication!.applicationName, "bundle": sp ? "com.apple.Spotlight" : w.owningApplication!.bundleIdentifier,
      "title": titles[w.windowID] ?? "", "x": w.frame.minX, "y": w.frame.minY, "w": w.frame.width, "h": w.frame.height, "onScreen": on.contains(w.windowID),
    ] as [String: Any] }])
  }
}
func appList() -> String {
  let running = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }.compactMap { $0.bundleIdentifier })
  var seen = Set<String>(), apps = [[String: Any]]()
  let fm = FileManager.default
  for dir in ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
    for name in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where name.hasSuffix(".app") {
      let path = dir + "/" + name
      guard let b = Bundle(path: path), let id = b.bundleIdentifier, !seen.contains(id) else { continue }
      seen.insert(id)
      var dn = fm.displayName(atPath: path)
      if dn.hasSuffix(".app") { dn = String(dn.dropLast(4)) }
      // tray：没有程序坞图标、只有菜单栏图标的 app（uTools 这类），得用快捷键或点菜单栏图标唤出
      let tray = (b.object(forInfoDictionaryKey: "LSUIElement") as? Bool) == true || (b.object(forInfoDictionaryKey: "LSUIElement") as? String) == "1"
      apps.append(["bundle": id, "name": dn, "running": running.contains(id), "tray": tray])
    }
  }
  // Spotlight 不在应用程序文件夹里：单列一个，用它的快捷键唤出
  apps.append(["bundle": "com.apple.Spotlight", "name": "Spotlight", "running": true, "tray": true])
  return json(["apps": apps.sorted { ($0["name"] as! String).localizedStandardCompare($1["name"] as! String) == .orderedAscending }])
}
func launch(_ id: String) -> String {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return "error: not found" }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = false
  switch await_({ try await NSWorkspace.shared.openApplication(at: url, configuration: cfg) }) {
  case .success: return "ok"
  case .failure(let e): return "error: \(e.localizedDescription)"
  }
}
func closeWindow(_ id: CGWindowID) -> String {
  guard let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]])?.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == id }),
        let pid = info[kCGWindowOwnerPID as String] as? pid_t else { return "error: no such window" }
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v)
  for w in v as? [AXUIElement] ?? [] {
    var wid: CGWindowID = 0
    guard _AXUIElementGetWindow(w, &wid) == .success, wid == id else { continue }
    var b: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &b)
    guard let btn = b else { return "error: no close button" }
    return AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString) == .success ? "ok" : "error: press failed"
  }
  return "error: window not found"
}
/** 找到这个窗口号对应的辅助功能窗口 */
func axWindow(_ id: CGWindowID) -> AXUIElement? {
  guard let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]])?.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == id }),
        let pid = info[kCGWindowOwnerPID as String] as? pid_t else { return nil }
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v)
  return (v as? [AXUIElement])?.first { var wid: CGWindowID = 0; return _AXUIElementGetWindow($0, &wid) == .success && wid == id }
}
/** 窗口所在显示器的可用区域（去掉菜单栏、程序坞），全局坐标、左上角原点 */
func usableRect(around r: CGRect) -> CGRect {
  let mainH = NSScreen.screens.first?.frame.height ?? 0
  let c = CGPoint(x: r.midX, y: r.midY)
  let flip = { (f: NSRect) in CGRect(x: f.minX, y: mainH - f.maxY, width: f.width, height: f.height) }
  let s = NSScreen.screens.first { flip($0.frame).contains(c) } ?? NSScreen.screens.first
  return s.map { flip($0.visibleFrame) } ?? r
}
func placeWindow(_ id: CGWindowID, _ mode: String, _ a: Double, _ b: Double) -> String {
  guard let w = axWindow(id) else { return "error: window not found" }
  var sz: DarwinBoolean = false, ps: DarwinBoolean = false
  AXUIElementIsAttributeSettable(w, kAXSizeAttribute as CFString, &sz)
  AXUIElementIsAttributeSettable(w, kAXPositionAttribute as CFString, &ps)
  func frame() -> CGRect {
    var p = CGPoint.zero, s = CGSize.zero, r: CFTypeRef?
    if AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &r) == .success { AXValueGetValue(r as! AXValue, .cgPoint, &p) }
    if AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &r) == .success { AXValueGetValue(r as! AXValue, .cgSize, &s) }
    return CGRect(origin: p, size: s)
  }
  let cur = frame()
  let out = { (r: CGRect) in "ok \(Int(r.minX)) \(Int(r.minY)) \(Int(r.width)) \(Int(r.height))" }
  if mode == "check" { return sz.boolValue ? out(cur) : "error: 这个窗口不能改大小" }
  guard sz.boolValue else { return "error: 这个窗口不能改大小" }
  let u = usableRect(around: cur)
  var t = cur
  switch mode {
  case "size": t.size = CGSize(width: max(80, min(a, u.width)), height: max(60, min(b, u.height)))
  case "fill": t = u
  case "left": t = CGRect(x: u.minX, y: u.minY, width: u.width / 2, height: u.height)
  case "right": t = CGRect(x: u.midX, y: u.minY, width: u.width / 2, height: u.height)
  case "aspect":
    guard a > 0, b > 0 else { return "error: bad aspect" }
    let k = min(u.width * 0.92 / a, u.height * 0.92 / b)
    t.size = CGSize(width: a * k, height: b * k)
    t.origin = CGPoint(x: u.midX - t.width / 2, y: u.midY - t.height / 2)
  default: return "error: bad mode"
  }
  // 放大后别跑出可用区域：先挪位置再改大小（有的 app 不让窗口超出屏幕，大小会被截掉）
  if t.maxX > u.maxX { t.origin.x = max(u.minX, u.maxX - t.width) }
  if t.maxY > u.maxY { t.origin.y = max(u.minY, u.maxY - t.height) }
  if ps.boolValue && t.origin != cur.origin { var o = t.origin; AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &o)!) }
  var size = t.size
  AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
  usleep(150_000)
  return out(frame())
}
// 系统自己的进程不让从手机上退出
let protectedBundles: Set<String> = ["com.apple.finder", "com.apple.dock", "com.apple.loginwindow", "com.apple.systemuiserver", "com.apple.WindowManager", "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.Spotlight"]
func quitApp(_ id: String, force: Bool) -> String {
  if protectedBundles.contains(id) { return "error: 系统进程不能退出" }
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id)
  if apps.isEmpty { return "ok" }
  for a in apps { _ = force ? a.forceTerminate() : a.terminate() }
  return "ok"
}
/** 点一下 app 的菜单栏图标（没有快捷键的托盘 app 只能这样唤出） */
func pressTray(_ id: String) -> String {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { return "error: not running" }
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), "AXExtrasMenuBar" as CFString, &v)
  guard let bar = v else { return "error: no menu bar icon" }
  var kids: CFTypeRef?
  AXUIElementCopyAttributeValue(bar as! AXUIElement, kAXChildrenAttribute as CFString, &kids)
  guard let item = (kids as? [AXUIElement])?.first else { return "error: no menu bar icon" }
  return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success ? "ok" : "error: press failed"
}
func bounds(_ id: CGWindowID) -> CGRect? {
  // 只按窗口号查的接口看不到别的桌面 / 台前调度收起来的窗口，所以查全部再找
  guard let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]])?.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == id }),
        let b = info[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
  return r
}
func activate(_ id: CGWindowID) -> String {
  let prev = frontPid()
  guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
        let pid = info[kCGWindowOwnerPID as String] as? pid_t else { return "0" }
  let ax = AXUIElementCreateApplication(pid)
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &v)
  for w in v as? [AXUIElement] ?? [] {
    var wid: CGWindowID = 0
    guard _AXUIElementGetWindow(w, &wid) == .success, wid == id else { continue }
    AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
  }
  NSRunningApplication(processIdentifier: pid)?.activate()
  return "\(prev)"
}
func keyToPid(_ pid: pid_t, _ code: UInt16, _ flags: UInt64, _ down: Bool) {
  guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
  e.flags = CGEventFlags(rawValue: flags)
  e.postToPid(pid)
}
func textToPid(_ pid: pid_t, _ text: String) {
  let u = Array(text.utf16)
  for i in stride(from: 0, to: u.count, by: 20) {
    var part = Array(u[i..<min(i + 20, u.count)])
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
      e.keyboardSetUnicodeString(stringLength: part.count, unicodeString: &part)
      e.postToPid(pid)
    }
    usleep(5_000)
  }
}

final class WindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
  let c: Int32, id: CGWindowID, hi: Bool
  var display: CGDirectDisplayID? = nil // 录整块显示器（不是窗口）
  var stream: SCStream?
  var size = (w: 0, h: 0), frame = CGRect.zero, alive = true
  var prev = [UInt8]() // 上一帧（紧凑 BGRA），用来找出真正变了的区域：系统给的变化区域经常是整个窗口
  let wlock = NSLock()
  let q = DispatchQueue(label: "wincap")
  init(c: Int32, id: CGWindowID, hi: Bool) { self.c = c; self.id = id; self.hi = hi }
  func send(_ d: [UInt8]) { wlock.lock(); if alive && !writeAll(c, d) { alive = false }; wlock.unlock() }
  func be16(_ v: Int) -> [UInt8] { [UInt8((v >> 8) & 255), UInt8(v & 255)] }
  func be32(_ v: Int) -> [UInt8] { let u = UInt32(bitPattern: Int32(truncatingIfNeeded: v)); return [UInt8(u >> 24), UInt8((u >> 16) & 255), UInt8((u >> 8) & 255), UInt8(u & 255)] }
  func config(for r: CGRect) -> SCStreamConfiguration {
    let cfg = SCStreamConfiguration()
    let k = hi ? (NSScreen.screens.map { $0.backingScaleFactor }.max() ?? 2) : 1
    cfg.width = max(2, Int(r.width * k)); cfg.height = max(2, Int(r.height * k))
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = display != nil // 整块屏带上鼠标指针（窗口不带）
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    cfg.queueDepth = 4
    return cfg
  }
  func start() -> String {
    guard case .success(let content) = shareable() else { return "error: no screen recording permission" }
    let f: SCContentFilter
    if let did = display {
      guard let d = content.displays.first(where: { $0.displayID == did }) else { return "error: no such display" }
      frame = CGDisplayBounds(did)
      f = SCContentFilter(display: d, excludingWindows: [])
    } else {
      guard let w = content.windows.first(where: { $0.windowID == id }) else { return "error: no such window" }
      frame = bounds(id) ?? w.frame
      f = SCContentFilter(desktopIndependentWindow: w)
    }
    filter = f
    let s = SCStream(filter: f, configuration: config(for: frame), delegate: self)
    do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q) } catch { return "error: \(error.localizedDescription)" }
    if case .failure(let e) = await_({ try await s.startCapture() }) { return "error: \(e.localizedDescription)" }
    stream = s
    sendBounds()
    // 每秒看一次窗口还在不在、挪没挪、大小变没变
    q.asyncAfter(deadline: .now() + 1) { [weak self] in self?.watch() }
    // 0.8 秒还没出帧：改成定时截图
    q.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      guard let self, self.alive, !self.gotFrame else { return }
      self.log("no live frames, polling snapshots")
      self.polling = true
      self.send([5, 1])
      self.poll()
    }
    return "ok"
  }
  func sendBounds() { send([3] + be32(Int(frame.minX)) + be32(Int(frame.minY)) + be16(Int(frame.width)) + be16(Int(frame.height))) }
  func watch() {
    guard alive else { return }
    guard let r = display.map({ CGDisplayBounds($0) }) ?? bounds(id) else { send([4]); stop(); return }
    if r != frame {
      let resized = r.size != frame.size
      frame = r
      sendBounds()
      if resized { stream?.updateConfiguration(config(for: r)) { _ in } }
    }
    q.asyncAfter(deadline: .now() + 1) { [weak self] in self?.watch() }
  }
  func stop() {
    wlock.lock(); alive = false; wlock.unlock()
    let s = stream; stream = nil
    s?.stopCapture { _ in }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    log("stream stopped: \(error.localizedDescription), polling snapshots")
    q.async { [weak self] in guard let self, self.alive, !self.polling else { return }; self.polling = true; self.send([5, 1]); self.poll() }
  }
  /** 整帧跟上一帧比（不用系统给的变化区域：有的 app 给的坐标跟画面对不上，画面会拼错），
   *  变了的行按「中间隔开超过 16 行就分开」分成几条带，每条带再缩到变了的列；顺手把变了的部分更新进 prev */
  func bands(_ base: UnsafeMutablePointer<UInt8>, _ bpr: Int, _ W: Int, _ H: Int) -> [CGRect] {
    var out = [CGRect]()
    prev.withUnsafeMutableBytes { pv in
      let pb = pv.baseAddress!.assumingMemoryBound(to: UInt8.self)
      var top = -1, bottom = -1, left = W, right = 0
      func flushBand() { if top >= 0 { out.append(CGRect(x: left, y: top, width: right - left, height: bottom - top + 1)) }; top = -1; left = W; right = 0 }
      for y in 0..<H {
        let cur = base + y * bpr, old = pb + y * W * 4
        if memcmp(cur, old, W * 4) == 0 { if top >= 0 && y - bottom > 16 { flushBand() }; continue }
        if top < 0 { top = y }
        bottom = y
        let c32 = UnsafeRawPointer(cur).assumingMemoryBound(to: UInt32.self), o32 = UnsafeRawPointer(old).assumingMemoryBound(to: UInt32.self)
        var l = 0
        while l < W && c32[l] == o32[l] { l += 1 }
        var r = W - 1
        while r > l && c32[r] == o32[r] { r -= 1 }
        left = min(left, l); right = max(right, r + 1)
        memcpy(old, cur, W * 4)
      }
      flushBand()
    }
    return out
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard alive, type == .screen, let att = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
          let raw = att[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
    guard let base = CVPixelBufferGetBaseAddress(pb)?.assumingMemoryBound(to: UInt8.self) else { return }
    if polling { polling = false; log("live frames back"); send([5, 0]) }
    gotFrame = true
    handle(base, bpr, W, H)
  }
  /** 一帧（BGRA）：尺寸变了就整块发，否则把变化区域跟上一帧比出真正变了的部分再发 */
  func handle(_ base: UnsafeMutablePointer<UInt8>, _ bpr: Int, _ W: Int, _ H: Int) {
    var rects: [CGRect]
    if W != size.w || H != size.h {
      size = (W, H)
      prev = [UInt8](repeating: 0, count: W * H * 4)
      send([1] + be16(W) + be16(H))
      rects = [CGRect(x: 0, y: 0, width: W, height: H)]
      for row in 0..<H { prev.withUnsafeMutableBytes { _ = memcpy($0.baseAddress! + row * W * 4, base + row * bpr, W * 4) } }
    } else {
      rects = bands(base, bpr, W, H)
    }
    for r in rects {
      let x = Int(r.minX), y = Int(r.minY), w = Int(r.width), h = Int(r.height)
      var out = [UInt8](repeating: 0, count: 9 + w * h * 4)
      out[0] = 2
      out.replaceSubrange(1..<9, with: be16(x) + be16(y) + be16(w) + be16(h))
      out.withUnsafeMutableBytes { dst in
        for row in 0..<h { memcpy(dst.baseAddress! + 9 + row * w * 4, base + (y + row) * bpr + x * 4, w * 4) }
      }
      send(out)
    }
  }
  // 不在当前桌面（别的桌面、台前调度收在一边、被遮住到系统不再合成）的窗口，实时录制不出帧：退回定时截图，照样只发变了的部分
  var polling = false, gotFrame = false, filter: SCContentFilter?, misses = 0
  func log(_ m: String) { FileHandle.standardError.write("wincap \(id) \(m)\n".data(using: .utf8)!) }
  func poll() {
    guard alive, polling, let f = filter else { return }
    let cfg = config(for: frame)
    SCScreenshotManager.captureImage(contentFilter: f, configuration: cfg) { [weak self] img, err in
      guard let self else { return }
      self.q.async {
        guard self.alive, self.polling else { return }
        if let img { self.misses = 0; self.handleImage(img) }
        else {
          self.misses += 1
          if self.misses == 1 { self.log("snapshot failed: \(err?.localizedDescription ?? "?")") }
          // 连续 2 秒截不到（比如最小化了）：告诉代理录不到
          if self.misses >= 6 && !self.gotFrame { self.send(Array("error: 这个窗口录不到（可能最小化了）\n".utf8)); self.stop(); return }
        }
        // 整块屏只有截图（锁屏界面受保护拿不到实时画面）时截勤一点，不然打字看着很卡；窗口截图慢一点就够
        self.q.asyncAfter(deadline: .now() + (self.display != nil ? 0.12 : 0.33)) { [weak self] in self?.poll() }
      }
    }
  }
  func handleImage(_ img: CGImage) {
    let W = img.width, H = img.height, bpr = W * 4
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bpr * H)
    defer { buf.deallocate() }
    guard let ctx = CGContext(data: buf, width: W, height: H, bitsPerComponent: 8, bytesPerRow: bpr, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
    gotFrame = true
    handle(buf, bpr, W, H)
  }
}

let sysWide = AXUIElementCreateSystemWide()
/** 现在的前台 app：NSWorkspace.frontmostApplication 在没有主循环的常驻进程里不会更新，用辅助功能问系统；
 *  问不到就取最上面那个普通窗口的主人 */
func frontPid() -> pid_t {
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(sysWide, kAXFocusedApplicationAttribute as CFString, &v) == .success, let a = v {
    var pid: pid_t = 0
    if AXUIElementGetPid(a as! AXUIElement, &pid) == .success, pid > 0 { return pid }
  }
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.first { ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowOwnerPID as String] as? pid_t ?? 0
}
/** 系统当前显示的鼠标指针是不是 I 形（文字输入）：各种 app 在输入框上都会换成它，只读系统的当前指针，不碰任何 app */
func cursorIsIBeam() -> Bool {
  guard let cur = NSCursor.currentSystem else { return false }
  let ib = NSCursor.iBeam
  if cur.hotSpot == ib.hotSpot && cur.image.size == ib.image.size { return true }
  // app 实际用的 I 形跟系统给的参考图不一定一样（实测 9×18、热点在正中）：窄、高、热点在中间就算
  let w = cur.image.size.width, h = cur.image.size.height
  return w <= 16 && h >= w * 1.5 && abs(cur.hotSpot.x - w / 2) <= 2 && abs(cur.hotSpot.y - h / 2) <= 2
}
func focusInfo() -> String {
  AXUIElementSetMessagingTimeout(sysWide, 0.3)
  func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil }
  var out: [String: Any] = ["secure": IsSecureEventInputEnabled(), "ibeam": cursorIsIBeam()]
  let fp = frontPid()
  let front = fp > 0 ? NSRunningApplication(processIdentifier: fp) : nil
  out["front"] = front?.bundleIdentifier ?? ""
  // 系统级查询拿不到时直接问前台 app（有的 app 只回应针对它自己的查询）
  var fe = attr(sysWide, kAXFocusedUIElementAttribute)
  if fe == nil, let p = front?.processIdentifier { let ae = AXUIElementCreateApplication(p); AXUIElementSetMessagingTimeout(ae, 0.3); fe = attr(ae, kAXFocusedUIElementAttribute); out["via"] = "app" }
  guard let f = fe else { return json(out) }
  let e = f as! AXUIElement
  var pid: pid_t = 0
  AXUIElementGetPid(e, &pid)
  let app = NSRunningApplication(processIdentifier: pid)
  out["app"] = app?.localizedName ?? ""
  out["bundle"] = app?.bundleIdentifier ?? ""
  out["role"] = attr(e, kAXRoleAttribute) as? String ?? ""
  out["subrole"] = attr(e, kAXSubroleAttribute) as? String ?? ""
  var settable: DarwinBoolean = false
  AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
  out["editable"] = settable.boolValue
  if let r = attr(e, kAXSelectedTextRangeAttribute) {
    var b: CFTypeRef?
    if AXUIElementCopyParameterizedAttributeValue(e, kAXBoundsForRangeParameterizedAttribute as CFString, r, &b) == .success, let bv = b {
      var rect = CGRect.zero
      AXValueGetValue(bv as! AXValue, .cgRect, &rect)
      out["caret"] = ["x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height]
    }
  }
  if let fv = attr(e, "AXFrame") {
    var rect = CGRect.zero
    if CFGetTypeID(fv) == AXValueGetTypeID() { AXValueGetValue(fv as! AXValue, .cgRect, &rect); out["frame"] = ["x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height] }
  }
  return json(out)
}

func location() -> String {
  let p = CGEvent(source: nil)?.location ?? .zero
  return "\(p.x),\(p.y)\n"
}

unlink(path)
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let cap = MemoryLayout.size(ofValue: addr.sun_path)
withUnsafeMutableBytes(of: &addr.sun_path) { dst in
  let s = Array(path.utf8.prefix(cap - 1))
  dst.copyBytes(from: s)
  dst[s.count] = 0
}
let old = umask(0o077)
let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
umask(old)
guard ok == 0, listen(fd, 4) == 0 else { FileHandle.standardError.write("mousectl bind failed\n".data(using: .utf8)!); exit(1) }

let lock = NSLock()
while true {
  let c = accept(fd, nil, nil)
  if c < 0 { continue }
  Thread.detachNewThread {
    var buf = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 4096)
    var stream: WindowStream? = nil
    while true {
      let n = read(c, &chunk, chunk.count)
      if n <= 0 { break }
      buf.append(contentsOf: chunk[0..<n])
      while let i = buf.firstIndex(of: 10) {
        let line = String(decoding: buf[0..<i], as: UTF8.self)
        buf.removeSubrange(0...i)
        let f = line.split(separator: " ")
        lock.lock()
        if f.first == "p", f.count == 4, let x = Double(f[1]), let y = Double(f[2]), let m = UInt8(f[3]) {
          batch = nil
          queue.async { pointer(x, y, m) }
        } else if f.first == "k", f.count == 4, let c = UInt16(f[1]), let fl = UInt64(f[2]) {
          batch = nil
          let down = f[3] == "1"
          queue.async { key(c, fl, down) }
        } else if f.first == "t", f.count == 2, let d = Data(base64Encoded: String(f[1])), let txt = String(data: d, encoding: .utf8) {
          if let b = batch { b.text += txt } else {
            let b = Batch(); b.text = txt; batch = b
            queue.async {
              lock.lock(); let s = b.text; if batch === b { batch = nil }; lock.unlock()
              paste(s)
            }
          }
        } else if f.first == "w", f.count >= 2 {
          lock.unlock()
          if f[1] == "list" { reply(c, windowList()) }
          else if f[1] == "apps" { reply(c, appList()) }
          else if f[1] == "launch", f.count == 3 { reply(c, launch(String(f[2]))) }
          else if f[1] == "tray", f.count == 3 { reply(c, queue.sync { pressTray(String(f[2])) }) }
          else if f[1] == "close", f.count == 3, let id = UInt32(f[2]) { reply(c, queue.sync { closeWindow(id) }) }
          else if f[1] == "place", f.count >= 4, let id = UInt32(f[2]) {
            let mode = String(f[3]), a = f.count > 4 ? Double(f[4]) ?? 0 : 0, b = f.count > 5 ? Double(f[5]) ?? 0 : 0
            reply(c, queue.sync { placeWindow(id, mode, a, b) })
          }
          else if f[1] == "quit", f.count == 4 { let id = String(f[2]), force = f[3] == "1"; reply(c, queue.sync { quitApp(id, force: force) }) }
          else if f[1] == "stream", f.count == 4, f[2].hasPrefix("s"), let idx = Int(f[2].dropFirst()) {
            // 整块显示器：s<序号>，序号跟 NSScreen.screens 的顺序一样（0 是主屏）
            let screens = NSScreen.screens
            if idx >= 0, idx < screens.count, let num = screens[idx].deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
              let ws = WindowStream(c: c, id: 0, hi: f[3] == "1")
              ws.display = CGDirectDisplayID(num.uint32Value)
              let r = ws.start()
              if r != "ok" { reply(c, r) } else { stream = ws }
            } else { reply(c, "error: no such display") }
          }
          else if f[1] == "stream", f.count == 4, let id = UInt32(f[2]) {
            let ws = WindowStream(c: c, id: id, hi: f[3] == "1")
            let r = ws.start()
            if r != "ok" { reply(c, r) } else { stream = ws }
          }
          lock.lock()
        } else if f.first == "a", f.count == 2, let id = UInt32(f[1]) {
          batch = nil
          lock.unlock()
          let prev = queue.sync { activate(id) }
          reply(c, prev)
          lock.lock()
        } else if f.first == "r", f.count == 2, let pid = Int32(f[1]) {
          batch = nil
          queue.async { NSRunningApplication(processIdentifier: pid)?.activate() }
        } else if f.first == "T", f.count == 3, let pid = Int32(f[1]), let d = Data(base64Encoded: String(f[2])), let txt = String(data: d, encoding: .utf8) {
          batch = nil
          queue.async { textToPid(pid, txt) }
        } else if f.first == "K", f.count == 5, let pid = Int32(f[1]), let kc = UInt16(f[2]), let fl = UInt64(f[3]) {
          batch = nil
          let down = f[4] == "1"
          queue.async { keyToPid(pid, kc, fl, down) }
        } else if f.first == "f" {
          lock.unlock()
          reply(c, queue.sync { focusInfo() })
          lock.lock()
        } else if f.first == "q" {
          let s = Array(location().utf8)
          _ = s.withUnsafeBytes { write(c, $0.baseAddress, s.count) }
        }
        lock.unlock()
      }
    }
    stream?.stop()
    close(c)
  }
}
