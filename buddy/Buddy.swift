// dsh-companion 的浮窗进程：一张像素立绘 + 一个气泡 + 右键菜单。
//
// 为什么是独立进程：DSH 插件（Node 侧）没有创建原生窗口的能力，而桌宠必须
// 独立于 DSH 窗口存在。这里刻意不用 Electron——Mac 上系统自带 AppKit 就能画
// 透明无边框窗口，一个 200KB 的二进制比拉一个 Chromium 轻得多。
//
// 与外界的通信全部走文件，因为简单、可观察、崩了也不会牵连插件：
//   say   插件写 {"text": "...", "id": "记录 id"}，浮窗轮询 mtime 后显示
//   press 浮窗追加 {"action": "look" | "open", "id": "..."}，插件监听目录后执行
//   state 浮窗保存窗口位置，重启后回到原处
import AppKit
import Carbon
import Foundation

// MARK: - 配置

struct BuddyOptions {
    var asset: String
    var statePath: String
    var sayPath: String
    var pressPath: String
    var lockPath: String
    var iconSize: Double
    var maxBubbleChars: Int
    var fontSize: Double
    var debugHitbox: Bool
    var hotkeyLook: String
    var hotkeyAsk: String
    var hotkeyCollect: String
    var askRequestPath: String
    var askResponsePath: String
    var recenterPath: String

    static func parse() -> BuddyOptions {
        var flags: [String: String] = [:]
        var args = Array(CommandLine.arguments.dropFirst())
        var i = 0
        while i < args.count {
            let token = args[i]
            if token.hasPrefix("--"), i + 1 < args.count {
                flags[String(token.dropFirst(2))] = args[i + 1]
                i += 2
            } else {
                i += 1
            }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return BuddyOptions(
            asset: flags["asset"] ?? "",
            statePath: flags["state"] ?? "\(home)/.dsh/dsh-companion/buddy.state.json",
            sayPath: flags["say"] ?? "\(home)/.dsh/dsh-companion/buddy.say.json",
            pressPath: flags["press"] ?? "\(home)/.dsh/dsh-companion/buddy.press.jsonl",
            lockPath: flags["lock"] ?? "\(home)/.dsh/dsh-companion/buddy.lock",
            iconSize: Double(flags["size"] ?? "") ?? 160,
            maxBubbleChars: Int(flags["max-bubble-chars"] ?? "") ?? 400,
            fontSize: Double(flags["font-size"] ?? "") ?? 13,
            debugHitbox: flags["debug-hitbox"] == "1",
            hotkeyLook: flags["hotkey-look"] ?? "F8",
            hotkeyAsk: flags["hotkey-ask"] ?? "F7",
            hotkeyCollect: flags["hotkey-collect"] ?? "F9",
            askRequestPath: flags["ask-request"] ?? "\(home)/.dsh/dsh-companion/buddy.ask.request.json",
            askResponsePath: flags["ask-response"] ?? "\(home)/.dsh/dsh-companion/buddy.ask.response.json",
            recenterPath: flags["recenter"] ?? "\(home)/.dsh/dsh-companion/buddy.recenter.json"
        )
    }
}

// MARK: - 几何（固定布局，改尺寸只改这里）

// 立绘边长与窗口宽度都来自 --size（默认 160），不再写死：
// 换形象或想放大时只改配置，不用重编。
let iconSize: CGFloat = max(64, min(512, CGFloat(BuddyOptions.parse().iconSize)))
/// 气泡字号：窗口宽度要跟着它走，否则字号一大，一行放不下几个字。
let bubbleFontSize: CGFloat = max(10, min(24, CGFloat(BuddyOptions.parse().fontSize)))
// 宽度 = 基础宽度（按立绘）+ 字号增量。13pt 时维持原来的 240；
// 每大 1pt 多给 18px，保证一行大致还是能放 ~17 个汉字。上限 560，避免横跨半个屏幕。
let windowWidth: CGFloat = {
    let base = max(240, iconSize + 100)
    let widened = base + (bubbleFontSize - 13) * 18
    return max(200, min(560, widened))
}()
let iconRect = NSRect(x: (windowWidth - iconSize) / 2, y: 10, width: iconSize, height: iconSize)
let bubbleTail: CGFloat = 10
let bubbleInset = NSSize(width: 10, height: 9)
/// 没有气泡时的窗口高度：只装得下立绘。
let idleHeight = iconRect.maxY + 10
/// 立绘顶部到气泡底部的间距。
let bubbleGap: CGFloat = 6

// MARK: - 内容视图

final class BuddyView: NSView {
    var image: NSImage?
    var bubbleText: String = ""
    /// 气泡高度：由控制器按文字实测后写入，0 表示不显示气泡。
    var bubbleHeight: CGFloat = 0
    /// 短提示（如「看一眼…」）：窄气泡、加粗、居中。
    var bubbleCompact = false
    var bubbleBold = false
    /// 气泡与输入框字号（来自配置）。
    var fontSize: CGFloat = bubbleFontSize
    var bubbleRecordId: String?
    /// 气泡里的动作按钮（id, 文案）。点击时回调 onPress(id)。
    var bubbleActions: [(id: String, label: String)] = []
    /// 常驻气泡：不自动消失（多画面收集时用）。
    var bubbleSticky = false
    /// 「段输出」气泡：显示在控制条上方，录制时监控每段模型输出。
    var segmentText: String = ""
    var segmentHeight: CGFloat = 0
    /// 单击（看一眼）：延迟触发，避免双击时先跑一次 look。
    var onPress: ((pid_t?, String?) -> Void)?
    /// 双击（看一眼并提问）。
    var onAsk: (() -> Void)?
    /// 气泡里的动作按钮（id 原样传出）。
    var onAction: ((String) -> Void)?
    var onOpenBubble: ((String?) -> Void)?
    var onDragEnd: ((NSPoint) -> Void)?
    var onMenu: ((NSEvent) -> Void)?

    /// 鼠标按下瞬间的前台应用（此时焦点还没被我们夺走），随事件带给插件。
    private var frontAtPress: (pid: pid_t, name: String)?

    private var pressOrigin: NSPoint = .zero
    /// 待触发的单击；双击到来时取消它。
    private var pendingSingleClick: DispatchWorkItem?
    private var lastClickAt: TimeInterval = 0
    private var windowOriginAtPress: NSPoint = .zero
    private var dragging = false

    override var isFlipped: Bool { false }

    /// 不透明内容的包围盒（相对整张图的比例 0–1）。
    /// 线稿左右本来就是透明留白，用画布矩形当命中区必然偏宽——这里按真实像素算。
    private var contentBBox: NSRect = NSRect(x: 0, y: 0, width: 1, height: 1)
    private let showHitbox = BuddyOptions.parse().debugHitbox

    /// 扫描 alpha 通道求包围盒（只在启动载入图片时跑一次）。
    func computeContentBBox(_ image: NSImage) {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let data = rep.bitmapData else { return }
        let w = rep.pixelsWide
        let h = rep.pixelsHigh
        let spp = max(1, rep.samplesPerPixel)
        let bpr = rep.bytesPerRow
        guard rep.hasAlpha else { return }
        var minX = w, minY = h, maxX = -1, maxY = -1
        for y in 0..<h {
            let row = data.advanced(by: y * bpr)
            for x in 0..<w {
                let alpha = row[x * spp + (spp - 1)]
                if alpha > 8 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { return }
        // 位图坐标原点在左上：换成立绘的「左下为原点」
        let left = CGFloat(minX) / CGFloat(w)
        let right = CGFloat(maxX + 1) / CGFloat(w)
        let top = CGFloat(minY) / CGFloat(h)
        let bottom = CGFloat(maxY + 1) / CGFloat(h)
        contentBBox = NSRect(x: left, y: 1 - bottom, width: right - left, height: bottom - top)
    }

    /// 命中矩形：整张图的绘制框，再按不透明包围盒收进去。
    var hitRect: NSRect {
        let full = imageRect
        return NSRect(
            x: full.minX + full.width * contentBBox.minX,
            y: full.minY + full.height * contentBBox.minY,
            width: full.width * contentBBox.width,
            height: full.height * contentBBox.height
        )
    }

    /// 立绘实际绘制区域：按图片比例等比缩放并居中（不再拉伸成正方形）。
    private var imageRect: NSRect {
        guard let image, image.size.width > 0, image.size.height > 0 else { return iconRect }
        let scale = min(iconRect.width / image.size.width, iconRect.height / image.size.height)
        let w = image.size.width * scale
        let h = image.size.height * scale
        return NSRect(x: iconRect.midX - w / 2, y: iconRect.minY, width: w, height: h)
    }

    override func draw(_ dirtyRect: NSRect) {
        // 只给**命中矩形**铺一层 2% 白：让这块区域接住点击（像素级命中测试看有没有画东西），
        // 而矩形之外保持全透明 → 点击直接穿透到下面的应用，不留死区。
        // 2% → 0.8%：像素级命中测试只要求 alpha 非零，这个浓度肉眼几乎看不到，
        // 但白底上之前能看出一个浅灰方块。
        NSColor(calibratedWhite: 1.0, alpha: 0.008).setFill()
        hitRect.fill()
        // 立绘：最近邻放大，保持像素边缘；按原始比例落位，不拉伸。
        if let image {
            NSGraphicsContext.current?.imageInterpolation = .none
            image.draw(in: imageRect, from: .zero, operation: .sourceOver, fraction: 1.0)
        }
        if showHitbox {
            NSColor.systemRed.withAlphaComponent(0.9).setStroke()
            let box = NSBezierPath(rect: hitRect)
            box.lineWidth = 1
            box.stroke()
        }
        drawSegmentBubble()
        drawBubble()
    }

    /// 气泡矩形：紧贴在立绘上方，高度由文字决定；紧凑模式下按文字宽度收窄并居中。
    var bubbleRect: NSRect {
        guard bubbleHeight > 0 else { return .zero }
        let full = windowWidth - 16
        let compactSingleLine = bubbleCompact && bubbleActions.isEmpty
        let width = compactSingleLine ? min(full, max(72, measuredTextWidth + 24)) : full
        return NSRect(
            x: (windowWidth - width) / 2,
            y: iconRect.maxY + bubbleGap - bubbleTail,
            width: width,
            height: bubbleHeight
        )
    }

    /// 当前文字在气泡里的单行宽度（紧凑模式用）。
    private var measuredTextWidth: CGFloat {
        let font = bubbleBold ? NSFont.boldSystemFont(ofSize: fontSize) : NSFont.systemFont(ofSize: fontSize)
        return (bubbleText as NSString).size(withAttributes: [.font: font]).width
    }

    /// 单行文字高度（含行距），紧凑气泡据此算高度。
    var lineHeight: CGFloat {
        let font = bubbleBold ? NSFont.boldSystemFont(ofSize: fontSize) : NSFont.systemFont(ofSize: fontSize)
        return ceil(font.ascender - font.descender + font.leading)
    }

    /// 气泡轮廓：圆角矩形 + 底部三角，**一笔画完**。
    ///
    /// 为什么不能「先画矩形再画三角」：矩形自己的底边是一条完整的抗锯齿边，
    /// 三角形叠上去之后，接缝处仍会透出那条边（看起来像一条横线）。只有让底边
    /// 在开口处真正断开、轮廓连续，才不会有缝。
    private func bubblePath(body: NSRect, tailWidth: CGFloat, tailDepth: CGFloat) -> NSBezierPath {
        let r: CGFloat = 10
        let path = NSBezierPath()
        let tailX = body.midX
        let half = tailWidth / 2

        path.move(to: NSPoint(x: body.minX + r, y: body.minY))
        // 底边左段 → 尾巴左侧 → 尾巴尖 → 尾巴右侧 → 底边右段
        path.line(to: NSPoint(x: tailX - half, y: body.minY))
        path.line(to: NSPoint(x: tailX, y: body.minY - tailDepth))
        path.line(to: NSPoint(x: tailX + half, y: body.minY))
        path.line(to: NSPoint(x: body.maxX - r, y: body.minY))
        // 右下 → 右上 → 左上 → 左下 四个圆角
        path.appendArc(withCenter: NSPoint(x: body.maxX - r, y: body.minY + r), radius: r, startAngle: 270, endAngle: 360)
        path.line(to: NSPoint(x: body.maxX, y: body.maxY - r))
        path.appendArc(withCenter: NSPoint(x: body.maxX - r, y: body.maxY - r), radius: r, startAngle: 0, endAngle: 90)
        path.line(to: NSPoint(x: body.minX + r, y: body.maxY))
        path.appendArc(withCenter: NSPoint(x: body.minX + r, y: body.maxY - r), radius: r, startAngle: 90, endAngle: 180)
        path.line(to: NSPoint(x: body.minX, y: body.minY + r))
        path.appendArc(withCenter: NSPoint(x: body.minX + r, y: body.minY + r), radius: r, startAngle: 180, endAngle: 270)
        path.close()
        return path
    }

    /// 动作按钮最多一行几个。超过就换行：一行塞 6 个会把文字压成 3 个字宽。
    private let actionsPerRow = 4

    /// 动作按钮占几行。
    var actionRows: Int {
        bubbleActions.isEmpty ? 0 : Int(ceil(Double(bubbleActions.count) / Double(actionsPerRow)))
    }

    /// 动作按钮的矩形（视图坐标）。放在气泡正文下方，每行最多 4 个，行内等分。
    var actionRects: [(id: String, rect: NSRect)] {
        guard !bubbleActions.isEmpty, bubbleHeight > 0 else { return [] }
        let box = bubbleRect
        let rowHeight: CGFloat = 26
        let gap: CGFloat = 8
        let rows = actionRows
        var result: [(String, NSRect)] = []
        for (index, action) in bubbleActions.enumerated() {
            let row = index / actionsPerRow
            let col = index % actionsPerRow
            let countInRow = min(actionsPerRow, bubbleActions.count - row * actionsPerRow)
            let width = (box.width - (gap * CGFloat(countInRow + 1))) / CGFloat(countInRow)
            let x = box.minX + gap + CGFloat(col) * (width + gap)
            // 第 1 行在最上面，最后一贴气泡底部（靠近正文的是第一行，读起来顺）。
            let y = box.minY + bubbleTail + 8 + CGFloat(rows - 1 - row) * 30
            result.append((action.id, NSRect(x: x, y: y, width: width, height: rowHeight)))
        }
        return result
    }

    /// 段输出气泡：贴在控制条上方，没有尾巴（它不是「人物在说话」）。
    var segmentRect: NSRect {
        guard segmentHeight > 0, bubbleHeight > 0 else { return .zero }
        let full = windowWidth - 16
        return NSRect(x: (windowWidth - full) / 2, y: bubbleRect.maxY + 8, width: full, height: segmentHeight)
    }

    /// 采样率菜单：1s / 2s / 5s / 10s / 20s，当前档打勾。
    private func showIntervalMenu(at viewPoint: NSPoint) {
        let current = Int(bubbleActions.first(where: { $0.id == "watch-interval" })?.label.dropLast() ?? "") ?? 0
        let menu = NSMenu()
        for ms in [1000, 2000, 5000, 10000, 20000] {
            let seconds = ms / 1000
            let item = NSMenuItem(title: "\(seconds)s", action: #selector(pickInterval(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ms
            if seconds == current { item.state = .on }
            menu.addItem(item)
        }
        guard let window else { return }
        let screenPoint = window.convertPoint(toScreen: convert(viewPoint, to: nil))
        menu.popUp(positioning: nil, at: screenPoint, in: nil)
    }

    @objc private func pickInterval(_ sender: NSMenuItem) {
        guard let ms = sender.representedObject as? Int else { return }
        onAction?("watch-interval:\(ms)")
    }

    private func drawSegmentBubble() {
        let text = segmentText.trimmingCharacters(in: .whitespacesAndNewlines)
        let rect = segmentRect
        guard !text.isEmpty, rect.height > 0 else { return }
        let path = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
        NSColor.windowBackgroundColor.withAlphaComponent(0.86).setFill()
        path.fill()
        NSColor.labelColor.withAlphaComponent(0.22).setStroke()
        path.lineWidth = 1.2
        path.stroke()
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.alignment = .left
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: max(10, fontSize - 1)),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: style,
        ]
        (text as NSString).draw(in: rect.insetBy(dx: 10, dy: 8), withAttributes: attrs)
    }

    private func drawBubble() {
        let text = bubbleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, bubbleHeight > 0 else { return }

        let rect = bubbleRect
        let body = NSRect(x: rect.minX, y: rect.minY + bubbleTail, width: rect.width, height: rect.height - bubbleTail)
        let path = bubblePath(body: body, tailWidth: 16, tailDepth: bubbleTail)

        NSColor.windowBackgroundColor.withAlphaComponent(0.95).setFill()
        path.fill()

        // 描边：和输入面板保持同一种观感。
        // 面板用的是 layer.border（像素对齐、边缘锐利），这里是路径描边（会被抗锯齿摊薄），
        // 同样的 alpha 看起来会浅一档，所以这里用 0.30 去对齐面板的 0.18。
        NSColor.labelColor.withAlphaComponent(0.34).setStroke()
        path.lineWidth = 1.6
        path.stroke()

        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.alignment = (bubbleCompact && bubbleActions.isEmpty) ? .center : .left
        let attrs: [NSAttributedString.Key: Any] = [
            .font: bubbleBold ? NSFont.boldSystemFont(ofSize: fontSize) : NSFont.systemFont(ofSize: fontSize),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: style,
        ]
        // 有按钮时文字区要让出底部一行，否则会画到按钮上。
        let actionRowHeight: CGFloat = CGFloat(actionRows) * 34
        let textBody = NSRect(
            x: body.minX,
            y: body.minY + actionRowHeight,
            width: body.width,
            height: max(0, body.height - actionRowHeight)
        )
        let inset = textBody.insetBy(dx: 10, dy: bubbleCompact ? 7 : 9)
        (text as NSString).draw(in: inset, withAttributes: attrs)

        // 动作按钮：描边小圆角矩形 + 居中文字。
        for (id, rect) in actionRects {
            let label = bubbleActions.first(where: { $0.id == id })?.label ?? ""
            let path = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
            NSColor.labelColor.withAlphaComponent(0.10).setFill()
            path.fill()
            NSColor.labelColor.withAlphaComponent(0.28).setStroke()
            path.lineWidth = 1
            path.stroke()
            let style = NSMutableParagraphStyle()
            style.alignment = .center
            let buttonAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: NSColor.labelColor,
                .paragraphStyle: style,
            ]
            let textRect = NSRect(x: rect.minX, y: rect.midY - 8, width: rect.width, height: 16)
            (label as NSString).draw(in: textRect, withAttributes: buttonAttrs)
        }
    }

    override func mouseDown(with event: NSEvent) {
        if let app = NSWorkspace.shared.frontmostApplication {
            frontAtPress = (app.processIdentifier, app.localizedName ?? "")
        }
        pressOrigin = NSEvent.mouseLocation
        windowOriginAtPress = window?.frame.origin ?? .zero
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - pressOrigin.x
        let dy = now.y - pressOrigin.y
        if !dragging, abs(dx) + abs(dy) > 3 { dragging = true }
        guard dragging else { return }
        var origin = NSPoint(x: windowOriginAtPress.x + dx, y: windowOriginAtPress.y + dy)

        // 只夹「立绘」而不是整个窗口：
        //   - 立绘始终完整留在**光标所在那块屏幕**内 → 不会被拖丢，也贴得到边
        //   - 因为按光标所在屏判断，把光标挪到另一块屏就会跟着过去 → 跨屏仍正常
        let cursor = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(cursor) }) ?? window.screen ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            let iconInWindow = NSRect(
                x: (windowWidth - iconSize) / 2,
                y: 10,
                width: iconSize,
                height: iconSize
            )
            origin.x = min(
                max(origin.x, visible.minX - iconInWindow.minX),
                visible.maxX - iconInWindow.maxX
            )
            origin.y = min(
                max(origin.y, visible.minY - iconInWindow.minY),
                visible.maxY - iconInWindow.maxY
            )
        }
        // 气泡正在显示时，窗口也必须留在屏幕内——否则气泡会被裁掉一半。
        if bubbleHeight > 0, let visible = screen?.visibleFrame {
            let size = window.frame.size
            origin.x = min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - size.width))
            origin.y = min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - size.height))
        }
        window.setFrameOrigin(origin)
    }

    override func mouseUp(with event: NSEvent) {
        if dragging {
            dragging = false
            onDragEnd?(window?.frame.origin ?? .zero)
            return
        }
        let point = convert(event.locationInWindow, from: nil)
        // 动作按钮必须**先判**：之前先判「点在气泡里」→ 一律当打开记录，按钮永远点不到。
        if let action = actionRects.first(where: { $0.rect.contains(point) }) {
            // 采样率按钮展开成菜单：一档一个选项、当前档打勾，点哪档就是哪档（不是循环切换）。
            if action.id == "watch-interval" {
                showIntervalMenu(at: point)
            } else {
                onAction?(action.id)
            }
        } else if bubbleHeight > 0, bubbleRect.contains(point), bubbleRecordId != nil {
            onOpenBubble?(bubbleRecordId)
        } else if bubbleHeight > 0, bubbleRect.contains(point) {
            // 常驻气泡没有关联记录时，点气泡本身不做任何事（不要穿透成「看一眼」）。
        } else if segmentHeight > 0, segmentRect.contains(point) {
            // 段输出气泡纯展示，不响应点击（尤其不能穿透成「看一眼」）。
        } else if hitRect.contains(point) {
            // 按**实际绘制区域**命中，而不是 160×160 的方格：
            // 线稿等比缩放后左右有留白，用方格会认成「点在空气里也算」。
            handleIconClick(pid: frontAtPress?.pid, app: frontAtPress?.name)
        }
    }

    /// 单击 = 看一眼，双击 = 看一眼并提问。
    ///
    /// 单击必须延迟到「双击窗口」结束才触发：否则双击会先跑一次 look、再跑一次 ask，
    /// 屏幕上会连出两个气泡，还白花一次模型调用。
    private func handleIconClick(pid: pid_t?, app: String?) {
        let now = Date().timeIntervalSince1970
        if now - lastClickAt < 0.3 {
            // 第二次点击：取消排队中的单击，按双击处理。
            pendingSingleClick?.cancel()
            pendingSingleClick = nil
            lastClickAt = 0
            onAsk?()
            return
        }

        lastClickAt = now
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSingleClick = nil
            self?.onPress?(pid, app)
        }
        pendingSingleClick = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    override func rightMouseDown(with event: NSEvent) {
        onMenu?(event)
    }
}


extension Notification.Name {
    /// 全局热键按下：userInfo["action"] 为 look / ask。
    static let buddyHotkeyPressed = Notification.Name("BuddyHotkeyPressed")
}

// MARK: - 全局热键

/// 常见键的 Carbon 键码。只覆盖实际会用到的：功能键、字母、数字、少量命名键。
let keyCodes: [String: UInt32] = [
    // 功能键
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    // 字母（ANSI 键码，与键盘布局无关）
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    // 数字
    "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
    // 命名键
    "space": 49, "tab": 48, "escape": 53, "return": 36, "enter": 36,
]

/// 解析 `option+shift+L` / `F8` 这类描述，产出 Carbon 键码与修饰符。
func parseHotkeySpec(_ spec: String) -> (keyCode: UInt32, modifiers: UInt32)? {
    let parts = spec.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    guard let keyName = parts.last, let keyCode = keyCodes[keyName] else { return nil }
    var modifiers: UInt32 = 0
    for name in parts.dropLast() {
        switch name {
        case "command", "cmd": modifiers |= UInt32(cmdKey)
        case "option", "opt", "alt": modifiers |= UInt32(optionKey)
        case "control", "ctrl": modifiers |= UInt32(controlKey)
        case "shift": modifiers |= UInt32(shiftKey)
        default: return nil
        }
    }
    return (keyCode, modifiers)
}


// MARK: - 提问面板

/// 无边框窗口默认 `canBecomeKey = false`，拿不到键盘输入——这正是「面板出现但打不了字」的原因。
final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// 支持换行的输入面板。为什么自己做而不继续用 osascript：
/// `display dialog` 只能单行，长问题会横向滚动，看不清。
final class AskTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onCancel: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // ⌘↩ 发送，Esc 取消；其余交给正常输入（含回车换行）。
        if event.keyCode == 53 {
            onCancel?()
            return
        }
        if event.keyCode == 36 && event.modifierFlags.contains(.command) {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}

final class AskController: NSObject {
    private var window: NSPanel?
    private var textView: AskTextView?
    private var responsePath = ""
    private var requestId = ""
    /// 输入框字号（跟随配置）。
    var fontSize: CGFloat = bubbleFontSize

    var isOpen: Bool { window != nil }

    func present(id: String, prompt: String, responsePath: String, anchor: NSRect) {
        dismiss()
        requestId = id
        self.responsePath = responsePath

        // 无边框浮层：贴着人物上方出现，和气泡同一个位置逻辑。
        let width = max(320, anchor.width)
        let height: CGFloat = 190
        let panel = KeyPanel(
            contentRect: NSRect(x: anchor.midX - width / 2, y: anchor.maxY + 8, width: width, height: height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        // 要收键盘输入：这里必须能成为 key window。
        panel.becomesKeyOnlyIfNeeded = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        container.wantsLayer = true
        // 语义色会随浅色/深色外观自动切换，不要再硬编码黑底。
        container.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.97).cgColor
        container.layer?.cornerRadius = 12
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.18).cgColor

        let scroll = NSScrollView(frame: NSRect(x: 12, y: 48, width: width - 24, height: height - 60))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder

        let textView = AskTextView(frame: NSRect(x: 0, y: 0, width: width - 24, height: height - 60))
        textView.isRichText = false
        textView.drawsBackground = false
        textView.textColor = NSColor.textColor
        textView.insertionPointColor = NSColor.textColor
        textView.font = NSFont.systemFont(ofSize: fontSize)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainerInset = NSSize(width: 4, height: 6)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: width - 24, height: .greatestFiniteMagnitude)
        textView.onSubmit = { [weak self] in self?.finish(cancelled: false) }
        textView.onCancel = { [weak self] in self?.finish(cancelled: true) }
        scroll.documentView = textView

        let hint = NSTextField(labelWithString: "⌘↩ 发送 · Esc 取消 · 支持换行")
        hint.frame = NSRect(x: 14, y: 18, width: 240, height: 16)
        hint.font = NSFont.systemFont(ofSize: 10.5)
        hint.textColor = NSColor.secondaryLabelColor

        let send = NSButton(title: "发送", target: self, action: #selector(sendClicked))
        send.bezelStyle = .rounded
        send.frame = NSRect(x: width - 76, y: 10, width: 62, height: 26)

        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelClicked))
        cancel.bezelStyle = .rounded
        cancel.frame = NSRect(x: width - 146, y: 10, width: 62, height: 26)

        container.addSubview(scroll)
        container.addSubview(hint)
        container.addSubview(send)
        container.addSubview(cancel)
        panel.contentView = container

        var panelFrame = panel.frame
        clampToScreen(&panelFrame)
        panel.setFrame(panelFrame, display: false)

        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(textView)

        window = panel
        self.textView = textView
    }

    /// 跟随人物移动：把面板重新贴到底盘上方（拖人或窗口尺寸变化时调用）。
    func reposition(anchor: NSRect) {
        guard let window else { return }
        let width = max(320, anchor.width)
        var frame = window.frame
        // 以人物为中心水平居中，而不是从人物左边缘往右铺。
        frame.origin = NSPoint(x: anchor.midX - width / 2, y: anchor.maxY + 8)
        frame.size.width = width
        clampToScreen(&frame)
        window.setFrame(frame, display: true)
    }

    /// 面板整体留在屏幕可视区内：否则人物靠边时输入框会被切掉。
    private func clampToScreen(_ frame: inout NSRect) {
        let center = NSPoint(x: frame.midX, y: frame.midY)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(center) })
            ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        frame.origin.x = min(max(frame.origin.x, visible.minX), max(visible.minX, visible.maxX - frame.width))
        frame.origin.y = min(max(frame.origin.y, visible.minY), max(visible.minY, visible.maxY - frame.height))
    }

    @objc private func sendClicked() { finish(cancelled: false) }
    @objc private func cancelClicked() { finish(cancelled: true) }

    private func finish(cancelled: Bool) {
        let text = cancelled ? "" : (textView?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        let payload: [String: Any] = ["id": requestId, "text": text, "cancelled": cancelled]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            try? data.write(to: URL(fileURLWithPath: responsePath), options: .atomic)
        }
        dismiss()
    }

    private func dismiss() {
        window?.orderOut(nil)
        window?.close()
        window = nil
        textView = nil
    }
}

// MARK: - 应用

final class BuddyController: NSObject, NSApplicationDelegate {
    private let options = BuddyOptions.parse()
    /// 应用激活通知的观察者（准备阶段跟随活动窗口用）。
    private var appActivationObserver: NSObjectProtocol?
    private var window: NSWindow!
    private var view: BuddyView!
    private var timer: Timer?
    private var sayStamp: Date?
    private var hotkeyRefs: [EventHotKeyRef?] = []
    /// 注册结果：写进状态文件，插件侧能看出「热键到底成没成」。
    private var hotkeyReport: [String: String] = [:]
    private let askController = AskController()
    private var askStamp: Date?
    private var recenterStamp: Date?
    private var bubbleHideAt: Date?
    private var bubbleHideWorkItem: DispatchWorkItem?
    /// 最近一次处理 say 文件的时间（诊断：判断事件驱动是否真的在触发）。
    private var lastSayAt: Date?
    /// 命令目录的事件源（事件驱动，代替 250ms 轮询）。
    private var directorySource: DispatchSourceFileSystemObject?
    private var bubbleVisible = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // 应用激活监听：准备阶段（看一阵等「开始」）要跟随活动窗口。
        // 用系统通知而不是每秒起子进程查询：一次激活只发一条事件，空闲时零开销。
        appActivationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.processIdentifier == getpid() { return }
            self.appendPress(action: "front-changed", id: nil, frontPid: app?.processIdentifier, frontApp: app?.localizedName)
        }

        let image = options.asset.isEmpty ? nil : NSImage(contentsOfFile: options.asset)

        view = BuddyView(frame: NSRect(origin: .zero, size: NSSize(width: windowWidth, height: idleHeight)))
        view.image = image
        view.fontSize = CGFloat(max(10, min(24, options.fontSize)))
        if let image { view.computeContentBBox(image) }
        view.wantsLayer = true

        let panel = NSPanel(
            contentRect: NSRect(origin: restoreOrigin(), size: NSSize(width: windowWidth, height: idleHeight)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // 点浮窗不激活本进程：焦点必须留在用户正在用的那个应用上，
        // 否则「看一眼」会把我们自己的窗口当成目标（实测：退化成宠物所在屏幕的整屏截图）。
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        window = panel
        window.contentView = view
        window.isOpaque = false
        // 窗口本身保持全透明：macOS 按像素命中测试，只有「画了东西」的地方会接住点击，
        // 其余区域把事件透给下面的应用（这正是我们要的——立绘四周不该有死区）。
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isMovableByWindowBackground = false
        window.makeKeyAndOrderFront(nil)

        view.onPress = { [weak self] pid, name in
            self?.appendPress(action: "look", id: nil, frontPid: pid, frontApp: name)
        }
        view.onAction = { [weak self] id in
            self?.appendPress(action: id, id: nil)
        }
        view.onAsk = { [weak self] in
            self?.appendPress(action: "ask", id: nil)
        }
        view.onOpenBubble = { [weak self] id in
            self?.appendPress(action: "open", id: id)
        }
        view.onDragEnd = { [weak self] origin in
            self?.saveOrigin(origin)
        }
        view.onMenu = { [weak self] event in
            self?.showMenu(event)
        }
        // 把「上次运行留下的命令文件」标记成已读，见 primeStamps()。
        primeStamps()
        // 人物被拖动 / 窗口因气泡改变高度时，让提问面板跟着走。
        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                guard let self, let frame = self.window?.frame else { return }
                self.askController.reposition(anchor: frame)
            }
        }

        installGlobalHotkeys()
        // 启动即落一次位置：否则用户没拖过时，状态文件里没有真实坐标可查。
        saveOrigin(window.frame.origin)

        // 事件驱动，不再轮询：插件用「写临时文件 + rename」的方式落命令，
        // rename 会在目录上产生 write 事件，这里被唤醒后再去读文件。
        // 之前是 250ms 定时器（空闲也在跑），改掉是为了不拿 CPU 换一个「省事」。
        startWatchingCommands()

        // 兜底：事件偶尔会漏（网络盘、异常 rename），用一条低频定时器补，不做高频轮询。
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.pollSay()
            self.pollAskRequest()
            self.pollRecenter()
        }
        timer?.tolerance = 1.5
        RunLoop.main.add(timer!, forMode: .common)
    }

    /// 启动时把已存在的命令文件认成「已读」，避免重启后重放。
    ///
    /// 症状：每次重启，桌宠都会把上次「看一眼」的回复再念一遍。
    /// 原因：`sayStamp` 初值是 nil，第一次 poll 看到那个还是旧文件的
    /// `buddy.say.json`，按「mtime 更新了」处理，于是原样播一次。
    /// 提问请求和 recenter 同理（一个会弹出早就提交过的面板，一个会把人物
    /// 拽回默认位置）。这里只记 mtime，不执行任何动作。
    private func primeStamps() {
        func stamp(_ path: String) -> Date {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let date = attrs[.modificationDate] as? Date {
                return date
            }
            return Date()
        }
        sayStamp = stamp(options.sayPath)
        askStamp = stamp(options.askRequestPath)
        recenterStamp = stamp(options.recenterPath)
    }

    /// 监听命令目录：say / ask 请求 / recenter 都是「写临时文件再 rename」，
    /// rename 会在目录上产生 write 事件。事件驱动比定时器省，且延迟更低。
    private func startWatchingCommands() {
        let dir = (options.sayPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.pollSay()
            self.pollAskRequest()
            self.pollRecenter()
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        directorySource = source
    }

    // MARK: 全局热键

    /// 注册 Carbon 全局热键。为什么能成：本进程是真正的 AppKit 应用，有事件循环；
    /// 之前从 Node 宿主里注册「返回成功但收不到事件」，就是因为那边没有这个循环。
    private func installGlobalHotkeys() {
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_: EventHandlerCallRef?, event: EventRef?, _: UnsafeMutableRawPointer?) -> OSStatus in
                var hotkeyId = EventHotKeyID()
                let status = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotkeyId
                )
                guard status == noErr else { return status }
                // 1 = 看一眼，2 = 看一眼并提问
                let action = hotkeyId.id == 2 ? "ask" : (hotkeyId.id == 3 ? "collect" : "look")
                NotificationCenter.default.post(name: .buddyHotkeyPressed, object: nil, userInfo: ["action": action])
                return noErr
            },
            1,
            &spec,
            nil,
            nil
        )

        let bindings: [(id: UInt32, spec: String, label: String)] = [
            (1, options.hotkeyLook, "look"),
            (2, options.hotkeyAsk, "ask"),
            (3, options.hotkeyCollect, "collect"),
        ]
        for binding in bindings {
            guard let parsed = parseHotkeySpec(binding.spec) else {
                hotkeyReport[binding.label] = "解析失败：\(binding.spec)"
                continue
            }
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: OSType(0x4453_4842), id: binding.id)
            let status = RegisterEventHotKey(parsed.keyCode, parsed.modifiers, id, GetApplicationEventTarget(), 0, &ref)
            if status == noErr, ref != nil {
                hotkeyRefs.append(ref)
                hotkeyReport[binding.label] = "ok：\(binding.spec)"
            } else {
                hotkeyReport[binding.label] = "注册失败（\(status)）：\(binding.spec)"
            }
        }

        NotificationCenter.default.addObserver(forName: .buddyHotkeyPressed, object: nil, queue: .main) { [weak self] note in
            let action = (note.userInfo?["action"] as? String) ?? "look"
            self?.appendPress(action: action, id: nil)
        }
        saveOrigin(window.frame.origin)
    }

    // MARK: 位置

    private func restoreOrigin() -> NSPoint {
        if let data = FileManager.default.contents(atPath: options.statePath),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
           let x = object["x"], let y = object["y"] {
            return NSPoint(x: x, y: y)
        }
        return defaultOrigin()
    }

    /// 默认位置：主屏右下角（避开菜单栏与 Dock）。
    private func defaultOrigin() -> NSPoint {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: screen.maxX - windowWidth - 24, y: screen.minY + 40)
    }

    private func saveOrigin(_ origin: NSPoint) {
        // 顺带记下尺寸：调试命中区域时，光有原点算不出立绘在哪。
        var payload: [String: Any] = [
            "x": origin.x,
            "y": origin.y,
            "w": Double(window?.frame.width ?? 0),
            "h": Double(window?.frame.height ?? 0),
        ]
        if !hotkeyReport.isEmpty { payload["hotkeys"] = hotkeyReport }
        if let lastSay = lastSayAt { payload["lastSayAt"] = Int(lastSay.timeIntervalSince1970 * 1000) }
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            try? data.write(to: URL(fileURLWithPath: options.statePath), options: .atomic)
        }
    }

    // MARK: 事件

    private func appendPress(action: String, id: String?, frontPid: pid_t? = nil, frontApp: String? = nil) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        var json = "{\"action\":\"\(action)\",\"at\":\(now)"
        if let id, !id.isEmpty {
            json += ",\"id\":\"\(id.replacingOccurrences(of: "\"", with: ""))\""
        }
        // 诊断用：如果「看一眼」抓到的是我们自己的窗口，看这两个字段就知道焦点什么时候丢的。
        if let frontPid { json += ",\"frontPid\":\(frontPid)" }
        if let frontApp, !frontApp.isEmpty { json += ",\"frontApp\":\"\(frontApp)\"" }
        json += "}\n"
        let path = options.pressPath
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(json.data(using: .utf8) ?? Data())
            try? handle.close()
        }
    }

    private func showMenu(_ event: NSEvent) {
        // 菜单分成两栏：
        //   上半栏 = 这一次的「看」：看一眼 / 提问 / 看几眼 / 看一阵
        //   下半栏 = 记录与插件本身：陪伴记录 / 隐藏 / 退出
        let menu = NSMenu()
        menu.addItem(withTitle: "看一眼", action: #selector(menuLook), keyEquivalent: "").target = self
        menu.addItem(withTitle: "看一眼并提问", action: #selector(menuAsk), keyEquivalent: "").target = self
        menu.addItem(withTitle: "看几眼", action: #selector(menuCollect), keyEquivalent: "").target = self
        menu.addItem(withTitle: "看一阵", action: #selector(menuWatch), keyEquivalent: "").target = self
        menu.addItem(withTitle: "记下这一帧", action: #selector(menuWatchShot), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "陪伴记录", action: #selector(menuOpenPanel), keyEquivalent: "").target = self
        menu.addItem(withTitle: "隐藏", action: #selector(menuHide), keyEquivalent: "").target = self
        menu.addItem(withTitle: "退出桌宠", action: #selector(menuQuit), keyEquivalent: "").target = self
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    @objc private func menuLook() { appendPress(action: "look", id: nil) }
    @objc private func menuAsk() { appendPress(action: "ask", id: nil) }
    @objc private func menuCollect() { appendPress(action: "collect", id: nil) }
    @objc private func menuWatch() { appendPress(action: "watch-toggle", id: nil) }
    @objc private func menuOpenPanel() { appendPress(action: "panel", id: nil) }
    @objc private func menuWatchShot() { appendPress(action: "watch-shot", id: nil) }

    @objc private func menuHide() {
        // 先告诉宿主「用户主动隐藏了」，让它把可见性存下来（重启后仍然隐藏）。
        appendPress(action: "hide-pet", id: nil)
        window.orderOut(nil)
    }
    @objc private func menuQuit() { NSApp.terminate(nil) }

    // MARK: 气泡

    private func pollSay() {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: options.sayPath),
              let stamp = attrs[.modificationDate] as? Date else { return }
        if let last = sayStamp, stamp <= last { return }
        sayStamp = stamp

        guard let data = FileManager.default.contents(atPath: options.sayPath),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        lastSayAt = Date()
        // 人物显隐：设置页「显示桌宠」开关与隐藏后的恢复都走这条。
        // 隐藏用 orderOut（窗口还在、热键还在），显示用 orderFront（不抢焦点）。
        if (object["hidePet"] as? Bool) == true {
            window.orderOut(nil)
            return
        }
        if (object["show"] as? Bool) == true {
            window.orderFront(nil)
            view.needsDisplay = true
            saveOrigin(window.frame.origin)
            return
        }
        // 主动收起：常驻气泡里的「知道了」按钮走这条，不然它会一直挂在人物头顶。
        if (object["hide"] as? Bool) == true {
            view.segmentText = ""
            view.segmentHeight = 0
            hideBubbleNow()
            return
        }
        let text = String(object["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        // 兜底截断：模型偶尔无视长度限制，气泡会一路长到屏幕外。
        // 超长时只显示前 N 字，完整内容仍在陪伴记录里。
        let limit = max(80, min(2000, options.maxBubbleChars))
        let shown = text.count > limit ? String(text.prefix(limit)) + "…" : text
        view.bubbleText = shown
        view.bubbleCompact = (object["compact"] as? Bool) ?? false
        view.bubbleBold = (object["bold"] as? Bool) ?? false
        view.bubbleSticky = (object["sticky"] as? Bool) ?? false
        view.bubbleActions = (object["actions"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let label = item["label"] as? String else { return nil }
            return (id, label)
        }
        // 紧凑气泡：高度 = 尾巴 + 单行文字 + 上下留白（之前写死 34，扣掉尾巴后文字被裁）
        // 只有「紧凑单行且没有按钮」才用固定高度。带按钮的常驻气泡文案通常较长，
        // 继续按一行算会让文字压到按钮上（用户实测的重叠）。
        let baseHeight = (view.bubbleCompact && view.bubbleActions.isEmpty)
            ? bubbleTail + view.lineHeight + 14
            : measureBubbleHeight(text)
        // 有动作按钮时给底部留出一行。
        view.bubbleHeight = baseHeight + CGFloat(view.actionRows) * 34
        // 段输出气泡：宿主只在「展开」时才给 top 字段。
        let topText = String(object["top"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        view.segmentText = topText
        view.segmentHeight = topText.isEmpty ? 0 : min(measureBubbleHeight(topText), 200)
        let id = object["id"] as? String
        view.bubbleRecordId = (id?.isEmpty ?? true) ? nil : id
        bubbleVisible = true
        // 气泡停留时长随文字长度增加，长句给更多阅读时间。
        bubbleHideWorkItem?.cancel()
        if view.bubbleSticky {
            bubbleHideAt = nil   // 常驻：由调用方通过新气泡或隐藏来结束
        } else {
            // 短确认（「已取消」「这一阵丢弃了」）由宿主指定停留时间：
            // 一句话的确认不该在屏幕上挂 6 秒以上。
            let requested = (object["ttlMs"] as? Double) ?? 0
            let seconds = requested > 0 ? max(0.8, min(30.0, requested / 1000.0)) : min(22.0, max(6.0, Double(text.count) / 14.0 + 5.0))
            bubbleHideAt = Date().addingTimeInterval(seconds)
            // 一次性定时器：到点才醒，不需要常态轮询。
            let work = DispatchWorkItem { [weak self] in self?.hideBubbleNow() }
            bubbleHideWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        }
        resizeWindowForBubble()
        // 只显示、不抢焦点：`makeKeyAndOrderFront` 会把我们的 app 激活成前台，
        // 于是紧接着的「看一眼」会把桌宠自己（或上一个应用）当成目标（实测过）。
        // 气泡不需要键盘输入，用 orderFront 即可。
        window.orderFront(nil)
        view.needsDisplay = true
        saveOrigin(window.frame.origin)
    }

    /// 按文字实测高度（宽度固定，换行后算多高）。
    private func measureBubbleHeight(_ text: String) -> CGFloat {
        let width = windowWidth - 16 - bubbleInset.width * 2
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: view.fontSize),
            .paragraphStyle: style,
        ]
        let bounds = (text as NSString).boundingRect(
            with: NSSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attrs
        )
        // 上下留白 + 尾巴 + 一点余量
        return ceil(bounds.height) + bubbleInset.height * 2 + bubbleTail + 6
    }

    /// 窗口向上长高（保持底边不动，立绘就不会跳）。
    private func resizeWindowForBubble() {
        guard let window else { return }
        let segmentExtra = view.segmentHeight > 0 ? view.segmentHeight + 8 : 0
        let height = view.bubbleHeight > 0
            ? max(idleHeight, iconRect.maxY + bubbleGap + view.bubbleHeight + segmentExtra + 4)
            : idleHeight
        var frame = window.frame
        if abs(frame.height - height) < 0.5 { return }
        frame.size.height = height
        // 只在「气泡可能被屏幕切掉」时把窗口挪进来：
        // 拖动过程完全不限制，所以跨屏和贴边都正常；代价是人贴边时出气泡会被轻推一下。
        if let screen = (window.screen ?? NSScreen.main)?.visibleFrame {
            if frame.maxY > screen.maxY {
                frame.origin.y = max(screen.minY, screen.maxY - frame.height)
            }
            frame.origin.x = min(max(frame.origin.x, screen.minX), max(screen.minX, screen.maxX - frame.width))
        }
        window.setFrame(frame, display: true)
        // 视图必须跟着窗口一起变大，否则气泡那部分区域收不到鼠标事件（拖不动）。
        view.frame = NSRect(origin: .zero, size: frame.size)
        window.contentView?.needsLayout = true
        view.needsDisplay = true
    }

    /// 轮询「重置位置」请求：插件（设置页按钮）写入后，人物回到主屏右下角的默认位置。
    private func pollRecenter() {
        let path = options.recenterPath
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let stamp = attrs[.modificationDate] as? Date else { return }
        if let last = recenterStamp, stamp <= last { return }
        recenterStamp = stamp
        guard let window else { return }
        let origin = defaultOrigin()
        window.setFrameOrigin(origin)
        saveOrigin(origin)
    }

    /// 轮询「提问请求」文件：插件写入 {id,prompt}，这里弹面板，提交后写回响应。
    private func pollAskRequest() {
        let path = options.askRequestPath
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let stamp = attrs[.modificationDate] as? Date else { return }
        if let last = askStamp, stamp <= last { return }
        askStamp = stamp
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String, !id.isEmpty else { return }
        let prompt = (object["prompt"] as? String) ?? "问点什么？"
        // 贴着人物上方弹出：和气泡同一套位置逻辑。
        let anchor = window?.frame ?? NSRect(x: 200, y: 200, width: 260, height: 160)
        askController.fontSize = CGFloat(max(10, min(24, options.fontSize)))
        askController.present(id: id, prompt: prompt, responsePath: options.askResponsePath, anchor: anchor)
    }

    /// 到点隐藏气泡（由一次性定时器调用，不再靠轮询判断时间）。
    private func hideBubbleNow() {
        guard bubbleVisible else { return }
        bubbleVisible = false
        bubbleHideAt = nil
        view.bubbleText = ""
        view.bubbleHeight = 0
        view.bubbleRecordId = nil
        resizeWindowForBubble()
        view.needsDisplay = true
    }
}

// 单实例：插件重挂时旧进程可能还没退，两个立绘会一起出现。
// 用 flock 而不是 pid 文件——进程崩掉时内核会自动释放锁，不会留下「假占用」。
func acquireSingleInstanceLock(path: String) -> Bool {
    let fd = open(path, O_CREAT | O_RDWR, 0o644)
    if fd < 0 { return true } // 锁文件建不了就别拦着自己启动
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        print("another buddy instance is running")
        return false
    }
    // 不关闭 fd：进程活着锁就在。
    return true
}

if !acquireSingleInstanceLock(path: BuddyOptions.parse().lockPath) {
    exit(0)
}

let app = NSApplication.shared
let controller = BuddyController()
app.delegate = controller
app.run()
