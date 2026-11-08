// dsh-companion 原生桥：窗口枚举 / 前台应用 / 空闲时长 / PDF 取文本
//
// 为什么是编译的 Swift 而不是 JXA 或第三方原生模块：
//   1. JXA 的 ObjC 桥对 CFArray/CFDictionary 的装箱极不稳定（同一份代码在
//      macOS 26 上 `ObjC.unwrap` 只能拿到 Ref，`objectForKey` 取不出值），
//      写出来的桥三天两头坏，且坏了没有可读的报错。
//   2. koffi / napi 原生模块要带 ABI 与下载渠道，桌宠这种长期驻留的东西不该有
//      第二套二进制分发链路。
//   3. `swiftc` 来自 Xcode Command Line Tools，本机已有；产物是单个可执行文件，
//      零运行时依赖，出错就是明确的退出码。
//
// 权限（TCC）：
//   - `kCGWindowName`（窗口标题）与 `screencapture` 需要「屏幕录制」。
//     未授权时窗口仍能枚举，只是 title 为空 —— 调用方必须容忍，不要把它当成
//     「这个窗口没有标题」。
//   - `axtext` 需要「辅助功能」。未授权时返回 axTrusted:false，不抛错。
//
// 输出契约：stdout 恰好一行 JSON，成功 {"ok":true,...}，失败 {"ok":false,"error":..}
// 退出码：0 成功 / 1 用法错误 / 2 运行期失败 / 3 权限缺失
//
// 子命令：
//   windows [--include-untitled]
//   frontapp
//   idle
//   pdftext --path <pdf> [--max-chars N]
//   axtext --pid <pid>
//   trust
//
// @module dsh-companion/bridge/DshBridge

import Foundation
import CoreGraphics
import AppKit
import UniformTypeIdentifiers
import PDFKit
import Vision
import ApplicationServices
import Carbon.HIToolbox

// MARK: - 输出

func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write(#"{"ok":false,"error":"encode"}"#.data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(text.data(using: .utf8)!)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ error: String, _ message: String, code: Int32 = 2) -> Never {
    emit(["ok": false, "error": error, "message": message])
    exit(code)
}

// MARK: - 参数

struct Args {
    let command: String
    let flags: [String: String]
    let switches: Set<String>
}

func parseArgs() -> Args {
    var rest = Array(CommandLine.arguments.dropFirst())
    guard let command = rest.first else {
        fail("usage", "需要子命令：windows | frontapp | idle | pdftext | axtext | trust", code: 1)
    }
    rest.removeFirst()
    var flags: [String: String] = [:]
    var switches: Set<String> = []
    var i = 0
    while i < rest.count {
        let token = rest[i]
        if token.hasPrefix("--") {
            let key = String(token.dropFirst(2))
            if i + 1 < rest.count, !rest[i + 1].hasPrefix("--") {
                flags[key] = rest[i + 1]
                i += 2
                continue
            }
            switches.insert(key)
            i += 1
            continue
        }
        i += 1
    }
    return Args(command: command, flags: flags, switches: switches)
}

// MARK: - 权限

func screenRecordingGranted() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightScreenCaptureAccess()
    }
    return true
}

func accessibilityGranted() -> Bool {
    AXIsProcessTrusted()
}

// MARK: - 窗口

// MARK: - 全局热键（常驻监听）

/// 键名 → 虚拟键码。只覆盖「字母/数字/F1-F19」这三种够用的形状。
func keyCodeFor(_ name: String) -> UInt32? {
    let upper = name.uppercased()
    let ansi: [String: Int] = [
        "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E,
        "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J,
        "K": kVK_ANSI_K, "L": kVK_ANSI_L, "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O,
        "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
        "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X, "Y": kVK_ANSI_Y,
        "Z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
        "9": kVK_ANSI_9, "SPACE": kVK_Space,
    ]
    if let code = ansi[upper] { return UInt32(code) }
    let fkeys: [String: Int] = [
        "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
        "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
        "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15, "F16": kVK_F16, "F17": kVK_F17,
        "F18": kVK_F18, "F19": kVK_F19,
    ]
    if let code = fkeys[upper] { return UInt32(code) }
    return nil
}

/// 事件文件路径：Carbon 的回调是 C 函数指针，不能捕获上下文，只能用文件级变量传进去。
var hotkeyEventsFile = ""
/// 必须强引用：addGlobalMonitorForEvents 返回的 token 一旦释放，监听就被摘掉了。
var globalHotkeyMonitor: Any?
/// CGEventTap 回调是 C 函数指针，只能用文件级变量传目标。
var tapKeyCode: Int64 = 0
var tapFlags: UInt64 = 0

func appendHotkeyEvent() {
    let line = "{\"event\":\"hotkey\",\"at\":\(Int(Date().timeIntervalSince1970 * 1000))}\n"
    if let handle = FileHandle(forWritingAtPath: hotkeyEventsFile) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    }
}

/// 常驻监听：注册一个全局热键，按下时往 stdout 打一行 JSON，其余时间阻塞。
/// 空闲 0 CPU（RunLoop 睡在系统事件上），不抢焦点。
func runHotkeyListener(spec: String, eventsFile: String) -> Never {
    hotkeyEventsFile = eventsFile
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    var carbonFlags: UInt32 = 0
    var cocoaFlags: NSEvent.ModifierFlags = []
    var keyName = ""
    for part in spec.split(separator: "+") {
        switch part.trimmingCharacters(in: .whitespaces).lowercased() {
        case "command", "cmd": carbonFlags |= UInt32(cmdKey); cocoaFlags.insert(.command)
        case "option", "opt", "alt": carbonFlags |= UInt32(optionKey); cocoaFlags.insert(.option)
        case "control", "ctrl": carbonFlags |= UInt32(controlKey); cocoaFlags.insert(.control)
        case "shift": carbonFlags |= UInt32(shiftKey); cocoaFlags.insert(.shift)
        case let other: keyName = other
        }
    }
    guard let code = keyCodeFor(keyName), !keyName.isEmpty else {
        emit(["ok": false, "error": "bad-spec", "message": "不支持的键：\(keyName)"])
        exit(2)
    }

    func appendEvent() {
        let line = "{\"event\":\"hotkey\",\"at\":\(Int(Date().timeIntervalSince1970 * 1000))}\n"
        if let handle = FileHandle(forWritingAtPath: hotkeyEventsFile) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            try? handle.close()
        }
    }

    let trusted = accessibilityGranted()
    // 主路：CGEventTap（skhd 同款）。无 bundle 的 CLI 里 NSEvent 全局监听收不到任何按键
    // （实测连 debug 日志都没有），而 CGEventTap 只要有辅助功能授权就可靠。
    if trusted {
        tapKeyCode = Int64(code)
        tapFlags = UInt64(cocoaFlags.rawValue)
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        if let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, _ in
                if type == .keyDown {
                    let code = event.getIntegerValueField(.keyboardEventKeycode)
                    let flags = event.flags.rawValue & 0xF0000  // command/option/control/shift 位
                    if ProcessInfo.processInfo.environment["DSH_HOTKEY_DEBUG"] == "1" {
                        let dbg = "{\"event\":\"key\",\"code\":\(code),\"flags\":\(flags)}\n"
                        if let h = FileHandle(forWritingAtPath: hotkeyEventsFile) {
                            h.seekToEndOfFile(); h.write(dbg.data(using: .utf8)!); try? h.close()
                        }
                    }
                    if code == tapKeyCode && flags == (tapFlags & 0xF0000) { appendHotkeyEvent() }
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: nil
        ) {
            let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            emit(["ok": true, "listening": true, "spec": spec, "backend": "cgeventtap", "axTrusted": true])
            CFRunLoopRun()
            exit(0)
        }
    }

    // 退路：Carbon（不需要授权，但可能不投递）。
    let hotKeyID = EventHotKeyID(signature: OSType(0x44534843), id: 1)
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(code, carbonFlags, hotKeyID, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr, ref != nil else {
        emit(["ok": false, "error": "register-failed", "message": "热键已被占用或系统不允许（status=\(status)）", "axTrusted": trusted])
        exit(3)
    }
    var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
        let line = "{\"event\":\"hotkey\",\"at\":\(Int(Date().timeIntervalSince1970 * 1000))}\n"
        if let handle = FileHandle(forWritingAtPath: hotkeyEventsFile) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            try? handle.close()
        }
        return noErr
    }, 1, &type, nil, nil)
    emit(["ok": true, "listening": true, "spec": spec, "backend": "carbon", "axTrusted": trusted])
    app.run()
    exit(0)
}

func frontmostApp() -> (name: String, bundleId: String, pid: Int) {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        return ("", "", 0)
    }
    return (app.localizedName ?? "", app.bundleIdentifier ?? "", Int(app.processIdentifier))
}

func windowList(includeUntitled: Bool) -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var out: [[String: Any]] = []
    for (index, info) in raw.enumerated() {
        let layer = (info[kCGWindowLayer as String] as? Int) ?? 0
        // 只要普通应用窗口层（0）：菜单栏、悬浮面板、输入法候选窗都在别的层，
        // 混进来只会让上层挑错目标。
        guard layer == 0 else { continue }
        let title = (info[kCGWindowName as String] as? String) ?? ""
        if !includeUntitled && title.isEmpty { continue }
        let boundsDict = (info[kCGWindowBounds as String] as? [String: Any]) ?? [:]
        let bounds: [String: Any] = [
            "x": (boundsDict["X"] as? Double) ?? 0,
            "y": (boundsDict["Y"] as? Double) ?? 0,
            "w": (boundsDict["Width"] as? Double) ?? 0,
            "h": (boundsDict["Height"] as? Double) ?? 0,
        ]
        let pid = (info[kCGWindowOwnerPID as String] as? Int) ?? 0
        // 加上 bundleId：上层要按「同一个应用的适配器」处理「刚才那个窗口」，
        // 只靠 ownerName 匹配显示名太脆（本地化、改名都会破）。
        let bundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
        out.append([
            "windowId": (info[kCGWindowNumber as String] as? Int) ?? 0,
            "ownerName": (info[kCGWindowOwnerName as String] as? String) ?? "",
            "ownerPid": pid,
            "bundleId": bundleId,
            "title": title,
            "layer": layer,
            "bounds": bounds,
            "onScreen": ((info[kCGWindowIsOnscreen as String] as? Int) ?? 0) != 0,
            // 列表本身是前到后排序：order 就是叠放次序，0 是最前面。
            "order": index,
        ])
    }
    return out
}

// MARK: - 空闲

func idleSeconds() -> Double {
    // kCGAnyInputEventType = ~0：任一输入事件重置计时。只读会话状态，无需授权。
    let anyInput = CGEventType(rawValue: ~0)!
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
}

// MARK: - PDF

func pdfText(path: String, maxChars: Int) -> (text: String, pages: Int, truncated: Bool) {
    let url = URL(fileURLWithPath: path)
    guard let doc = PDFDocument(url: url) else {
        fail("pdf-open-failed", "打不开 PDF：\(path)")
    }
    let pages = doc.pageCount
    var text = ""
    var truncated = false
    for index in 0..<pages {
        guard let page = doc.page(at: index), let pageText = page.string else { continue }
        if text.count + pageText.count > maxChars {
            let room = max(0, maxChars - text.count)
            text += String(pageText.prefix(room))
            truncated = true
            break
        }
        text += pageText
        text += "\n"
    }
    return (text, pages, truncated)
}

// MARK: - 辅助功能文本（实验性）

/// 用 ⌘C 取选中内容（通用退路）：微信、Electron 应用、部分国产软件完全不暴露 AX 选中接口，
/// 但它们都支持复制。做法：保存剪贴板 → 发 ⌘C → 等剪贴板变化 → 读字符串 → 还原剪贴板。
func selectionViaClipboard() -> String {
    let pasteboard = NSPasteboard.general
    // 快照：保留每种类型的数据，尽量无损还原用户的剪贴板。
    let savedItems: [[NSPasteboard.PasteboardType: Data]] = (pasteboard.pasteboardItems ?? []).map { item in
        var entry: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { entry[type] = data }
        }
        return entry
    }
    let before = pasteboard.changeCount

    let source = CGEventSource(stateID: .combinedSessionState)
    let keyCodeC: CGKeyCode = 0x08
    if let down = CGEvent(keyboardEventSource: source, virtualKey: keyCodeC, keyDown: true),
       let up = CGEvent(keyboardEventSource: source, virtualKey: keyCodeC, keyDown: false) {
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        usleep(30_000)
        up.post(tap: .cghidEventTap)
    }

    // 等剪贴板变化（最多约 400ms）；没变化说明这个应用不响应 ⌘C 或没有选中内容。
    var text = ""
    for _ in 0..<20 {
        if pasteboard.changeCount != before {
            text = pasteboard.string(forType: .string) ?? ""
            break
        }
        usleep(20_000)
    }

    // 还原剪贴板（即使没读到内容也要还原）。
    if !savedItems.isEmpty {
        pasteboard.clearContents()
        let items = savedItems.map { entry -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in entry { item.setData(data, forType: type) }
            return item
        }
        pasteboard.writeObjects(items)
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 读当前选中文本：只认 `AXSelectedTextAttribute`。
/// 不能复用 `axFocusedWindowText`——它先读 `kAXValueAttribute`，输入框里整段值会盖过选中区。
func axSelectedText() -> [String: Any] {
    guard accessibilityGranted() else {
        return ["axTrusted": false, "text": "", "app": "", "pid": 0]
    }
    // 候选元素按「最可能带选中内容」排序，逐个试：
    //   系统焦点 → 前台应用的焦点元素 → 前台窗口 → 前台窗口的焦点子元素。
    // 只试系统焦点是不够的：它可能指向窗口本身或 WebArea 外壳，选中内容在更内层。
    let front = NSWorkspace.shared.frontmostApplication
    var candidates: [AXUIElement] = []
    func push(_ element: AXUIElement?) {
        if let element { candidates.append(element) }
    }

    let system = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
       let focused = focusedRef {
        push((focused as! AXUIElement))
    }
    if let app = front {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var appFocused: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &appFocused) == .success,
           let element = appFocused {
            push((element as! AXUIElement))
        }
        var windowRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
           let window = windowRef {
            let axWindow = window as! AXUIElement
            push(axWindow)
            var windowFocused: CFTypeRef?
            if AXUIElementCopyAttributeValue(axWindow, kAXFocusedUIElementAttribute as CFString, &windowFocused) == .success,
               let element = windowFocused {
                push((element as! AXUIElement))
            }
        }
    }

    /// 从一个元素读**真正的选中文字**。
    ///
    /// 关键是先判断「选中范围」而不是先读 `AXSelectedText`：Obsidian 这类编辑器在
    /// 只有光标、没有选中时，也会把「光标所在这一行」当成 AXSelectedText 返回。
    /// 只检查文本非空，就会把光标行当成选中，于是跳过截图、只喂那一行给模型（实测）。
    ///
    /// 规则：
    ///   1. 读得到 range：长度为 0 = 光标停着，不算选中，返回空串
    ///   2. 读得到 range：长度 > 0 才用参数化属性取范围内的字符串
    ///   3. 读不到 range（个别应用不给）：退回 AXSelectedText，但若它等于控件全文
    ///      （kAXValueAttribute），说明那是整段内容而不是选中，同样返回空串
    func selectedTextOf(_ target: AXUIElement) -> (text: String, source: String) {
        var rangeRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(target, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
           let rangeValue = rangeRef {
            var range = CFRange()
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) {
                if range.length == 0 { return ("", "caret") }
                var strRef: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    target,
                    kAXStringForRangeParameterizedAttribute as CFString,
                    rangeValue,
                    &strRef
                ) == .success, let str = strRef as? String, !str.isEmpty {
                    return (str, "range")
                }
            }
        }

        var valueRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(target, kAXSelectedTextAttribute as CFString, &valueRef) == .success,
           let value = valueRef as? String, !value.isEmpty {
            var fullRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &fullRef) == .success,
               let full = fullRef as? String, full == value {
                return ("", "whole-value")
            }
            // 这一支没有 range 信息：可能是真选中，也可能是「光标所在行」（Obsidian 实测）。
            return (value, "selected-text")
        }
        return ("", "none")
    }

    /// 从候选元素向下有限广度搜索，找**真正暴露 AXSelectedTextRange** 的那个元素。
    ///
    /// 为什么需要：Electron / Chromium 应用（Obsidian、VS Code）的焦点元素常常是外层容器，
    /// 范围属性在更内层的编辑节点上。只问外层，永远拿不到 range，就只能靠剪贴板——
    /// 而这类编辑器「没选中时 ⌘C 复制整行」，会把验证骗过去。
    func rangeSignal(from candidates: [AXUIElement]) -> (text: String, caret: Bool)? {
        var queue = candidates
        var visited = 0
        while !queue.isEmpty && visited < 400 {
            let element = queue.removeFirst()
            visited += 1

            var rangeRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
               let rangeValue = rangeRef {
                var range = CFRange()
                if AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) {
                    if range.length == 0 { return ("", true) }
                    var strRef: CFTypeRef?
                    if AXUIElementCopyParameterizedAttributeValue(
                        element,
                        kAXStringForRangeParameterizedAttribute as CFString,
                        rangeValue,
                        &strRef
                    ) == .success, let str = strRef as? String, !str.isEmpty {
                        return (str, false)
                    }
                }
            }

            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children)
            }
        }
        return nil
    }

    // 第一轮：只看「范围」信号。
    // 只要有任何候选暴露了 AXSelectedTextRange，就以它为准：
    // 长度 0 = 光标停着，直接判定「没有选中」，**不再走剪贴板兜底**——
    // 否则 Obsidian / VS Code 这类「没选中时 ⌘C 复制整行」的编辑器会骗过验证。
    var sawRange = false
    var sawCaret = false
    var text = ""
    var source = ""

    // 先从整棵焦点子树里找范围信号（覆盖 Electron 把编辑节点藏在里层的情况）。
    if let signal = rangeSignal(from: candidates) {
        if signal.caret {
            sawRange = true
            sawCaret = true
        } else {
            sawRange = true
            text = signal.text
            source = "range-subtree"
        }
    }

    for candidate in candidates where text.isEmpty && !sawCaret {
        let result = selectedTextOf(candidate)
        if result.source == "caret" {
            sawRange = true
            sawCaret = true
            continue
        }
        if result.source == "range" {
            sawRange = true
            if result.text.isEmpty { continue }
            text = result.text
            source = "range"
            break
        }
    }

    // 第二轮：所有候选都没暴露 range 时，才退到 AXSelectedText + 剪贴板交叉验证。
    if text.isEmpty && !sawRange {
        for candidate in candidates {
            let result = selectedTextOf(candidate)
            if result.text.isEmpty { continue }
            let viaClipboard = selectionViaClipboard()
            if viaClipboard.isEmpty { continue }
            text = viaClipboard
            source = "clipboard"
            break
        }
    }

    return [
        "axTrusted": true,
        "text": text,
        "source": source,
        "sawRange": sawRange,
        "sawCaret": sawCaret,
        "app": front?.localizedName ?? "",
        "pid": front.map { Int($0.processIdentifier) } ?? 0,
    ]
}

func axFocusedWindowText(pid: pid_t) -> [String: Any] {
    guard accessibilityGranted() else {
        return ["axTrusted": false]
    }
    let app = AXUIElementCreateApplication(pid)
    var windowRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
          let window = windowRef else {
        return ["axTrusted": true, "title": "", "text": ""]
    }
    let axWindow = window as! AXUIElement
    var titleRef: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
    let title = (titleRef as? String) ?? ""

    // 只取「焦点元素」的文本，不做整窗遍历：整树遍历在大文档上会卡住主线程，
    // 且顺序不可控。需要整篇文本时走 app 专用适配器（Word / PDF）。
    var focusedRef: CFTypeRef?
    var text = ""
    if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
       let focused = focusedRef {
        let element = focused as! AXUIElement
        for attribute in [kAXValueAttribute, kAXSelectedTextAttribute] {
            var valueRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, attribute as CFString, &valueRef) == .success,
               let value = valueRef as? String,
               !value.isEmpty {
                text = value
                break
            }
        }
    }
    return ["axTrusted": true, "title": title, "text": String(text.prefix(20000))]
}


/// 光标是否落在桌面上：从前往后找第一个包含光标的 layer 0 窗口，找不到就是桌面。
///
/// 为什么需要它：Finder 的 AX「焦点窗口」在你点桌面后仍然指向它上一次的窗口（实测），
/// 仅靠 AX 无法区分「Finder 窗口」和「桌面」。光标位置是可靠的物理事实。
func cursorIsOverDesktop() -> Bool {
    // 注意：`CGEvent.location` 与 `CGWindowList` 的 bounds 都是**左上原点**，同一套坐标，
    // 可以直接比较。（`NSEvent.mouseLocation` 才是左下原点——混用会永远判成桌面。）
    guard let point = CGEvent(source: nil)?.location else { return false }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return true }
    for window in list {
        let layer = (window[kCGWindowLayer as String] as? Int) ?? 0
        if layer != 0 { continue }
        guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
        if bounds.contains(point) { return false }
    }
    return true
}

// MARK: - 分发

let args = parseArgs()

switch args.command {
case "windows":
    let includeUntitled = args.switches.contains("include-untitled")
    let front = frontmostApp()
    let windows = windowList(includeUntitled: includeUntitled)
    emit([
        "ok": true,
        "frontApp": ["name": front.name, "bundleId": front.bundleId, "pid": front.pid],
        "windows": windows,
        "screenRecording": screenRecordingGranted(),
        "accessibility": accessibilityGranted(),
    ])

case "frontapp":
    let front = frontmostApp()
    var payload: [String: Any] = [
        "ok": true,
        "name": front.name,
        "bundleId": front.bundleId,
        "pid": front.pid,
        "idleSeconds": idleSeconds(),
        "screenRecording": screenRecordingGranted(),
        "accessibility": accessibilityGranted(),
    ]
    // 前台窗口：优先用 **AX 焦点窗口** 判定。
    //
    // 不能用「CGWindowList 里第一条属于该 pid 的窗口」——那可能是这个应用**开着但没焦点**
    // 的窗口。典型症状：点桌面时前台是 Finder，却拿到了 Finder 的 Downloads 窗口（实测）。
    var hasFocusedWindow = false
    var focusedTitle = ""
    var focusedNumber: Int? = nil
    if accessibilityGranted() {
        let axApp = AXUIElementCreateApplication(pid_t(front.pid))
        var windowRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
           let window = windowRef {
            hasFocusedWindow = true
            let axWindow = window as! AXUIElement
            var titleRef: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
            focusedTitle = (titleRef as? String) ?? ""
            var numberRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(axWindow, "AXWindowNumber" as CFString, &numberRef) == .success,
               let number = numberRef as? Int {
                focusedNumber = number
            }
        }
    }

    if hasFocusedWindow {
        var resolvedId = focusedNumber
        var resolvedTitle = focusedTitle
        var resolvedBounds: Any? = nil
        // AXWindowNumber 不一定可用：退化成「同 pid 且标题一致」的窗口。
        if resolvedId == nil || resolvedId == 0 {
            if let match = windowList(includeUntitled: true).first(where: {
                ($0["ownerPid"] as? Int) == front.pid && (($0["title"] as? String) ?? "") == focusedTitle
            }) {
                resolvedId = match["windowId"] as? Int
                resolvedBounds = match["bounds"]
            }
        }
        if let id = resolvedId, id > 0 {
            payload["windowId"] = id
            payload["windowTitle"] = resolvedTitle
            if let resolvedBounds { payload["bounds"] = resolvedBounds }
            payload["desktop"] = (front.bundleId == "com.apple.finder" && cursorIsOverDesktop())
        } else {
            // 有「焦点窗口」但解析不到窗口号：不要直接判成桌面（会把 DSH 之类误判成整屏），
            // 退回「该 pid 的第一个可见窗口」。
            if let match = windowList(includeUntitled: true).first(where: { ($0["ownerPid"] as? Int) == front.pid }) {
                payload["windowId"] = match["windowId"] as? Int
                payload["windowTitle"] = (match["title"] as? String) ?? resolvedTitle
                payload["desktop"] = false
            } else {
                payload["desktop"] = true
            }
        }
    } else {
        // 没有焦点窗口 = 桌面 / 通知中心 / 聚焦搜索这类浮层：
        // 明确标记，让上层按「整屏截图」处理，而不是沿用上一个窗口。
        payload["desktop"] = true
    }
    // 光标在桌面上（没有任何普通窗口覆盖）时，即使 Finder 报了个「焦点窗口」，
    // 也应该按桌面处理——这正是「点桌面却看到 Downloads」的成因。
    payload["cursorOverDesktop"] = cursorIsOverDesktop()
    emit(payload)

case "idle":
    emit(["ok": true, "idleSeconds": idleSeconds()])

case "pdftext":
    guard let path = args.flags["path"] else {
        fail("usage", "pdftext 需要 --path", code: 1)
    }
    let maxChars = Int(args.flags["max-chars"] ?? "") ?? 40000
    let result = pdfText(path: path, maxChars: maxChars)
    emit([
        "ok": true,
        "text": result.text,
        "pages": result.pages,
        "truncated": result.truncated,
        "chars": result.text.count,
    ])

case "pickfile":
    // 原生选图：从插件设置页点「选择…」时调用。
    // 用 NSOpenPanel 而不是自己写路径解析——用户不该被要求记住绝对路径。
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApp.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType.png, UTType.jpeg, UTType.webP]
    panel.message = "选择一张 PNG 立绘（透明背景效果最好）"
    panel.prompt = "选择"
    panel.level = .floating
    let picked = panel.runModal()
    if picked != .OK {
        emit(["ok": true, "cancelled": true])
    } else {
        emit(["ok": true, "path": panel.url?.path ?? ""])
    }
case "ask":
    // 原生小窗问一句：抓完图之后再弹，避免把自己截进去。
    // 单行输入够用；回车发送、Esc 取消（取消则整条链路不花钱、不留记录）。
    let prompt = args.flags["prompt"] ?? "问点什么？"
    NSApplication.shared.setActivationPolicy(.accessory)
    let alert = NSAlert()
    alert.messageText = prompt
    alert.informativeText = "回车发送，Esc 取消"
    alert.addButton(withTitle: "发送")
    alert.addButton(withTitle: "取消")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
    field.placeholderString = "比如：这段在说什么？这个报错怎么处理？"
    alert.accessoryView = field
    alert.window.initialFirstResponder = field
    let response = alert.runModal()
    let typed = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if response != .alertFirstButtonReturn || typed.isEmpty {
        emit(["ok": true, "cancelled": true])
    } else {
        emit(["ok": true, "text": typed])
    }
case "poke":
    // 给 macOS 快捷指令用：往事件文件追加一次触发，不需要任何 TCC 权限。
    guard let pokeFile = args.flags["events"], !pokeFile.isEmpty else {
        fail("usage", "poke 需要 --events <file>", code: 1)
    }
    let mode = args.flags["mode"].map { ",\"mode\":\"\($0)\"" } ?? ""
    let line = "{\"event\":\"hotkey\",\"at\":\(Int(Date().timeIntervalSince1970 * 1000)),\"from\":\"poke\"\(mode)}\n"
    if !FileManager.default.fileExists(atPath: pokeFile) {
        FileManager.default.createFile(atPath: pokeFile, contents: nil)
    }
    if let handle = FileHandle(forWritingAtPath: pokeFile) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    }
    emit(["ok": true, "poked": pokeFile])

case "hotkeys":
    guard let spec = args.flags["spec"], !spec.isEmpty else {
        fail("usage", "hotkeys 需要 --spec", code: 1)
    }
    guard let eventsFile = args.flags["events"], !eventsFile.isEmpty else {
        fail("usage", "hotkeys 需要 --events <file>", code: 1)
    }
    runHotkeyListener(spec: spec, eventsFile: eventsFile)

case "ocr":
    // 对一张图做本地文字识别（Vision，不联网）。多画面收集用它给每张图附 OCR。
    guard let file = args.flags["file"], !file.isEmpty else {
        fail("usage", "ocr 需要 --file <图片路径>", code: 1)
    }
    guard let image = NSImage(contentsOfFile: file) else {
        fail("bad-image", "读不到图片：\(file)", code: 1)
    }
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
        fail("bad-image", "图片无法转成位图", code: 1)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    emit(["ok": true, "lines": lines, "text": lines.joined(separator: "\n")])
case "sheet":
    // 拼图：把若干帧按给定矩形画到一张画布上（矩形由插件算好，这里只负责画）。
    // 用 spec 文件而不是长参数：格数、坐标都是数组，命令行传起来容易出错。
    guard let specPath = args.flags["spec"], !specPath.isEmpty else {
        fail("usage", "sheet 需要 --spec <json 文件>", code: 1)
    }
    guard let specData = FileManager.default.contents(atPath: specPath),
          let spec = try? JSONSerialization.jsonObject(with: specData) as? [String: Any],
          let outPath = spec["out"] as? String,
          let cells = spec["cells"] as? [[String: Any]], !cells.isEmpty else {
        fail("bad-spec", "spec 读不出来（需要 width/height/out/cells）", code: 1)
    }
    let canvasW = Int(spec["width"] as? Int ?? 2160)
    let canvasH = Int(spec["height"] as? Int ?? 1350)
    guard canvasW > 0, canvasH > 0 else { fail("bad-spec", "画布尺寸非法", code: 1) }
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: canvasW,
        pixelsHigh: canvasH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { fail("bitmap-failed", "建不了画布", code: 1) }
    let context = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    NSColor.black.setFill()
    NSRect(x: 0, y: 0, width: canvasW, height: canvasH).fill()
    var drawn = 0
    for cell in cells {
        guard let path = cell["path"] as? String,
              let image = NSImage(contentsOfFile: path) else { continue }
        let x = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
        let rect = NSRect(
            x: CGFloat((cell["x"] as? Double) ?? 0),
            y: CGFloat((cell["y"] as? Double) ?? 0),
            width: CGFloat((cell["w"] as? Double) ?? 0),
            height: CGFloat((cell["h"] as? Double) ?? 0)
        )
        guard rect.width > 1, rect.height > 1 else { continue }
        // 等比裁剪到格子（填满），不拉伸。
        let scale = max(rect.width / x.width, rect.height / x.height)
        let srcW = rect.width / scale
        let srcH = rect.height / scale
        let src = NSRect(x: (x.width - srcW) / 2, y: (x.height - srcH) / 2, width: srcW, height: srcH)
        image.draw(in: rect, from: src, operation: .copy, fraction: 1, respectFlipped: false, hints: nil)
        drawn += 1
    }
    NSGraphicsContext.restoreGraphicsState()
    guard drawn > 0 else { fail("nothing-drawn", "没有任何一帧画上去", code: 1) }
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fail("encode-failed", "PNG 编码失败", code: 1)
    }
    do {
        try png.write(to: URL(fileURLWithPath: outPath))
    } catch {
        fail("write-failed", "写不了 \(outPath)：\(error.localizedDescription)", code: 1)
    }
    emit(["ok": true, "path": outPath, "cells": drawn, "width": canvasW, "height": canvasH])

case "watchprobe":
    // 离线实验：按间隔抓帧 + 本地 OCR + 按文字变化切分「状态」。
    //
    // 目的：先验证「屏幕内容能不能用『文字变化』切分」以及切分粒度是否合理，
    // 全程不调用模型、不花 token。这是「看一阵」正式实现前的可行性实验。
    guard let seconds = Int(args.flags["seconds"] ?? "120"),
          let interval = Double(args.flags["interval"] ?? "2") else {
        fail("usage", "watchprobe 需要 --seconds <n> --interval <秒> [--out <path>] [--threshold 0.8]", code: 1)
    }
    let outPath = args.flags["out"] ?? "/tmp/dsh-watchprobe.jsonl"
    let threshold = Double(args.flags["threshold"] ?? "0.8") ?? 0.8
    let keepDir = args.flags["keep-dir"] ?? ""
    let drift = args.switches.contains("drift") || args.flags["drift"] != nil
    let minRun = max(1, Int(args.flags["min-run"] ?? "1") ?? 1)
    // 纯追加视为同一状态：聊天/日志/构建输出都是「只增不减」，
    // 用整体相似度会让它们每隔几秒就切一个新状态（实测）。
    let additiveOk = args.switches.contains("additive") || args.flags["additive"] != nil
    if !keepDir.isEmpty {
        try? FileManager.default.createDirectory(atPath: keepDir, withIntermediateDirectories: true)
    }
    final class State: @unchecked Sendable {
        /// 「上一个保留状态」的行集合（drift 模式用它比较，避免流式文字造成的漂移）。
        var keptLines: Set<String> = []
        /// 上一帧的行（非 drift 模式比较对象）。
        var prevLines: Set<String> = []
        var stateIndex = 0
        var lastKeepAt = Date.distantPast
        /// 连续多少帧低于阈值：达到 minRun 才真正切分（滞回，防止瞬时抖动触发）。
        var lowRun = 0
    }
    let probe = State()
    func normalize(_ raw: [String]) -> Set<String> {
        Set(raw.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { $0.count >= 2 })
    }
    func jaccard(_ a: Set<String>, _ b: Set<String>) -> Double {
        if a.isEmpty && b.isEmpty { return 1 }
        let union = a.union(b).count
        return union == 0 ? 1 : Double(a.intersection(b).count) / Double(union)
    }
    func capture() -> CGImage? {
        // 新 SDK 把 CGDisplayCreateImage 标成 unavailable，改用系统命令。
        // 每次约 150–250ms，对 2 秒的采样间隔完全够用。
        let tmp = NSTemporaryDirectory() + "dsh-watchprobe-shot.png"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-t", "png", tmp]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        guard let image = NSImage(contentsOfFile: tmp) else { return nil }
        var rect = CGRect(origin: .zero, size: image.size)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
    func ocr(_ image: CGImage) -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try? handler.perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    var out = ""
    var kept = 0
    var frames = 0
    let startedAt = Date()
    while Date().timeIntervalSince(startedAt) < Double(seconds) {
        autoreleasepool {
            frames += 1
            let now = Date()
            guard let image = capture() else {
                out += "{\"t\":\(Int(now.timeIntervalSince1970 * 1000)),\"error\":\"capture-nil\"}\n"
                return
            }
            let raw = ocr(image)
            let cur = normalize(raw)
            let baseline = drift ? probe.keptLines : probe.prevLines
            var sim = jaccard(baseline, cur)
            if additiveOk, !baseline.isEmpty, baseline.isSubset(of: cur) {
                // 只增不减 = 内容在延长，不是换了场景。
                sim = 1
            }
            let low = !baseline.isEmpty && sim < threshold
            probe.lowRun = low ? probe.lowRun + 1 : 0
            let isNewState = probe.keptLines.isEmpty || (low && probe.lowRun >= minRun)
            if isNewState {
                probe.stateIndex += 1
                probe.keptLines = cur
                probe.lastKeepAt = now
                kept += 1
                if !keepDir.isEmpty {
                    let name = String(format: "frame-%03d.png", probe.stateIndex)
                    let path = (keepDir as NSString).appendingPathComponent(name)
                    if let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) {
                        CGImageDestinationAddImage(dest, image, nil)
                        CGImageDestinationFinalize(dest)
                    }
                }
            }
            probe.prevLines = cur
            out += "{\"t\":\(Int(now.timeIntervalSince1970 * 1000)),\"state\":\(probe.stateIndex),\"kept\":\(isNewState),\"sim\":\(String(format: "%.3f", sim)),\"lines\":\(cur.count),\"chars\":\(raw.joined().count)}\n"
        }
        Thread.sleep(forTimeInterval: interval)
    }
    try? out.write(toFile: outPath, atomically: true, encoding: .utf8)
    emit(["ok": true, "frames": frames, "states": kept, "seconds": seconds, "interval": interval, "out": outPath, "keepDir": keepDir])
case "axtree":
    // 诊断用：从系统焦点元素向下走几层，打印 role / 是否有选中范围 / 选中文本长度。
    // 目的是「看清楚某个应用到底暴露了什么」，而不是靠猜。
    guard accessibilityGranted() else { fail("no-permission", "需要辅助功能授权", code: 2) }
    var nodes: [[String: Any]] = []
    let systemRoot = AXUIElementCreateSystemWide()
    var startRef: CFTypeRef?
    AXUIElementCopyAttributeValue(systemRoot, kAXFocusedUIElementAttribute as CFString, &startRef)
    var queue: [(AXUIElement, Int)] = []
    if let start = startRef {
        queue.append((start as! AXUIElement, 0))
    } else if let front = NSWorkspace.shared.frontmostApplication {
        // 系统焦点拿不到时（比如焦点在桌面上），退到前台应用的焦点元素 / 窗口。
        let axApp = AXUIElementCreateApplication(front.processIdentifier)
        var appFocused: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &appFocused) == .success,
           let element = appFocused {
            queue.append((element as! AXUIElement, 0))
        } else {
            var windowRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
               let window = windowRef {
                queue.append((window as! AXUIElement, 0))
            }
        }
    }
    var visited = 0
    while !queue.isEmpty && visited < 60 {
        let (element, depth) = queue.removeFirst()
        visited += 1
        func attr(_ name: String) -> String {
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &ref) == .success, let value = ref else { return "" }
            if let str = value as? String { return String(str.prefix(40)) }
            return ""
        }
        var hasRange = false
        var rangeLen = -1
        var rangeRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
           let rv = rangeRef {
            var range = CFRange()
            if AXValueGetValue(rv as! AXValue, .cfRange, &range) {
                hasRange = true
                rangeLen = range.length
            }
        }
        var selectedTextLen = 0
        var selRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selRef) == .success,
           let sel = selRef as? String { selectedTextLen = sel.count }
        nodes.append([
            "depth": depth,
            "role": attr(kAXRoleAttribute),
            "subrole": attr(kAXSubroleAttribute),
            "hasRange": hasRange,
            "rangeLen": rangeLen,
            "selectedTextLen": selectedTextLen,
            "valueLen": attr(kAXValueAttribute).count,
            "title": attr(kAXTitleAttribute),
            "desc": attr(kAXDescriptionAttribute),
        ])
        if depth >= 6 { continue }
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children.prefix(8) { queue.append((child, depth + 1)) }
        }
    }
    emit(["ok": true, "count": nodes.count, "nodes": nodes])
case "screens":
    // 所有显示器的矩形（CG 坐标）。桌面截图要「每块屏各截一张」，避免「你以为在看 A、它截了 B」。
    let mainHeight = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
        ?? NSScreen.main?.frame.height
        ?? 0
    let list: [[String: Any]] = NSScreen.screens.map { screen in
        let frame = screen.frame
        let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? 0
        return [
            "name": screen.localizedName,
            "builtin": CGDisplayIsBuiltin(id) != 0,
            "x": Int(frame.origin.x.rounded()),
            "y": Int((mainHeight - frame.origin.y - frame.height).rounded()),
            "w": Int(frame.width.rounded()),
            "h": Int(frame.height.rounded()),
        ]
    }
    emit(["ok": true, "screens": list])
case "cursorscreen":
    // 光标所在的显示器矩形（CG 坐标：左上原点，与 screencapture -R 一致）。
    // 多显示器下「看一眼桌面」必须截**光标所在那块**，否则永远只截主屏。
    let mouse = NSEvent.mouseLocation
    let mainHeight = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
        ?? NSScreen.main?.frame.height
        ?? 0
    let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) })
    guard let screen else { fail("no-screen", "光标不在任何显示器上", code: 1) }
    let frame = screen.frame
    emit([
        "ok": true,
        "mouseX": Int(mouse.x.rounded()),
        "mouseY": Int(mouse.y.rounded()),
        "x": Int(frame.origin.x.rounded()),
        "y": Int((mainHeight - frame.origin.y - frame.height).rounded()),
        "w": Int(frame.width.rounded()),
        "h": Int(frame.height.rounded()),
        "scale": screen.backingScaleFactor,
        "count": NSScreen.screens.count,
    ])
case "selection":
    var payload = axSelectedText()
    // --copy：AX 读不到时用 ⌘C + 剪贴板兜底（微信/Electron 这类应用只有这条路）。
    // 注意：裸开关（--copy 后面没有值）会进 switches，不是 flags。
    //
    // 但**不能无条件兜底**：如果 AX 已经明确给出「没有选中」（sawRange=true 且文本为空，
    // 即 range 长度 0 = 光标），再按 ⌘C 只会复制「光标所在行」——Obsidian / VS Code
    // 都这么干，于是「光标」又被剪贴板捞成了「选中」。这条是三次修复失败的真正原因。
    let explicitNoSelection = (payload["sawRange"] as? Bool) == true
    if (payload["text"] as? String ?? "").isEmpty,
       !explicitNoSelection,
       args.switches.contains("copy") || args.flags["copy"] != nil {
        let copied = selectionViaClipboard()
        if !copied.isEmpty {
            payload["text"] = copied
            payload["via"] = "clipboard"
        }
    }
    payload["ok"] = true
    emit(payload)

case "axtext":
    guard let pidText = args.flags["pid"], let pid = pid_t(pidText) else {
        fail("usage", "axtext 需要 --pid", code: 1)
    }
    var payload = axFocusedWindowText(pid: pid)
    payload["ok"] = true
    emit(payload)

case "trust":
    emit([
        "ok": true,
        "screenRecording": screenRecordingGranted(),
        "accessibility": accessibilityGranted(),
    ])

default:
    fail("usage", "未知子命令：\(args.command)", code: 1)
}
