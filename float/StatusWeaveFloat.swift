import Cocoa
import WebKit

/// StatusWeave 前置浮动窗口
/// 菜单栏 ⚡ 图标控制显示/隐藏;窗口始终浮于其他窗口之上(类似豆包前置窗)
/// 依赖本地服务: http://localhost:8787 (先运行 `npx statusweave` 或 `statusweave`)

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var port = "8787"

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["PORT"] ?? "8787"

        // 浮动窗口(默认 476x758,取自实际使用调校;用户拖过的尺寸位置会被记住)
        let rect = NSRect(x: 0, y: 0, width: 476, height: 758)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "StatusWeave"
        // The dashboard supplies the pixel-console language; the surrounding
        // window stays recognizably macOS and uses the same dark foundation.
        window.backgroundColor = NSColor(calibratedRed: 10 / 255, green: 13 / 255, blue: 20 / 255, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.level = .floating                       // 始终前置
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 400, height: 560)
        window.setFrameAutosaveName("statusweave.main") // 记住用户调整的尺寸/位置

        let webView = WKWebView(frame: window.contentView!.bounds)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        if let url = URL(string: "http://localhost:\(port)") {
            webView.load(URLRequest(url: url))
        }
        window.contentView!.addSubview(webView)
        window.center()
        window.makeKeyAndOrderFront(nil)

        // 菜单栏图标:程序化绘制 logo(轨道环+圆点+脉冲)
        // isTemplate = true → macOS 自动渲染为白/黑,与系统菜单栏图标风格一致
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = Self.makeLogoImage(size: 20)
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "StatusWeave"
        let menu = NSMenu()
        let toggleItem = NSMenuItem(title: "显示 / 隐藏面板", action: #selector(toggleWindow), keyEquivalent: "s")
        toggleItem.target = self
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu

        // 最小应用主菜单:让 ⌘Q 退出 / ⌘W 关窗 在窗口获得焦点时生效
        // (LSUIElement 默认没有 mainMenu,快捷键无处绑定)
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit StatusWeave", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "Window")
        fileMenu.addItem(NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        fileMenuItem.submenu = fileMenu
        NSApp.mainMenu = mainMenu

        NSApp.activate(ignoringOtherApps: true)
    }

    /// Draws the StatusWeave mark (orbit ring + dot + pulse) in code — no image assets needed.
    /// Template image: macOS tints it white/black depending on the menu bar appearance.
    private static func makeLogoImage(size: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
            // Scale the 1024-canvas mark up so it fills ~90% of the tile (centered)
            let s = rect.width / 820
            let px = { (x: CGFloat) in (x - 512) * s + rect.width / 2 }
            let py = { (y: CGFloat) in (y - 512) * s + rect.height / 2 }
            NSColor.black.set()

            // Orbit ring: arc from 65° around to 25°+360° (gap at top-right)
            let ring = NSBezierPath()
            ring.lineWidth = 58 * s
            ring.lineCapStyle = .round
            var deg: CGFloat = 65
            var first = true
            while deg <= 385 {
                let a = deg * .pi / 180
                let p = NSPoint(x: px(512 + 330 * cos(a)), y: py(512 - 330 * sin(a)))
                if first { ring.move(to: p); first = false } else { ring.line(to: p) }
                deg += 5
            }
            ring.stroke()

            // Dot at ~42° on the ring path
            let da: CGFloat = 42 * .pi / 180
            let dx = px(512 + 306 * cos(da))
            let dy = py(512 - 306 * sin(da))
            let dr = 54 * s
            NSBezierPath(ovalIn: NSRect(x: dx - dr, y: dy - dr, width: dr * 2, height: dr * 2)).fill()

            // Pulse polyline
            let pulse = NSBezierPath()
            pulse.lineWidth = 46 * s
            pulse.lineCapStyle = .round
            pulse.lineJoinStyle = .round
            let pts: [(CGFloat, CGFloat)] = [(333, 525), (466, 525), (499, 383), (549, 629), (593, 525), (703, 525)]
            pulse.move(to: NSPoint(x: px(pts[0].0), y: py(pts[0].1)))
            for (x, y) in pts.dropFirst() { pulse.line(to: NSPoint(x: px(x), y: py(y))) }
            pulse.stroke()
            return true
        }
        img.isTemplate = true
        return img
    }

    @objc private func toggleWindow() {
        if window.isVisible {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// The monitor server is not reachable: show an actionable placeholder
    /// instead of a blank window, and auto-retry every 5 seconds.
    private func showServerMissingPage(_ webView: WKWebView) {
        let url = "http://localhost:\(port)"
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="5;url=\(url)">
        <style>
          body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
                 background:#0a0d14; color:#d7deeb; font:14px -apple-system,"PingFang SC",sans-serif; }
          .box { max-width:340px; padding:0 28px; text-align:center; }
          h1 { font-size:18px; margin:0 0 6px; }
          p { color:#8b95a8; line-height:1.7; margin:10px 0; }
          code { display:block; background:#131824; border:1px solid #232c40; border-radius:8px;
                 padding:10px 12px; margin:14px 0; color:#7ee2a8;
                 font:13px ui-monospace,Menlo,monospace; user-select:all; }
          .hint { font-size:12px; color:#5b6577; }
        </style></head><body><div class="box">
          <h1>⚡ StatusWeave</h1>
          <p>The local monitor is not running.<br>Start it in Terminal and this panel connects automatically.</p>
          <code>npx statusweave</code>
          <p>本地监控服务未运行。<br>在终端运行上面的命令,本窗口会自动连接。</p>
          <p class="hint">Retrying every 5 s · 每 5 秒自动重试 · \(url)</p>
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false // 关窗不退出,驻留菜单栏
    }
}

// External links (e.g. the GitHub button) must not navigate inside the panel —
// hand them to the default browser instead.
extension AppDelegate: WKUIDelegate, WKNavigationDelegate {
    // target="_blank" links arrive here (WKWebView does not open new windows by itself)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // Same-tab external links: open externally, keep the dashboard on localhost
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let host = url.host,
           host != "localhost", host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // Server not running (connection refused) or navigation failed midway —
    // swap in the guided placeholder instead of leaving a blank panel.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showServerMissingPage(webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showServerMissingPage(webView)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 菜单栏应用,不占 Dock
app.run()
