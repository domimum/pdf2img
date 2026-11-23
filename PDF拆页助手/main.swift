import AppKit
import PDFKit
import Foundation

// ============================================================
//  PDF 拆页助手 —— 先勾选需要的页，再统一保存为图片到桌面
//  纯 macOS 原生 (AppKit + PDFKit)，零第三方依赖
// ============================================================

// MARK: - App 入口
class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 940, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        win.center()
        win.title = "PDF 拆页助手"
        win.minSize = NSSize(width: 720, height: 460)
        win.contentViewController = MainViewController()
        self.window = win
        // 轻量工具，置顶显示，切换其他软件对照时也能随时点到
        win.level = .floating
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // 支持：把 PDF 拖到 Dock 图标 / 双击 PDF / open -a 打开
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        let url = URL(fileURLWithPath: filename)
        guard url.pathExtension.lowercased() == "pdf",
              let vc = window?.contentViewController as? MainViewController else { return false }
        vc.openPDF(url: url)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }
}

// 传统入口：手动创建 app、设置 delegate、运行主循环
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

// MARK: - 翻转坐标系的视图（子视图从左上角排布）
class FlippedView: NSView {
    override var isFlipped: Bool { return true }
}

// MARK: - 空状态渐变徽章（蓝紫渐变圆 + 白色文档图标）
class EmptyBadgeView: NSView {
    override func draw(_ rect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        // 渐变圆底
        let colors = [
            NSColor(calibratedRed: 0.42, green: 0.58, blue: 1.0, alpha: 1).cgColor,
            NSColor(calibratedRed: 0.19, green: 0.33, blue: 0.92, alpha: 1).cgColor
        ] as CFArray
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            ctx.saveGState()
            ctx.addEllipse(in: rect.insetBy(dx: 1, dy: 1))
            ctx.clip()
            ctx.drawLinearGradient(grad,
                                   start: CGPoint(x: rect.minX, y: rect.maxY),
                                   end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
            ctx.restoreGState()
        }
        // 白色文档图标（右上角折角）
        let cx = rect.midX, cy = rect.midY
        let docW = rect.width * 0.34, docH = rect.height * 0.42
        let dx = cx - docW / 2, dy = cy - docH / 2
        let fold = docW * 0.26
        NSColor.white.setFill()
        let body = NSBezierPath()
        body.move(to: NSPoint(x: dx, y: dy))
        body.line(to: NSPoint(x: dx + docW, y: dy))
        body.line(to: NSPoint(x: dx + docW, y: dy + docH - fold))
        body.line(to: NSPoint(x: dx + docW - fold, y: dy + docH))
        body.line(to: NSPoint(x: dx, y: dy + docH))
        body.close()
        body.fill()
        // 折角（浅灰蓝）
        NSColor(calibratedWhite: 0.80, alpha: 1).setFill()
        let f = NSBezierPath()
        f.move(to: NSPoint(x: dx + docW, y: dy + docH - fold))
        f.line(to: NSPoint(x: dx + docW - fold, y: dy + docH - fold))
        f.line(to: NSPoint(x: dx + docW - fold, y: dy + docH))
        f.close()
        f.fill()
        // 三条横线
        NSColor(calibratedRed: 0.25, green: 0.40, blue: 0.88, alpha: 1).setStroke()
        for i in 0..<3 {
            let ly = dy + docH * (0.64 - CGFloat(i) * 0.17)
            let lp = NSBezierPath()
            lp.lineWidth = 2
            lp.move(to: NSPoint(x: dx + docW * 0.18, y: ly))
            lp.line(to: NSPoint(x: dx + docW * 0.76, y: ly))
            lp.stroke()
        }
    }
}

// MARK: - 支持拖拽的根视图
class DropView: NSView {
    weak var controller: MainViewController?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        return hasPDF(sender) ? .copy : []
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return hasPDF(sender) ? .copy : []
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let url = firstPDF(from: sender) else { return false }
        controller?.openPDF(url: url)
        return true
    }

    private func hasPDF(_ s: NSDraggingInfo) -> Bool { firstPDF(from: s) != nil }
    private func firstPDF(from s: NSDraggingInfo) -> URL? {
        guard let objects = s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] else { return nil }
        return objects.first { $0.pathExtension.lowercased() == "pdf" }
    }
}

// MARK: - 大图预览窗口
class PreviewWindow: NSWindow {
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {   // ESC 关闭
            self.close()
        } else {
            super.keyDown(with: event)
        }
    }
}

class PreviewWindowController: NSWindowController {
    init(page: PDFPage, pageNumber: Int, docName: String) {
        let b = page.bounds(for: .mediaBox)
        let ratio = b.width / max(1, b.height)

        // 高清渲染（按屏幕高度的约 2.2 倍像素，Retina 下清晰）
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let renderH = max(1200, screen.height * 2.2)
        let renderW = renderH * ratio
        let bigImg = page.thumbnail(of: NSSize(width: renderW, height: renderH), for: .mediaBox)

        // 窗口显示尺寸：不超过屏幕的 82% 宽 / 88% 高
        let maxW = screen.width * 0.82
        let maxH = screen.height * 0.88
        var dispW = min(maxW, maxH * ratio)
        var dispH = dispW / ratio
        if dispH > maxH { dispH = maxH; dispW = dispH * ratio }

        // 图片区高度 = 窗口内容高度 - 标题留白(用内容区直接放图，不加额外视图)
        let win = PreviewWindow(
            contentRect: NSRect(x: 0, y: 0, width: dispW, height: dispH),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        win.title = "\(docName) · 第 \(pageNumber) 页（ESC 关闭）"
        win.minSize = NSSize(width: 320, height: 400)
        win.level = .floating

        let imageView = NSImageView(frame: NSRect(x: 0, y: 0, width: dispW, height: dispH))
        imageView.image = bigImg
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.autoresizingMask = [.width, .height]
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        win.contentView = imageView
        win.center()

        super.init(window: win)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

// MARK: - 单页卡片
class PageCard: NSView {
    let pageIndex: Int          // 0 基
    let page: PDFPage
    weak var owner: MainViewController?
    let imageView = NSImageView()
    let pageLabel = NSTextField(labelWithString: "")

    // 左上角：选中序号角标（蓝色圆）
    let selectBadge = NSTextField(labelWithString: "")
    // 右上角：已保存对勾（绿色圆）
    let savedBadge = NSTextField(labelWithString: "✓")

    var selected = false
    var saved = false

    init(index: Int, page: PDFPage, owner: MainViewController) {
        self.pageIndex = index
        self.page = page
        self.owner = owner
        super.init(frame: .zero)

        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = 1.5
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.isEditable = false
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.white.cgColor
        addSubview(imageView)

        pageLabel.stringValue = "第 \(index + 1) 页"
        pageLabel.alignment = .center
        pageLabel.font = .systemFont(ofSize: 12, weight: .medium)
        pageLabel.textColor = .labelColor
        addSubview(pageLabel)

        selectBadge.alignment = .center
        selectBadge.font = .systemFont(ofSize: 12, weight: .bold)
        selectBadge.textColor = .white
        selectBadge.wantsLayer = true
        selectBadge.layer?.cornerRadius = 11
        selectBadge.layer?.backgroundColor = NSColor.systemBlue.cgColor
        selectBadge.isHidden = true
        addSubview(selectBadge)

        savedBadge.stringValue = "✓"
        savedBadge.alignment = .center
        savedBadge.font = .systemFont(ofSize: 13, weight: .bold)
        savedBadge.textColor = .white
        savedBadge.wantsLayer = true
        savedBadge.layer?.cornerRadius = 11
        savedBadge.layer?.backgroundColor = NSColor.systemGreen.cgColor
        savedBadge.isHidden = true
        addSubview(savedBadge)

        toolTip = "单击选中/取消 · 双击放大查看"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // 单击=选中/取消，双击=放大（用 clickCount 精确区分，避免手势冲突）
    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            owner?.zoomPage(self)
        } else {
            owner?.toggleSelect(self)
        }
    }

    func setThumbnail(_ img: NSImage) { imageView.image = img }

    // 设置选中状态；order 为选中序号（从 1 开始），取消时传 0
    func setSelected(_ isSelected: Bool, order: Int) {
        selected = isSelected
        if isSelected {
            selectBadge.stringValue = "\(order)"
            selectBadge.isHidden = false
            layer?.borderColor = NSColor.systemBlue.cgColor
            layer?.borderWidth = 2.5
            layer?.backgroundColor = NSColor(red: 0.90, green: 0.95, blue: 1.0, alpha: 1.0).cgColor
        } else {
            selectBadge.isHidden = true
            layer?.borderWidth = 1.5
            layer?.borderColor = saved ? NSColor.systemGreen.cgColor : NSColor.separatorColor.cgColor
            layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        }
    }

    func markSaved() {
        saved = true
        savedBadge.isHidden = false
        if !selected { layer?.borderColor = NSColor.systemGreen.cgColor }
    }
    func markFailed() {
        let prev = layer?.borderColor
        layer?.borderColor = NSColor.systemRed.cgColor
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self = self else { return }
            self.layer?.borderColor = self.selected
                ? NSColor.systemBlue.cgColor
                : (self.saved ? NSColor.systemGreen.cgColor : (prev ?? NSColor.separatorColor.cgColor))
        }
    }

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        imageView.frame = NSRect(x: 8, y: 30, width: w - 16, height: h - 40)
        pageLabel.frame = NSRect(x: 4, y: 6, width: w - 8, height: 18)
        selectBadge.frame = NSRect(x: 8, y: h - 30, width: 22, height: 22)
        savedBadge.frame = NSRect(x: w - 30, y: h - 30, width: 22, height: 22)
    }
}

// MARK: - 主控制器
class MainViewController: NSViewController {
    private var doc: PDFDocument?
    private var baseName = "PDF"
    private var cards: [PageCard] = []

    // 按点击顺序记录被选中的卡片
    private var selectedCards: [PageCard] = []
    // 大图预览窗口（每页一个）
    private var previewControllers: [PreviewWindowController] = []

    private let dropView = DropView()
    private let topBar = NSView()
    private let scroll = NSScrollView()
    private let grid = FlippedView()
    private let statusLabel = NSTextField(labelWithString: "")

    // 空白引导提示（未打开 PDF 时显示）
    private let hintView = NSView()
    private let hintBadge = EmptyBadgeView()
    private let hintTitle = NSTextField(labelWithString: "")
    private let hintSubtitle = NSTextField(labelWithString: "")
    private let hintOpenBtn = NSButton(title: "打开 PDF 文件", target: nil, action: nil)
    private let hintSteps = NSView()
    private var sourcePDFURL: URL?   // 导出矢量 PDF 时用原始文件重新读取

    private let openBtn = NSButton(title: "打开 PDF", target: nil, action: nil)
    private let dpiPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let fmtPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clearBtn = NSButton(title: "清空选择", target: nil, action: nil)
    private let saveSelBtn = NSButton(title: "存选中 (0)", target: nil, action: nil)
    private let dpiHint = NSTextField(labelWithString: "清晰度")
    private let fmtHint = NSTextField(labelWithString: "格式")

    private var dpi: CGFloat = 150      // 默认 150 DPI
    private let lastPDFKey = "PDFHelperLastPDFPath"   // 记住上次打开的 PDF

    private let cardW: CGFloat = 168
    private let cardH: CGFloat = 236
    private let gap: CGFloat = 16
    private let margin: CGFloat = 20

    override func loadView() { view = dropView }

    override func viewDidLoad() {
        super.viewDidLoad()
        dropView.controller = self

        // 顶部工具条
        topBar.wantsLayer = true
        topBar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        view.addSubview(topBar)

        openBtn.bezelStyle = .rounded
        openBtn.target = self
        openBtn.action = #selector(choosePDF)
        topBar.addSubview(openBtn)

        dpiHint.font = .systemFont(ofSize: 12)
        dpiHint.textColor = .secondaryLabelColor
        topBar.addSubview(dpiHint)

        dpiPopup.addItems(withTitles: ["普通 (150)", "高清 (300)", "打印 (450)"])
        dpiPopup.selectItem(at: 0)
        dpiPopup.target = self
        dpiPopup.action = #selector(dpiChanged)
        topBar.addSubview(dpiPopup)

        fmtHint.font = .systemFont(ofSize: 12)
        fmtHint.textColor = .secondaryLabelColor
        topBar.addSubview(fmtHint)

        fmtPopup.addItems(withTitles: ["PNG", "JPG", "PDF"])
        fmtPopup.selectItem(at: 0)
        fmtPopup.target = self
        fmtPopup.action = #selector(fmtChanged)
        topBar.addSubview(fmtPopup)

        clearBtn.bezelStyle = .rounded
        clearBtn.target = self
        clearBtn.action = #selector(clearSelection)
        topBar.addSubview(clearBtn)

        saveSelBtn.bezelStyle = .rounded
        saveSelBtn.target = self
        saveSelBtn.action = #selector(saveSelected)
        saveSelBtn.isEnabled = false
        topBar.addSubview(saveSelBtn)

        // 滚动区
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.documentView = grid
        view.addSubview(scroll)

        // ===== 空白引导提示（美观版） =====
        hintBadge.wantsLayer = true
        hintBadge.layer?.cornerRadius = 40        // 圆形
        hintBadge.layer?.shadowColor = NSColor(calibratedRed: 0.2, green: 0.35, blue: 0.9, alpha: 0.32).cgColor
        hintBadge.layer?.shadowOpacity = 1
        hintBadge.layer?.shadowRadius = 18
        hintBadge.layer?.shadowOffset = NSSize(width: 0, height: 8)
        hintView.addSubview(hintBadge)

        hintTitle.stringValue = "把 PDF 拖到这里"
        hintTitle.alignment = .center
        hintTitle.font = .systemFont(ofSize: 22, weight: .semibold)
        hintTitle.textColor = .labelColor
        hintView.addSubview(hintTitle)

        hintSubtitle.stringValue = "或点击下方按钮选择文件，然后勾选想要的页面"
        hintSubtitle.alignment = .center
        hintSubtitle.font = .systemFont(ofSize: 13)
        hintSubtitle.textColor = .secondaryLabelColor
        hintView.addSubview(hintSubtitle)

        hintOpenBtn.bezelStyle = .rounded
        hintOpenBtn.target = self
        hintOpenBtn.action = #selector(choosePDF)
        hintOpenBtn.font = .systemFont(ofSize: 14, weight: .medium)
        if #available(macOS 11.0, *) { hintOpenBtn.contentTintColor = .controlAccentColor }
        hintView.addSubview(hintOpenBtn)

        // 三个步骤提示（彩色圆点编号 + 说明）
        let steps: [(String, String, NSColor)] = [
            ("1", "单击勾选", NSColor(calibratedRed: 0.23, green: 0.38, blue: 0.94, alpha: 1)),
            ("2", "双击放大", NSColor(calibratedRed: 0.55, green: 0.35, blue: 0.95, alpha: 1)),
            ("3", "存到桌面", NSColor(calibratedRed: 0.0, green: 0.68, blue: 0.45, alpha: 1))
        ]
        for (num, text, color) in steps {
            let pill = NSView()
            pill.wantsLayer = true
            pill.layer?.backgroundColor = NSColor(calibratedWhite: 0.5, alpha: 0.09).cgColor
            pill.layer?.cornerRadius = 13
            let dot = NSTextField(labelWithString: num)
            dot.alignment = .center
            dot.font = .boldSystemFont(ofSize: 11)
            dot.textColor = .white
            dot.wantsLayer = true
            dot.layer?.cornerRadius = 9
            dot.layer?.backgroundColor = color.cgColor
            pill.addSubview(dot)
            let label = NSTextField(labelWithString: text)
            label.font = .systemFont(ofSize: 12)
            label.textColor = .secondaryLabelColor
            pill.addSubview(label)
            hintSteps.addSubview(pill)
        }
        hintView.addSubview(hintSteps)
        view.addSubview(hintView)

        // 底部状态
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.textColor = .secondaryLabelColor
        view.addSubview(statusLabel)

        setStatus("就绪 · 请打开 PDF")
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        let w = view.bounds.width, h = view.bounds.height
        let barH: CGFloat = 56, statusH: CGFloat = 30

        topBar.frame = NSRect(x: 0, y: h - barH, width: w, height: barH)
        let midY = (barH - 30) / 2
        // 左侧：打开 PDF / 清晰度 / 格式
        openBtn.frame = NSRect(x: 16, y: midY, width: 104, height: 30)
        dpiHint.frame = NSRect(x: 132, y: midY + 7, width: 50, height: 18)
        dpiPopup.frame = NSRect(x: 186, y: midY, width: 116, height: 26)
        fmtHint.frame = NSRect(x: 316, y: midY + 7, width: 34, height: 18)
        fmtPopup.frame = NSRect(x: 354, y: midY, width: 78, height: 26)
        // 右侧：存选中 / 清空选择（从右边缘往左排，固定间距，避免重叠）
        let rightMargin: CGFloat = 16
        let saveW: CGFloat = 128, clearW: CGFloat = 92, btnGap: CGFloat = 12
        saveSelBtn.frame = NSRect(x: w - rightMargin - saveW, y: midY, width: saveW, height: 30)
        clearBtn.frame = NSRect(x: w - rightMargin - saveW - btnGap - clearW, y: midY, width: clearW, height: 30)

        scroll.frame = NSRect(x: 0, y: statusH, width: w, height: h - barH - statusH)
        statusLabel.frame = NSRect(x: 16, y: 6, width: w - 32, height: 20)

        // 提示居中于滚动区
        let hw: CGFloat = min(480, w - 40)
        let hh: CGFloat = 330
        let hx = (w - hw) / 2
        let hy = statusH + (scroll.frame.height - hh) / 2
        hintView.frame = NSRect(x: hx, y: hy, width: hw, height: hh)
        // 徽章
        let badgeSize: CGFloat = 84
        hintBadge.frame = NSRect(x: (hw - badgeSize) / 2, y: hh - 104, width: badgeSize, height: badgeSize)
        // 标题 / 副标题
        hintTitle.frame = NSRect(x: 0, y: hh - 152, width: hw, height: 30)
        hintSubtitle.frame = NSRect(x: 0, y: hh - 178, width: hw, height: 22)
        // 打开按钮
        hintOpenBtn.frame = NSRect(x: (hw - 168) / 2, y: hh - 234, width: 168, height: 40)
        // 三个步骤 pill（横排居中）
        let pillW: CGFloat = 108, pillH: CGFloat = 28, pillGap: CGFloat = 12
        let stepsW = pillW * 3 + pillGap * 2
        let startX = (hw - stepsW) / 2
        for (i, pill) in hintSteps.subviews.enumerated() {
            pill.frame = NSRect(x: startX + CGFloat(i) * (pillW + pillGap), y: hh - 292, width: pillW, height: pillH)
            // 数字圆圈：在 pill 内垂直居中
            let dotSide: CGFloat = 18
            let dotY = (pillH - dotSide) / 2
            if let dot = pill.subviews[0] as? NSTextField { dot.frame = NSRect(x: 10, y: dotY, width: dotSide, height: dotSide) }
            // 文字：高度撑满 pill，靠 NSTextField 自身垂直居中，y 不偏移
            if let label = pill.subviews[1] as? NSTextField {
                label.frame = NSRect(x: 34, y: 0, width: pillW - 40, height: pillH)
            }
        }
        hintSteps.frame = NSRect(x: 0, y: 0, width: hw, height: hh)

        layoutGrid()
    }

    private func layoutGrid() {
        let availW = scroll.bounds.width
        let cols = max(1, Int((availW - margin * 2 + gap) / (cardW + gap)))
        for (i, card) in cards.enumerated() {
            let r = i / cols, c = i % cols
            let x = margin + CGFloat(c) * (cardW + gap)
            let y = margin + CGFloat(r) * (cardH + gap)   // grid 为 flipped
            card.frame = NSRect(x: x, y: y, width: cardW, height: cardH)
        }
        let rows = cards.isEmpty ? 0 : (cards.count + cols - 1) / cols
        let contentH = margin * 2 + CGFloat(rows) * (cardH + gap) + 4
        grid.frame = NSRect(x: 0, y: 0, width: availW, height: max(contentH, scroll.bounds.height))
    }

    // MARK: 打开 PDF
    @objc private func choosePDF() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedFileTypes = ["pdf"]
        panel.message = "选择一个 PDF 文件"
        // 默认定位到上次打开 PDF 所在目录
        if let last = UserDefaults.standard.string(forKey: lastPDFKey), !last.isEmpty {
            let lastURL = URL(fileURLWithPath: last)
            if FileManager.default.fileExists(atPath: lastURL.deletingLastPathComponent().path) {
                panel.directoryURL = lastURL.deletingLastPathComponent()
                panel.nameFieldStringValue = lastURL.lastPathComponent
            }
        }
        panel.begin { [weak self] result in
            if result == .OK, let url = panel.url { self?.openPDF(url: url) }
        }
    }

    func openPDF(url: URL) {
        guard let d = PDFDocument(url: url) else {
            setStatus("无法打开该文件，请确认是有效的 PDF")
            return
        }
        // 记住这次打开的路径（拖拽 / 双击 / 对话框 三条路径统一记录）
        UserDefaults.standard.set(url.path, forKey: lastPDFKey)
        hintView.isHidden = true
        sourcePDFURL = url
        doc = d
        baseName = url.deletingPathExtension().lastPathComponent
        view.window?.title = "\(url.lastPathComponent) · \(d.pageCount) 页"

        for pc in previewControllers { pc.close() }
        previewControllers.removeAll()
        for c in cards { c.removeFromSuperview() }
        cards.removeAll()
        selectedCards.removeAll()
        updateSaveButton()

        let total = d.pageCount
        for i in 0..<total {
            guard let page = d.page(at: i) else { continue }
            let card = PageCard(index: i, page: page, owner: self)
            grid.addSubview(card)
            cards.append(card)
            renderThumbnail(for: card)
        }
        layoutGrid()
        setStatus("已载入 \(total) 页 · 点页面勾选要保存的页，再点「存选中」")
    }

    private func renderThumbnail(for card: PageCard) {
        DispatchQueue.global(qos: .userInitiated).async { [weak card] in
            guard let card = card else { return }
            let b = card.page.bounds(for: .mediaBox)
            let h: CGFloat = 320
            let w = max(1, h * b.width / max(1, b.height))
            let img = card.page.thumbnail(of: NSSize(width: w, height: h), for: .mediaBox)
            DispatchQueue.main.async { card.setThumbnail(img) }
        }
    }

    // MARK: 选中 / 取消
    func toggleSelect(_ card: PageCard) {
        if let idx = selectedCards.firstIndex(where: { $0 === card }) {
            // 取消选中
            selectedCards.remove(at: idx)
            card.setSelected(false, order: 0)
            // 后面卡的序号前移
            for (i, c) in selectedCards.enumerated() { c.setSelected(true, order: i + 1) }
        } else {
            // 选中
            selectedCards.append(card)
            card.setSelected(true, order: selectedCards.count)
        }
        updateSaveButton()
        let n = selectedCards.count
        setStatus(n == 0 ? "未选中任何页 · 点页面勾选要保存的页" : "已选中 \(n) 页 · 点「存选中」把这些页存到桌面")
    }

    // 双击放大查看该页大图
    func zoomPage(_ card: PageCard) {
        let pc = PreviewWindowController(page: card.page, pageNumber: card.pageIndex + 1, docName: baseName)
        previewControllers.append(pc)
        pc.showWindow(nil)
        pc.window?.makeKeyAndOrderFront(nil)
    }

    @objc private func clearSelection() {
        for c in selectedCards { c.setSelected(false, order: 0) }
        selectedCards.removeAll()
        updateSaveButton()
        setStatus("已清空选择 · 未选中任何页")
    }

    private func updateSaveButton() {
        let n = selectedCards.count
        saveSelBtn.title = "存选中 (\(n))"
        saveSelBtn.isEnabled = n > 0
    }

    // MARK: 保存
    @objc private func dpiChanged() {
        switch dpiPopup.indexOfSelectedItem {
        case 1: dpi = 300
        case 2: dpi = 450
        default: dpi = 150
        }
    }

    // 选 PDF 时「清晰度」无意义（矢量无损），禁用并置灰
    @objc private func fmtChanged() {
        let isPDF = fmtPopup.indexOfSelectedItem == 2
        dpiPopup.isEnabled = !isPDF
        dpiHint.textColor = isPDF ? .disabledControlTextColor : .secondaryLabelColor
    }

    // 只保存被选中的页；没选中的一律不存
    @objc private func saveSelected() {
        let targets = selectedCards
        guard !targets.isEmpty else { setStatus("请先勾选要保存的页"); return }
        let count = targets.count
        let isPDF = fmtPopup.indexOfSelectedItem == 2
        setStatus(isPDF ? "正在把选中的 \(count) 页合并为 PDF 存到桌面…" : "正在导出选中的 \(count) 页到桌面…")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            var savedNames: [String] = []
            if isPDF {
                // 矢量 PDF：把选中页直接合并成一个新 PDF
                if let name = self.savePDFSync(targets) { savedNames = [name] }
            } else {
                for card in targets {
                    if let name = self.savePageSync(card) { savedNames.append(name) }
                }
            }
            DispatchQueue.main.async {
                let ok = isPDF ? (savedNames.isEmpty ? 0 : count) : savedNames.count
                let fail = count - ok
                self.setStatus("完成：\(ok)/\(count) 页已存到桌面（未选中的页未处理）")
                // 完成弹窗
                let alert = NSAlert()
                alert.alertStyle = fail == 0 ? .informational : .warning
                alert.messageText = fail == 0 ? "已存完 ✓" : "保存完成（有 \(fail) 页失败）"
                if fail == 0 {
                    if isPDF {
                        alert.informativeText = "选中的 \(ok) 页已合并成一个 PDF 保存到桌面：\n\n\(savedNames.first ?? "")"
                    } else {
                        let preview = savedNames.prefix(6).joined(separator: "\n")
                        let more = savedNames.count > 6 ? "\n…等 \(savedNames.count) 个文件" : ""
                        alert.informativeText = "选中的 \(ok) 页已全部保存到桌面：\n\n\(preview)\(more)"
                    }
                } else {
                    let preview = savedNames.prefix(6).joined(separator: "\n")
                    alert.informativeText = "成功 \(ok) 页，失败 \(fail) 页。\n已保存：\n\(preview)"
                }
                alert.addButton(withTitle: "好")
                alert.runModal()
            }
        }
    }

    // 把选中页合并为矢量 PDF，返回文件名；失败返回 nil
    private func savePDFSync(_ cards: [PageCard]) -> String? {
        // 从原始文件重新读取，保证矢量质量且不破坏界面上的文档对象
        var source: PDFDocument? = doc
        if let url = sourcePDFURL, let fresh = PDFDocument(url: url) { source = fresh }
        let out = PDFDocument()
        for card in cards {
            guard let page = source?.page(at: card.pageIndex) else { continue }
            out.insert(page, at: out.pageCount)
        }
        guard out.pageCount > 0 else { return nil }
        let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first!
        let base = "\(baseName)_选中\(cards.count)页"
        var dest = desktop.appendingPathComponent("\(base).pdf")
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = desktop.appendingPathComponent("\(base)_\(n).pdf")
            n += 1
        }
        guard out.write(to: dest) else { return nil }
        DispatchQueue.main.async { for c in cards { c.markSaved() } }
        return dest.lastPathComponent
    }

    // 返回保存后的文件名；失败返回 nil
    private func savePageSync(_ card: PageCard) -> String? {
        let scale = dpi / 72.0
        let fmt = fmtPopup.indexOfSelectedItem == 1 ? "jpg" : "png"
        let b = card.page.bounds(for: .mediaBox)
        let img = card.page.thumbnail(
            of: NSSize(width: Int((b.width * scale).rounded()), height: Int((b.height * scale).rounded())),
            for: .mediaBox
        )
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
            DispatchQueue.main.async { card.markFailed() }
            return nil
        }
        let data: Data? = fmt == "png"
            ? rep.representation(using: .png, properties: [:])
            : rep.representation(using: .jpeg, properties: [.compressionFactor: 0.92])
        guard let outData = data else {
            DispatchQueue.main.async { card.markFailed() }
            return nil
        }
        let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first!
        let base = "\(baseName)_第\(card.pageIndex + 1)页"
        var dest = desktop.appendingPathComponent("\(base).\(fmt)")
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = desktop.appendingPathComponent("\(base)_\(n).\(fmt)")
            n += 1
        }
        do {
            try outData.write(to: dest)
            DispatchQueue.main.async { card.markSaved() }
            return dest.lastPathComponent
        } catch {
            DispatchQueue.main.async { card.markFailed() }
            return nil
        }
    }

    private func setStatus(_ text: String) { statusLabel.stringValue = text }
}
