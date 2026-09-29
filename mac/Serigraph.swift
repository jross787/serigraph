// Serigraph for Mac: a native window around the local Serigraph server.
//
// The server runs in the background (a launchd agent installed by
// `serigraph install`) from its own copy of the engine, so the window opens
// instantly and every Mac runs the same updated version. This app adds what a
// browser tab cannot: a Dock icon, standard menus, File > Open with the Mac
// file picker, Open Recent, and files opened from Finder or dropped on the
// Dock icon. Everything else is the same web app.
import Cocoa
import UniformTypeIdentifiers
import WebKit

let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/Serigraph", isDirectory: true)

struct InstallConfig: Decodable { var port: Int? }

func configuredPort() -> Int {
  let file = supportDirectory.appendingPathComponent("config.json")
  if let data = try? Data(contentsOf: file),
     let config = try? JSONDecoder().decode(InstallConfig.self, from: data),
     let port = config.port, (1024...65535).contains(port) {
    return port
  }
  return 4747
}

// Open Recent and the Dock's recent-files menu come from NSDocumentController.
// Serigraph has no NSDocument classes, so route those requests to the page.
final class DocumentController: NSDocumentController {
  var openHandler: ((URL) -> Void)?

  override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                             completionHandler: @escaping (NSDocument?, Bool, Error?) -> Void) {
    openHandler?(url)
    completionHandler(nil, false, nil)
  }
}

// The page's top bar doubles as the window's title bar. The page reports the
// bar's height and where its controls are; a press anywhere else in the bar
// moves the window, and a double-click zooms it like any Mac title bar.
final class MapWebView: WKWebView {
  var barHeight: CGFloat = 0
  var controls: [CGRect] = []

  override func mouseDown(with event: NSEvent) {
    let local = convert(event.locationInWindow, from: nil)
    let point = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
    if point.y >= 0, point.y < barHeight, !controls.contains(where: { $0.contains(point) }) {
      if event.clickCount == 2 {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize" {
        case "Minimize": window?.performMiniaturize(nil)
        case "None": break
        default: window?.performZoom(nil)
        }
      } else {
        window?.performDrag(with: event)
      }
      return
    }
    super.mouseDown(with: event)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
  let documents: DocumentController
  let base = URL(string: "http://127.0.0.1:\(configuredPort())/")!
  var window: NSWindow!
  var webView: MapWebView!
  var status: NSTextField!
  var titleObservation: NSKeyValueObservation?
  var pageReady = false
  var pendingPaths: [String] = []
  var attempts = 0
  var startedServer = false
  let barHeight: CGFloat = 56

  init(documents: DocumentController) {
    self.documents = documents
    super.init()
    documents.openHandler = { [weak self] url in self?.open(url) }
  }

  // MARK: Application

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = makeMainMenu()
    makeWindow()
    waitForServer()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil) }
    return true
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    urls.forEach(open)
  }

  // MARK: Window

  func makeWindow() {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, name: "serigraph")
    configuration.applicationNameForUserAgent = "SerigraphMac/1"
    configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

    webView = MapWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    webView.translatesAutoresizingMaskIntoConstraints = false

    status = NSTextField(wrappingLabelWithString: "Starting Serigraph…")
    status.alignment = .center
    status.textColor = .secondaryLabelColor
    status.font = .systemFont(ofSize: 13)
    status.translatesAutoresizingMaskIntoConstraints = false

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    window.title = "Serigraph"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 760, height: 520)
    window.backgroundColor = .windowBackgroundColor
    window.delegate = self

    let content = NSView()
    content.addSubview(webView)
    content.addSubview(status)
    window.contentView = content
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      status.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      status.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
    ])

    titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
      let title = view.title ?? ""
      self?.window.title = title.isEmpty ? "Serigraph" : title
    }

    window.center()
    window.setFrameAutosaveName("SerigraphMainWindow")
    window.makeKeyAndOrderFront(nil)
    placeWindowButtons()
  }

  // Center the close, minimize, and zoom buttons in the page's taller top bar.
  func placeWindowButtons() {
    guard let close = window.standardWindowButton(.closeButton),
          let minimize = window.standardWindowButton(.miniaturizeButton),
          let zoom = window.standardWindowButton(.zoomButton),
          let container = close.superview?.superview,
          !window.styleMask.contains(.fullScreen) else { return }
    let top = ((barHeight - close.frame.height) / 2).rounded()
    var frame = container.frame
    frame.size.height = close.frame.height + top
    frame.origin.y = window.frame.height - frame.size.height
    container.frame = frame
    let spacing = minimize.frame.origin.x - close.frame.origin.x
    for (index, button) in [close, minimize, zoom].enumerated() {
      button.setFrameOrigin(NSPoint(x: 20 + CGFloat(index) * spacing, y: button.frame.origin.y))
    }
  }

  func windowDidResize(_ notification: Notification) { placeWindowButtons() }
  func windowDidBecomeKey(_ notification: Notification) { placeWindowButtons() }

  func windowWillEnterFullScreen(_ notification: Notification) {
    webView.evaluateJavaScript("document.documentElement.classList.add('native-fullscreen')")
  }

  func windowDidExitFullScreen(_ notification: Notification) {
    webView.evaluateJavaScript("document.documentElement.classList.remove('native-fullscreen')")
    placeWindowButtons()
  }

  // MARK: Server

  func waitForServer() {
    var request = URLRequest(url: base.appendingPathComponent("api/maps"))
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        if let http = response as? HTTPURLResponse, http.statusCode < 500 {
          self.attempts = 0
          self.webView.load(URLRequest(url: self.base))
        } else {
          self.retryServer()
        }
      }
    }.resume()
  }

  func retryServer() {
    attempts += 1
    if attempts == 4, !startedServer {
      startedServer = true
      let launchctl = Process()
      launchctl.executableURL = URL(fileURLWithPath: "/bin/launchctl")
      launchctl.arguments = ["kickstart", "gui/\(getuid())/app.serigraph.server"]
      try? launchctl.run()
    }
    if attempts > 120 {
      showStatus("Serigraph’s background service isn’t running. Open Terminal, run “serigraph install”, then open Serigraph again.")
      return
    }
    if attempts > 8 { showStatus("Starting Serigraph…") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.waitForServer() }
  }

  func showStatus(_ text: String) {
    status.stringValue = text
    status.isHidden = false
    webView.isHidden = true
  }

  // MARK: Opening files

  func open(_ url: URL) {
    guard url.isFileURL else { return }
    documents.noteNewRecentDocumentURL(url)
    pendingPaths.append(url.path)
    if pageReady { deliverPendingPaths() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func deliverPendingPaths() {
    let paths = pendingPaths
    pendingPaths = []
    for path in paths {
      guard let data = try? JSONSerialization.data(withJSONObject: [path]),
            let list = String(data: data, encoding: .utf8) else { continue }
      webView.evaluateJavaScript("window.serigraph && window.serigraph.openPath(\(list)[0])")
    }
  }

  @objc func openDocument(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.yaml]
    panel.prompt = "Open"
    panel.message = "Choose a map file, or a folder of map files. It stays where it is, and your edits save to it."
    panel.beginSheetModal(for: window) { [weak self] response in
      if response == .OK, let url = panel.url { self?.open(url) }
    }
  }

  // MARK: Page messages

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == base.host,
          let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      pageReady = true
      deliverPendingPaths()
    case "open-panel":
      openDocument(nil)
    case "titlebar":
      webView.barHeight = CGFloat(body["height"] as? Double ?? 0)
      webView.controls = (body["controls"] as? [[String: Double]] ?? []).compactMap { rect in
        guard let x = rect["x"], let y = rect["y"], let width = rect["width"], let height = rect["height"] else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
      }
    default:
      break
    }
  }

  func runPage(_ script: String) {
    webView.evaluateJavaScript(script)
  }

  @objc func newMap(_ sender: Any?) { runPage("window.serigraph && window.serigraph.newMap()") }
  @objc func showProjects(_ sender: Any?) { runPage("window.serigraph && window.serigraph.goHome()") }
  @objc func search(_ sender: Any?) { runPage("window.serigraph && window.serigraph.search()") }
  @objc func checkForUpdates(_ sender: Any?) { runPage("window.serigraph && window.serigraph.checkForUpdates()") }
  @objc func reloadPage(_ sender: Any?) { pageReady = false; webView.reload() }
  @objc func openHelp(_ sender: Any?) {
    NSWorkspace.shared.open(URL(string: "https://github.com/jross787/serigraph#readme")!)
  }

  // MARK: Navigation

  func isAppURL(_ url: URL) -> Bool { url.host == base.host && url.port == base.port }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if ["blob", "data", "about"].contains(url.scheme ?? "") || isAppURL(url) { return decisionHandler(.allow) }
    // Links to GitHub, documentation, and other sites open in the default browser.
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.canCreateDirectories = true
    panel.beginSheetModal(for: window) { result in
      guard result == .OK, let url = panel.url else { return completionHandler(nil) }
      try? FileManager.default.removeItem(at: url) // the panel already confirmed replacing it
      completionHandler(url)
    }
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, !isAppURL(url) { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
  }

  // An update restarts the server; wait for it rather than showing an error page.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    pageReady = false
    attempts = 0
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.waitForServer() }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    status.isHidden = true
    webView.isHidden = false
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    pageReady = false
    webView.reload()
  }

  // MARK: Menus

  func makeMainMenu() -> NSMenu {
    let main = NSMenu()

    let app = NSMenu()
    app.addItem(withTitle: "About Serigraph", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Hide Serigraph", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
      .keyEquivalentModifierMask = [.command, .option]
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit Serigraph", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    main.addItem(submenu: app, title: "Serigraph")

    let file = NSMenu(title: "File")
    file.addItem(withTitle: "New Map…", action: #selector(newMap(_:)), keyEquivalent: "n")
    file.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
    let recent = NSMenu(title: "Open Recent")
    recent.addItem(withTitle: "Clear Menu", action: #selector(NSDocumentController.clearRecentDocuments(_:)), keyEquivalent: "")
    file.addItem(submenu: recent, title: "Open Recent")
    file.addItem(.separator())
    file.addItem(withTitle: "Projects", action: #selector(showProjects(_:)), keyEquivalent: "p")
      .keyEquivalentModifierMask = [.command, .shift]
    file.addItem(.separator())
    file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    main.addItem(submenu: file, title: "File")

    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Search Maps…", action: #selector(search(_:)), keyEquivalent: "k")
    main.addItem(submenu: edit, title: "Edit")

    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
    view.addItem(.separator())
    view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
      .keyEquivalentModifierMask = [.command, .control]
    main.addItem(submenu: view, title: "View")

    let windows = NSMenu(title: "Window")
    windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windows.addItem(.separator())
    windows.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    main.addItem(submenu: windows, title: "Window")
    NSApp.windowsMenu = windows

    let help = NSMenu(title: "Help")
    help.addItem(withTitle: "Serigraph Help", action: #selector(openHelp(_:)), keyEquivalent: "")
    main.addItem(submenu: help, title: "Help")
    NSApp.helpMenu = help
    return main
  }
}

extension NSMenu {
  func addItem(submenu: NSMenu, title: String) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.submenu = submenu
    addItem(item)
  }
}

// The first NSDocumentController created becomes the shared one.
let documents = DocumentController()
let delegate = AppDelegate(documents: documents)
let application = NSApplication.shared
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
