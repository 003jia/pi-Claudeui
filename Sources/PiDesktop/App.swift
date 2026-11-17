import AppKit
import WebKit

@main
struct PiDesktop {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = DesktopApp()
        signal(SIGPIPE, SIG_IGN)
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class DesktopApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private typealias Reply = (Any?, String?) -> Void
    private let installation = PiInstallation()
    private let engine = EngineRuntime(bundleURL: Bundle.main.bundleURL)
    private let historyQueue = DispatchQueue(label: "local.pi-desktop.history", qos: .userInitiated)
    private let attachmentQueue = DispatchQueue(label: "local.pi-desktop.attachments", qos: .userInitiated)
    private var window: NSWindow!
    private var web: WKWebView!
    private var index: URL!
    private lazy var folder = initialFolder()
    private var pi: PiProcess?
    private var waitingLaunch: (() -> Void)?
    private var quitting = false
    private var knownSessions: [String: String] = [:]
    private let preferenceChoices = [
        "sendShortcut": ["enter", "command-enter"],
        "sidebarOnLaunch": ["show", "hide"],
        "replyFont": ["serif", "system"],
        "chatWidth": ["standard", "compact", "wide"],
        "codeSize": ["12", "14", "16"]
    ]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .aqua)
        installMenu()
        let resources = Bundle.main.resourceURL!.appendingPathComponent("Web", isDirectory: true)
        index = resources.appendingPathComponent("index.html")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "piHost")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.setAccessibilityLabel("Pi")

        let visible = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1140, height: 770)
        window = PiWindow(contentRect: NSRect(x: 0, y: 0, width: min(1140, visible.width), height: min(770, visible.height)),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Pi"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .white
        window.minSize = NSSize(width: 640, height: 490)
        window.isMovable = true
        window.contentView = web
        let frameName = "PiDesktop.window"
        if !window.setFrameUsingName(frameName) { window.center() }
        window.setFrameAutosaveName(frameName)
        web.loadFileURL(index, allowingReadAccessTo: resources)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let pi else { return .terminateNow }
        quitting = true
        waitingLaunch = nil
        pi.close(abort: true)
        return .terminateLater
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        try? engine.refreshBundleLocation()
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.remove()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isIndex(url) {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated, let scheme = url.scheme?.lowercased(),
           ["https", "http"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    private func isIndex(_ url: URL?) -> Bool {
        guard let url, url.isFileURL else { return false }
        return url.standardizedFileURL.resolvingSymlinksInPath().path ==
            index.standardizedFileURL.resolvingSymlinksInPath().path
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let alert = NSAlert(error: error)
        alert.messageText = "Pi 界面加载失败"
        alert.beginSheetModal(for: window)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard !quitting, message.frameInfo.isMainFrame, isIndex(message.frameInfo.request.url),
              let request = message.body as? [String: Any], let action = request["action"] as? String else {
            replyHandler(nil, "无法识别 Pi 窗口发出的请求。")
            return
        }
        switch action {
        case "initial":
            let saved = preferenceChoices.map { key, choices in
                if let value = UserDefaults.standard.string(forKey: "desktop.\(key)"), choices.contains(value) {
                    return (key, value)
                }
                return (key, choices[0])
            }
            replyHandler(["folder": folder.path, "home": installation.home.path,
                          "sessionDirectory": installation.sessionRoot(for: folder).path,
                          "preferences": Dictionary(uniqueKeysWithValues: saved)], nil)
        case "setDesktopPreference":
            guard let key = request["key"] as? String, let value = request["value"] as? String,
                  preferenceChoices[key]?.contains(value) == true else {
                replyHandler(nil, "此设置值不可用。")
                return
            }
            UserDefaults.standard.set(value, forKey: "desktop.\(key)")
            replyHandler(NSNull(), nil)
        case "launch":
            launch(request, reply: replyHandler)
        case "rpc":
            guard waitingLaunch == nil, let pi, let record = request["record"] as? [String: Any] else {
                replyHandler(nil, "Pi 尚未连接。")
                return
            }
            if record["type"] as? String == "prompt" { try? engine.refreshBundleLocation() }
            pi.send(record) { error in replyHandler(NSNull(), error) }
        case "history":
            loadHistory(replyHandler)
        case "chooseFolder":
            chooseFolder(replyHandler)
        case "chooseAttachments":
            let limit = min(max(request["limit"] as? Int ?? 1, 1), AttachmentReader.countLimit)
            chooseAttachments(limit: limit, replyHandler)
        case "revealWorkspaceEntry":
            revealWorkspaceEntry(request["path"] as? String, replyHandler)
        case "revealSessions":
            let directory = installation.sessionRoot(for: folder)
            guard directoryExists(directory) else { replyHandler(nil, "当前会话目录尚未建立。"); return }
            NSWorkspace.shared.activateFileViewerSelecting([directory])
            replyHandler(NSNull(), nil)
        case "copy":
            guard let text = request["text"] as? String else { replyHandler(nil, "没有可复制的内容。"); return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            replyHandler(NSNull(), nil)
        default:
            replyHandler(nil, "此操作不可用。")
        }
    }

    private func launch(_ request: [String: Any], reply: @escaping Reply) {
        let session = request["session"] as? String
        guard let generation = request["generation"] as? String,
              let path = request["folder"] as? String, path.hasPrefix("/"), waitingLaunch == nil else {
            reply(nil, "Pi 正在切换会话，请稍后再试。")
            return
        }
        if let session, knownSessions[session] != path || !FileManager.default.fileExists(atPath: session) {
            reply(nil, "这个会话文件已移动或删除。")
            return
        }
        let target = URL(fileURLWithPath: path, isDirectory: true)
        guard directoryExists(target) else {
            reply(nil, "工作目录已移动或删除。请选择一个可用的文件夹。")
            return
        }
        let start = { [weak self] in
            guard let self else { return }
            do {
                let permissionExtension = try self.engine.extensionURL()
                self.pi = try PiProcess(installation: self.installation, folder: target, session: session,
                                        permissionExtension: permissionExtension,
                                        onLines: { [weak self] records in
                    self?.deliver(function: "receive", data: ["generation": generation, "records": records])
                }, onExit: { [weak self] status, detail in
                    self?.processEnded(generation: generation, status: status, detail: detail)
                })
                self.folder = target
                UserDefaults.standard.set(target.path, forKey: "workingFolder")
                reply(["sessionDirectory": self.installation.sessionRoot(for: target).path,
                       "permissionExtension": permissionExtension.path], nil)
            } catch {
                reply(nil, error.localizedDescription)
            }
        }
        if let pi {
            waitingLaunch = start
            pi.close()
        } else {
            start()
        }
    }

    private func processEnded(generation: String, status: Int32, detail: String) {
        pi = nil
        if quitting {
            NSApp.reply(toApplicationShouldTerminate: true)
        } else if let next = waitingLaunch {
            waitingLaunch = nil
            next()
        } else {
            deliver(function: "disconnected", data: ["generation": generation, "status": status, "detail": detail])
        }
    }

    private func deliver(function: String, data: [String: Any]) {
        web.callAsyncJavaScript("window.piDesktop?.\(function)(data)", arguments: ["data": data],
                                in: nil, in: .page, completionHandler: nil)
    }

    private func loadHistory(_ reply: @escaping Reply) {
        let root = installation.sessionRoot(for: folder)
        historyQueue.async {
            let list = SessionHistory().recent(in: root)
            DispatchQueue.main.async {
                guard root == self.installation.sessionRoot(for: self.folder) else {
                    reply([], nil)
                    return
                }
                self.knownSessions = Dictionary(uniqueKeysWithValues: list.compactMap {
                    guard let path = $0["path"], let folder = $0["folder"] else { return nil }
                    return (path, folder)
                })
                reply(list, nil)
            }
        }
    }

    private func chooseFolder(_ reply: @escaping Reply) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = folder
        panel.prompt = "选择"
        panel.message = "选择 Pi 可以在其中读写文件的工作目录。"
        panel.beginSheetModal(for: window) { reply($0 == .OK ? panel.url?.path : nil, nil) }
    }

    private func chooseAttachments(limit: Int, _ reply: @escaping Reply) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = limit > 1
        panel.directoryURL = folder
        panel.prompt = "添加"
        panel.message = "选取图片或文件。每条消息最多添加 \(AttachmentReader.countLimit) 个附件。"
        panel.beginSheetModal(for: window) { result in
            guard result == .OK else { reply(NSNull(), nil); return }
            let urls = panel.urls
            self.attachmentQueue.async {
                var attachments: [[String: String]] = []
                var errors: [String] = []
                for url in urls.prefix(limit) {
                    do { attachments.append(try AttachmentReader.read(url)) }
                    catch { errors.append("\(url.lastPathComponent)  \(error.localizedDescription)") }
                }
                if urls.count > limit { errors.append("本条消息只能再添加 \(limit) 个附件。") }
                let result: [String: Any] = ["attachments": attachments, "errors": errors]
                DispatchQueue.main.async { reply(result, nil) }
            }
        }
    }

    private func revealWorkspaceEntry(_ path: String?, _ reply: Reply) {
        let root = folder.resolvingSymlinksInPath().standardizedFileURL
        let target: URL
        if let path {
            let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)
            target = url.resolvingSymlinksInPath().standardizedFileURL
        } else {
            target = root
        }
        let components = root.pathComponents
        guard target.pathComponents.starts(with: components), FileManager.default.fileExists(atPath: target.path) else {
            reply(nil, "这个项目文件已移动、删除或不在工作目录内。")
            return
        }
        if target == root { NSWorkspace.shared.open(root) }
        else { NSWorkspace.shared.activateFileViewerSelecting([target]) }
        reply(NSNull(), nil)
    }

    private func initialFolder() -> URL {
        if let path = UserDefaults.standard.string(forKey: "workingFolder"), path.hasPrefix("/") {
            let url = URL(fileURLWithPath: path, isDirectory: true)
            if directoryExists(url) { return url }
        }
        return installation.home
    }

    private func directoryExists(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }

    private func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem()
        let file = NSMenuItem()
        let edit = NSMenuItem()
        let windows = NSMenuItem()
        menu.items = [app, file, edit, windows]
        app.submenu = NSMenu(title: "Pi")
        app.submenu?.addItem(withTitle: "关于 Pi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.submenu?.addItem(.separator())
        app.submenu?.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",").target = self
        app.submenu?.addItem(.separator())
        app.submenu?.addItem(withTitle: "退出 Pi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        file.submenu = NSMenu(title: "文件")
        file.submenu?.addItem(withTitle: "新建对话", action: #selector(newConversation), keyEquivalent: "n").target = self
        file.submenu?.addItem(withTitle: "选择工作目录…", action: #selector(pickWorkingFolder), keyEquivalent: "o").target = self
        file.submenu?.addItem(.separator())
        file.submenu?.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        edit.submenu = NSMenu(title: "编辑")
        edit.submenu?.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.submenu?.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        redo?.keyEquivalentModifierMask = [.command, .shift]
        edit.submenu?.addItem(.separator())
        edit.submenu?.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        windows.submenu = NSMenu(title: "窗口")
        windows.submenu?.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windows.submenu
    }

    @objc private func newConversation() { deliver(function: "menu", data: ["action": "newSession"]) }
    @objc private func pickWorkingFolder() { deliver(function: "menu", data: ["action": "chooseFolder"]) }
    @objc private func openSettings() { deliver(function: "menu", data: ["action": "settings"]) }
}

private final class PiWindow: NSWindow {
    private var drag: (pointer: NSPoint, origin: NSPoint)?

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            drag = nil
            if isDragLocation(event.locationInWindow) {
                drag = (convertPoint(toScreen: event.locationInWindow), frame.origin)
                return
            }
        case .leftMouseDragged:
            if let drag {
                let pointer = convertPoint(toScreen: event.locationInWindow)
                setFrameOrigin(NSPoint(x: drag.origin.x + pointer.x - drag.pointer.x,
                                       y: drag.origin.y + pointer.y - drag.pointer.y))
                return
            }
        case .leftMouseUp:
            if drag != nil {
                drag = nil
                saveFrame(usingName: frameAutosaveName)
                return
            }
        default:
            break
        }
        super.sendEvent(event)
    }

    private func isDragLocation(_ location: NSPoint) -> Bool {
        guard let contentView, isMovable, attachedSheet == nil, !styleMask.contains(.fullScreen) else { return false }
        let point = contentView.convert(location, from: nil)
        let bounds = contentView.bounds
        let top = contentView.isFlipped ? point.y - bounds.minY : bounds.maxY - point.y
        // The top bar's traffic lights and sidebar buttons sit outside this region.
        return top >= 0 && top < 44 && point.x >= 126 && point.x < bounds.maxX - 172
    }
}
