import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import QuartzCore

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

// MARK: - Data Structures & Cache

struct CachedAXElement {
    let element: AXUIElement
    let role: String
    let subrole: String?
    let title: String?
    let value: String?
    let bounds: CGRect?
    let actions: [String]
}

final class HelperState {
    private let lock = NSLock()
    // Keyed by "win:<windowId>" and "app:<pid>"
    private var elementCaches: [String: [Int: CachedAXElement]] = [:]
    private var elementCacheTimes: [String: Date] = [:]
    // Keyed by windowId -> live AXUIElement? window + pid + fallbackBounds
    private var windowElements: [Int: (axWindow: AXUIElement?, pid: pid_t, bundleId: String?, appName: String, fallbackBounds: CGRect)] = [:]
    private var installedAppsCache: [[String: Any]]? = nil
    private var installedAppsCacheTime: Date = .distantPast
    private var manualAXCheckedPids = Set<pid_t>()

    func getInstalledApps(maxAge: TimeInterval = 30.0) -> [[String: Any]]? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = installedAppsCache, Date().timeIntervalSince(installedAppsCacheTime) < maxAge {
            return cached
        }
        return nil
    }

    func setInstalledApps(_ apps: [[String: Any]]) {
        lock.lock()
        defer { lock.unlock() }
        installedAppsCache = apps
        installedAppsCacheTime = Date()
    }

    func setWindowElement(id: Int, value: (axWindow: AXUIElement?, pid: pid_t, bundleId: String?, appName: String, fallbackBounds: CGRect)) {
        lock.lock()
        defer { lock.unlock() }
        windowElements[id] = value
    }

    func getWindowElement(id: Int) -> (axWindow: AXUIElement?, pid: pid_t, bundleId: String?, appName: String, fallbackBounds: CGRect)? {
        lock.lock()
        defer { lock.unlock() }
        return windowElements[id]
    }

    func hasElementCache(windowId: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let existing = elementCaches["win:\(windowId)"], !existing.isEmpty {
            return true
        }
        return false
    }

    func setElementCache(windowId: Int, pid: pid_t, elements: [Int: CachedAXElement]) {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        elementCaches["win:\(windowId)"] = elements
        elementCaches["app:\(pid)"] = elements
        elementCacheTimes["win:\(windowId)"] = now
        elementCacheTimes["app:\(pid)"] = now
    }

    func getRecentElementCache(windowId: Int, maxAge: TimeInterval = 2.5) -> [Int: CachedAXElement]? {
        lock.lock()
        defer { lock.unlock() }
        let key = "win:\(windowId)"
        if let ts = elementCacheTimes[key], Date().timeIntervalSince(ts) <= maxAge,
           let cached = elementCaches[key], !cached.isEmpty {
            return cached
        }
        return nil
    }

    func lookupElement(windowId: Int, pid: pid_t, index: Int) -> CachedAXElement? {
        lock.lock()
        defer { lock.unlock() }
        if let entry = elementCaches["win:\(windowId)"]?[index] {
            return entry
        }
        return elementCaches["app:\(pid)"]?[index]
    }

    func markManualAXChecked(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return manualAXCheckedPids.insert(pid).inserted
    }
}

let state = HelperState()

/// Wake Electron / Chromium Accessibility trees on demand without stealing focus.
func ensureManualAccessibility(pid: pid_t) {
    guard pid > 0 else { return }
    let axApp = AXUIElementCreateApplication(pid)
    var val: CFTypeRef?
    let copyErr = AXUIElementCopyAttributeValue(axApp, "AXManualAccessibility" as CFString, &val)
    let firstTime = state.markManualAXChecked(pid: pid)
    if copyErr == .success {
        let alreadyEnabled = (val as? Bool) ?? ((val as? NSNumber)?.boolValue ?? false)
        if !alreadyEnabled {
            let setErr = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            if setErr == .success && firstTime {
                Thread.sleep(forTimeInterval: 0.16)
            }
        }
    } else if firstTime {
        let setErr = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if setErr == .success {
            Thread.sleep(forTimeInterval: 0.16)
        }
    }
}
let stdoutLock = NSLock()
let hidCursorLock = NSLock()

@inline(__always)
func onMain<T>(_ body: () throws -> T) rethrows -> T {
    if Thread.isMainThread {
        return try body()
    }
    return try DispatchQueue.main.sync(execute: body)
}

// MARK: - JSON Helpers

func writeResponse(id: Any?, ok: Bool, result: Any? = nil, error: String? = nil) {
    var payload: [String: Any] = ["ok": ok]
    if let id = id {
        payload["id"] = id
    } else {
        payload["id"] = NSNull()
    }
    if ok {
        payload["result"] = result ?? [:]
    } else {
        payload["error"] = error ?? "Unknown error"
    }
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
       let line = String(data: data, encoding: .utf8),
       let outBytes = (line + "\n").data(using: .utf8) {
        stdoutLock.lock()
        defer { stdoutLock.unlock() }
        FileHandle.standardOutput.write(outBytes)
    }
}

func asBool(_ v: Any?) -> Bool? {
    guard let ref = v else { return nil }
    if CFGetTypeID(ref as CFTypeRef) == CFBooleanGetTypeID() {
        return (ref as? NSNumber)?.boolValue
    }
    return ref as? Bool
}

func asDouble(_ v: Any?) -> Double? {
    guard let ref = v else { return nil }
    if CFGetTypeID(ref as CFTypeRef) == CFBooleanGetTypeID() { return nil }
    if let n = ref as? NSNumber { return n.doubleValue }
    if let d = ref as? Double { return d }
    if let i = ref as? Int { return Double(i) }
    return nil
}

func asInt(_ v: Any?) -> Int? {
    guard let ref = v else { return nil }
    if CFGetTypeID(ref as CFTypeRef) == CFBooleanGetTypeID() { return nil }
    if let n = ref as? NSNumber { return n.intValue }
    if let i = ref as? Int { return i }
    if let d = ref as? Double { return Int(d) }
    return nil
}


// MARK: - AX Utilities

func axCopyAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var val: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &val)
    return err == .success ? val : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let ref = axCopyAttr(el, attr) else { return nil }
    if let s = ref as? String { return s }
    if let attrStr = ref as? NSAttributedString { return attrStr.string }
    if let n = ref as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    guard let ref = axCopyAttr(el, attr) else { return nil }
    if let b = ref as? Bool { return b }
    if let n = ref as? NSNumber { return n.boolValue }
    return nil
}

func axPoint(_ el: AXUIElement, _ attr: String = kAXPositionAttribute as String) -> CGPoint? {
    guard let ref = axCopyAttr(el, attr), CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
    let axVal = ref as! AXValue
    var pt = CGPoint.zero
    if AXValueGetValue(axVal, .cgPoint, &pt) { return pt }
    return nil
}

func axSize(_ el: AXUIElement, _ attr: String = kAXSizeAttribute as String) -> CGSize? {
    guard let ref = axCopyAttr(el, attr), CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
    let axVal = ref as! AXValue
    var sz = CGSize.zero
    if AXValueGetValue(axVal, .cgSize, &sz) { return sz }
    return nil
}

func axBounds(_ el: AXUIElement) -> CGRect? {
    guard let pt = axPoint(el), let sz = axSize(el) else { return nil }
    return CGRect(origin: pt, size: sz)
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    if AXUIElementCopyActionNames(el, &names) == .success, let arr = names as? [String] {
        return arr
    }
    return []
}

func axSetPoint(_ el: AXUIElement, _ pt: CGPoint) -> Bool {
    var mutablePt = pt
    guard let val = AXValueCreate(.cgPoint, &mutablePt) else { return false }
    return AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, val) == .success
}

func axSetSize(_ el: AXUIElement, _ sz: CGSize) -> Bool {
    var mutableSz = sz
    guard let val = AXValueCreate(.cgSize, &mutableSz) else { return false }
    return AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, val) == .success
}

func rectToDict(_ r: CGRect) -> [String: Double] {
    return [
        "x": Double(r.origin.x.rounded()),
        "y": Double(r.origin.y.rounded()),
        "width": Double(r.size.width.rounded()),
        "height": Double(r.size.height.rounded())
    ]
}

// MARK: - Displays (Quartz Top-Left Coordinates)

func getDisplaysInfo() -> [[String: Any]] {
    return onMain {
        let screens = NSScreen.screens
        let primaryHeight = screens.first?.frame.height ?? 1080.0
        var result: [[String: Any]] = []
        for (idx, screen) in screens.enumerated() {
            let f = screen.frame
            let vf = screen.visibleFrame
            let qFrame = CGRect(
                x: f.origin.x,
                y: primaryHeight - (f.origin.y + f.size.height),
                width: f.size.width,
                height: f.size.height
            )
            let qVisible = CGRect(
                x: vf.origin.x,
                y: primaryHeight - (vf.origin.y + vf.size.height),
                width: vf.size.width,
                height: vf.size.height
            )
            result.append([
                "index": idx,
                "name": screen.localizedName,
                "isPrimary": idx == 0,
                "scaleFactor": Double(screen.backingScaleFactor),
                "frame": rectToDict(qFrame),
                "visibleFrame": rectToDict(qVisible)
            ])
        }
        return result
    }
}

// MARK: - Installed & Running Apps Discovery

func scanInstalledApps() -> [[String: Any]] {
    if let cached = state.getInstalledApps(maxAge: 30.0) {
        return cached
    }
    let searchDirs = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
        (NSHomeDirectory() as NSString).appendingPathComponent("Applications")
    ]
    var seenKeys = Set<String>()
    var apps: [[String: Any]] = []
    let fm = FileManager.default
    for dir in searchDirs {
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { continue }
        for entry in entries where entry.hasSuffix(".app") {
            let fullPath = (dir as NSString).appendingPathComponent(entry)
            let bundle = Bundle(path: fullPath)
            let bundleId = bundle?.bundleIdentifier
            let displayName = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? (entry as NSString).deletingPathExtension
            let key = bundleId ?? fullPath
            if seenKeys.contains(key) { continue }
            seenKeys.insert(key)
            apps.append([
                "id": bundleId ?? fullPath,
                "bundleId": bundleId as Any,
                "displayName": displayName,
                "path": fullPath
            ])
        }
    }
    state.setInstalledApps(apps)
    return apps
}

func isHelperOverlayProcessOrWindow(
    pid: pid_t,
    ownerName: String? = nil,
    windowName: String? = nil,
    app: NSRunningApplication? = nil
) -> Bool {
    if pid == ProcessInfo.processInfo.processIdentifier { return true }
    if let wn = windowName, (wn == "Computer Use Cursor" || wn == "Computer Use Highlight") {
        return true
    }
    if let on = ownerName?.lowercased(), on == "mac-cua-helper" {
        return true
    }
    if let a = app {
        if a.executableURL?.lastPathComponent.lowercased() == "mac-cua-helper" { return true }
        if a.localizedName?.lowercased() == "mac-cua-helper" { return true }
    }
    return false
}

func liveRunningApplications(cgPids: Set<pid_t>? = nil) -> [NSRunningApplication] {
    var seen = Set<pid_t>()
    var out: [NSRunningApplication] = []
    let wsApps = onMain { NSWorkspace.shared.runningApplications }
    for app in wsApps where !app.isTerminated {
        if isHelperOverlayProcessOrWindow(pid: app.processIdentifier, app: app) { continue }
        seen.insert(app.processIdentifier)
        out.append(app)
    }
    let pidsToCheck: Set<pid_t>
    if let provided = cgPids {
        pidsToCheck = provided
    } else {
        let cgList = (CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var s = Set<pid_t>()
        for entry in cgList {
            if let pid = entry[kCGWindowOwnerPID as String] as? pid_t,
               ((entry[kCGWindowLayer as String] as? Int) ?? 0) == 0 {
                let ownerName = entry[kCGWindowOwnerName as String] as? String
                let winName = entry[kCGWindowName as String] as? String
                if isHelperOverlayProcessOrWindow(pid: pid, ownerName: ownerName, windowName: winName) { continue }
                s.insert(pid)
            }
        }
        pidsToCheck = s
    }
    for pid in pidsToCheck where !seen.contains(pid) {
        if let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
            if isHelperOverlayProcessOrWindow(pid: pid, app: app) { continue }
            seen.insert(pid)
            out.append(app)
        }
    }
    return out
}

func resolveRunningApp(_ query: String) -> NSRunningApplication? {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    let lower = trimmed.lowercased()
    let running = liveRunningApplications()

    // 1. Exact bundleId match (prefer regular activationPolicy)
    let exactBundle = running.filter { ($0.bundleIdentifier?.lowercased() == lower) }
    if let reg = exactBundle.first(where: { $0.activationPolicy == .regular }) ?? exactBundle.first {
        return reg
    }
    // 2. Exact localizedName or bundle/executable path match
    let exactName = running.filter {
        ($0.localizedName?.lowercased() == lower) ||
        ($0.bundleURL?.path.lowercased() == lower) ||
        ($0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == lower) ||
        ($0.executableURL?.lastPathComponent.lowercased() == lower)
    }
    if let reg = exactName.first(where: { $0.activationPolicy == .regular }) ?? exactName.first {
        return reg
    }
    // 3. Substring match on regular or window-owning apps
    let partial = running.filter {
        ($0.localizedName?.lowercased().contains(lower) == true) ||
        ($0.bundleIdentifier?.lowercased().contains(lower) == true) ||
        ($0.executableURL?.lastPathComponent.lowercased().contains(lower) == true)
    }
    return partial.first(where: { $0.activationPolicy == .regular }) ?? partial.first
}

func findAppURL(_ query: String) -> URL? {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasPrefix("/") && FileManager.default.fileExists(atPath: trimmed) {
        return URL(fileURLWithPath: trimmed)
    }
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed) {
        return url
    }
    let lower = trimmed.lowercased()
    let installed = scanInstalledApps()
    for app in installed {
        let bId = (app["bundleId"] as? String)?.lowercased()
        let dName = (app["displayName"] as? String)?.lowercased()
        let path = app["path"] as? String ?? ""
        let fileStem = ((path as NSString).lastPathComponent as NSString).deletingPathExtension.lowercased()
        if bId == lower || dName == lower || fileStem == lower {
            return URL(fileURLWithPath: path)
        }
    }
    for app in installed {
        let dName = (app["displayName"] as? String)?.lowercased() ?? ""
        if dName.contains(lower) {
            if let path = app["path"] as? String {
                return URL(fileURLWithPath: path)
            }
        }
    }
    return nil
}

func resolveBundleExecutableURL(_ appURL: URL) -> URL? {
    if appURL.pathExtension.lowercased() == "app" {
        if let execURL = Bundle(url: appURL)?.executableURL,
           FileManager.default.isExecutableFile(atPath: execURL.path) {
            return execURL
        }
        let stem = appURL.deletingPathExtension().lastPathComponent
        let fallback = appURL.appendingPathComponent("Contents/MacOS/\(stem)")
        if FileManager.default.isExecutableFile(atPath: fallback.path) {
            return fallback
        }
        return nil
    }
    if FileManager.default.isExecutableFile(atPath: appURL.path) {
        return appURL
    }
    return nil
}

func launchAppSync(query: String, activate: Bool = false, timeoutMs: Int = 6000) throws -> NSRunningApplication {
    if let existing = resolveRunningApp(query) {
        if activate {
            existing.activate()
        }
        return existing
    }
    guard let appURL = findAppURL(query) else {
        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Application not found: \(query)"])
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = activate
    cfg.addsToRecentItems = false

    let sem = DispatchSemaphore(value: 0)
    var launchedApp: NSRunningApplication?
    var launchErr: Error?
    onMain {
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { app, err in
            launchedApp = app
            launchErr = err
            sem.signal()
        }
    }
    let fallbackExec = resolveBundleExecutableURL(appURL)
    let wsWaitMs = (fallbackExec != nil) ? min(timeoutMs, 3000) : timeoutMs
    let waitResult = sem.wait(timeout: .now() + .milliseconds(wsWaitMs))

    // Fallback to direct Foundation.Process executable spawn when LaunchServices rejects unsigned/sandboxed bundles
    if launchedApp == nil, let execURL = fallbackExec {
        let proc = Process()
        proc.executableURL = execURL
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            let pid = proc.processIdentifier
            let pidDeadline = Date().addingTimeInterval(min(3.0, Double(timeoutMs) / 1000.0))
            while Date() < pidDeadline {
                if let rApp = NSRunningApplication(processIdentifier: pid), !rApp.isTerminated {
                    launchedApp = rApp
                    launchErr = nil
                    break
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
            if activate {
                launchedApp?.activate()
            }
        } catch {
            if launchErr == nil {
                launchErr = error
            }
        }
    } else if waitResult == .timedOut {
        throw NSError(domain: "MacCUAHelper", code: 408, userInfo: [NSLocalizedDescriptionKey: "Timed out launching application: \(query)"])
    }

    if let err = launchErr, launchedApp == nil {
        throw err
    }
    guard let app = launchedApp else {
        throw NSError(domain: "MacCUAHelper", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to obtain running application handle for: \(query)"])
    }
    // Poll for AX responsiveness (and initial window creation if GUI app)
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    var axReadyAt: Date? = nil
    while Date() < deadline {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXRoleAttribute as CFString, &role) == .success {
            if axReadyAt == nil {
                axReadyAt = Date()
            }
            if let wins = axCopyAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty {
                break
            }
            if let readyTime = axReadyAt, Date().timeIntervalSince(readyTime) >= 0.45 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.06)
    }
    return app
}

// MARK: - Window Enumeration & Matching

func cgWindowBoundsFromEntry(_ entry: [String: Any]) -> CGRect? {
    guard let bDict = entry[kCGWindowBounds as String] as? [String: Any] else { return nil }
    let cx = (bDict["X"] as? CGFloat) ?? CGFloat((bDict["X"] as? Double) ?? 0.0)
    let cy = (bDict["Y"] as? CGFloat) ?? CGFloat((bDict["Y"] as? Double) ?? 0.0)
    let cw = (bDict["Width"] as? CGFloat) ?? CGFloat((bDict["Width"] as? Double) ?? 0.0)
    let ch = (bDict["Height"] as? CGFloat) ?? CGFloat((bDict["Height"] as? Double) ?? 0.0)
    return CGRect(x: cx, y: cy, width: cw, height: ch)
}

func cgWindowLiveInfo(windowId: Int) -> (exists: Bool, bounds: CGRect?, onScreen: Bool, layer: Int, ownerPid: pid_t, title: String, ownerName: String) {
    guard windowId > 0, windowId < 1_000_000_000 else {
        return (false, nil, false, 0, 0, "", "")
    }
    let directEntries = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]]) ?? []
    let matchedEntry: [String: Any]?
    if let first = directEntries.first {
        matchedEntry = first
    } else {
        // .optionIncludingWindow omits off-Space / off-screen windows on macOS; fall back to .optionAll lookup
        let allEntries = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        matchedEntry = allEntries.first { (($0[kCGWindowNumber as String] as? Int) ?? 0) == windowId }
    }
    guard let entry = matchedEntry else {
        return (false, nil, false, 0, 0, "", "")
    }
    let onScreen = (entry[kCGWindowIsOnscreen as String] as? Bool) == true
    let layer = (entry[kCGWindowLayer as String] as? Int) ?? 0
    let ownerPid = (entry[kCGWindowOwnerPID as String] as? pid_t) ?? 0
    let title = (entry[kCGWindowName as String] as? String) ?? ""
    let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? ""
    return (true, cgWindowBoundsFromEntry(entry), onScreen, layer, ownerPid, title, ownerName)
}

func isScreenLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = dict["CGSSessionScreenIsLocked"] as? Bool { return locked }
    if let lockedNum = dict["CGSSessionScreenIsLocked"] as? NSNumber { return lockedNum.boolValue }
    return false
}

func isTargetWindowOnActiveSpace(_ windowId: Int) -> Bool {
    if windowId <= 0 { return true }
    if windowId >= 1_000_000_000 { return true }
    return cgWindowLiveInfo(windowId: windowId).onScreen
}

func isWindowTopmostAtPoint(windowId: Int, screenPt: CGPoint) -> Bool {
    guard windowId > 0, windowId < 1_000_000_000 else { return false }
    let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for entry in onScreen {
        let ownerPid = (entry[kCGWindowOwnerPID as String] as? pid_t) ?? 0
        let ownerName = entry[kCGWindowOwnerName as String] as? String
        let winName = entry[kCGWindowName as String] as? String
        if isHelperOverlayProcessOrWindow(pid: ownerPid, ownerName: ownerName, windowName: winName) { continue }
        let layer = (entry[kCGWindowLayer as String] as? Int) ?? 0
        if layer != 0 { continue }
        let alpha = (entry[kCGWindowAlpha as String] as? Double) ?? 1.0
        if alpha <= 0.01 { continue }
        guard let b = cgWindowBoundsFromEntry(entry), b.contains(screenPt) else { continue }
        let wid = (entry[kCGWindowNumber as String] as? Int) ?? 0
        return wid == windowId
    }
    return false
}

func enumerateWindows(appFilter: String? = nil, pidFilter: pid_t? = nil, includeMinimized: Bool = true) -> [[String: Any]] {
    let cgList = (CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var cgById: [Int: [String: Any]] = [:]
    var cgByPid: [pid_t: [[String: Any]]] = [:]
    for entry in cgList {
        guard let wid = entry[kCGWindowNumber as String] as? Int,
              let pid = entry[kCGWindowOwnerPID as String] as? pid_t else { continue }
        let ownerName = entry[kCGWindowOwnerName as String] as? String
        let winName = entry[kCGWindowName as String] as? String
        if isHelperOverlayProcessOrWindow(pid: pid, ownerName: ownerName, windowName: winName) { continue }
        let layer = (entry[kCGWindowLayer as String] as? Int) ?? 0
        if layer != 0 { continue }
        cgById[wid] = entry
        cgByPid[pid, default: []].append(entry)
    }

    var results: [[String: Any]] = []
    var seenWindowIds = Set<Int>()

    var pidList: [(pid: pid_t, app: NSRunningApplication?, fallbackName: String)] = []
    if let pf = pidFilter, pf > 0 {
        let rApp = onMain { NSRunningApplication(processIdentifier: pf) }
        let ownerName = (cgByPid[pf]?.first?[kCGWindowOwnerName as String] as? String) ?? rApp?.localizedName ?? "PID-\(pf)"
        if !isHelperOverlayProcessOrWindow(pid: pf, ownerName: ownerName, app: rApp) {
            pidList = [(pf, rApp, ownerName)]
        }
    } else if let filter = appFilter, !filter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        if let target = resolveRunningApp(filter),
           !isHelperOverlayProcessOrWindow(pid: target.processIdentifier, app: target) {
            pidList = [(target.processIdentifier, target, target.localizedName ?? filter)]
        }
    } else {
        var addedPids = Set<pid_t>()
        for app in liveRunningApplications(cgPids: Set(cgByPid.keys)) {
            if isHelperOverlayProcessOrWindow(pid: app.processIdentifier, app: app) { continue }
            if app.activationPolicy == .regular || cgByPid[app.processIdentifier] != nil {
                addedPids.insert(app.processIdentifier)
                let fallback = (cgByPid[app.processIdentifier]?.first?[kCGWindowOwnerName as String] as? String) ?? "PID-\(app.processIdentifier)"
                pidList.append((app.processIdentifier, app, fallback))
            }
        }
        for (pid, entries) in cgByPid where !addedPids.contains(pid) {
            let ownerName = (entries.first?[kCGWindowOwnerName as String] as? String) ?? "PID-\(pid)"
            let rApp = NSRunningApplication(processIdentifier: pid)
            if isHelperOverlayProcessOrWindow(pid: pid, ownerName: ownerName, app: rApp) { continue }
            pidList.append((pid, rApp, ownerName))
        }
    }

    for item in pidList {
        let pid = item.pid
        let app = item.app
        let appName = app?.localizedName ?? item.fallbackName
        let bundleId = app?.bundleIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetMessagingTimeout(axApp, isScreenLocked() ? 0.45 : 1.8)
        var rawWinsRef: CFTypeRef?
        let axWinsErr = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &rawWinsRef)
        let beforeCount = results.count

        if axWinsErr == .success, let rawWins = rawWinsRef as? [AXUIElement], !rawWins.isEmpty {
            for (idx, axWin) in rawWins.enumerated() {
                let role = axString(axWin, kAXRoleAttribute as String) ?? ""
                let subrole = axString(axWin, kAXSubroleAttribute as String)
                // Skip Finder desktop scroll area pseudo-window or non-window AX Application elements
                if role != "AXWindow" { continue }
                if subrole == "AXDesktop" { continue }

                let minimized = axBool(axWin, kAXMinimizedAttribute as String) ?? false
                if !includeMinimized && minimized { continue }

                let title = axString(axWin, kAXTitleAttribute as String) ?? ""
                if title == "Computer Use Cursor" || title == "Computer Use Highlight" { continue }
                let bounds = axBounds(axWin) ?? .zero
                let focused = (axBool(axWin, kAXFocusedAttribute as String) ?? false) || ((app?.isActive == true) && (axBool(axWin, kAXMainAttribute as String) ?? false))
                let isMain = axBool(axWin, kAXMainAttribute as String) ?? false

                var wid: CGWindowID = 0
                let err = _AXUIElementGetWindow(axWin, &wid)
                var resolvedId: Int = (err == .success && wid > 0) ? Int(wid) : 0

                if resolvedId == 0, let candidates = cgByPid[pid] {
                    for cand in candidates {
                        guard let cWid = cand[kCGWindowNumber as String] as? Int, !seenWindowIds.contains(cWid) else { continue }
                        if let cb = cgWindowBoundsFromEntry(cand) {
                            if abs(cb.origin.x - bounds.origin.x) <= 4 && abs(cb.origin.y - bounds.origin.y) <= 4 &&
                               abs(cb.size.width - bounds.size.width) <= 4 && abs(cb.size.height - bounds.size.height) <= 4 {
                                resolvedId = cWid
                                break
                            }
                        }
                    }
                    if resolvedId == 0 && !title.isEmpty {
                        for cand in candidates {
                            guard let cWid = cand[kCGWindowNumber as String] as? Int, !seenWindowIds.contains(cWid) else { continue }
                            if ((cand[kCGWindowName as String] as? String) ?? "") == title {
                                resolvedId = cWid
                                break
                            }
                        }
                    }
                }
                if resolvedId == 0 {
                    resolvedId = 1_000_000_000 + Int(pid) * 1000 + idx
                }
                if resolvedId > 0 && resolvedId < 1_000_000_000 && cgById[resolvedId] == nil {
                    let liveInfo = cgWindowLiveInfo(windowId: resolvedId)
                    if liveInfo.exists && liveInfo.layer != 0 { continue }
                }
                if seenWindowIds.contains(resolvedId) { continue }
                seenWindowIds.insert(resolvedId)

                let effectiveBounds = (bounds.width > 1 && bounds.height > 1)
                    ? bounds
                    : (cgById[resolvedId].flatMap { cgWindowBoundsFromEntry($0) } ?? bounds)

                state.setWindowElement(id: resolvedId, value: (axWindow: axWin, pid: pid, bundleId: bundleId, appName: appName, fallbackBounds: effectiveBounds))

                let onScreen: Bool
                if let cgEntry = cgById[resolvedId] {
                    onScreen = (cgEntry[kCGWindowIsOnscreen as String] as? Bool) == true
                } else {
                    onScreen = !minimized && !(app?.isHidden ?? false)
                }
                results.append([
                    "id": resolvedId,
                    "app": bundleId ?? appName,
                    "appName": appName,
                    "bundleId": bundleId as Any,
                    "pid": Int(pid),
                    "title": title,
                    "role": role,
                    "subrole": subrole as Any,
                    "bounds": rectToDict(effectiveBounds),
                    "focused": focused,
                    "main": isMain,
                    "minimized": minimized,
                    "onScreen": onScreen,
                    "axBacked": true
                ])
            }
        }

        if results.count == beforeCount,
           (app == nil || (app?.activationPolicy == .regular && !(app?.isHidden ?? false))),
           let cgCandidates = cgByPid[pid] {
            // Fallback to CoreGraphics layer-0 windows when AX yielded zero AXWindows (custom-rendered/Electron apps, App Nap, or locked Space)
            let filteredCandidates = cgCandidates.filter { entry in
                let isOnScreen = (entry[kCGWindowIsOnscreen as String] as? Bool) == true
                let rawTitle = (entry[kCGWindowName as String] as? String) ?? ""
                guard isOnScreen || !rawTitle.isEmpty else { return false }
                let storeType = (entry[kCGWindowStoreType as String] as? Int) ?? 1
                if storeType == 0 { return false }
                let alpha = (entry[kCGWindowAlpha as String] as? Double) ?? 1.0
                guard alpha > 0.01, let b = cgWindowBoundsFromEntry(entry) else { return false }
                if b.width < 80 || b.height < 60 { return false }
                if b.origin.y < 0 && b.height <= 40 { return false }
                // Exclude AppKit's hidden (0, mainScreenH - 500, 500, 500) event-routing backing window
                if rawTitle.isEmpty && b.origin.x == 0 && b.width == 500 && b.height == 500 {
                    return false
                }
                return true
            }
            for (idx, cand) in filteredCandidates.enumerated() {
                guard let cWid = cand[kCGWindowNumber as String] as? Int, !seenWindowIds.contains(cWid),
                      let bounds = cgWindowBoundsFromEntry(cand) else { continue }
                seenWindowIds.insert(cWid)
                let title = (cand[kCGWindowName as String] as? String) ?? ""
                let isOnScreen = (cand[kCGWindowIsOnscreen as String] as? Bool) == true
                let isFirst = (idx == 0)
                state.setWindowElement(id: cWid, value: (axWindow: nil, pid: pid, bundleId: bundleId, appName: appName, fallbackBounds: bounds))
                results.append([
                    "id": cWid,
                    "app": bundleId ?? appName,
                    "appName": appName,
                    "bundleId": bundleId as Any,
                    "pid": Int(pid),
                    "title": title,
                    "role": "AXWindow",
                    "subrole": NSNull(),
                    "bounds": rectToDict(bounds),
                    "focused": (app?.isActive == true) && isFirst,
                    "main": isFirst,
                    "minimized": false,
                    "onScreen": isOnScreen,
                    "axBacked": false
                ])
            }
        }
    }
    return results
}

func listAppsWithWindows() -> [[String: Any]] {
    let openWindows = enumerateWindows(appFilter: nil, includeMinimized: true)
    var winsByPid: [Int: [[String: Any]]] = [:]
    for w in openWindows {
        if let pid = w["pid"] as? Int {
            winsByPid[pid, default: []].append(w)
        }
    }

    var byKey: [String: [String: Any]] = [:]
    for inst in scanInstalledApps() {
        let key = (inst["bundleId"] as? String) ?? (inst["id"] as? String) ?? UUID().uuidString
        var item = inst
        item["isRunning"] = false
        item["isActive"] = false
        item["windows"] = [] as [[String: Any]]
        byKey[key] = item
    }

    let wsApps = onMain { NSWorkspace.shared.runningApplications }
    for run in wsApps where !run.isTerminated && run.activationPolicy == .regular {
        let pid = Int(run.processIdentifier)
        let bId = run.bundleIdentifier
        let name = run.localizedName ?? bId ?? "PID-\(pid)"
        let path = run.bundleURL?.path
        let key = bId ?? path ?? "pid:\(pid)"
        var entry = byKey[key] ?? [
            "id": bId ?? name,
            "bundleId": bId as Any,
            "displayName": name,
            "path": path as Any
        ]
        entry["pid"] = pid
        entry["isRunning"] = true
        entry["isActive"] = run.isActive
        entry["isHidden"] = run.isHidden
        entry["windows"] = winsByPid[pid] ?? []
        byKey[key] = entry
    }

    return byKey.values.sorted { a, b in
        let ar = (a["isRunning"] as? Bool) ?? false
        let br = (b["isRunning"] as? Bool) ?? false
        if ar != br { return ar && !br }
        let an = (a["displayName"] as? String) ?? ""
        let bn = (b["displayName"] as? String) ?? ""
        return an.localizedCaseInsensitiveCompare(bn) == .orderedAscending
    }
}

// MARK: - Resolve Target Window

typealias ResolvedWindowTarget = (windowId: Int, axWindow: AXUIElement?, pid: pid_t, bundleId: String?, appName: String, windowMeta: [String: Any])

func resolvedWindowBounds(_ resolved: ResolvedWindowTarget) -> CGRect {
    if let axW = resolved.axWindow, let b = axBounds(axW) {
        return b
    }
    if let liveB = cgWindowLiveInfo(windowId: resolved.windowId).bounds {
        return liveB
    }
    if let h = state.getWindowElement(id: resolved.windowId), h.fallbackBounds != .zero {
        return h.fallbackBounds
    }
    if let bDict = resolved.windowMeta["bounds"] as? [String: Any],
       let x = asDouble(bDict["x"]), let y = asDouble(bDict["y"]),
       let w = asDouble(bDict["width"]), let h = asDouble(bDict["height"]) {
        return CGRect(x: x, y: y, width: w, height: h)
    }
    return .zero
}

func resolveTargetWindow(windowId: Int?, appQuery: String?, windowTitle: String?, autoLaunch: Bool = true) throws -> ResolvedWindowTarget {
    if let wid = windowId {
        if let cached = state.getWindowElement(id: wid) {
            if wid > 0 && wid < 1_000_000_000 {
                let live = cgWindowLiveInfo(windowId: wid)
                if live.exists && live.layer == 0 {
                    // If cached without AX handle while screen was locked and session is now unlocked, attempt single-PID upgrade
                    if cached.axWindow == nil && !isScreenLocked() {
                        let scoped = enumerateWindows(pidFilter: cached.pid, includeMinimized: true)
                        if let meta = scoped.first(where: { ($0["id"] as? Int) == wid }),
                           let handle = state.getWindowElement(id: wid), handle.axWindow != nil {
                            return (wid, handle.axWindow, handle.pid, handle.bundleId, handle.appName, meta)
                        }
                    }
                    let b = (cached.axWindow.flatMap { axBounds($0) }) ?? live.bounds ?? cached.fallbackBounds
                    let title = (cached.axWindow.flatMap { axString($0, kAXTitleAttribute as String) }) ?? live.title
                    let meta: [String: Any] = [
                        "id": wid,
                        "app": cached.bundleId ?? cached.appName,
                        "appName": cached.appName,
                        "bundleId": cached.bundleId as Any,
                        "pid": Int(cached.pid),
                        "title": title,
                        "role": "AXWindow",
                        "bounds": rectToDict(b),
                        "minimized": (cached.axWindow.flatMap { axBool($0, kAXMinimizedAttribute as String) }) ?? false,
                        "onScreen": live.onScreen,
                        "axBacked": cached.axWindow != nil
                    ]
                    return (wid, cached.axWindow, cached.pid, cached.bundleId, cached.appName, meta)
                }
            }
            let scoped = enumerateWindows(pidFilter: cached.pid, includeMinimized: true)
            if let meta = scoped.first(where: { ($0["id"] as? Int) == wid }),
               let handle = state.getWindowElement(id: wid) {
                return (wid, handle.axWindow, handle.pid, handle.bundleId, handle.appName, meta)
            }
        }
        // Direct O(1) WindowServer owner-PID lookup before scanning all system processes
        if wid > 0 && wid < 1_000_000_000 {
            let live = cgWindowLiveInfo(windowId: wid)
            if live.exists && live.layer == 0 && live.ownerPid > 0 && !isHelperOverlayProcessOrWindow(pid: live.ownerPid, ownerName: live.ownerName, windowName: live.title) {
                let scoped = enumerateWindows(pidFilter: live.ownerPid, includeMinimized: true)
                if let meta = scoped.first(where: { ($0["id"] as? Int) == wid }),
                   let handle = state.getWindowElement(id: wid) {
                    return (wid, handle.axWindow, handle.pid, handle.bundleId, handle.appName, meta)
                }
                let rApp = onMain { NSRunningApplication(processIdentifier: live.ownerPid) }
                let appName = rApp?.localizedName ?? (live.ownerName.isEmpty ? "PID-\(live.ownerPid)" : live.ownerName)
                let bundleId = rApp?.bundleIdentifier
                let b = live.bounds ?? .zero
                state.setWindowElement(id: wid, value: (axWindow: nil, pid: live.ownerPid, bundleId: bundleId, appName: appName, fallbackBounds: b))
                let meta: [String: Any] = [
                    "id": wid,
                    "app": bundleId ?? appName,
                    "appName": appName,
                    "bundleId": bundleId as Any,
                    "pid": Int(live.ownerPid),
                    "title": live.title,
                    "role": "AXWindow",
                    "bounds": rectToDict(b),
                    "minimized": false,
                    "onScreen": live.onScreen,
                    "axBacked": false
                ]
                return (wid, nil, live.ownerPid, bundleId, appName, meta)
            }
        }
        if let q = appQuery, !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let scoped = enumerateWindows(appFilter: q, includeMinimized: true)
            if let meta = scoped.first(where: { ($0["id"] as? Int) == wid }),
               let handle = state.getWindowElement(id: wid) {
                return (wid, handle.axWindow, handle.pid, handle.bundleId, handle.appName, meta)
            }
        }
        // Only scan full window list for synthetic (>= 1_000_000_000) AX-only window IDs
        if wid >= 1_000_000_000 {
            let allUnfiltered = enumerateWindows(appFilter: nil, includeMinimized: true)
            if let meta = allUnfiltered.first(where: { ($0["id"] as? Int) == wid }),
               let handle = state.getWindowElement(id: wid) {
                return (wid, handle.axWindow, handle.pid, handle.bundleId, handle.appName, meta)
            }
        }
        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Window ID \(wid) not found (not open or no longer exists)"])
    }

    guard let query = appQuery, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Either windowId or app must be provided"])
    }

    var runningApp = resolveRunningApp(query)
    if runningApp == nil && autoLaunch {
        runningApp = try launchAppSync(query: query, activate: false)
    }
    guard let app = runningApp else {
        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "App '\(query)' is not running"])
    }

    var wins = enumerateWindows(pidFilter: app.processIdentifier, includeMinimized: true)

    // If app was just launched or has no open window yet, try reopening/creating default window gently
    if wins.isEmpty && autoLaunch, let url = app.bundleURL {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        let sem = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in sem.signal() }
        _ = sem.wait(timeout: .now() + .milliseconds(2500))
        Thread.sleep(forTimeInterval: 0.25)
        wins = enumerateWindows(pidFilter: app.processIdentifier, includeMinimized: true)
    }

    if let titleSub = windowTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !titleSub.isEmpty {
        let lower = titleSub.lowercased()
        if let matched = wins.first(where: { (($0["title"] as? String) ?? "").lowercased() == lower })
            ?? wins.first(where: { (($0["title"] as? String) ?? "").lowercased().contains(lower) }) {
            let wid = matched["id"] as! Int
            if let h = state.getWindowElement(id: wid) {
                return (wid, h.axWindow, h.pid, h.bundleId, h.appName, matched)
            }
        }
        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "No window matching title '\(titleSub)' in app '\(query)'"])
    }

    // Prefer main/focused non-minimized window, then first window
    if let chosen = wins.first(where: { ($0["main"] as? Bool) == true && ($0["minimized"] as? Bool) == false })
        ?? wins.first(where: { ($0["minimized"] as? Bool) == false })
        ?? wins.first {
        let wid = chosen["id"] as! Int
        if let h = state.getWindowElement(id: wid) {
            return (wid, h.axWindow, h.pid, h.bundleId, h.appName, chosen)
        }
    }

    throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "App '\(app.localizedName ?? query)' (pid \(app.processIdentifier)) is running but currently has no open windows"])
}

// MARK: - AX Tree Walker & Indexing

let interactiveRoles: Set<String> = [
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXRadioButton", "AXCheckBox",
    "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField",
    "AXSlider", "AXIncrementor", "AXLink", "AXMenuItem", "AXMenuBarItem",
    "AXTab", "AXTabGroup", "AXRow", "AXCell", "AXOutlineRow", "AXDisclosureTriangle",
    "AXColorWell", "AXValueIndicator", "AXSegmentedControl"
]

func cleanActionName(_ raw: String) -> String {
    if raw.hasPrefix("AX") && raw.count > 2 {
        return String(raw.dropFirst(2))
    }
    return raw
}

func walkAXTree(
    root: AXUIElement,
    windowOrigin: CGPoint = .zero,
    maxDepth: Int = 28,
    maxElements: Int = 600
) -> (lines: [String], elements: [Int: CachedAXElement]) {
    var lines: [String] = []
    var elements: [Int: CachedAXElement] = [:]
    var nextIndex = 1
    var visitedHashes = Set<CFHashCode>()

    func visit(_ node: AXUIElement, depth: Int) {
        if nextIndex > maxElements || depth > maxDepth { return }
        let h = CFHash(node)
        if visitedHashes.contains(h) { return }
        visitedHashes.insert(h)

        let role = axString(node, kAXRoleAttribute as String) ?? "AXUnknown"
        let subrole = axString(node, kAXSubroleAttribute as String)
        let title = axString(node, kAXTitleAttribute as String)
        let desc = axString(node, kAXDescriptionAttribute as String)
        let help = axString(node, kAXHelpAttribute as String)
        let rawVal = axString(node, kAXValueAttribute as String)
        let placeholder = axString(node, "AXPlaceholderValue")
        let enabled = axBool(node, kAXEnabledAttribute as String)
        let focused = axBool(node, kAXFocusedAttribute as String) ?? false
        let selected = axBool(node, kAXSelectedAttribute as String) ?? false
        let expanded = axBool(node, kAXExpandedAttribute as String)
        let bounds = axBounds(node)
        let actions = axActions(node)

        // Suppress indexing zero-sized invisible nodes unless focused, while still traversing descendants (e.g. display:contents wrappers)
        let isZeroSized = (depth > 0) && (bounds.map { $0.width < 1 && $0.height < 1 } ?? false) && !focused

        let labelCandidates = [title, desc, placeholder, help].compactMap { s -> String? in
            guard let trimmed = s?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
            return trimmed
        }
        let primaryLabel = labelCandidates.first

        let trimmedValue: String? = {
            guard let v = rawVal?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
            if v.count > 160 { return String(v.prefix(157)) + "..." }
            return v
        }()

        let nonTrivialActions = actions.filter { $0 != "AXCancel" && $0 != "AXRaise" }
        let shouldIndex = !isZeroSized && (
            interactiveRoles.contains(role)
            || !nonTrivialActions.isEmpty
            || primaryLabel != nil
            || (role == "AXStaticText" && trimmedValue != nil)
            || focused
        )

        var childIndent = depth
        if shouldIndex && depth > 0 {
            let idx = nextIndex
            nextIndex += 1
            elements[idx] = CachedAXElement(
                element: node,
                role: role,
                subrole: subrole,
                title: primaryLabel,
                value: trimmedValue,
                bounds: bounds,
                actions: actions
            )

            let indent = String(repeating: "  ", count: max(0, depth - 1))
            var parts: [String] = ["\(indent)[\(idx)] \(cleanActionName(role))"]
            if let sr = subrole, sr != role {
                parts.append("(\(cleanActionName(sr)))")
            }
            if let lbl = primaryLabel {
                let escaped = lbl.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\"", with: "\\\"")
                let clipped = escaped.count > 120 ? String(escaped.prefix(117)) + "..." : escaped
                parts.append("\"\(clipped)\"")
            }
            if let val = trimmedValue, val != primaryLabel {
                let escaped = val.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\"", with: "\\\"")
                parts.append("value=\"\(escaped)\"")
            }
            if enabled == false { parts.append("disabled") }
            if focused { parts.append("focused") }
            if selected { parts.append("selected") }
            if let exp = expanded { parts.append(exp ? "expanded" : "collapsed") }

            let secondaryActions = actions
                .map { cleanActionName($0) }
                .filter { $0 != "Press" && $0 != "Cancel" }
            if !secondaryActions.isEmpty {
                parts.append("actions=[\(secondaryActions.joined(separator: ","))]")
            }
            if let b = bounds {
                let relX = Int((b.origin.x - windowOrigin.x).rounded())
                let relY = Int((b.origin.y - windowOrigin.y).rounded())
                parts.append("@(\(relX),\(relY) \(Int(b.width.rounded()))x\(Int(b.height.rounded())))")
            }
            lines.append(parts.joined(separator: " "))
        } else if depth == 0 {
            childIndent = 0
        }

        if let children = axCopyAttr(node, kAXChildrenAttribute as String) as? [AXUIElement] {
            for child in children {
                if nextIndex > maxElements { break }
                visit(child, depth: childIndent + 1)
            }
        }
    }

    visit(root, depth: 0)
    return (lines, elements)
}

// MARK: - Codex Virtual Cursor & Visual Overlay System (1:1 ComputerUseCursor + FogCursorStyle + VelocityVerlet)

struct CodexSpringParams {
    let response: Double
    let dampingFraction: Double

    static let stretch = CodexSpringParams(response: 0.20, dampingFraction: 0.85)
    static let press = CodexSpringParams(response: 0.20, dampingFraction: 0.85)
    static let visibility = CodexSpringParams(response: 0.42, dampingFraction: 0.86)
    static let scootProgress = CodexSpringParams(response: 0.19, dampingFraction: 0.94)
    static let scootPosition = CodexSpringParams(response: 0.19, dampingFraction: 0.90)
    static let rotation = CodexSpringParams(response: 0.12, dampingFraction: 0.90)
    static let scootTilt = CodexSpringParams(response: 0.055, dampingFraction: 0.82)
    static let scootStretch = CodexSpringParams(response: 0.12, dampingFraction: 0.86)
}

struct CodexSpring1D {
    static let substepDt: Double = 1.0 / 240.0
    static let restThreshold: Double = 0.06

    var value: Double
    var target: Double
    var velocity: Double = 0.0
    var force: Double = 0.0
    var response: Double
    var dampingFraction: Double
    var simulationTime: Double = 0.0
    var scriptTime: Double = 0.0

    init(value: Double, target: Double, params: CodexSpringParams) {
        self.value = value
        self.target = target
        self.response = params.response
        self.dampingFraction = params.dampingFraction
    }

    mutating func snap(to newValue: Double) {
        value = newValue
        target = newValue
        velocity = 0.0
        force = 0.0
        simulationTime = 0.0
        scriptTime = 0.0
    }

    mutating func setAngularTarget(_ degrees: Double) {
        var delta = (degrees - value).truncatingRemainder(dividingBy: 360.0)
        if delta > 180.0 { delta -= 360.0 }
        if delta < -180.0 { delta += 360.0 }
        target = value + delta
    }

    var isAtRest: Bool {
        if simulationTime == 0.0 && value != target {
            return false
        }
        let maxEnergy = max(velocity * velocity, force * force)
        if maxEnergy > Self.restThreshold * Self.restThreshold {
            return false
        }
        let tol = target * 0.01
        let diff = target - value
        if tol == 0.0 {
            return abs(diff) <= 1e-4
        }
        return (diff * diff) <= (tol * tol)
    }

    var isSettled: Bool {
        return value == target && isAtRest
    }

    mutating func step(dt: Double) {
        let resp = max(0.001, response)
        let stepDt = Self.substepDt
        let maxStiff = 1.0 / (2.0 * stepDt * stepDt)
        let twoPi = Double.pi * 2.0
        let stiffness = min((twoPi * twoPi) / (resp * resp), maxStiff)
        let drag = sqrt(stiffness) * 2.0 * dampingFraction

        scriptTime += max(0.0, dt)
        if scriptTime - simulationTime > 1.0 {
            simulationTime = scriptTime - (1.0 / 60.0)
        }
        let halfDt = stepDt * 0.5
        while simulationTime < scriptTime {
            let vHalf = velocity + force * halfDt
            value += vHalf * stepDt
            force = -drag * vHalf + (target - value) * stiffness
            velocity = vHalf + force * halfDt
            simulationTime += stepDt
        }
        if isAtRest {
            value = target
        }
    }
}

struct CodexCubicSegment {
    let control1: CGPoint
    let control2: CGPoint
    let end: CGPoint
}

struct CodexMotionPath {
    let start: CGPoint
    let end: CGPoint
    let startControl: CGPoint
    let endControl: CGPoint
    let arc: CGPoint?
    let arcIn: CGPoint?
    let arcOut: CGPoint?
    let segments: [CodexCubicSegment]
}

struct CodexMotionPathMeasurement {
    let length: Double
    let staysInBounds: Bool
    let angleChangeEnergy: Double
    let maxAngleChange: Double
    let totalTurn: Double
}

enum CodexMotionPlanner {
    static let clickAngleDegrees: Double = -44.0
    static let scootDistanceThreshold: Double = 196.0
    static let boundsMargin: Double = 20.0
    static let startHandle: Double = 0.41960295031576633
    static let endpointHandle: Double = 0.15
    static let arcSize: Double = 0.2765523188064277
    static let arcFlow: Double = 0.5783555327868779
    static let candidateCount: Int = 20
    static let springDampingFraction: Double = 0.90
    static let springResponseMin: Double = 0.12
    static let springResponseMax: Double = 2.20
    static let springResponseScaler: Double = 0.70

    static func normalizeDegrees(_ deg: Double) -> Double {
        let rem = deg.truncatingRemainder(dividingBy: 360.0)
        return rem < 0.0 ? rem + 360.0 : rem
    }

    static func clickDirection(_ angleDeg: Double = clickAngleDegrees) -> CGPoint {
        let rad = angleDeg * (.pi / 180.0)
        return CGPoint(x: sin(rad), y: -cos(rad))
    }

    static func unitVector(_ v: CGPoint) -> CGPoint {
        let len = hypot(v.x, v.y)
        if len < 0.001 {
            return CGPoint(x: 1.0, y: 0.0)
        }
        return CGPoint(x: v.x / len, y: v.y / len)
    }

    static func tangentDegrees(_ tangent: CGPoint) -> Double {
        if hypot(tangent.x, tangent.y) < 0.001 {
            return normalizeDegrees(clickAngleDegrees)
        }
        let u = unitVector(tangent)
        return normalizeDegrees(atan2(Double(u.y), Double(u.x)) * (180.0 / .pi) + 90.0)
    }

    static func clampControlPoint(bounds: CGRect, origin: CGPoint, dir: CGPoint, dist: CGFloat) -> CGPoint {
        var allowed = dist
        if dir.x < 0 {
            allowed = min(allowed, (origin.x - bounds.minX) / (-dir.x))
        } else if dir.x > 0 {
            allowed = min(allowed, (bounds.maxX - origin.x) / dir.x)
        }
        if dir.y < 0 {
            allowed = min(allowed, (origin.y - bounds.minY) / (-dir.y))
        } else if dir.y > 0 {
            allowed = min(allowed, (bounds.maxY - origin.y) / dir.y)
        }
        let d = max(0.0, allowed)
        return CGPoint(x: origin.x + dir.x * d, y: origin.y + dir.y * d)
    }

    static func cubicPoint(_ p0: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ p3: CGPoint, _ t: CGFloat) -> CGPoint {
        let u = 1.0 - t
        let b0 = u * u * u
        let b1 = 3.0 * u * u * t
        let b2 = 3.0 * u * t * t
        let b3 = t * t * t
        return CGPoint(
            x: p0.x * b0 + c1.x * b1 + c2.x * b2 + p3.x * b3,
            y: p0.y * b0 + c1.y * b1 + c2.y * b2 + p3.y * b3
        )
    }

    static func cubicTangent(_ p0: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ p3: CGPoint, _ t: CGFloat) -> CGPoint {
        let u = 1.0 - t
        return CGPoint(
            x: 3.0 * u * u * (c1.x - p0.x) + 6.0 * u * t * (c2.x - c1.x) + 3.0 * t * t * (p3.x - c2.x),
            y: 3.0 * u * u * (c1.y - p0.y) + 6.0 * u * t * (c2.y - c1.y) + 3.0 * t * t * (p3.y - c2.y)
        )
    }

    static func evaluate(_ path: CodexMotionPath, progress: Double) -> (point: CGPoint, tangent: CGPoint) {
        let clamped = max(0.0, min(1.0, progress))
        let count = max(1, path.segments.count)
        let scaled = clamped == 1.0 ? Double(count - 1) : clamped * Double(count)
        let segIdx = min(count - 1, max(0, Int(floor(scaled))))
        let seg = path.segments[segIdx]
        let segStart = segIdx == 0 ? path.start : path.segments[segIdx - 1].end
        let localT = CGFloat(clamped == 1.0 ? 1.0 : (scaled - Double(segIdx)))
        return (
            point: cubicPoint(segStart, seg.control1, seg.control2, seg.end, localT),
            tangent: cubicTangent(segStart, seg.control1, seg.control2, seg.end, localT)
        )
    }

    static func wrapRadians(_ prev: Double, _ next: Double) -> Double {
        var d = next - prev
        while d > .pi { d -= .pi * 2.0 }
        while d < -.pi { d += .pi * 2.0 }
        return d
    }

    static func pointInMargin(_ p: CGPoint, bounds: CGRect, margin: CGFloat) -> Bool {
        return p.x >= bounds.minX + margin
            && p.x <= bounds.maxX - margin
            && p.y >= bounds.minY + margin
            && p.y <= bounds.maxY - margin
    }

    static func measure(_ path: CodexMotionPath, bounds: CGRect?) -> CodexMotionPathMeasurement {
        let margin = CGFloat(boundsMargin)
        var length: Double = 0.0
        var energy: Double = 0.0
        var maxChange: Double = 0.0
        var totalTurn: Double = 0.0
        var prevAngle: Double? = nil
        var staysIn = bounds.map { pointInMargin(path.start, bounds: $0, margin: margin) } ?? true

        var segStart = path.start
        var prevPt = path.start
        for seg in path.segments {
            for step in 1...24 {
                let t = CGFloat(step) / 24.0
                let pt = cubicPoint(segStart, seg.control1, seg.control2, seg.end, t)
                let dx = Double(pt.x - prevPt.x)
                let dy = Double(pt.y - prevPt.y)
                let stepLen = hypot(dx, dy)
                length += stepLen
                if let b = bounds, staysIn {
                    staysIn = pointInMargin(pt, bounds: b, margin: margin)
                }
                if stepLen > 0.01 {
                    let ang = atan2(dy, dx)
                    if let pa = prevAngle {
                        let delta = wrapRadians(pa, ang)
                        energy += delta * delta
                        maxChange = max(maxChange, abs(delta))
                        totalTurn += abs(delta)
                    }
                    prevAngle = ang
                }
                prevPt = pt
            }
            segStart = seg.end
        }
        return CodexMotionPathMeasurement(
            length: length,
            staysInBounds: staysIn,
            angleChangeEnergy: energy,
            maxAngleChange: maxChange,
            totalTurn: totalTurn
        )
    }

    static func awkwardApproachFactor(_ path: CodexMotionPath) -> Double {
        let clickVec = clickDirection(clickAngleDegrees)
        let chord = unitVector(CGPoint(x: path.end.x - path.start.x, y: path.end.y - path.start.y))
        let dot = Double(chord.x * clickVec.x + chord.y * clickVec.y)
        return max(0.0, min(1.0, (-dot - 0.08) / 0.92))
    }

    static func pathCost(_ path: CodexMotionPath, _ m: CodexMotionPathMeasurement) -> Double {
        let chord = max(1.0, Double(hypot(path.end.x - path.start.x, path.end.y - path.start.y)))
        let excess = max(0.0, m.length / chord - 1.0)
        let arcPenalty = path.arc == nil ? 0.0 : 45.0
        let awkward = awkwardApproachFactor(path)
        return m.length
            + excess * 320.0
            + m.angleChangeEnergy * 140.0
            + m.maxAngleChange * 180.0
            + m.totalTurn * 18.0
            + awkward * 90.0
            + arcPenalty
    }

    static func responseForPath(_ path: CodexMotionPath) -> Double {
        let m = measure(path, bounds: nil)
        let chord = max(1.0, Double(hypot(path.end.x - path.start.x, path.end.y - path.start.y)))
        let excess = max(0.0, m.length / chord - 1.0)
        let lenNorm = max(0.0, min(1.0, (m.length - 180.0) / 760.0))
        let exNorm = max(0.0, min(1.0, excess / 0.55))
        let turnNorm = max(0.0, min(1.0, m.totalTurn / (.pi * 1.4)))
        let energyNorm = max(0.0, min(1.0, m.angleChangeEnergy / 1.25))
        let curveNorm = max(0.0, min(1.0, exNorm * 0.42 + turnNorm * 0.38 + energyNorm * 0.20))
        let awkward = awkwardApproachFactor(path)
        let arcAdd = path.arc == nil ? 0.0 : 0.04
        let arcMul = path.arc == nil ? 1.0 : 0.90
        let raw = (0.42 + lenNorm * 0.22 + curveNorm * 0.12 + awkward * 0.28 + arcAdd) * springResponseScaler * arcMul
        return max(springResponseMin, min(springResponseMax, raw))
    }

    static func planPath(start: CGPoint, end: CGPoint, bounds: CGRect) -> (path: CodexMotionPath, params: CodexSpringParams) {
        let clickTan = clickDirection(clickAngleDegrees)
        let dist = hypot(end.x - start.x, end.y - start.y)
        let delta = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let chordDir = unitVector(delta)
        let startDist = max(48.0, min(640.0, min(dist * CGFloat(startHandle), dist * 0.90)))
        let endDist = max(48.0, min(640.0, min(dist * CGFloat(endpointHandle), dist * 0.90)))
        let oppClickTan = CGPoint(x: -clickTan.x, y: -clickTan.y)

        let cStart = clampControlPoint(bounds: bounds, origin: start, dir: clickTan, dist: startDist)
        let cEnd = clampControlPoint(bounds: bounds, origin: end, dir: oppClickTan, dist: endDist)
        let cStartTight = clampControlPoint(bounds: bounds, origin: start, dir: clickTan, dist: startDist * 0.65)
        let cEndTight = clampControlPoint(bounds: bounds, origin: end, dir: oppClickTan, dist: endDist * 0.65)

        let perp = CGPoint(x: -chordDir.y, y: chordDir.x)
        let sign: CGFloat = (perp.x * clickTan.x + perp.y * clickTan.y >= 0.0) ? 1.0 : -1.0
        let naturalNormal = CGPoint(x: perp.x * sign, y: perp.y * sign)
        let mid = CGPoint(x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5)

        let arcDistBase = max(50.0, min(520.0, dist * CGFloat(arcSize)))
        let arcHandleBase = max(38.0, min(440.0, dist * CGFloat(arcFlow)))

        var candidates: [CodexMotionPath] = [
            CodexMotionPath(
                start: start,
                end: end,
                startControl: cStart,
                endControl: cEnd,
                arc: nil,
                arcIn: nil,
                arcOut: nil,
                segments: [CodexCubicSegment(control1: cStart, control2: cEnd, end: end)]
            ),
            CodexMotionPath(
                start: start,
                end: end,
                startControl: cStartTight,
                endControl: cEndTight,
                arc: nil,
                arcIn: nil,
                arcOut: nil,
                segments: [CodexCubicSegment(control1: cStartTight, control2: cEndTight, end: end)]
            )
        ]

        let distScales: [CGFloat] = [0.55, 0.80, 1.05]
        let handleScales: [CGFloat] = [0.65, 1.00, 1.35]
        for ds in distScales {
            for hs in handleScales {
                for normalSign in [CGFloat(1.0), CGFloat(-1.0)] {
                    let n = CGPoint(x: naturalNormal.x * normalSign, y: naturalNormal.y * normalSign)
                    let m = arcDistBase * ds
                    let h = arcHandleBase * hs
                    let arcPt = CGPoint(
                        x: mid.x + n.x * m + clickTan.x * startDist * 0.16,
                        y: mid.y + n.y * m + clickTan.y * startDist * 0.16
                    )
                    let arcIn = CGPoint(x: arcPt.x - chordDir.x * h, y: arcPt.y - chordDir.y * h)
                    let arcOut = CGPoint(x: arcPt.x + chordDir.x * h, y: arcPt.y + chordDir.y * h)
                    candidates.append(
                        CodexMotionPath(
                            start: start,
                            end: end,
                            startControl: cStart,
                            endControl: cEnd,
                            arc: arcPt,
                            arcIn: arcIn,
                            arcOut: arcOut,
                            segments: [
                                CodexCubicSegment(control1: cStart, control2: arcIn, end: arcPt),
                                CodexCubicSegment(control1: arcOut, control2: cEnd, end: end)
                            ]
                        )
                    )
                }
            }
        }

        let limited = Array(candidates.prefix(candidateCount))
        var bestInBounds = limited[0]
        var bestInCost = Double.infinity
        var bestAny = limited[0]
        var bestAnyCost = Double.infinity

        for cand in limited {
            let m = measure(cand, bounds: bounds)
            let cost = pathCost(cand, m)
            if cost < bestAnyCost {
                bestAny = cand
                bestAnyCost = cost
            }
            if m.staysInBounds && cost < bestInCost {
                bestInBounds = cand
                bestInCost = cost
            }
        }

        let chosen = bestInCost.isFinite ? bestInBounds : bestAny
        let resp = responseForPath(chosen)
        return (chosen, CodexSpringParams(response: resp, dampingFraction: springDampingFraction))
    }
}

enum ActiveCursorMotion {
    case bezier(path: CodexMotionPath, progressSpring: CodexSpring1D)
    case scoot(start: CGPoint, end: CGPoint, axisRotation: Double, rotationTarget: Double, progressSpring: CodexSpring1D)
}

struct CursorRipple {
    let screenPt: CGPoint
    let startTime: TimeInterval
    let duration: TimeInterval
    let colorKind: String
    let ringCount: Int
}

struct CursorRenderSnapshot {
    let hotspotInCanvas: CGPoint
    let currentScreenPt: CGPoint
    let visibility: CGFloat
    let opacity: CGFloat
    let rotationDegrees: CGFloat
    let scootAxisDegrees: CGFloat
    let scootRotationDegrees: CGFloat
    let scootStretch: CGFloat
    let velocityStretch: CGFloat
    let pressScale: CGFloat
    let fogScale: CGFloat
    let isPressed: Bool
    let isDragging: Bool
    let ripples: [CursorRipple]
    let scrollDirection: String?
    let scrollProgress: CGFloat
    let badgeText: String?
    let badgeColorKind: String
    let badgeOpacity: CGFloat
    let now: TimeInterval
}

func cursorAccentRGB(_ kind: String) -> (r: CGFloat, g: CGFloat, b: CGFloat) {
    switch kind.lowercased() {
    case "right", "r", "secondary":
        return (0.66, 0.33, 0.97)
    case "middle", "m":
        return (0.96, 0.62, 0.04)
    default:
        return (0.22, 0.74, 0.97)
    }
}

func makeCodexAgentCursorCanonicalPath() -> CGPath {
    // Exact normalized AgentCursor Bezier geometry from SkyComputerUseService (23x24)
    // rotated +44deg into canonical up-pointing frame with rounded tip apex at (0, 0).
    let p = CGMutablePath()
    p.move(to: CGPoint(x: -2.691, y: 1.684))
    p.addCurve(
        to: CGPoint(x: 2.258, y: 1.379),
        control1: CGPoint(x: -1.613, y: -0.414),
        control2: CGPoint(x: 1.287, y: -0.592)
    )
    p.addLine(to: CGPoint(x: 10.077, y: 17.279))
    p.addCurve(
        to: CGPoint(x: 6.527, y: 21.339),
        control1: CGPoint(x: 11.150, y: 19.465),
        control2: CGPoint(x: 8.864, y: 22.079)
    )
    p.addLine(to: CGPoint(x: -0.682, y: 19.053))
    p.addLine(to: CGPoint(x: -8.035, y: 22.234))
    p.addCurve(
        to: CGPoint(x: -11.381, y: 18.599),
        control1: CGPoint(x: -10.421, y: 23.266),
        control2: CGPoint(x: -12.576, y: 20.925)
    )
    p.closeSubpath()
    return p
}

let codexAgentCursorCanonicalPath: CGPath = makeCodexAgentCursorCanonicalPath()

func drawCodexElementHighlight(in cg: CGContext, rect: CGRect, opacity: CGFloat) {
    guard opacity > 0.01, rect.width >= 2, rect.height >= 2 else { return }
    cg.saveGState()
    let inset = rect.insetBy(dx: 1.5, dy: 1.5)
    let radius = min(8.0, min(inset.width, inset.height) * 0.25)
    let path = CGPath(roundedRect: inset, cornerWidth: radius, cornerHeight: radius, transform: nil)

    cg.setFillColor(CGColor(red: 0.22, green: 0.74, blue: 0.97, alpha: 0.08 * opacity))
    cg.addPath(path)
    cg.fillPath()

    cg.setShadow(
        offset: .zero,
        blur: 5.5,
        color: CGColor(red: 0.06, green: 0.65, blue: 0.91, alpha: 0.45 * opacity)
    )
    cg.setStrokeColor(CGColor(red: 0.22, green: 0.74, blue: 0.97, alpha: 0.90 * opacity))
    cg.setLineWidth(1.8)
    cg.addPath(path)
    cg.strokePath()
    cg.restoreGState()
}

func drawCodexCursorGraphics(in cg: CGContext, canvasSize: CGSize, snapshot: CursorRenderSnapshot) {
    let alpha = max(0.0, min(1.0, snapshot.opacity))
    let hasRipples = !snapshot.ripples.isEmpty
    guard alpha > 0.01 || hasRipples else { return }

    let hx = snapshot.hotspotInCanvas.x
    let hy = snapshot.hotspotInCanvas.y
    let rgbSpace = CGColorSpaceCreateDeviceRGB()

    // 1. FogCursorStyle Dynamic Luminous Frosted Backdrop Aura (0.72x daintier scale, 1.0x -> 2.5x with velocity)
    if alpha > 0.01 {
        cg.saveGState()
        let rotRad = (snapshot.rotationDegrees + snapshot.scootRotationDegrees) * (.pi / 180.0)
        // Offset aura slightly along body axis behind tip so the mist surrounds the daintier pointer body
        let bodyCenterOffset: CGFloat = 7.5 * snapshot.pressScale
        let fogCenter = CGPoint(
            x: hx - sin(rotRad) * bodyCenterOffset,
            y: hy + cos(rotRad) * bodyCenterOffset
        )
        let fogRadius = (snapshot.isDragging ? 17.5 : 13.5) * max(1.0, min(2.5, snapshot.fogScale))
        // Authentic Codex FogCursorStyle sky-blue luminous mist (Package_ComputerUse.bundle LensSequence/Lens_frame_22.png: #0B9EFF -> #3EC0FF -> #BCE9FC)
        let fogColors = [
            CGColor(red: 0.043, green: 0.620, blue: 1.000, alpha: 0.34 * alpha),
            CGColor(red: 0.243, green: 0.753, blue: 1.000, alpha: 0.18 * alpha),
            CGColor(red: 0.737, green: 0.914, blue: 0.988, alpha: 0.0)
        ] as CFArray
        let fogLocs: [CGFloat] = [0.0, 0.52, 1.0]
        if let grad = CGGradient(colorsSpace: rgbSpace, colors: fogColors, locations: fogLocs) {
            cg.drawRadialGradient(
                grad,
                startCenter: fogCenter,
                startRadius: 0.0,
                endCenter: fogCenter,
                endRadius: fogRadius,
                options: []
            )
        }
        cg.restoreGState()
    }

    // 2. Daintier Click Pulse Rings (anchored in screen coordinates)
    for ripple in snapshot.ripples {
        let elapsed = snapshot.now - ripple.startTime
        if elapsed < 0 || elapsed > ripple.duration { continue }
        let p = CGFloat(elapsed / ripple.duration)
        let rx = hx + (ripple.screenPt.x - snapshot.currentScreenPt.x)
        let ry = hy + (ripple.screenPt.y - snapshot.currentScreenPt.y)
        let accent = cursorAccentRGB(ripple.colorKind)

        cg.saveGState()
        if p < 0.24 {
            let flashAlpha = (1.0 - p / 0.24) * 0.34
            cg.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: flashAlpha))
            cg.fillEllipse(in: CGRect(x: rx - 4.2, y: ry - 4.2, width: 8.4, height: 8.4))
        }

        let rings = max(1, min(3, ripple.ringCount))
        for ringIdx in 0..<rings {
            let delay = CGFloat(ringIdx) * 0.15
            if p < delay { continue }
            let rp = min(1.0, (p - delay) / max(0.2, 1.0 - delay))
            let eased = 1.0 - pow(1.0 - rp, 2.6)
            let radius = 5.5 + 16.5 * eased
            let ringAlpha = pow(1.0 - rp, 1.55) * 0.86
            cg.setStrokeColor(CGColor(red: accent.r, green: accent.g, blue: accent.b, alpha: ringAlpha))
            cg.setLineWidth(max(0.85, 1.5 * (1.0 - rp * 0.55)))
            cg.strokeEllipse(in: CGRect(x: rx - radius, y: ry - radius, width: radius * 2.0, height: radius * 2.0))
        }
        cg.restoreGState()
    }

    // 3. Directional Scroll Indicator
    if alpha > 0.01, let dir = snapshot.scrollDirection, snapshot.scrollProgress < 1.0 {
        let sp = snapshot.scrollProgress
        let waveAlpha = sin(sp * .pi) * 0.86 * alpha
        if waveAlpha > 0.02 {
            cg.saveGState()
            cg.setStrokeColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: waveAlpha))
            cg.setShadow(offset: CGSize(width: 0, height: 1), blur: 2.5, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.42 * waveAlpha))
            cg.setLineWidth(1.5)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)

            let drift = (sp - 0.5) * 7.0
            for idx in 0..<2 {
                let step = CGFloat(idx) * 4.8
                let path = CGMutablePath()
                switch dir {
                case "up", "u":
                    let cy = hy - 10.0 - step + drift
                    path.move(to: CGPoint(x: hx - 3.6, y: cy + 2.5))
                    path.addLine(to: CGPoint(x: hx, y: cy))
                    path.addLine(to: CGPoint(x: hx + 3.6, y: cy + 2.5))
                case "left", "l":
                    let cx = hx - 10.0 - step + drift
                    path.move(to: CGPoint(x: cx + 2.5, y: hy - 3.6))
                    path.addLine(to: CGPoint(x: cx, y: hy))
                    path.addLine(to: CGPoint(x: cx + 2.5, y: hy + 3.6))
                case "right", "r":
                    let cx = hx + 14.0 + step - drift
                    path.move(to: CGPoint(x: cx - 2.5, y: hy - 3.6))
                    path.addLine(to: CGPoint(x: cx, y: hy))
                    path.addLine(to: CGPoint(x: cx - 2.5, y: hy + 3.6))
                default:
                    let cy = hy + 18.0 + step - drift
                    path.move(to: CGPoint(x: hx - 3.6, y: cy - 2.5))
                    path.addLine(to: CGPoint(x: hx, y: cy))
                    path.addLine(to: CGPoint(x: hx + 3.6, y: cy - 2.5))
                }
                cg.addPath(path)
                cg.strokePath()
            }
            cg.restoreGState()
        }
    }

    // 4. Daintier 0.72x Codex AgentCursor (Tip anchored at exact (0, 0), ~16.5pt tall, sleek ~2.0pt white border, pill-free)
    if alpha > 0.01 {
        cg.saveGState()
        cg.translateBy(x: hx, y: hy)

        let visClamped = max(0.0, min(1.0, snapshot.visibility))
        let visScale: CGFloat = 0.40 + 0.60 * visClamped
        let scootS = max(0.20, min(1.0, snapshot.scootStretch))
        if abs(scootS - 1.0) > 0.001 {
            let axisRad = snapshot.scootAxisDegrees * (.pi / 180.0)
            cg.rotate(by: axisRad)
            cg.scaleBy(x: 1.0, y: scootS)
            cg.rotate(by: -axisRad)
        }

        let totalRotRad = (snapshot.rotationDegrees + snapshot.scootRotationDegrees) * (.pi / 180.0)
        cg.rotate(by: totalRotRad)

        let baseCursorScale: CGFloat = 0.72
        let combinedScale = visScale * snapshot.pressScale * baseCursorScale
        let dartWidthScale = max(0.65, min(1.0, snapshot.velocityStretch)) * combinedScale
        cg.scaleBy(x: dartWidthScale, y: combinedScale)

        // Soft ambient drop shadow + sleek white border (~2.0pt effective screen width: 2.78 * 0.72 = 2.00pt)
        let visBlurExtra = (1.0 - visClamped) * 4.0
        cg.saveGState()
        cg.setShadow(
            offset: CGSize(width: 0.0, height: 1.5),
            blur: 3.8 + visBlurExtra,
            color: CGColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.36 * alpha)
        )
        cg.setLineJoin(.round)
        cg.setLineCap(.round)
        cg.setLineWidth(2.78)
        cg.setStrokeColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.98 * alpha))
        cg.addPath(codexAgentCursorCanonicalPath)
        cg.strokePath()
        cg.restoreGState()

        // Rich pure black pointer body matching Codex SoftwareCursor (#000000 -> #0D0D11)
        cg.saveGState()
        cg.addPath(codexAgentCursorCanonicalPath)
        cg.clip()
        let bodyColors = [
            CGColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 1.0 * alpha),
            CGColor(red: 0.05, green: 0.05, blue: 0.067, alpha: 1.0 * alpha)
        ] as CFArray
        let bodyLocs: [CGFloat] = [0.0, 1.0]
        if let bodyGrad = CGGradient(colorsSpace: rgbSpace, colors: bodyColors, locations: bodyLocs) {
            cg.drawLinearGradient(
                bodyGrad,
                start: CGPoint(x: 0.0, y: 0.0),
                end: CGPoint(x: 0.0, y: 22.5),
                options: []
            )
        } else {
            cg.setFillColor(CGColor(red: 0.02, green: 0.02, blue: 0.03, alpha: 0.99 * alpha))
            cg.fill(CGRect(x: -16, y: -4, width: 32, height: 30))
        }
        cg.restoreGState()

        cg.restoreGState()
    }
}

final class VirtualCursorCanvasView: NSView {
    override var isFlipped: Bool { true }
    var snapshot: CursorRenderSnapshot? = nil

    override func draw(_ dirtyRect: NSRect) {
        guard let snap = snapshot, let cg = NSGraphicsContext.current?.cgContext else { return }
        drawCodexCursorGraphics(in: cg, canvasSize: bounds.size, snapshot: snap)
    }
}

final class ElementHighlightCanvasView: NSView {
    override var isFlipped: Bool { true }
    var highlightOpacity: CGFloat = 0.0

    override func draw(_ dirtyRect: NSRect) {
        guard highlightOpacity > 0.01, let cg = NSGraphicsContext.current?.cgContext else { return }
        let localRect = bounds.insetBy(dx: 4.0, dy: 4.0)
        drawCodexElementHighlight(in: cg, rect: localRect, opacity: highlightOpacity)
    }
}

final class UnconstrainedOverlayWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }
}

final class VirtualCursorInstance {
    static let canvasSize: CGFloat = 240.0
    static let halfCanvas: CGFloat = 120.0
    static let restingRotationDeg: Double = CodexMotionPlanner.normalizeDegrees(CodexMotionPlanner.clickAngleDegrees)

    let windowId: Int
    var pid: pid_t
    var axWindow: AXUIElement?
    var windowOrigin: CGPoint

    let cursorWindow: UnconstrainedOverlayWindow
    let cursorView: VirtualCursorCanvasView
    let highlightWindow: UnconstrainedOverlayWindow
    let highlightView: ElementHighlightCanvasView

    var isVisible: Bool = false
    var opacity: CGFloat = 0.0
    var currentScreenPt: CGPoint = .zero
    var startScreenPt: CGPoint = .zero
    var targetScreenPt: CGPoint = .zero
    var lastTickTime: TimeInterval = 0.0
    var isGliding: Bool = false

    // Exact 240Hz Velocity-Verlet state springs
    var motion: ActiveCursorMotion? = nil
    var positionXSpring: CodexSpring1D
    var positionYSpring: CodexSpring1D
    var rotationSpring: CodexSpring1D
    var scootAxisSpring: CodexSpring1D
    var scootRotationSpring: CodexSpring1D
    var scootStretchSpring: CodexSpring1D
    var stretchSpring: CodexSpring1D
    var pressScaleSpring: CodexSpring1D
    var visibilitySpring: CodexSpring1D

    var rotationDegrees: Double
    var scootAxisRotation: Double = 0.0

    var isPressed: Bool = false
    var pressReleaseAt: TimeInterval = 0.0
    var isDragging: Bool = false

    var ripples: [CursorRipple] = []

    var scrollDirection: String? = nil
    var scrollStartTime: TimeInterval = 0.0
    let scrollDuration: TimeInterval = 0.38

    var badgeText: String? = nil
    var badgeColorKind: String = "left"
    var badgeSetTime: TimeInterval = 0.0

    var highlightScreenRect: CGRect? = nil
    var highlightSetTime: TimeInterval = 0.0
    var highlightOpacity: CGFloat = 0.0

    var lastActivityTime: TimeInterval = 0.0
    var healthTickCounter: Int = 0
    var pendingCloseEnoughCallbacks: [(distanceThreshold: CGFloat, progressThreshold: Double, fire: () -> Void)] = []

    init(windowId: Int, pid: pid_t, axWindow: AXUIElement?, windowOrigin: CGPoint) {
        self.windowId = windowId
        self.pid = pid
        self.axWindow = axWindow
        self.windowOrigin = windowOrigin

        let restDeg = Self.restingRotationDeg
        self.rotationDegrees = restDeg
        self.positionXSpring = CodexSpring1D(value: 0, target: 0, params: .scootPosition)
        self.positionYSpring = CodexSpring1D(value: 0, target: 0, params: .scootPosition)
        self.rotationSpring = CodexSpring1D(value: restDeg, target: restDeg, params: .rotation)
        self.scootAxisSpring = CodexSpring1D(value: 0, target: 0, params: .rotation)
        self.scootRotationSpring = CodexSpring1D(value: 0, target: 0, params: .scootTilt)
        self.scootStretchSpring = CodexSpring1D(value: 1, target: 1, params: .scootStretch)
        self.stretchSpring = CodexSpring1D(value: 1, target: 1, params: .stretch)
        self.pressScaleSpring = CodexSpring1D(value: 1, target: 1, params: .press)
        self.visibilitySpring = CodexSpring1D(value: 0, target: 0, params: .visibility)

        let isGlobal = (windowId <= 0)
        let winCursorLevel: NSWindow.Level = isGlobal ? .statusBar : .normal
        let winHighlightLevel: NSWindow.Level = isGlobal
            ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue - 1)
            : .normal
        let behavior: NSWindow.CollectionBehavior = isGlobal
            ? [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            : [.fullScreenAuxiliary, .stationary, .ignoresCycle]

        let cSize = VirtualCursorInstance.canvasSize
        let cWin = UnconstrainedOverlayWindow(
            contentRect: NSRect(x: 0, y: 0, width: cSize, height: cSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        cWin.title = "Computer Use Cursor"
        cWin.isOpaque = false
        cWin.backgroundColor = .clear
        cWin.hasShadow = false
        cWin.ignoresMouseEvents = true
        cWin.level = winCursorLevel
        cWin.collectionBehavior = behavior
        cWin.isReleasedWhenClosed = false

        let cView = VirtualCursorCanvasView(frame: NSRect(x: 0, y: 0, width: cSize, height: cSize))
        cWin.contentView = cView

        let hWin = UnconstrainedOverlayWindow(
            contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        hWin.title = "Computer Use Highlight"
        hWin.isOpaque = false
        hWin.backgroundColor = .clear
        hWin.hasShadow = false
        hWin.ignoresMouseEvents = true
        hWin.level = winHighlightLevel
        hWin.collectionBehavior = behavior
        hWin.isReleasedWhenClosed = false

        let hView = ElementHighlightCanvasView(frame: NSRect(x: 0, y: 0, width: 40, height: 40))
        hWin.contentView = hView

        self.cursorWindow = cWin
        self.cursorView = cView
        self.highlightWindow = hWin
        self.highlightView = hView
    }

    func snapTo(_ pt: CGPoint) {
        motion = nil
        isGliding = false
        currentScreenPt = pt
        startScreenPt = pt
        targetScreenPt = pt
        positionXSpring.snap(to: Double(pt.x))
        positionYSpring.snap(to: Double(pt.y))
        rotationSpring.snap(to: Self.restingRotationDeg)
        rotationDegrees = Self.restingRotationDeg
        scootAxisSpring.snap(to: 0.0)
        scootRotationSpring.snap(to: 0.0)
        scootStretchSpring.snap(to: 1.0)
        stretchSpring.snap(to: 1.0)
        scootAxisRotation = 0.0
    }

    func shiftForWindowDelta(dx: CGFloat, dy: CGFloat) {
        currentScreenPt = CGPoint(x: currentScreenPt.x + dx, y: currentScreenPt.y + dy)
        startScreenPt = CGPoint(x: startScreenPt.x + dx, y: startScreenPt.y + dy)
        targetScreenPt = CGPoint(x: targetScreenPt.x + dx, y: targetScreenPt.y + dy)
        positionXSpring.value += Double(dx)
        positionXSpring.target += Double(dx)
        positionYSpring.value += Double(dy)
        positionYSpring.target += Double(dy)
        if let hr = highlightScreenRect {
            highlightScreenRect = hr.offsetBy(dx: dx, dy: dy)
        }
        if let m = motion {
            switch m {
            case .scoot(let s, let e, let axis, let rotT, let prog):
                motion = .scoot(
                    start: CGPoint(x: s.x + dx, y: s.y + dy),
                    end: CGPoint(x: e.x + dx, y: e.y + dy),
                    axisRotation: axis,
                    rotationTarget: rotT,
                    progressSpring: prog
                )
            case .bezier(let p, let prog):
                let shiftedSegs = p.segments.map {
                    CodexCubicSegment(
                        control1: CGPoint(x: $0.control1.x + dx, y: $0.control1.y + dy),
                        control2: CGPoint(x: $0.control2.x + dx, y: $0.control2.y + dy),
                        end: CGPoint(x: $0.end.x + dx, y: $0.end.y + dy)
                    )
                }
                let shiftedPath = CodexMotionPath(
                    start: CGPoint(x: p.start.x + dx, y: p.start.y + dy),
                    end: CGPoint(x: p.end.x + dx, y: p.end.y + dy),
                    startControl: CGPoint(x: p.startControl.x + dx, y: p.startControl.y + dy),
                    endControl: CGPoint(x: p.endControl.x + dx, y: p.endControl.y + dy),
                    arc: p.arc.map { CGPoint(x: $0.x + dx, y: $0.y + dy) },
                    arcIn: p.arcIn.map { CGPoint(x: $0.x + dx, y: $0.y + dy) },
                    arcOut: p.arcOut.map { CGPoint(x: $0.x + dx, y: $0.y + dy) },
                    segments: shiftedSegs
                )
                motion = .bezier(path: shiftedPath, progressSpring: prog)
            }
        }
    }

    func startMotion(to target: CGPoint, screenBounds: CGRect) {
        let start = currentScreenPt
        startScreenPt = start
        targetScreenPt = target
        let dist = Double(hypot(target.x - start.x, target.y - start.y))
        if dist < 0.5 {
            snapTo(target)
            return
        }

        isGliding = true
        if dist <= CodexMotionPlanner.scootDistanceThreshold {
            // Codex Scoot Mode (<= 196pt): preserves existing positionX/Y velocity for chained glides!
            let dir = CodexMotionPlanner.unitVector(CGPoint(x: target.x - start.x, y: target.y - start.y))
            let axisRot = hypot(target.x - start.x, target.y - start.y) < 0.001
                ? 0.0
                : atan2(Double(dir.y), Double(dir.x)) * (180.0 / .pi)
            let rotTarget = max(-1.0, min(1.0, Double(dir.x) * 0.75 + Double(-dir.y) * 0.62)) * 70.0

            positionXSpring.response = CodexSpringParams.scootPosition.response
            positionXSpring.dampingFraction = CodexSpringParams.scootPosition.dampingFraction
            positionYSpring.response = CodexSpringParams.scootPosition.response
            positionYSpring.dampingFraction = CodexSpringParams.scootPosition.dampingFraction
            positionXSpring.target = Double(target.x)
            positionYSpring.target = Double(target.y)
            rotationSpring.setAngularTarget(Self.restingRotationDeg)
            scootAxisSpring.setAngularTarget(axisRot)

            let prog = CodexSpring1D(value: 0.0, target: 1.0, params: .scootProgress)
            motion = .scoot(
                start: start,
                end: target,
                axisRotation: axisRot,
                rotationTarget: rotTarget,
                progressSpring: prog
            )
        } else {
            // Codex Curved Bezier / 2-Segment Arc Mode (> 196pt)
            let planned = CodexMotionPlanner.planPath(start: start, end: target, bounds: screenBounds)
            let followerResp = max(0.035, min(0.12, planned.params.response * 0.18))
            positionXSpring.response = followerResp
            positionXSpring.dampingFraction = planned.params.dampingFraction
            positionYSpring.response = followerResp
            positionYSpring.dampingFraction = planned.params.dampingFraction

            let prog = CodexSpring1D(value: 0.0, target: 1.0, params: planned.params)
            motion = .bezier(path: planned.path, progressSpring: prog)
        }
    }

    func stepPhysics(dt: Double, now: TimeInterval) {
        let clampedDt = max(1.0 / 240.0, min(0.05, dt))
        var currentProgress: Double = 1.0

        if let active = motion {
            switch active {
            case .bezier(let path, var progSpring):
                scootStretchSpring.target = 1.0
                scootRotationSpring.target = 0.0
                progSpring.step(dt: clampedDt)
                let p = max(0.0, min(1.0, progSpring.value))
                currentProgress = p
                let eval = CodexMotionPlanner.evaluate(path, progress: p)
                var tanDeg = CodexMotionPlanner.tangentDegrees(eval.tangent)
                // Smooth terminal tangent blend into -44deg click orientation on final approach (SkyComputerUseService terminalTangentBlendStart)
                if p > 0.96 {
                    let blend = max(0.0, min(1.0, (p - 0.96) / 0.04))
                    var diff = (Self.restingRotationDeg - tanDeg).truncatingRemainder(dividingBy: 360.0)
                    if diff > 180.0 { diff -= 360.0 }
                    if diff < -180.0 { diff += 360.0 }
                    tanDeg = CodexMotionPlanner.normalizeDegrees(tanDeg + diff * blend)
                }

                positionXSpring.target = Double(eval.point.x)
                positionYSpring.target = Double(eval.point.y)
                rotationSpring.setAngularTarget(tanDeg)
                scootAxisSpring.setAngularTarget(0.0)

                let prevPt = currentScreenPt
                positionXSpring.step(dt: clampedDt)
                positionYSpring.step(dt: clampedDt)
                rotationSpring.step(dt: clampedDt)
                scootAxisSpring.step(dt: clampedDt)

                let newPt = CGPoint(x: positionXSpring.value, y: positionYSpring.value)
                let speed = Double(hypot(newPt.x - prevPt.x, newPt.y - prevPt.y)) / max(clampedDt, 1.0 / 240.0)
                currentScreenPt = newPt
                rotationDegrees = rotationSpring.value
                scootAxisRotation = scootAxisSpring.value
                stretchSpring.target = max(0.65, min(1.0, 1.0 - speed / 5500.0))

                let closePos = hypot(newPt.x - path.end.x, newPt.y - path.end.y) <= 0.85
                    && abs(positionXSpring.velocity) <= 12.0
                    && abs(positionYSpring.velocity) <= 12.0
                if p >= 0.999 && abs(progSpring.velocity) < 0.01 && closePos {
                    currentScreenPt = path.end
                    positionXSpring.snap(to: Double(path.end.x))
                    positionYSpring.snap(to: Double(path.end.y))
                    rotationSpring.snap(to: Self.restingRotationDeg)
                    rotationDegrees = Self.restingRotationDeg
                    scootAxisSpring.snap(to: 0.0)
                    scootAxisRotation = 0.0
                    stretchSpring.target = 1.0
                    motion = nil
                    isGliding = false
                } else {
                    motion = .bezier(path: path, progressSpring: progSpring)
                }

            case .scoot(let start, let end, let axisRot, let rotTarget, var progSpring):
                progSpring.step(dt: clampedDt)
                positionXSpring.target = Double(end.x)
                positionYSpring.target = Double(end.y)
                scootAxisSpring.setAngularTarget(axisRot)
                rotationSpring.setAngularTarget(Self.restingRotationDeg)

                positionXSpring.step(dt: clampedDt)
                positionYSpring.step(dt: clampedDt)
                rotationSpring.step(dt: clampedDt)
                scootAxisSpring.step(dt: clampedDt)

                let newPt = CGPoint(x: positionXSpring.value, y: positionYSpring.value)
                currentScreenPt = newPt
                rotationDegrees = rotationSpring.value
                scootAxisRotation = scootAxisSpring.value

                let dx = Double(end.x - start.x)
                let dy = Double(end.y - start.y)
                let chordSq = dx * dx + dy * dy
                let projP: Double = chordSq < 0.001
                    ? 1.0
                    : max(0.0, min(1.0, ((Double(newPt.x - start.x) * dx) + (Double(newPt.y - start.y) * dy)) / chordSq))
                currentProgress = max(projP, max(0.0, min(1.0, progSpring.value)))
                let bell = sin(min(1.0, projP) * .pi)

                stretchSpring.target = 1.0
                scootStretchSpring.target = 1.0 + (1.0 - bell - 1.0) * 0.15 // lerp(1, 1 - sin(p*pi), 0.15)
                scootRotationSpring.target = rotTarget * bell

                let closePos = hypot(newPt.x - end.x, newPt.y - end.y) <= 0.85
                    && abs(positionXSpring.velocity) <= 12.0
                    && abs(positionYSpring.velocity) <= 12.0
                if projP >= 0.999 && abs(progSpring.velocity) < 0.01 && closePos {
                    currentScreenPt = end
                    positionXSpring.snap(to: Double(end.x))
                    positionYSpring.snap(to: Double(end.y))
                    rotationSpring.snap(to: Self.restingRotationDeg)
                    rotationDegrees = Self.restingRotationDeg
                    scootAxisSpring.snap(to: 0.0)
                    scootRotationSpring.snap(to: 0.0)
                    scootStretchSpring.snap(to: 1.0)
                    scootAxisRotation = 0.0
                    motion = nil
                    isGliding = false
                } else {
                    motion = .scoot(
                        start: start,
                        end: end,
                        axisRotation: axisRot,
                        rotationTarget: rotTarget,
                        progressSpring: progSpring
                    )
                }
            }
        } else {
            isGliding = false
            stretchSpring.target = 1.0
            scootStretchSpring.target = 1.0
            scootRotationSpring.target = 0.0
            rotationSpring.setAngularTarget(Self.restingRotationDeg)
            rotationSpring.step(dt: clampedDt)
            rotationDegrees = rotationSpring.value
        }

        pressScaleSpring.target = (isPressed || isDragging) ? 0.70 : 1.0
        visibilitySpring.step(dt: clampedDt)
        stretchSpring.step(dt: clampedDt)
        scootStretchSpring.step(dt: clampedDt)
        scootRotationSpring.step(dt: clampedDt)
        pressScaleSpring.step(dt: clampedDt)
        opacity = CGFloat(max(0.0, min(1.0, visibilitySpring.value)))

        // Fire CloseEnough callbacks as soon as cursor enters close-enough zone (preserving arrival momentum!)
        if !pendingCloseEnoughCallbacks.isEmpty {
            let distRemaining = hypot(targetScreenPt.x - currentScreenPt.x, targetScreenPt.y - currentScreenPt.y)
            var remaining: [(distanceThreshold: CGFloat, progressThreshold: Double, fire: () -> Void)] = []
            var toFire: [() -> Void] = []
            for cb in pendingCloseEnoughCallbacks {
                if !isGliding || distRemaining <= cb.distanceThreshold || (currentProgress >= cb.progressThreshold && distRemaining <= 24.0) {
                    toFire.append(cb.fire)
                } else {
                    remaining.append(cb)
                }
            }
            pendingCloseEnoughCallbacks = remaining
            for f in toFire { f() }
        }
    }

    var hasActiveSprings: Bool {
        return motion != nil
            || !positionXSpring.isSettled
            || !positionYSpring.isSettled
            || !rotationSpring.isSettled
            || !scootAxisSpring.isSettled
            || !scootRotationSpring.isSettled
            || !scootStretchSpring.isSettled
            || !stretchSpring.isSettled
            || !pressScaleSpring.isSettled
            || !visibilitySpring.isSettled
    }

    func flushPendingCallbacks() {
        let callbacks = pendingCloseEnoughCallbacks
        pendingCloseEnoughCallbacks.removeAll()
        for cb in callbacks {
            cb.fire()
        }
    }

    func updateWindowFrames(primaryHeight: CGFloat, refreshOrdering: Bool = false) {
        let onActiveSpace = isTargetWindowOnActiveSpace(windowId)
        if !onActiveSpace {
            if cursorWindow.isVisible || highlightWindow.isVisible {
                cursorWindow.alphaValue = 0.0
                highlightWindow.alphaValue = 0.0
                cursorWindow.orderOut(nil)
                highlightWindow.orderOut(nil)
                CATransaction.flush()
            }
            return
        }

        let hasDirectWindowNumber = (windowId > 0 && windowId < 1_000_000_000)

        if let hRect = highlightScreenRect, highlightOpacity > 0.01 {
            let padded = hRect.insetBy(dx: -6.0, dy: -6.0)
            let appKitHRect = NSRect(
                x: padded.origin.x,
                y: primaryHeight - (padded.origin.y + padded.size.height),
                width: max(12.0, padded.size.width),
                height: max(12.0, padded.size.height)
            )
            highlightWindow.setFrame(appKitHRect, display: false)
            highlightView.frame = NSRect(origin: .zero, size: appKitHRect.size)
            highlightView.highlightOpacity = highlightOpacity
            highlightView.needsDisplay = true
            highlightWindow.alphaValue = 1.0
            if hasDirectWindowNumber {
                if !highlightWindow.isVisible || refreshOrdering {
                    highlightWindow.order(.above, relativeTo: windowId)
                }
            } else if !highlightWindow.isVisible {
                highlightWindow.orderFrontRegardless()
            }
        } else if highlightWindow.isVisible {
            highlightWindow.alphaValue = 0.0
            highlightWindow.orderOut(nil)
            CATransaction.flush()
        }

        let appKitOrigin = NSPoint(
            x: currentScreenPt.x - VirtualCursorInstance.halfCanvas,
            y: (primaryHeight - currentScreenPt.y) - VirtualCursorInstance.halfCanvas
        )
        cursorWindow.setFrameOrigin(appKitOrigin)
        if opacity > 0.01 || !ripples.isEmpty {
            cursorWindow.alphaValue = 1.0
            if hasDirectWindowNumber {
                if !cursorWindow.isVisible || refreshOrdering {
                    let anchorWinNum = (highlightWindow.isVisible && highlightWindow.windowNumber > 0)
                        ? highlightWindow.windowNumber
                        : windowId
                    cursorWindow.order(.above, relativeTo: anchorWinNum)
                }
            } else if !cursorWindow.isVisible {
                cursorWindow.orderFrontRegardless()
            }
        }
    }

    func makeRenderSnapshot(hotspotInCanvas: CGPoint, now: TimeInterval, deterministicForScreenshot: Bool = false) -> CursorRenderSnapshot {
        let scrollProg: CGFloat = {
            guard scrollDirection != nil else { return 1.0 }
            let el = now - scrollStartTime
            if el < 0 { return 0.0 }
            return min(1.0, CGFloat(el / scrollDuration))
        }()
        let visVal = deterministicForScreenshot ? 1.0 : CGFloat(max(0.0, min(1.0, visibilitySpring.value)))
        let effOpacity = deterministicForScreenshot ? max(opacity, 1.0) : opacity
        let velNorm = min(1.0, max(0.0, (abs(positionXSpring.velocity) + abs(positionYSpring.velocity)) * 0.5 / 3000.0))
        let fogScale = deterministicForScreenshot ? 1.0 : CGFloat(1.0 + velNorm * 1.5)

        return CursorRenderSnapshot(
            hotspotInCanvas: hotspotInCanvas,
            currentScreenPt: deterministicForScreenshot ? targetScreenPt : currentScreenPt,
            visibility: visVal,
            opacity: effOpacity,
            rotationDegrees: deterministicForScreenshot ? CGFloat(Self.restingRotationDeg) : CGFloat(rotationDegrees),
            scootAxisDegrees: deterministicForScreenshot ? 0.0 : CGFloat(scootAxisRotation),
            scootRotationDegrees: deterministicForScreenshot ? 0.0 : CGFloat(scootRotationSpring.value),
            scootStretch: deterministicForScreenshot ? 1.0 : CGFloat(scootStretchSpring.value),
            velocityStretch: deterministicForScreenshot ? 1.0 : CGFloat(stretchSpring.value),
            pressScale: CGFloat(pressScaleSpring.value),
            fogScale: fogScale,
            isPressed: isPressed,
            isDragging: isDragging,
            ripples: ripples,
            scrollDirection: scrollProg < 1.0 ? scrollDirection : nil,
            scrollProgress: scrollProg,
            badgeText: nil,
            badgeColorKind: badgeColorKind,
            badgeOpacity: 0.0,
            now: now
        )
    }

    func orderOutWindows() {
        flushPendingCallbacks()
        isVisible = false
        opacity = 0.0
        visibilitySpring.snap(to: 0.0)
        highlightOpacity = 0.0
        highlightScreenRect = nil
        badgeText = nil
        ripples.removeAll()
        cursorWindow.alphaValue = 0.0
        highlightWindow.alphaValue = 0.0
        cursorWindow.orderOut(nil)
        highlightWindow.orderOut(nil)
        CATransaction.flush()
    }

    func destroyWindows() {
        orderOutWindows()
        cursorWindow.close()
        highlightWindow.close()
        CATransaction.flush()
    }
}

final class VirtualCursorManager {
    static let shared = VirtualCursorManager()

    private var instances: [Int: VirtualCursorInstance] = [:]
    private var animTimer: Timer? = nil
    var enabled: Bool = true
    var idleTimeoutSec: TimeInterval = 8.0
    var glideEnabled: Bool = true

    private init() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
                self?.removeCursorsOnMain(forPid: app.processIdentifier)
            }
        }
        nc.addObserver(
            forName: NSWorkspace.didHideApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
                self?.removeCursorsOnMain(forPid: app.processIdentifier)
            }
        }
    }

    private func ensureTimerOnMain() {
        if animTimer == nil {
            // 120Hz ProMotion frame-paced RunLoop driver with exact CACurrentMediaTime delta sub-stepping (240Hz Verlet)
            let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
                self?.tickOnMain()
            }
            RunLoop.main.add(t, forMode: .common)
            animTimer = t
        }
    }

    private func screenBoundsContaining(_ pt: CGPoint) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
        for scr in NSScreen.screens {
            let f = scr.frame
            let cgRect = CGRect(x: f.origin.x, y: primaryHeight - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height)
            if cgRect.insetBy(dx: -40, dy: -40).contains(pt) {
                return cgRect
            }
        }
        let main = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGRect(x: main.origin.x, y: primaryHeight - (main.origin.y + main.size.height), width: main.size.width, height: main.size.height)
    }

    private func getOrCreateOnMain(windowId: Int, pid: pid_t, axWindow: AXUIElement?, windowOrigin: CGPoint) -> VirtualCursorInstance {
        if let existing = instances[windowId] {
            existing.pid = pid
            if let axW = axWindow { existing.axWindow = axW }
            existing.windowOrigin = windowOrigin
            return existing
        }
        let created = VirtualCursorInstance(windowId: windowId, pid: pid, axWindow: axWindow, windowOrigin: windowOrigin)
        instances[windowId] = created
        return created
    }

    private func tickOnMain() {
        let now = CACurrentMediaTime()
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
        var anyActive = false
        var deadIds: [Int] = []

        for (wid, inst) in instances {
            // Periodic target app/window health & live movement check (~100ms at 120Hz)
            inst.healthTickCounter += 1
            let shouldCheckHealth = (inst.healthTickCounter >= 12)
            if shouldCheckHealth {
                inst.healthTickCounter = 0
                if inst.pid > 0 {
                    let terminated: Bool
                    if let rApp = NSRunningApplication(processIdentifier: inst.pid) {
                        terminated = rApp.isTerminated
                    } else {
                        terminated = (kill(inst.pid, 0) != 0 && errno == ESRCH)
                    }
                    if terminated {
                        deadIds.append(wid)
                        continue
                    }
                }
                if wid > 0 {
                    let cgInfo = cgWindowLiveInfo(windowId: wid)
                    if let axW = inst.axWindow {
                        var roleRef: CFTypeRef?
                        let roleErr = AXUIElementCopyAttributeValue(axW, kAXRoleAttribute as CFString, &roleRef)
                        if roleErr == .invalidUIElement || (roleErr != .success && wid < 1_000_000_000 && !cgInfo.exists) {
                            deadIds.append(wid)
                            continue
                        }
                        if axBool(axW, kAXMinimizedAttribute as String) == true {
                            deadIds.append(wid)
                            continue
                        }
                        if let liveB = axBounds(axW) ?? cgInfo.bounds {
                            let dx = liveB.origin.x - inst.windowOrigin.x
                            let dy = liveB.origin.y - inst.windowOrigin.y
                            if abs(dx) >= 0.5 || abs(dy) >= 0.5 {
                                inst.windowOrigin = liveB.origin
                                inst.shiftForWindowDelta(dx: dx, dy: dy)
                            }
                        }
                    } else {
                        if wid < 1_000_000_000 && !cgInfo.exists {
                            deadIds.append(wid)
                            continue
                        }
                        if let liveB = cgInfo.bounds {
                            let dx = liveB.origin.x - inst.windowOrigin.x
                            let dy = liveB.origin.y - inst.windowOrigin.y
                            if abs(dx) >= 0.5 || abs(dy) >= 0.5 {
                                inst.windowOrigin = liveB.origin
                                inst.shiftForWindowDelta(dx: dx, dy: dy)
                            }
                        }
                    }
                }
            }

            let dt = inst.lastTickTime > 0 ? max(1.0 / 240.0, min(0.05, now - inst.lastTickTime)) : (1.0 / 120.0)
            inst.lastTickTime = now

            // Release press compression automatically after hold duration
            if inst.isPressed && !inst.isDragging && now >= inst.pressReleaseAt {
                inst.isPressed = false
            }

            // Prune expired click ripples
            inst.ripples.removeAll { now - $0.startTime > $0.duration }

            // Visibility spring target (Codex Qo = { response: 0.42, dampingFraction: 0.86 })
            let idleSec = now - inst.lastActivityTime
            let stayActive = inst.isVisible && (idleSec < idleTimeoutSec || inst.isDragging || inst.isGliding)
            inst.visibilitySpring.target = stayActive ? 1.0 : 0.0

            inst.stepPhysics(dt: dt, now: now)

            if stayActive {
                if inst.highlightScreenRect != nil {
                    inst.highlightOpacity = min(1.0, inst.highlightOpacity + CGFloat(dt * 8.0))
                } else {
                    inst.highlightOpacity = 0.0
                }
            } else {
                if inst.highlightScreenRect != nil {
                    inst.highlightOpacity = max(0.0, inst.highlightOpacity - CGFloat(dt * 3.5))
                } else {
                    inst.highlightOpacity = 0.0
                }
                if inst.opacity <= 0.01 && inst.ripples.isEmpty {
                    inst.orderOutWindows()
                    continue
                }
            }

            inst.updateWindowFrames(primaryHeight: primaryHeight, refreshOrdering: shouldCheckHealth)
            let center = CGPoint(x: VirtualCursorInstance.halfCanvas, y: VirtualCursorInstance.halfCanvas)
            inst.cursorView.snapshot = inst.makeRenderSnapshot(hotspotInCanvas: center, now: now)
            inst.cursorView.needsDisplay = true
            anyActive = true
        }

        for wid in deadIds {
            if let inst = instances.removeValue(forKey: wid) {
                inst.destroyWindows()
            }
        }

        if !anyActive {
            animTimer?.invalidate()
            animTimer = nil
        }
    }

    func glideToAndAwaitCloseEnough(
        windowId: Int,
        pid: pid_t,
        axWindow: AXUIElement?,
        targetScreenPt: CGPoint,
        windowOrigin: CGPoint,
        highlightRect: CGRect? = nil,
        badge: String? = nil,
        badgeColorKind: String = "left",
        showCursor: Bool = true
    ) {
        guard showCursor else { return }
        let sem = DispatchSemaphore(value: 0)
        var shouldWait = false

        onMain {
            guard self.enabled else { return }
            let now = CACurrentMediaTime()
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
            let inst = self.getOrCreateOnMain(windowId: windowId, pid: pid, axWindow: axWindow, windowOrigin: windowOrigin)

            // Fire any callbacks from an earlier chained glide on this window while preserving VelocityVerlet momentum!
            inst.flushPendingCallbacks()

            let wasVisible = inst.isVisible && inst.opacity > 0.05
            inst.isVisible = true
            inst.lastActivityTime = now
            inst.lastTickTime = now

            if let hRect = highlightRect, hRect.width >= 2, hRect.height >= 2 {
                inst.highlightScreenRect = hRect
                inst.highlightSetTime = now
                inst.highlightOpacity = 1.0
            } else {
                inst.highlightScreenRect = nil
                inst.highlightOpacity = 0.0
            }

            // Mouse pill permanently suppressed (always nil)
            inst.badgeText = nil
            inst.badgeColorKind = badgeColorKind

            if !wasVisible {
                if self.glideEnabled {
                    // Entrance spring (Qo: scale 0.4->1.0 + soft approach glide)
                    inst.visibilitySpring.value = 0.35
                    inst.visibilitySpring.target = 1.0
                    inst.opacity = 0.35
                    let entryStart = CGPoint(x: targetScreenPt.x - 32.0, y: targetScreenPt.y + 26.0)
                    let screenRect = self.screenBoundsContaining(entryStart).union(self.screenBoundsContaining(targetScreenPt))
                    inst.snapTo(entryStart)
                    inst.startMotion(to: targetScreenPt, screenBounds: screenRect)
                    inst.pendingCloseEnoughCallbacks.append((distanceThreshold: 12.0, progressThreshold: 0.85, fire: { sem.signal() }))
                    shouldWait = true
                } else {
                    inst.visibilitySpring.snap(to: 1.0)
                    inst.opacity = 1.0
                    inst.snapTo(targetScreenPt)
                }
            } else if self.glideEnabled {
                inst.visibilitySpring.target = 1.0
                let dist = hypot(targetScreenPt.x - inst.currentScreenPt.x, targetScreenPt.y - inst.currentScreenPt.y)
                if dist < 2.5 && !inst.isGliding {
                    inst.snapTo(targetScreenPt)
                } else {
                    let screenRect = self.screenBoundsContaining(inst.currentScreenPt).union(self.screenBoundsContaining(targetScreenPt))
                    inst.startMotion(to: targetScreenPt, screenBounds: screenRect)
                    inst.pendingCloseEnoughCallbacks.append((distanceThreshold: 14.0, progressThreshold: 0.86, fire: { sem.signal() }))
                    shouldWait = true
                }
            } else {
                inst.visibilitySpring.snap(to: 1.0)
                inst.opacity = 1.0
                inst.snapTo(targetScreenPt)
            }

            inst.updateWindowFrames(primaryHeight: primaryHeight, refreshOrdering: true)
            let center = CGPoint(x: VirtualCursorInstance.halfCanvas, y: VirtualCursorInstance.halfCanvas)
            inst.cursorView.snapshot = inst.makeRenderSnapshot(hotspotInCanvas: center, now: now)
            inst.cursorView.needsDisplay = true
            self.ensureTimerOnMain()
        }

        if shouldWait && !Thread.isMainThread {
            _ = sem.wait(timeout: .now() + .milliseconds(550))
        }
    }

    func triggerClickEffect(
        windowId: Int,
        screenPt: CGPoint,
        button: String = "left",
        clickCount: Int = 1,
        holdDurationMs: Int? = nil,
        showCursor: Bool = true
    ) {
        guard showCursor else { return }
        onMain {
            guard self.enabled, let inst = self.instances[windowId] else { return }
            let now = CACurrentMediaTime()
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
            inst.lastActivityTime = now
            inst.isPressed = true
            inst.pressScaleSpring.target = 0.70
            let holdSec = holdDurationMs.map { max(0.09, min(2.0, Double($0) / 1000.0)) } ?? 0.115
            inst.pressReleaseAt = now + holdSec
            inst.ripples.append(
                CursorRipple(
                    screenPt: screenPt,
                    startTime: now,
                    duration: clickCount > 1 ? 0.88 : 0.76,
                    colorKind: button,
                    ringCount: max(1, min(3, clickCount))
                )
            )
            inst.updateWindowFrames(primaryHeight: primaryHeight)
            let center = CGPoint(x: VirtualCursorInstance.halfCanvas, y: VirtualCursorInstance.halfCanvas)
            inst.cursorView.snapshot = inst.makeRenderSnapshot(hotspotInCanvas: center, now: now)
            inst.cursorView.needsDisplay = true
            self.ensureTimerOnMain()
        }
    }

    func triggerScrollEffect(windowId: Int, direction: String, showCursor: Bool = true) {
        guard showCursor else { return }
        onMain {
            guard self.enabled, let inst = self.instances[windowId] else { return }
            let now = CACurrentMediaTime()
            inst.lastActivityTime = now
            inst.scrollDirection = direction
            inst.scrollStartTime = now
            let center = CGPoint(x: VirtualCursorInstance.halfCanvas, y: VirtualCursorInstance.halfCanvas)
            inst.cursorView.snapshot = inst.makeRenderSnapshot(hotspotInCanvas: center, now: now)
            inst.cursorView.needsDisplay = true
            self.ensureTimerOnMain()
        }
    }

    func setDragState(windowId: Int, screenPt: CGPoint, isDragging: Bool, showCursor: Bool = true) {
        guard showCursor else { return }
        DispatchQueue.main.async {
            guard self.enabled, let inst = self.instances[windowId] else { return }
            let now = CACurrentMediaTime()
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
            let prev = inst.currentScreenPt
            inst.currentScreenPt = screenPt
            inst.targetScreenPt = screenPt
            inst.positionXSpring.snap(to: Double(screenPt.x))
            inst.positionYSpring.snap(to: Double(screenPt.y))
            inst.motion = nil
            inst.isGliding = false
            inst.isDragging = isDragging
            inst.isPressed = isDragging
            inst.pressScaleSpring.target = isDragging ? 0.70 : 1.0
            inst.lastActivityTime = now

            let dx = screenPt.x - prev.x
            let dy = screenPt.y - prev.y
            let stepDist = hypot(dx, dy)
            if stepDist > 0.6 {
                let tanDeg = CodexMotionPlanner.tangentDegrees(CGPoint(x: dx, y: dy))
                inst.rotationSpring.setAngularTarget(tanDeg)
                inst.stretchSpring.target = max(0.72, min(1.0, 1.0 - Double(stepDist) / 90.0))
            } else if !isDragging {
                inst.rotationSpring.setAngularTarget(VirtualCursorInstance.restingRotationDeg)
                inst.stretchSpring.target = 1.0
            }
            if !isDragging {
                inst.ripples.append(
                    CursorRipple(
                        screenPt: screenPt,
                        startTime: now,
                        duration: 0.42,
                        colorKind: "left",
                        ringCount: 1
                    )
                )
            }
            inst.updateWindowFrames(primaryHeight: primaryHeight)
            let center = CGPoint(x: VirtualCursorInstance.halfCanvas, y: VirtualCursorInstance.halfCanvas)
            inst.cursorView.snapshot = inst.makeRenderSnapshot(hotspotInCanvas: center, now: now)
            inst.cursorView.needsDisplay = true
            self.ensureTimerOnMain()
        }
    }

    func updateWindowMoved(windowId: Int, oldOrigin: CGPoint, newOrigin: CGPoint) {
        DispatchQueue.main.async {
            guard let inst = self.instances[windowId], inst.isVisible else { return }
            let dx = newOrigin.x - oldOrigin.x
            let dy = newOrigin.y - oldOrigin.y
            inst.windowOrigin = newOrigin
            inst.shiftForWindowDelta(dx: dx, dy: dy)
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 1080.0
            inst.updateWindowFrames(primaryHeight: primaryHeight, refreshOrdering: true)
        }
    }

    func removeCursor(windowId: Int) {
        onMain {
            if let inst = self.instances.removeValue(forKey: windowId) {
                inst.destroyWindows()
            }
        }
    }

    private func removeCursorsOnMain(forPid pid: pid_t) {
        let matching = instances.filter { $0.value.pid == pid }.map { $0.key }
        for wid in matching {
            if let inst = instances.removeValue(forKey: wid) {
                inst.destroyWindows()
            }
        }
    }

    func removeCursors(forPid pid: pid_t) {
        onMain {
            self.removeCursorsOnMain(forPid: pid)
        }
    }

    func clearAll() {
        onMain {
            for (_, inst) in self.instances {
                inst.destroyWindows()
            }
            self.instances.removeAll()
            self.animTimer?.invalidate()
            self.animTimer = nil
        }
    }

    func shutdownAll() {
        clearAll()
    }

    func touchActivityIfVisible(windowId: Int) {
        onMain {
            if let inst = self.instances[windowId], inst.isVisible && inst.opacity > 0.01 {
                inst.lastActivityTime = CACurrentMediaTime()
            }
        }
    }

    func getCursorDict(windowId: Int, windowOrigin: CGPoint? = nil) -> [String: Any]? {
        return onMain {
            guard let inst = self.instances[windowId], inst.isVisible && inst.opacity > 0.01 else {
                return nil
            }
            let origin = windowOrigin ?? inst.windowOrigin
            return [
                "windowId": windowId,
                "pid": Int(inst.pid),
                "visible": true,
                "targetOnScreen": isTargetWindowOnActiveSpace(windowId),
                "opacity": Double((inst.opacity * 100).rounded() / 100),
                "x": Double((inst.currentScreenPt.x - origin.x).rounded()),
                "y": Double((inst.currentScreenPt.y - origin.y).rounded()),
                "screenX": Double(inst.currentScreenPt.x.rounded()),
                "screenY": Double(inst.currentScreenPt.y.rounded()),
                "targetX": Double((inst.targetScreenPt.x - origin.x).rounded()),
                "targetY": Double((inst.targetScreenPt.y - origin.y).rounded()),
                "rotation": Double((inst.rotationDegrees * 10).rounded() / 10),
                "isGliding": inst.isGliding,
                "isPressed": inst.isPressed,
                "isDragging": inst.isDragging,
                "activeRipples": inst.ripples.count,
                "badge": inst.badgeText as Any,
                "highlightedBounds": inst.highlightScreenRect.map { rectToDict($0) } as Any
            ]
        }
    }

    func getFullState(filterWindowId: Int? = nil) -> [String: Any] {
        return onMain {
            var cursors: [[String: Any]] = []
            for wid in self.instances.keys.sorted() {
                if let fw = filterWindowId, wid != fw { continue }
                guard let inst = self.instances[wid] else { continue }
                if !inst.isVisible && inst.opacity <= 0.01 && inst.ripples.isEmpty { continue }
                cursors.append([
                    "windowId": wid,
                    "pid": Int(inst.pid),
                    "visible": inst.isVisible && inst.opacity > 0.01,
                    "targetOnScreen": isTargetWindowOnActiveSpace(wid),
                    "opacity": Double((inst.opacity * 100).rounded() / 100),
                    "x": Double((inst.currentScreenPt.x - inst.windowOrigin.x).rounded()),
                    "y": Double((inst.currentScreenPt.y - inst.windowOrigin.y).rounded()),
                    "screenX": Double(inst.currentScreenPt.x.rounded()),
                    "screenY": Double(inst.currentScreenPt.y.rounded()),
                    "targetX": Double((inst.targetScreenPt.x - inst.windowOrigin.x).rounded()),
                    "targetY": Double((inst.targetScreenPt.y - inst.windowOrigin.y).rounded()),
                    "rotation": Double((inst.rotationDegrees * 10).rounded() / 10),
                    "isGliding": inst.isGliding,
                    "isPressed": inst.isPressed,
                    "isDragging": inst.isDragging,
                    "activeRipples": inst.ripples.count,
                    "badge": inst.badgeText as Any,
                    "highlightedBounds": inst.highlightScreenRect.map { rectToDict($0) } as Any
                ])
            }

            let selfPid = ProcessInfo.processInfo.processIdentifier
            let cgOnScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            var overlays: [[String: Any]] = []
            for entry in cgOnScreen {
                guard let ownerPid = entry[kCGWindowOwnerPID as String] as? pid_t, ownerPid == selfPid else { continue }
                let name = (entry[kCGWindowName as String] as? String) ?? ""
                guard name == "Computer Use Cursor" || name == "Computer Use Highlight" else { continue }
                let winAlpha = (entry[kCGWindowAlpha as String] as? Double) ?? 1.0
                guard winAlpha > 0.001 else { continue }
                let bDict = (entry[kCGWindowBounds as String] as? [String: Any]) ?? [:]
                let ox = (bDict["X"] as? Double) ?? 0.0
                let oy = (bDict["Y"] as? Double) ?? 0.0
                let ow = (bDict["Width"] as? Double) ?? 0.0
                let oh = (bDict["Height"] as? Double) ?? 0.0
                overlays.append([
                    "overlayWindowNumber": (entry[kCGWindowNumber as String] as? Int) ?? 0,
                    "title": name,
                    "layer": (entry[kCGWindowLayer as String] as? Int) ?? 0,
                    "alpha": winAlpha,
                    "bounds": [
                        "x": ox.rounded(),
                        "y": oy.rounded(),
                        "width": ow.rounded(),
                        "height": oh.rounded()
                    ],
                    "hotspotScreen": [
                        "x": (ox + ow * 0.5).rounded(),
                        "y": (oy + oh * 0.5).rounded()
                    ]
                ])
            }

            return [
                "config": [
                    "enabled": self.enabled,
                    "idleTimeoutMs": Int((self.idleTimeoutSec * 1000.0).rounded()),
                    "glideEnabled": self.glideEnabled
                ],
                "cursors": cursors,
                "onScreenOverlays": overlays
            ]
        }
    }

    func compositeIntoWindowContext(windowId: Int, windowBounds: CGRect, cg: CGContext, canvasSize: CGSize) {
        onMain {
            guard let inst = self.instances[windowId],
                  (inst.isVisible && inst.opacity > 0.01) || !inst.ripples.isEmpty else {
                return
            }
            let now = CACurrentMediaTime()
            if let hRect = inst.highlightScreenRect, inst.highlightOpacity > 0.01 {
                let localHRect = CGRect(
                    x: hRect.origin.x - windowBounds.origin.x,
                    y: hRect.origin.y - windowBounds.origin.y,
                    width: hRect.width,
                    height: hRect.height
                )
                drawCodexElementHighlight(in: cg, rect: localHRect, opacity: max(inst.highlightOpacity, 0.92))
            }
            let anchorPt = inst.isDragging ? inst.currentScreenPt : inst.targetScreenPt
            let localHotspot = CGPoint(
                x: anchorPt.x - windowBounds.origin.x,
                y: anchorPt.y - windowBounds.origin.y
            )
            let snap = inst.makeRenderSnapshot(hotspotInCanvas: localHotspot, now: now, deterministicForScreenshot: !inst.isDragging)
            drawCodexCursorGraphics(in: cg, canvasSize: canvasSize, snapshot: snap)
        }
    }
}

// MARK: - Window Screenshot & AX Wireframe Fallback (Point-Normalized + Optional Cursor Overlay)

func captureWindowScreenshot(
    windowId: Int,
    windowBounds: CGRect,
    title: String,
    elements: [Int: CachedAXElement],
    includeCursor: Bool = false
) -> [String: Any]? {
    let targetW = max(1, Int((windowBounds.width > 0 ? windowBounds.width : 800).rounded()))
    let targetH = max(1, Int((windowBounds.height > 0 ? windowBounds.height : 600).rounded()))
    let w = max(1, min(4096, targetW))
    let h = max(1, min(4096, targetH))
    let scaleX = CGFloat(w) / CGFloat(targetW)
    let scaleY = CGFloat(h) / CGFloat(targetH)

    if #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() {
        let sem = DispatchSemaphore(value: 0)
        var capturedCGImage: CGImage? = nil
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                if let scWin = content.windows.first(where: { Int($0.windowID) == windowId }) {
                    let filter = SCContentFilter(desktopIndependentWindow: scWin)
                    let cfg = SCStreamConfiguration()
                    // Normalize to 1:1 point resolution matching window-relative AX & click coordinates
                    cfg.width = w
                    cfg.height = h
                    cfg.showsCursor = false
                    capturedCGImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
                }
            } catch {
                capturedCGImage = nil
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + .seconds(4))
        if let cgImg = capturedCGImage {
            if !includeCursor && cgImg.width == w && cgImg.height == h {
                let rep = NSBitmapImageRep(cgImage: cgImg)
                if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.80]) {
                    return [
                        "mimeType": "image/jpeg",
                        "base64": jpeg.base64EncodedString(),
                        "width": w,
                        "height": h,
                        "cursorComposited": false,
                        "source": "screencapturekit"
                    ]
                }
            } else if let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: w,
                pixelsHigh: h,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
            ) {
                onMain {
                    NSGraphicsContext.saveGraphicsState()
                    if let rawCtx = NSGraphicsContext(bitmapImageRep: rep) {
                        let cg = rawCtx.cgContext
                        cg.draw(cgImg, in: CGRect(x: 0, y: 0, width: w, height: h))
                        if includeCursor {
                            cg.translateBy(x: 0, y: CGFloat(h))
                            cg.scaleBy(x: scaleX, y: -scaleY)
                            NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
                            VirtualCursorManager.shared.compositeIntoWindowContext(
                                windowId: windowId,
                                windowBounds: windowBounds,
                                cg: cg,
                                canvasSize: CGSize(width: targetW, height: targetH)
                            )
                        }
                    }
                    NSGraphicsContext.restoreGraphicsState()
                }
                if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.80]) {
                    return [
                        "mimeType": "image/jpeg",
                        "base64": jpeg.base64EncodedString(),
                        "width": w,
                        "height": h,
                        "cursorComposited": includeCursor,
                        "source": "screencapturekit"
                    ]
                }
            }
        }
    }

    // Permission-free AX Wireframe Fallback normalized to exact 1:1 window point dimensions
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: w,
        pixelsHigh: h,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }

    var drawnCount = 0
    onMain {
        NSGraphicsContext.saveGraphicsState()
        if let rawCtx = NSGraphicsContext(bitmapImageRep: rep) {
            let cg = rawCtx.cgContext
            // Flip to top-left origin inside bitmap and install flipped NSGraphicsContext so text & cursor render upright
            cg.translateBy(x: 0, y: CGFloat(h))
            cg.scaleBy(x: scaleX, y: -scaleY)
            NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

            cg.setFillColor(NSColor(calibratedWhite: 0.11, alpha: 1.0).cgColor)
            cg.fill(CGRect(x: 0, y: 0, width: targetW, height: targetH))

            // Header banner
            cg.setFillColor(NSColor(calibratedRed: 0.18, green: 0.20, blue: 0.25, alpha: 1.0).cgColor)
            cg.fill(CGRect(x: 0, y: 0, width: targetW, height: min(28, targetH)))

            let headerAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.boldSystemFont(ofSize: 12),
                .foregroundColor: NSColor.white
            ]
            let bannerText = "\(title.isEmpty ? "Window #\(windowId)" : title)  [AX Layout Preview - Grant Screen Recording for live pixels]"
            (bannerText as NSString).draw(at: NSPoint(x: 10, y: 6), withAttributes: headerAttrs)

            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(calibratedRed: 0.78, green: 0.90, blue: 1.0, alpha: 1.0)
            ]
            let staticTextAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9.5, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 0.68, alpha: 0.85)
            ]

            let canvasBounds = CGRect(x: 0, y: 0, width: CGFloat(targetW), height: CGFloat(targetH))
            let sortedIndices = elements.keys.sorted()
            var structuralIndices: [Int] = []
            var interactiveIndices: [Int] = []
            for idx in sortedIndices {
                guard let el = elements[idx] else { continue }
                let hasAction = !el.actions.filter { $0 != "AXCancel" && $0 != "AXRaise" }.isEmpty
                if interactiveRoles.contains(el.role) || hasAction {
                    interactiveIndices.append(idx)
                } else {
                    structuralIndices.append(idx)
                }
            }

            // 1. Draw structural/text boxes underneath so outer AXGroup containers never obscure deep controls
            var textLabelsDrawn = 0
            for idx in structuralIndices.prefix(220) {
                guard let el = elements[idx], let b = el.bounds else { continue }
                let rect = CGRect(
                    x: b.origin.x - windowBounds.origin.x,
                    y: b.origin.y - windowBounds.origin.y,
                    width: b.width,
                    height: b.height
                ).intersection(canvasBounds)
                if rect.isNull || rect.width < 4 || rect.height < 4 { continue }

                cg.setStrokeColor(NSColor(calibratedWhite: 0.35, alpha: 0.45).cgColor)
                cg.setLineWidth(0.6)
                cg.stroke(rect)
                drawnCount += 1

                if el.role == "AXStaticText", textLabelsDrawn < 80, rect.width >= 24 && rect.height >= 12,
                   let txt = el.title ?? el.value, !txt.isEmpty {
                    let clipped = txt.count > 32 ? String(txt.prefix(29)) + "..." : txt
                    (clipped as NSString).draw(in: rect.insetBy(dx: 2, dy: 1), withAttributes: staticTextAttrs)
                    textLabelsDrawn += 1
                }
            }

            // 2. Draw interactive/actionable controls on top across the full deep tree (up to 380 controls)
            for idx in interactiveIndices.prefix(380) {
                guard let el = elements[idx], let b = el.bounds else { continue }
                let rect = CGRect(
                    x: b.origin.x - windowBounds.origin.x,
                    y: b.origin.y - windowBounds.origin.y,
                    width: b.width,
                    height: b.height
                ).intersection(canvasBounds)
                if rect.isNull || rect.width < 4 || rect.height < 4 { continue }

                cg.setFillColor(NSColor(calibratedRed: 0.16, green: 0.36, blue: 0.54, alpha: 0.12).cgColor)
                cg.fill(rect)
                cg.setStrokeColor(NSColor(calibratedRed: 0.35, green: 0.72, blue: 0.98, alpha: 0.88).cgColor)
                cg.setLineWidth(1.2)
                cg.stroke(rect)
                drawnCount += 1

                if rect.width >= 24 && rect.height >= 14 {
                    let tag = "[\(idx)] \(el.title ?? el.value ?? cleanActionName(el.role))"
                    let clipped = tag.count > 28 ? String(tag.prefix(25)) + "..." : tag
                    (clipped as NSString).draw(in: rect.insetBy(dx: 2, dy: 1), withAttributes: labelAttrs)
                }
            }

            if includeCursor {
                VirtualCursorManager.shared.compositeIntoWindowContext(
                    windowId: windowId,
                    windowBounds: windowBounds,
                    cg: cg,
                    canvasSize: CGSize(width: targetW, height: targetH)
                )
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.80]) else { return nil }
    return [
        "mimeType": "image/jpeg",
        "base64": jpeg.base64EncodedString(),
        "width": w,
        "height": h,
        "cursorComposited": includeCursor,
        "wireframeElementCount": drawnCount,
        "source": "ax_wireframe_fallback"
    ]
}

// MARK: - Keyboard & Mouse Event Synthesis

let keyCodeMap: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "equal": 24, "9": 25, "7": 26,
    "-": 27, "minus": 27, "8": 28, "0": 29, "]": 30, "bracketright": 30, "o": 31,
    "u": 32, "[": 33, "bracketleft": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "kp_enter": 76,
    "l": 37, "j": 38, "'": 39, "apostrophe": 39, "k": 40, ";": 41, "semicolon": 41,
    "\\": 42, "backslash": 42, ",": 43, "comma": 43, "/": 44, "slash": 44,
    "n": 45, "m": 46, ".": 47, "period": 47, "tab": 48, "space": 49, " ": 49,
    "`": 50, "grave": 50, "backspace": 51, "delete": 51, "forwarddelete": 117,
    "escape": 53, "esc": 53,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "page_up": 116, "prior": 116,
    "pagedown": 121, "page_down": 121, "next": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "kp_0": 82, "numpad_0": 82, "kp_1": 83, "numpad_1": 83, "kp_2": 84, "numpad_2": 84,
    "kp_3": 85, "numpad_3": 85, "kp_4": 86, "numpad_4": 86, "kp_5": 87, "numpad_5": 87,
    "kp_6": 88, "numpad_6": 88, "kp_7": 89, "numpad_7": 89, "kp_8": 91, "numpad_8": 91,
    "kp_9": 92, "numpad_9": 92
]

let shiftedPunctuation: [String: (CGKeyCode, Bool)] = [
    "!": (18, true), "@": (19, true), "#": (20, true), "$": (21, true), "%": (23, true),
    "^": (22, true), "&": (26, true), "*": (28, true), "(": (25, true), ")": (29, true),
    "_": (27, true), "+": (24, true), "plus": (24, true), "{": (33, true), "}": (30, true),
    "|": (42, true), ":": (41, true), "\"": (39, true), "<": (43, true), "less": (43, true),
    ">": (47, true), "greater": (47, true), "?": (44, true), "~": (50, true)
]

func parseKeyChord(_ chord: String) throws -> (keyCode: CGKeyCode, flags: CGEventFlags) {
    let rawTokens = chord.split(separator: "+", omittingEmptySubsequences: true).map {
        $0.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if rawTokens.isEmpty {
        throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid empty key chord"])
    }
    var flags: CGEventFlags = []
    var mainToken: String? = nil

    for tok in rawTokens {
        let low = tok.lowercased()
        switch low {
        case "cmd", "command", "super", "super_l", "super_r", "meta", "meta_l", "meta_r", "gui":
            flags.insert(.maskCommand)
        case "ctrl", "control", "control_l", "control_r":
            flags.insert(.maskControl)
        case "alt", "option", "alt_l", "alt_r", "option_l", "option_r":
            flags.insert(.maskAlternate)
        case "shift", "shift_l", "shift_r":
            flags.insert(.maskShift)
        default:
            mainToken = tok
        }
    }

    guard let keyStr = mainToken else {
        // Modifier-only chord (e.g., "shift")
        if flags.contains(.maskCommand) { return (55, flags) }
        if flags.contains(.maskShift) { return (56, flags) }
        if flags.contains(.maskAlternate) { return (58, flags) }
        if flags.contains(.maskControl) { return (59, flags) }
        throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported key chord: \(chord)"])
    }

    let lowKey = keyStr.lowercased()
    if let (code, needsShift) = shiftedPunctuation[lowKey] {
        if needsShift { flags.insert(.maskShift) }
        return (code, flags)
    }
    if keyStr.count == 1, let ch = keyStr.first, ch.isUppercase && ch.isLetter {
        flags.insert(.maskShift)
    }
    if let code = keyCodeMap[lowKey] {
        return (code, flags)
    }
    throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported key token '\(keyStr)' in chord '\(chord)'"])
}

func postKeyChord(pid: pid_t, chord: String, durationMs: Int? = nil, globalTap: Bool = false) throws {
    let (keyCode, flags) = try parseKeyChord(chord)
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false) else {
        throw NSError(domain: "MacCUAHelper", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGEvent for key chord \(chord)"])
    }
    down.flags = flags
    up.flags = flags
    if globalTap {
        down.post(tap: .cghidEventTap)
    } else {
        down.postToPid(pid)
    }
    if let dur = durationMs, dur > 0 {
        Thread.sleep(forTimeInterval: min(10.0, Double(dur) / 1000.0))
    } else {
        Thread.sleep(forTimeInterval: 0.015)
    }
    if globalTap {
        up.post(tap: .cghidEventTap)
    } else {
        up.postToPid(pid)
    }
}

func postUnicodeText(pid: pid_t, text: String, globalTap: Bool = false) throws {
    let src = CGEventSource(stateID: .hidSystemState)
    let utf16 = Array(text.utf16)
    var idx = 0
    let chunkSize = 16
    while idx < utf16.count {
        let end = min(idx + chunkSize, utf16.count)
        var slice = Array(utf16[idx..<end])
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else {
            throw NSError(domain: "MacCUAHelper", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to create Unicode CGEvent"])
        }
        down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
        up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
        if globalTap {
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        } else {
            down.postToPid(pid)
            up.postToPid(pid)
        }
        Thread.sleep(forTimeInterval: 0.01)
        idx = end
    }
}

func makeWindowTargetedMouseEvent(
    source: CGEventSource?,
    type: CGEventType,
    button: CGMouseButton,
    screenPt: CGPoint,
    windowOrigin: CGPoint,
    windowId: Int,
    clickState: Int = 1,
    flags: CGEventFlags = []
) -> CGEvent? {
    guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: screenPt, mouseButton: button) else {
        return nil
    }
    ev.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    if !flags.isEmpty {
        ev.flags = flags
    }
    if windowId > 0 && windowId < 1_000_000_000 {
        ev.setIntegerValueField(CGEventField(rawValue: 50)!, value: 248)
        ev.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowId))
        if var data = ev.data as Data?, data.count >= 52 {
            let relX = Float32(screenPt.x - windowOrigin.x).bitPattern.bigEndian
            let relY = Float32(screenPt.y - windowOrigin.y).bitPattern.bigEndian
            data.withUnsafeMutableBytes { ptr in
                ptr.storeBytes(of: relX, toByteOffset: 44, as: UInt32.self)
                ptr.storeBytes(of: relY, toByteOffset: 48, as: UInt32.self)
            }
            if let patched = CGEvent(withDataAllocator: nil, data: data as CFData) {
                return patched
            }
        }
    }
    return ev
}

func performCoordinateClick(
    screenPt: CGPoint,
    button: String,
    clickCount: Int,
    heldChord: String?,
    durationMs: Int?,
    targetPid: pid_t? = nil,
    targetWindowId: Int = 0,
    windowOrigin: CGPoint = .zero,
    useGlobalTap: Bool = true,
    restoreCursor: Bool = true
) throws {
    var heldFlags: CGEventFlags = []
    var heldKeyCode: CGKeyCode? = nil
    if let chord = heldChord, !chord.isEmpty {
        let parsed = try parseKeyChord(chord)
        heldFlags = parsed.flags
        heldKeyCode = parsed.keyCode
    }

    let (downType, upType, cgBtn): (CGEventType, CGEventType, CGMouseButton) = {
        switch button.lowercased() {
        case "right", "r": return (.rightMouseDown, .rightMouseUp, .right)
        case "middle", "m": return (.otherMouseDown, .otherMouseUp, .center)
        default: return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()

    let count = max(1, min(5, clickCount))

    if !useGlobalTap, let pid = targetPid, pid > 0, targetWindowId > 0, targetWindowId < 1_000_000_000 {
        let src = CGEventSource(stateID: .hidSystemState)
        if let kc = heldKeyCode, let kd = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: true) {
            kd.flags = heldFlags
            kd.postToPid(pid)
        }
        for i in 1...count {
            guard let down = makeWindowTargetedMouseEvent(
                source: src,
                type: downType,
                button: cgBtn,
                screenPt: screenPt,
                windowOrigin: windowOrigin,
                windowId: targetWindowId,
                clickState: i,
                flags: heldFlags
            ),
            let up = makeWindowTargetedMouseEvent(
                source: src,
                type: upType,
                button: cgBtn,
                screenPt: screenPt,
                windowOrigin: windowOrigin,
                windowId: targetWindowId,
                clickState: i,
                flags: heldFlags
            ) else { continue }
            down.postToPid(pid)
            if let dur = durationMs, dur > 0 {
                Thread.sleep(forTimeInterval: min(10.0, Double(dur) / 1000.0))
            } else {
                Thread.sleep(forTimeInterval: 0.02)
            }
            up.postToPid(pid)
            if i < count {
                Thread.sleep(forTimeInterval: 0.03)
            }
        }
        if let kc = heldKeyCode, let ku = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: false) {
            ku.flags = []
            ku.postToPid(pid)
        }
        return
    }

    hidCursorLock.lock()
    defer { hidCursorLock.unlock() }

    let savedCursor = CGEvent(source: nil)?.location
    let src = CGEventSource(stateID: .hidSystemState)

    if let kc = heldKeyCode, let kd = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: true) {
        kd.flags = heldFlags
        kd.post(tap: .cghidEventTap)
    }

    for i in 1...count {
        guard let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: screenPt, mouseButton: cgBtn),
              let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: screenPt, mouseButton: cgBtn) else {
            continue
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        if !heldFlags.isEmpty {
            down.flags = heldFlags
            up.flags = heldFlags
        }
        down.post(tap: .cghidEventTap)
        if let dur = durationMs, dur > 0 {
            Thread.sleep(forTimeInterval: min(10.0, Double(dur) / 1000.0))
        } else {
            Thread.sleep(forTimeInterval: 0.02)
        }
        up.post(tap: .cghidEventTap)
        if i < count {
            Thread.sleep(forTimeInterval: 0.03)
        }
    }

    if let kc = heldKeyCode, let ku = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: false) {
        ku.flags = []
        ku.post(tap: .cghidEventTap)
    }

    if restoreCursor, let orig = savedCursor {
        Thread.sleep(forTimeInterval: 0.02)
        CGWarpMouseCursorPosition(orig)
    }
}

func performCoordinateHoverMove(
    screenPt: CGPoint,
    pid: pid_t? = nil,
    windowId: Int = 0,
    windowOrigin: CGPoint = .zero,
    globalTap: Bool = false,
    restoreCursor: Bool = false
) {
    let src = CGEventSource(stateID: .hidSystemState)
    if !globalTap, let targetPid = pid, targetPid > 0 {
        if let mv = makeWindowTargetedMouseEvent(
            source: src,
            type: .mouseMoved,
            button: .left,
            screenPt: screenPt,
            windowOrigin: windowOrigin,
            windowId: windowId,
            clickState: 0
        ) {
            mv.postToPid(targetPid)
        }
        return
    }
    hidCursorLock.lock()
    defer { hidCursorLock.unlock() }
    let savedCursor = CGEvent(source: nil)?.location
    if let mv = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: screenPt, mouseButton: .left) {
        mv.post(tap: .cghidEventTap)
    }
    if restoreCursor, let orig = savedCursor {
        Thread.sleep(forTimeInterval: 0.015)
        CGWarpMouseCursorPosition(orig)
    }
}

func hitTestWindowAXActionAtPoint(
    axWindow: AXUIElement,
    screenPt: CGPoint,
    wantedActions: [String],
    maxDepth: Int = 14,
    maxVisited: Int = 450
) -> (element: AXUIElement, action: String, bounds: CGRect)? {
    var visited = 0
    var best: (element: AXUIElement, action: String, bounds: CGRect, area: CGFloat, depth: Int)? = nil

    func visit(_ el: AXUIElement, depth: Int) {
        if visited >= maxVisited || depth > maxDepth { return }
        visited += 1

        if depth > 0, let b = axBounds(el), b.width >= 2, b.height >= 2, b.contains(screenPt) {
            let acts: [String] = {
                var namesRef: CFArray?
                if AXUIElementCopyActionNames(el, &namesRef) == .success, let arr = namesRef as? [String] {
                    return arr
                }
                return []
            }()
            if let matchedAct = wantedActions.first(where: { acts.contains($0) }) {
                let area = b.width * b.height
                if let cur = best {
                    if area < cur.area * 0.98 || (abs(area - cur.area) <= cur.area * 0.05 && depth >= cur.depth) {
                        best = (el, matchedAct, b, area, depth)
                    }
                } else {
                    best = (el, matchedAct, b, area, depth)
                }
            }
        }

        guard let children = axCopyAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] else { return }
        for child in children {
            if visited >= maxVisited { break }
            // Prune container branches whose explicit bounds clearly miss screenPt (allowing slight overflow)
            if let cb = axBounds(child), cb.width > 4, cb.height > 4 {
                if !cb.insetBy(dx: -12, dy: -12).contains(screenPt) {
                    continue
                }
            }
            visit(child, depth: depth + 1)
        }
    }

    visit(axWindow, depth: 0)
    return best.map { ($0.element, $0.action, $0.bounds) }
}

// MARK: - Background Menu Paste & Clipboard Save/Restore

func triggerEditPasteViaMenuBar(pid: pid_t) -> Bool {
    let axApp = AXUIElementCreateApplication(pid)
    guard let menuBarRef = axCopyAttr(axApp, kAXMenuBarAttribute as String) else { return false }
    let menuBar = menuBarRef as! AXUIElement
    guard let barItems = axCopyAttr(menuBar, kAXChildrenAttribute as String) as? [AXUIElement] else { return false }

    for barItem in barItems {
        let barTitle = (axString(barItem, kAXTitleAttribute as String) ?? "").lowercased()
        if barTitle == "edit" || barTitle.contains("edit") {
            guard let menus = axCopyAttr(barItem, kAXChildrenAttribute as String) as? [AXUIElement] else { continue }
            for menu in menus {
                guard let items = axCopyAttr(menu, kAXChildrenAttribute as String) as? [AXUIElement] else { continue }
                for item in items {
                    let cmdChar = axString(item, "AXMenuItemCmdChar")?.uppercased()
                    let cmdMods = (axCopyAttr(item, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
                    let itemTitle = (axString(item, kAXTitleAttribute as String) ?? "").lowercased()
                    // Cmd+V with no extra shift/option modifiers (cmdMods == 0 means Command only in AXMenuItem)
                    if (cmdChar == "V" && cmdMods == 0) || itemTitle == "paste" {
                        if AXUIElementPerformAction(item, kAXPressAction as CFString) == .success {
                            return true
                        }
                    }
                }
            }
        }
    }
    return false
}

func pasteWithClipboardRestore(pid: pid_t, axWindow: AXUIElement?, text: String, format: String) throws {
    let fmt = format.lowercased()

    // 1. Snapshot current clipboard items and write requested payload on main thread
    let savedSnapshot: [[(NSPasteboard.PasteboardType, Data)]] = onMain {
        let pb = NSPasteboard.general
        var snapshot: [[(NSPasteboard.PasteboardType, Data)]] = []
        if let existingItems = pb.pasteboardItems {
            for item in existingItems {
                var pairs: [(NSPasteboard.PasteboardType, Data)] = []
                for t in item.types {
                    if let d = item.data(forType: t) {
                        pairs.append((t, d))
                    }
                }
                if !pairs.isEmpty {
                    snapshot.append(pairs)
                }
            }
        }

        pb.clearContents()
        if fmt == "html" {
            let item = NSPasteboardItem()
            if let htmlData = text.data(using: .utf8) {
                item.setData(htmlData, forType: .html)
            }
            let plainFallback = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            item.setString(plainFallback, forType: .string)
            pb.writeObjects([item])
        } else {
            pb.setString(text, forType: .string)
        }
        return snapshot
    }

    defer {
        // Restore user's previous clipboard contents on main thread
        onMain {
            let pb = NSPasteboard.general
            pb.clearContents()
            if !savedSnapshot.isEmpty {
                let restoredItems: [NSPasteboardItem] = savedSnapshot.map { pairs in
                    let newItem = NSPasteboardItem()
                    for (t, d) in pairs {
                        newItem.setData(d, forType: t)
                    }
                    return newItem
                }
                pb.writeObjects(restoredItems)
            }
        }
    }

    // 2. For plain text / markdown, check if focused element inside target window accepts direct AXSelectedText insertion first
    if fmt != "html" {
        let axApp = AXUIElementCreateApplication(pid)
        if let focusedRef = axCopyAttr(axApp, kAXFocusedUIElementAttribute as String) {
            let focusedEl = focusedRef as! AXUIElement
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(focusedEl, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue {
                if AXUIElementSetAttributeValue(focusedEl, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success {
                    Thread.sleep(forTimeInterval: 0.05)
                    return
                }
            }
        }
    }

    // 3. Trigger background menu bar Edit -> Paste (works even when app is in the background!)
    if triggerEditPasteViaMenuBar(pid: pid) {
        Thread.sleep(forTimeInterval: 0.14)
        return
    }

    // 4. Fallback to Cmd+V sent to pid
    try postKeyChord(pid: pid, chord: "cmd+v")
    Thread.sleep(forTimeInterval: 0.14)
}

// MARK: - Lookup Cached Element & Target Visual Anchor

func lookupCachedElement(windowId: Int, pid: pid_t, elementIndex: Int) throws -> CachedAXElement {
    if let entry = state.lookupElement(windowId: windowId, pid: pid, index: elementIndex) {
        return entry
    }
    throw NSError(
        domain: "MacCUAHelper",
        code: 404,
        userInfo: [NSLocalizedDescriptionKey: "Element index [\(elementIndex)] not found in cached AX state for window \(windowId). Call get_window_state first to refresh element indices."]
    )
}

func resolveActionVisualAnchor(entry: CachedAXElement?, pid: pid_t, winBounds: CGRect) -> (pt: CGPoint, highlight: CGRect?) {
    if let e = entry, let eb = axBounds(e.element) ?? e.bounds, eb.width >= 1, eb.height >= 1 {
        return (CGPoint(x: eb.midX, y: eb.midY), eb)
    }
    let axApp = AXUIElementCreateApplication(pid)
    if let focusedRef = axCopyAttr(axApp, kAXFocusedUIElementAttribute as String) {
        let focusedEl = focusedRef as! AXUIElement
        if let fb = axBounds(focusedEl), fb.width >= 1, fb.height >= 1 {
            return (CGPoint(x: fb.midX, y: fb.midY), fb)
        }
    }
    return (CGPoint(x: winBounds.midX, y: winBounds.midY), nil)
}

func clickBadgeTitle(button: String, clickCount: Int) -> String {
    let b = button.lowercased()
    if b == "right" || b == "r" { return "Right Click" }
    if b == "middle" || b == "m" { return "Middle Click" }
    if clickCount == 2 { return "Double Click" }
    if clickCount >= 3 { return "Triple Click" }
    return "Click"
}

func scrollArrowSymbol(_ dir: String) -> String {
    switch dir.lowercased() {
    case "up", "u": return "↑"
    case "left", "l": return "←"
    case "right", "r": return "→"
    default: return "↓"
    }
}

// MARK: - Command Dispatcher

func handleRequest(_ req: [String: Any]) throws -> Any {
    let method = (req["method"] as? String) ?? ""
    let params = (req["params"] as? [String: Any]) ?? [:]

    switch method {
    case "ping", "check_permissions":
        return [
            "axTrusted": AXIsProcessTrusted(),
            "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
            "screenLocked": isScreenLocked(),
            "displays": getDisplaysInfo()
        ]

    case "request_permissions":
        let promptAX = asBool(params["promptAX"]) ?? true
        let promptScreen = asBool(params["promptScreenCapture"]) ?? false
        var axTrusted = AXIsProcessTrusted()
        if !axTrusted && promptAX {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            axTrusted = AXIsProcessTrustedWithOptions(opts)
        }
        var screenAccess = CGPreflightScreenCaptureAccess()
        if !screenAccess && promptScreen {
            screenAccess = CGRequestScreenCaptureAccess()
        }
        return [
            "axTrusted": axTrusted,
            "screenCaptureAccess": screenAccess
        ]

    case "get_displays":
        return ["displays": getDisplaysInfo()]

    case "list_apps":
        let runningOnly = asBool(params["runningOnly"]) ?? false
        let all = listAppsWithWindows()
        let filtered = runningOnly ? all.filter { ($0["isRunning"] as? Bool) == true } : all
        return ["apps": filtered]

    case "launch_app":
        guard let appQuery = params["app"] as? String, !appQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Missing required parameter 'app'"])
        }
        let activate = asBool(params["activate"]) ?? false
        let timeoutMs = asInt(params["timeoutMs"]) ?? 6000
        let app = try launchAppSync(query: appQuery, activate: activate, timeoutMs: timeoutMs)
        let wins = enumerateWindows(pidFilter: app.processIdentifier, includeMinimized: true)
        return [
            "id": app.bundleIdentifier ?? app.localizedName ?? appQuery,
            "bundleId": app.bundleIdentifier as Any,
            "displayName": app.localizedName as Any,
            "pid": Int(app.processIdentifier),
            "isRunning": true,
            "isActive": app.isActive,
            "windows": wins
        ]

    case "list_windows":
        let appFilter = params["app"] as? String
        let includeMinimized = asBool(params["includeMinimized"]) ?? true
        return ["windows": enumerateWindows(appFilter: appFilter, includeMinimized: includeMinimized)]

    case "manage_windows":
        guard let ops = params["operations"] as? [[String: Any]] else {
            throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Missing 'operations' array"])
        }
        var opResults: [[String: Any]] = []
        for op in ops {
            do {
                let wid = asInt(op["windowId"])
                let appQuery = op["app"] as? String
                let winTitle = op["windowTitle"] as? String
                let action = ((op["action"] as? String) ?? "").lowercased()

                if action == "hide_app" || action == "unhide_app" || action == "quit_app" {
                    guard let q = appQuery, let rApp = resolveRunningApp(q) else {
                        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Running app not found: \(appQuery ?? "")"])
                    }
                    let pid = rApp.processIdentifier
                    if action == "hide_app" {
                        rApp.hide()
                        VirtualCursorManager.shared.removeCursors(forPid: pid)
                    } else if action == "unhide_app" {
                        rApp.unhide()
                    } else {
                        let axApp = AXUIElementCreateApplication(pid)
                        var quitViaAX = false
                        if let menuBarRef = axCopyAttr(axApp, kAXMenuBarAttribute as String) {
                            let menuBar = menuBarRef as! AXUIElement
                            if let barItems = axCopyAttr(menuBar, kAXChildrenAttribute as String) as? [AXUIElement] {
                                for barItem in barItems.prefix(2) {
                                    if let menus = axCopyAttr(barItem, kAXChildrenAttribute as String) as? [AXUIElement] {
                                        for menu in menus {
                                            if let items = axCopyAttr(menu, kAXChildrenAttribute as String) as? [AXUIElement] {
                                                for item in items {
                                                    let cmdChar = axString(item, "AXMenuItemCmdChar")?.uppercased()
                                                    let title = (axString(item, kAXTitleAttribute as String) ?? "").lowercased()
                                                    if cmdChar == "Q" || title == "quit" || title.hasPrefix("quit ") {
                                                        if AXUIElementPerformAction(item, kAXPressAction as CFString) == .success {
                                                            quitViaAX = true
                                                            break
                                                        }
                                                    }
                                                }
                                            }
                                            if quitViaAX { break }
                                        }
                                    }
                                    if quitViaAX { break }
                                }
                            }
                        }
                        if !quitViaAX {
                            _ = rApp.terminate()
                        }
                        VirtualCursorManager.shared.removeCursors(forPid: pid)
                    }
                    opResults.append(["ok": true, "action": action, "app": rApp.bundleIdentifier ?? q])
                    continue
                }

                let resolved = try resolveTargetWindow(windowId: wid, appQuery: appQuery, windowTitle: winTitle, autoLaunch: false)
                let maybeAxWin = resolved.axWindow
                switch action {
                case "set_bounds", "move_resize", "move", "resize":
                    guard let axWin = maybeAxWin else {
                        throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Window \(resolved.windowId) does not expose Accessibility window controls for \(action)"])
                    }
                    let current = axBounds(axWin) ?? resolvedWindowBounds(resolved)
                    let nx = asDouble(op["x"]).map { CGFloat($0) } ?? current.origin.x
                    let ny = asDouble(op["y"]).map { CGFloat($0) } ?? current.origin.y
                    let nw = asDouble(op["width"]).map { CGFloat($0) } ?? current.size.width
                    let nh = asDouble(op["height"]).map { CGFloat($0) } ?? current.size.height
                    if axBool(axWin, kAXMinimizedAttribute as String) == true {
                        _ = AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                        Thread.sleep(forTimeInterval: 0.1)
                    }
                    // Position -> Size -> Position ensures cross-display moves are not clamped by old screen bounds
                    _ = axSetPoint(axWin, CGPoint(x: nx, y: ny))
                    _ = axSetSize(axWin, CGSize(width: nw, height: nh))
                    _ = axSetPoint(axWin, CGPoint(x: nx, y: ny))
                    let updated = axBounds(axWin) ?? CGRect(x: nx, y: ny, width: nw, height: nh)
                    VirtualCursorManager.shared.updateWindowMoved(
                        windowId: resolved.windowId,
                        oldOrigin: current.origin,
                        newOrigin: updated.origin
                    )
                    opResults.append(["ok": true, "windowId": resolved.windowId, "action": action, "bounds": rectToDict(updated)])

                case "minimize":
                    guard let axWin = maybeAxWin else {
                        throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Window \(resolved.windowId) does not expose Accessibility minimize control"])
                    }
                    let err = AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
                    VirtualCursorManager.shared.removeCursor(windowId: resolved.windowId)
                    opResults.append(["ok": err == .success, "windowId": resolved.windowId, "action": action])

                case "restore", "unminimize":
                    guard let axWin = maybeAxWin else {
                        throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Window \(resolved.windowId) does not expose Accessibility restore control"])
                    }
                    let err = AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                    opResults.append(["ok": err == .success, "windowId": resolved.windowId, "action": action])

                case "activate", "focus":
                    if let axWin = maybeAxWin {
                        if axBool(axWin, kAXMinimizedAttribute as String) == true {
                            _ = AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                        }
                        _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                        _ = AXUIElementSetAttributeValue(axWin, kAXMainAttribute as CFString, kCFBooleanTrue)
                    }
                    NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                    opResults.append(["ok": true, "windowId": resolved.windowId, "action": action])

                case "raise":
                    guard let axWin = maybeAxWin else {
                        throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Window \(resolved.windowId) does not expose Accessibility raise control"])
                    }
                    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                    opResults.append(["ok": true, "windowId": resolved.windowId, "action": action])

                case "close":
                    if let axWin = maybeAxWin, let closeBtnRef = axCopyAttr(axWin, kAXCloseButtonAttribute as String) {
                        let closeBtn = closeBtnRef as! AXUIElement
                        let err = AXUIElementPerformAction(closeBtn, kAXPressAction as CFString)
                        VirtualCursorManager.shared.removeCursor(windowId: resolved.windowId)
                        opResults.append(["ok": err == .success, "windowId": resolved.windowId, "action": action])
                    } else if maybeAxWin == nil {
                        try postKeyChord(pid: resolved.pid, chord: "cmd+w")
                        VirtualCursorManager.shared.removeCursor(windowId: resolved.windowId)
                        opResults.append(["ok": true, "windowId": resolved.windowId, "action": action])
                    } else {
                        throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Window \(resolved.windowId) has no AXCloseButton"])
                    }

                default:
                    throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported window management action: \(action)"])
                }
            } catch {
                opResults.append(["ok": false, "error": error.localizedDescription])
            }
        }
        return ["results": opResults]

    case "get_window_state":
        let wid = asInt(params["windowId"])
        let appQuery = params["app"] as? String
        let winTitle = params["windowTitle"] as? String
        let autoLaunch = asBool(params["autoLaunch"]) ?? true
        let includeScreenshot = asBool(params["includeScreenshot"]) ?? false
        let includeCursor = asBool(params["includeCursor"]) ?? false
        let maxDepth = asInt(params["maxDepth"]) ?? 28
        let maxElements = asInt(params["maxElements"]) ?? 600
        let preserveCache = asBool(params["preserveElementCache"]) ?? false
        let screenshotOnly = asBool(params["screenshotOnly"]) ?? false

        let resolved = try resolveTargetWindow(windowId: wid, appQuery: appQuery, windowTitle: winTitle, autoLaunch: autoLaunch)
        if includeScreenshot || includeCursor {
            VirtualCursorManager.shared.touchActivityIfVisible(windowId: resolved.windowId)
        }
        let winBounds = resolvedWindowBounds(resolved)
        let walked: (lines: [String], elements: [Int: CachedAXElement])
        if screenshotOnly, let recentEls = state.getRecentElementCache(windowId: resolved.windowId, maxAge: 3.0) {
            walked = (lines: [], elements: recentEls)
        } else if let axWin = resolved.axWindow {
            ensureManualAccessibility(pid: resolved.pid)
            walked = walkAXTree(
                root: axWin,
                windowOrigin: winBounds.origin,
                maxDepth: maxDepth,
                maxElements: maxElements
            )
        } else {
            walked = (
                lines: ["  (Accessibility hierarchy unavailable for this window; window-relative coordinate actions and screenshots remain available)"],
                elements: [:]
            )
        }

        if !preserveCache || !state.hasElementCache(windowId: resolved.windowId) {
            state.setElementCache(windowId: resolved.windowId, pid: resolved.pid, elements: walked.elements)
        }

        let winTitleActual = resolved.axWindow.flatMap { axString($0, kAXTitleAttribute as String) }
            ?? (resolved.windowMeta["title"] as? String)
            ?? ""
        let wInt = Int(winBounds.width.rounded())
        let hInt = Int(winBounds.height.rounded())
        let wxInt = Int(winBounds.origin.x.rounded())
        let wyInt = Int(winBounds.origin.y.rounded())
        let header = "Window #\(resolved.windowId) \"\(winTitleActual)\" app=\"\(resolved.bundleId ?? resolved.appName)\" pid=\(resolved.pid) size=\(wInt)x\(hInt) screen=@(\(wxInt),\(wyInt) \(wInt)x\(hInt))"
        let fullTreeText = ([header] + walked.lines).joined(separator: "\n")

        var resp: [String: Any] = [
            "window": resolved.windowMeta,
            "windowId": resolved.windowId,
            "app": resolved.bundleId ?? resolved.appName,
            "appName": resolved.appName,
            "pid": Int(resolved.pid),
            "coordinateSpace": "window_relative_points",
            "elementCount": walked.elements.count,
            "tree": fullTreeText
        ]

        if let curDict = VirtualCursorManager.shared.getCursorDict(windowId: resolved.windowId, windowOrigin: winBounds.origin) {
            resp["cursor"] = curDict
        }

        if includeScreenshot {
            if let shot = captureWindowScreenshot(
                windowId: resolved.windowId,
                windowBounds: winBounds,
                title: winTitleActual,
                elements: walked.elements,
                includeCursor: includeCursor
            ) {
                resp["screenshot"] = shot
            }
        }
        return resp

    case "perform_action":
        let wid = asInt(params["windowId"])
        let appQuery = params["app"] as? String
        let winTitle = params["windowTitle"] as? String
        let actionType = ((params["action"] as? String) ?? "").lowercased()
        let showCursor = asBool(params["showCursor"]) ?? true
        let customBadgeRaw = (params["badge"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        func effectiveBadge(_ fallback: String) -> String? {
            return nil
        }

        let resolved = try resolveTargetWindow(windowId: wid, appQuery: appQuery, windowTitle: winTitle, autoLaunch: false)
        let winBounds = resolvedWindowBounds(resolved)

        func withCursorMeta(_ base: [String: Any]) -> [String: Any] {
            var out = base
            if let cur = VirtualCursorManager.shared.getCursorDict(windowId: resolved.windowId, windowOrigin: winBounds.origin) {
                out["cursor"] = cur
            }
            return out
        }

        switch actionType {
        case "click":
            let button = (params["mouseButton"] as? String) ?? "left"
            let clickCount = asInt(params["clickCount"]) ?? 1
            let heldKey = params["key"] as? String
            let durationMs = asInt(params["durationMs"])
            let badgeLabel = effectiveBadge(clickBadgeTitle(button: button, clickCount: clickCount))
            let isPlainLeft = (button.lowercased() == "left" || button.lowercased() == "l")
                && clickCount == 1
                && (heldKey == nil || heldKey!.isEmpty)
                && (durationMs == nil || durationMs! <= 0)
            let isPlainRight = (button.lowercased() == "right" || button.lowercased() == "r")
                && clickCount == 1
                && (heldKey == nil || heldKey!.isEmpty)
                && (durationMs == nil || durationMs! <= 0)

            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                let liveBounds = axBounds(entry.element) ?? entry.bounds
                let visualPt = liveBounds.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: winBounds.midX, y: winBounds.midY)

                VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                    windowId: resolved.windowId,
                    pid: resolved.pid,
                    axWindow: resolved.axWindow,
                    targetScreenPt: visualPt,
                    windowOrigin: winBounds.origin,
                    highlightRect: liveBounds,
                    badge: badgeLabel,
                    badgeColorKind: button,
                    showCursor: showCursor
                )
                VirtualCursorManager.shared.triggerClickEffect(
                    windowId: resolved.windowId,
                    screenPt: visualPt,
                    button: button,
                    clickCount: clickCount,
                    holdDurationMs: durationMs,
                    showCursor: showCursor
                )

                if isPlainLeft {
                    for axAct in [kAXPressAction as String, kAXConfirmAction as String, kAXPickAction as String] {
                        if entry.actions.contains(axAct) {
                            if AXUIElementPerformAction(entry.element, axAct as CFString) == .success {
                                return withCursorMeta(["ok": true, "mechanism": "ax_action:\(axAct)", "windowId": resolved.windowId])
                            }
                        }
                    }
                } else if isPlainRight && entry.actions.contains(kAXShowMenuAction as String) {
                    if AXUIElementPerformAction(entry.element, kAXShowMenuAction as CFString) == .success {
                        return withCursorMeta(["ok": true, "mechanism": "ax_action:AXShowMenu", "windowId": resolved.windowId])
                    }
                }

                // Fallback to coordinate click at element center
                guard let eb = liveBounds else {
                    throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Element [\(elIdx)] does not support AXPress and has no screen bounds"])
                }
                let activateFallback = asBool(params["activateWindow"]) ?? (asBool(params["activateForCoordinateFallback"]) ?? false)
                if let axWin = resolved.axWindow {
                    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                }
                if activateFallback {
                    NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                    Thread.sleep(forTimeInterval: 0.06)
                }
                let center = CGPoint(x: eb.midX, y: eb.midY)
                let useGlobalFallback = !isScreenLocked() && (activateFallback || isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: center))
                try performCoordinateClick(
                    screenPt: center,
                    button: button,
                    clickCount: clickCount,
                    heldChord: heldKey,
                    durationMs: durationMs,
                    targetPid: resolved.pid,
                    targetWindowId: resolved.windowId,
                    windowOrigin: winBounds.origin,
                    useGlobalTap: useGlobalFallback
                )
                return withCursorMeta(["ok": true, "mechanism": "coordinate_fallback", "windowId": resolved.windowId])
            } else if let x = asDouble(params["x"]), let y = asDouble(params["y"]) {
                let coordsAreGlobal = asBool(params["globalCoordinates"]) ?? false
                let pt = coordsAreGlobal
                    ? CGPoint(x: x, y: y)
                    : CGPoint(x: winBounds.origin.x + CGFloat(x), y: winBounds.origin.y + CGFloat(y))
                let activateWin = asBool(params["activateWindow"]) ?? false
                let forceCoord = asBool(params["coordinateOnly"]) ?? asBool(params["forceCoordinate"]) ?? false

                // Background AX hit-test first when activateWindow is false (unless pure coordinateOnly mode is requested)
                var axHit: (element: AXUIElement, action: String, bounds: CGRect)? = nil
                if !activateWin && !forceCoord, let axWin = resolved.axWindow, (isPlainLeft || isPlainRight) {
                    let wanted = isPlainLeft
                        ? [kAXPressAction as String, kAXConfirmAction as String, kAXPickAction as String]
                        : [kAXShowMenuAction as String]
                    axHit = hitTestWindowAXActionAtPoint(axWindow: axWin, screenPt: pt, wantedActions: wanted)
                }

                VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                    windowId: resolved.windowId,
                    pid: resolved.pid,
                    axWindow: resolved.axWindow,
                    targetScreenPt: pt,
                    windowOrigin: winBounds.origin,
                    highlightRect: axHit?.bounds,
                    badge: badgeLabel,
                    badgeColorKind: button,
                    showCursor: showCursor
                )
                VirtualCursorManager.shared.triggerClickEffect(
                    windowId: resolved.windowId,
                    screenPt: pt,
                    button: button,
                    clickCount: clickCount,
                    holdDurationMs: durationMs,
                    showCursor: showCursor
                )

                if let hit = axHit, AXUIElementPerformAction(hit.element, hit.action as CFString) == .success {
                    return withCursorMeta(["ok": true, "mechanism": "ax_coordinate_hit:\(hit.action)", "windowId": resolved.windowId])
                }

                if activateWin {
                    if let axWin = resolved.axWindow {
                        _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                    }
                    NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                    Thread.sleep(forTimeInterval: 0.06)
                } else if !isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: pt), let axWin = resolved.axWindow {
                    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                    Thread.sleep(forTimeInterval: 0.03)
                }
                let useGlobalClick = !isScreenLocked() && (activateWin || coordsAreGlobal || isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: pt))
                try performCoordinateClick(
                    screenPt: pt,
                    button: button,
                    clickCount: clickCount,
                    heldChord: heldKey,
                    durationMs: durationMs,
                    targetPid: resolved.pid,
                    targetWindowId: resolved.windowId,
                    windowOrigin: winBounds.origin,
                    useGlobalTap: useGlobalClick
                )
                return withCursorMeta(["ok": true, "mechanism": "coordinate", "windowId": resolved.windowId])
            } else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "click requires either elementIndex or (x, y) coordinates"])
            }

        case "hover", "move":
            var targetPt: CGPoint
            var highlightBox: CGRect? = nil
            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                guard let eb = axBounds(entry.element) ?? entry.bounds else {
                    throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Element [\(elIdx)] has no screen bounds for \(actionType)"])
                }
                targetPt = CGPoint(x: eb.midX, y: eb.midY)
                highlightBox = eb
            } else if let x = asDouble(params["x"]), let y = asDouble(params["y"]) {
                let coordsAreGlobal = asBool(params["globalCoordinates"]) ?? false
                targetPt = coordsAreGlobal
                    ? CGPoint(x: x, y: y)
                    : CGPoint(x: winBounds.origin.x + CGFloat(x), y: winBounds.origin.y + CGFloat(y))
                if let hw = asDouble(params["width"]), let hh = asDouble(params["height"]), hw > 1, hh > 1 {
                    let rect = CGRect(origin: targetPt, size: CGSize(width: hw, height: hh))
                    highlightBox = rect
                    targetPt = CGPoint(x: rect.midX, y: rect.midY)
                }
            } else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "\(actionType) requires either elementIndex or (x, y) coordinates"])
            }

            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: targetPt,
                windowOrigin: winBounds.origin,
                highlightRect: highlightBox,
                badge: effectiveBadge(actionType == "move" ? "Move" : "Hover"),
                badgeColorKind: "left",
                showCursor: showCursor
            )
            if asBool(params["ripple"]) ?? false {
                VirtualCursorManager.shared.triggerClickEffect(
                    windowId: resolved.windowId,
                    screenPt: targetPt,
                    button: "left",
                    clickCount: 1,
                    showCursor: showCursor
                )
            }

            let dispatchMove = asBool(params["dispatchMoveEvent"]) ?? (actionType == "hover")
            if dispatchMove {
                let activateWin = asBool(params["activateWindow"]) ?? false
                let restore = asBool(params["restoreCursor"]) ?? !activateWin
                performCoordinateHoverMove(
                    screenPt: targetPt,
                    pid: resolved.pid,
                    windowId: resolved.windowId,
                    windowOrigin: winBounds.origin,
                    globalTap: activateWin && !isScreenLocked(),
                    restoreCursor: restore
                )
            }

            return withCursorMeta([
                "ok": true,
                "windowId": resolved.windowId,
                "x": Double((targetPt.x - winBounds.origin.x).rounded()),
                "y": Double((targetPt.y - winBounds.origin.y).rounded()),
                "screenX": Double(targetPt.x.rounded()),
                "screenY": Double(targetPt.y.rounded())
            ])

        case "set_value":
            guard let elIdx = asInt(params["elementIndex"]) else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "set_value requires elementIndex"])
            }
            guard let value = params["value"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "set_value requires string value"])
            }
            let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
            let anchor = resolveActionVisualAnchor(entry: entry, pid: resolved.pid, winBounds: winBounds)
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge("Set Value"),
                badgeColorKind: "left",
                showCursor: showCursor
            )

            _ = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let err = AXUIElementSetAttributeValue(entry.element, kAXValueAttribute as CFString, value as CFTypeRef)
            if err == .success {
                return withCursorMeta(["ok": true, "mechanism": "ax_set_value", "windowId": resolved.windowId])
            }
            // Fallback: select all in focused element and type replacement
            try postKeyChord(pid: resolved.pid, chord: "cmd+a")
            Thread.sleep(forTimeInterval: 0.03)
            if value.isEmpty {
                try postKeyChord(pid: resolved.pid, chord: "Backspace")
            } else {
                try postUnicodeText(pid: resolved.pid, text: value)
            }
            return withCursorMeta(["ok": true, "mechanism": "key_replace_fallback", "windowId": resolved.windowId])

        case "select_text":
            guard let elIdx = asInt(params["elementIndex"]),
                  let targetText = params["text"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "select_text requires elementIndex and text"])
            }
            let prefix = params["prefix"] as? String ?? ""
            let suffix = params["suffix"] as? String ?? ""
            let selType = (params["selectionType"] as? String) ?? "text"

            let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
            guard let fullVal = axString(entry.element, kAXValueAttribute as String) else {
                throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Element [\(elIdx)] does not expose a string AXValue for select_text"])
            }
            let needle = prefix + targetText + suffix
            let nsFull = fullVal as NSString
            let foundRange = nsFull.range(of: needle)
            if foundRange.location == NSNotFound {
                throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Substring '\(targetText)' (with specified prefix/suffix) not found in element [\(elIdx)]"])
            }
            let prefixLen = (prefix as NSString).length
            let textLen = (targetText as NSString).length
            let matchStart = foundRange.location + prefixLen

            var cfRange: CFRange
            switch selType {
            case "cursor_before":
                cfRange = CFRange(location: matchStart, length: 0)
            case "cursor_after":
                cfRange = CFRange(location: matchStart + textLen, length: 0)
            default:
                cfRange = CFRange(location: matchStart, length: textLen)
            }

            let anchor = resolveActionVisualAnchor(entry: entry, pid: resolved.pid, winBounds: winBounds)
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge("Select"),
                badgeColorKind: "left",
                showCursor: showCursor
            )

            _ = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard let axRange = AXValueCreate(.cfRange, &cfRange) else {
                throw NSError(domain: "MacCUAHelper", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to construct CFRange AXValue"])
            }
            let setErr = AXUIElementSetAttributeValue(entry.element, kAXSelectedTextRangeAttribute as CFString, axRange)
            if setErr != .success {
                throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Element [\(elIdx)] rejected kAXSelectedTextRangeAttribute (AXError \(setErr.rawValue))"])
            }
            return withCursorMeta(["ok": true, "windowId": resolved.windowId, "range": ["location": cfRange.location, "length": cfRange.length]])

        case "perform_secondary_action":
            guard let elIdx = asInt(params["elementIndex"]),
                  let reqAction = params["secondaryAction"] as? String ?? params["actionName"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "perform_secondary_action requires elementIndex and secondaryAction"])
            }
            let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
            let anchor = resolveActionVisualAnchor(entry: entry, pid: resolved.pid, winBounds: winBounds)
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge(cleanActionName(reqAction)),
                badgeColorKind: "secondary",
                showCursor: showCursor
            )
            VirtualCursorManager.shared.triggerClickEffect(
                windowId: resolved.windowId,
                screenPt: anchor.pt,
                button: "secondary",
                clickCount: 1,
                showCursor: showCursor
            )

            let normalized = reqAction.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: " ", with: "")
            if normalized == "expand" || normalized == "collapse" {
                let targetBool: CFBoolean = (normalized == "expand") ? kCFBooleanTrue : kCFBooleanFalse
                if AXUIElementSetAttributeValue(entry.element, "AXDisclosing" as CFString, targetBool) == .success ||
                   AXUIElementSetAttributeValue(entry.element, kAXExpandedAttribute as CFString, targetBool) == .success {
                    return withCursorMeta(["ok": true, "action": reqAction, "windowId": resolved.windowId])
                }
            }
            let matched = entry.actions.first { raw in
                let rawNorm = raw.lowercased().replacingOccurrences(of: " ", with: "")
                let cleanNorm = cleanActionName(raw).lowercased().replacingOccurrences(of: " ", with: "")
                return rawNorm == normalized || cleanNorm == normalized
            }
            guard let axAct = matched else {
                throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Action '\(reqAction)' is not supported by element [\(elIdx)]. Available actions: \(entry.actions.joined(separator: ", "))"])
            }
            let err = AXUIElementPerformAction(entry.element, axAct as CFString)
            if err != .success {
                throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "AXPerformAction(\(axAct)) failed with AXError \(err.rawValue)"])
            }
            return withCursorMeta(["ok": true, "action": axAct, "windowId": resolved.windowId])

        case "type_text":
            guard let text = params["text"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "type_text requires text"])
            }
            var targetEntry: CachedAXElement? = nil
            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                targetEntry = entry
                _ = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            let anchor = resolveActionVisualAnchor(entry: targetEntry, pid: resolved.pid, winBounds: winBounds)
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge("Type"),
                badgeColorKind: "left",
                showCursor: showCursor
            )

            let activateFirst = asBool(params["activateWindow"]) ?? false
            if activateFirst {
                NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                Thread.sleep(forTimeInterval: 0.05)
            }
            try postUnicodeText(pid: resolved.pid, text: text, globalTap: activateFirst)
            return withCursorMeta(["ok": true, "windowId": resolved.windowId])

        case "press_key":
            guard let key = params["key"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "press_key requires key"])
            }
            var targetEntry: CachedAXElement? = nil
            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                targetEntry = entry
                _ = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            let anchor = resolveActionVisualAnchor(entry: targetEntry, pid: resolved.pid, winBounds: winBounds)
            let clippedKey = key.count > 14 ? String(key.prefix(12)) + ".." : key
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge("Key: \(clippedKey)"),
                badgeColorKind: "left",
                showCursor: showCursor
            )

            let durationMs = asInt(params["durationMs"])
            let activateFirst = asBool(params["activateWindow"]) ?? false
            if activateFirst {
                NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                Thread.sleep(forTimeInterval: 0.05)
            }
            try postKeyChord(pid: resolved.pid, chord: key, durationMs: durationMs, globalTap: activateFirst)
            return withCursorMeta(["ok": true, "windowId": resolved.windowId])

        case "paste":
            guard let text = params["text"] as? String else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "paste requires text"])
            }
            let format = (params["format"] as? String) ?? "text"
            var targetEntry: CachedAXElement? = nil
            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                targetEntry = entry
                _ = AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            let anchor = resolveActionVisualAnchor(entry: targetEntry, pid: resolved.pid, winBounds: winBounds)
            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: anchor.pt,
                windowOrigin: winBounds.origin,
                highlightRect: anchor.highlight,
                badge: effectiveBadge("Paste"),
                badgeColorKind: "left",
                showCursor: showCursor
            )

            try pasteWithClipboardRestore(pid: resolved.pid, axWindow: resolved.axWindow, text: text, format: format)
            return withCursorMeta(["ok": true, "windowId": resolved.windowId, "clipboardRestored": true])

        case "scroll":
            let dir = ((params["direction"] as? String) ?? "down").lowercased()
            let pixels: Int32 = {
                if let px = asInt(params["pixels"]) { return Int32(px) }
                let pages = asDouble(params["pages"]) ?? 1.0
                return Int32((pages * 360.0).rounded())
            }()
            var targetPt = CGPoint(x: winBounds.midX, y: winBounds.midY)
            var highlightBox: CGRect? = nil
            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                if let eb = axBounds(entry.element) ?? entry.bounds {
                    targetPt = CGPoint(x: eb.midX, y: eb.midY)
                    highlightBox = eb
                }
            } else if let x = asDouble(params["x"]), let y = asDouble(params["y"]) {
                let globalCoords = asBool(params["globalCoordinates"]) ?? false
                targetPt = globalCoords
                    ? CGPoint(x: x, y: y)
                    : CGPoint(x: winBounds.origin.x + CGFloat(x), y: winBounds.origin.y + CGFloat(y))
            }

            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: targetPt,
                windowOrigin: winBounds.origin,
                highlightRect: highlightBox,
                badge: effectiveBadge("Scroll \(scrollArrowSymbol(dir))"),
                badgeColorKind: "left",
                showCursor: showCursor
            )
            VirtualCursorManager.shared.triggerScrollEffect(
                windowId: resolved.windowId,
                direction: dir,
                showCursor: showCursor
            )

            let (dy, dx): (Int32, Int32) = {
                switch dir {
                case "up", "u": return (pixels, 0)
                case "down", "d": return (-pixels, 0)
                case "left", "l": return (0, pixels)
                case "right", "r": return (0, -pixels)
                default: return (-pixels, 0)
                }
            }()

            let activateWin = asBool(params["activateWindow"]) ?? false
            if activateWin {
                if let axWin = resolved.axWindow {
                    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                }
                NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                Thread.sleep(forTimeInterval: 0.05)
            }

            let useGlobalTap = activateWin || isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: targetPt)
            if useGlobalTap {
                hidCursorLock.lock()
                do {
                    defer { hidCursorLock.unlock() }
                    let savedCursor = CGEvent(source: nil)?.location
                    let src = CGEventSource(stateID: .hidSystemState)
                    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: targetPt, mouseButton: .left) {
                        move.post(tap: .cghidEventTap)
                    }
                    if let wheel = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                        wheel.location = targetPt
                        wheel.post(tap: .cghidEventTap)
                    }
                    if let orig = savedCursor {
                        Thread.sleep(forTimeInterval: 0.02)
                        CGWarpMouseCursorPosition(orig)
                    }
                }
            } else {
                // Target window is occluded or on another Space -> post directly to target PID so covering windows are never scrolled
                let src = CGEventSource(stateID: .hidSystemState)
                if let move = makeWindowTargetedMouseEvent(
                    source: src,
                    type: .mouseMoved,
                    button: .left,
                    screenPt: targetPt,
                    windowOrigin: winBounds.origin,
                    windowId: resolved.windowId,
                    clickState: 0
                ) {
                    move.postToPid(resolved.pid)
                }
                if let wheel = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                    wheel.location = targetPt
                    if resolved.windowId > 0 && resolved.windowId < 1_000_000_000 {
                        wheel.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(resolved.windowId))
                        wheel.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(resolved.windowId))
                    }
                    wheel.postToPid(resolved.pid)
                }
            }
            return withCursorMeta(["ok": true, "windowId": resolved.windowId])

        case "drag":
            let globalCoords = asBool(params["globalCoordinates"]) ?? false
            var startPt: CGPoint? = nil
            var endPt: CGPoint? = nil
            var startHighlight: CGRect? = nil

            if let fromIdx = asInt(params["fromElementIndex"]) {
                let e = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: fromIdx)
                if let eb = axBounds(e.element) ?? e.bounds {
                    startPt = CGPoint(x: eb.midX, y: eb.midY)
                    startHighlight = eb
                }
            } else if let fx = asDouble(params["fromX"]), let fy = asDouble(params["fromY"]) {
                startPt = globalCoords
                    ? CGPoint(x: fx, y: fy)
                    : CGPoint(x: winBounds.origin.x + CGFloat(fx), y: winBounds.origin.y + CGFloat(fy))
            }

            if let toIdx = asInt(params["toElementIndex"]) {
                let e = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: toIdx)
                if let eb = axBounds(e.element) ?? e.bounds {
                    endPt = CGPoint(x: eb.midX, y: eb.midY)
                }
            } else if let tx = asDouble(params["toX"]), let ty = asDouble(params["toY"]) {
                endPt = globalCoords
                    ? CGPoint(x: tx, y: ty)
                    : CGPoint(x: winBounds.origin.x + CGFloat(tx), y: winBounds.origin.y + CGFloat(ty))
            }

            guard let start = startPt, let end = endPt else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "drag requires (fromX, fromY) / fromElementIndex and (toX, toY) / toElementIndex"])
            }

            var heldFlags: CGEventFlags = []
            if let chord = params["key"] as? String, !chord.isEmpty {
                heldFlags = (try parseKeyChord(chord)).flags
            }

            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: start,
                windowOrigin: winBounds.origin,
                highlightRect: startHighlight,
                badge: effectiveBadge("Drag"),
                badgeColorKind: "left",
                showCursor: showCursor
            )
            VirtualCursorManager.shared.triggerClickEffect(
                windowId: resolved.windowId,
                screenPt: start,
                button: "left",
                clickCount: 1,
                holdDurationMs: 260,
                showCursor: showCursor
            )

            let activateWin = asBool(params["activateWindow"]) ?? false
            if activateWin {
                if let axWin = resolved.axWindow {
                    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                }
                NSRunningApplication(processIdentifier: resolved.pid)?.activate()
                Thread.sleep(forTimeInterval: 0.06)
            } else if !isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: start), let axWin = resolved.axWindow {
                _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                Thread.sleep(forTimeInterval: 0.03)
            }

            let steps = max(6, min(60, asInt(params["steps"]) ?? 20))
            let useGlobalDrag = !isScreenLocked() && (activateWin || globalCoords || isWindowTopmostAtPoint(windowId: resolved.windowId, screenPt: start))
            if !useGlobalDrag, resolved.pid > 0, resolved.windowId > 0, resolved.windowId < 1_000_000_000 {
                let src = CGEventSource(stateID: .hidSystemState)
                if let down = makeWindowTargetedMouseEvent(
                    source: src,
                    type: .leftMouseDown,
                    button: .left,
                    screenPt: start,
                    windowOrigin: winBounds.origin,
                    windowId: resolved.windowId,
                    clickState: 1,
                    flags: heldFlags
                ) {
                    down.postToPid(resolved.pid)
                }
                VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: start, isDragging: true, showCursor: showCursor)
                for s in 1...steps {
                    let rawT = CGFloat(s) / CGFloat(steps)
                    let t = rawT * rawT * (3.0 - 2.0 * rawT)
                    let cur = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
                    if let dragEv = makeWindowTargetedMouseEvent(
                        source: src,
                        type: .leftMouseDragged,
                        button: .left,
                        screenPt: cur,
                        windowOrigin: winBounds.origin,
                        windowId: resolved.windowId,
                        clickState: 1,
                        flags: heldFlags
                    ) {
                        dragEv.postToPid(resolved.pid)
                    }
                    VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: cur, isDragging: true, showCursor: showCursor)
                    Thread.sleep(forTimeInterval: 0.010)
                }
                if let up = makeWindowTargetedMouseEvent(
                    source: src,
                    type: .leftMouseUp,
                    button: .left,
                    screenPt: end,
                    windowOrigin: winBounds.origin,
                    windowId: resolved.windowId,
                    clickState: 1,
                    flags: heldFlags
                ) {
                    up.postToPid(resolved.pid)
                }
                VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: end, isDragging: false, showCursor: showCursor)
            } else {
                hidCursorLock.lock()
                do {
                    defer { hidCursorLock.unlock() }
                    let savedCursor = CGEvent(source: nil)?.location
                    let src = CGEventSource(stateID: .hidSystemState)
                    if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) {
                        down.flags = heldFlags
                        down.post(tap: .cghidEventTap)
                    }
                    VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: start, isDragging: true, showCursor: showCursor)
                    for s in 1...steps {
                        let rawT = CGFloat(s) / CGFloat(steps)
                        // Smooth S-curve ease-in-out drag progression
                        let t = rawT * rawT * (3.0 - 2.0 * rawT)
                        let cur = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
                        if let dragEv = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: cur, mouseButton: .left) {
                            dragEv.flags = heldFlags
                            dragEv.post(tap: .cghidEventTap)
                        }
                        VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: cur, isDragging: true, showCursor: showCursor)
                        Thread.sleep(forTimeInterval: 0.010)
                    }
                    if let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) {
                        up.flags = heldFlags
                        up.post(tap: .cghidEventTap)
                    }
                    VirtualCursorManager.shared.setDragState(windowId: resolved.windowId, screenPt: end, isDragging: false, showCursor: showCursor)
                    if let orig = savedCursor {
                        Thread.sleep(forTimeInterval: 0.02)
                        CGWarpMouseCursorPosition(orig)
                    }
                }
            }
            return withCursorMeta(["ok": true, "windowId": resolved.windowId])

        default:
            throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unknown perform_action type: \(actionType)"])
        }

    case "cursor_control":
        let subAction = ((params["action"] as? String) ?? "get_state").lowercased()
        switch subAction {
        case "get_state", "state":
            return VirtualCursorManager.shared.getFullState(filterWindowId: asInt(params["windowId"]))

        case "configure", "config":
            onMain {
                if let en = asBool(params["enabled"]) {
                    VirtualCursorManager.shared.enabled = en
                    if !en {
                        VirtualCursorManager.shared.clearAll()
                    }
                }
                if let idleMs = asInt(params["idleTimeoutMs"]) {
                    let clamped = max(200, min(60_000, idleMs))
                    VirtualCursorManager.shared.idleTimeoutSec = Double(clamped) / 1000.0
                }
                if let glide = asBool(params["glideEnabled"]) {
                    VirtualCursorManager.shared.glideEnabled = glide
                }
            }
            return VirtualCursorManager.shared.getFullState()

        case "clear_all", "clear":
            VirtualCursorManager.shared.clearAll()
            return VirtualCursorManager.shared.getFullState()

        case "hide":
            if let wid = asInt(params["windowId"]) {
                VirtualCursorManager.shared.removeCursor(windowId: wid)
            } else if let appQ = params["app"] as? String, !appQ.isEmpty {
                if let rApp = resolveRunningApp(appQ) {
                    VirtualCursorManager.shared.removeCursors(forPid: rApp.processIdentifier)
                }
            } else {
                VirtualCursorManager.shared.clearAll()
            }
            return VirtualCursorManager.shared.getFullState()

        case "move", "hover", "highlight":
            let wid = asInt(params["windowId"])
            let appQ = params["app"] as? String
            let winTitle = params["windowTitle"] as? String
            let globalCoords = asBool(params["globalCoordinates"]) ?? false
            let badgeText: String? = nil

            if wid == nil && (appQ == nil || appQ!.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                guard globalCoords, let gx = asDouble(params["x"]), let gy = asDouble(params["y"]) else {
                    throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "cursor_control '\(subAction)' requires windowId/app or globalCoordinates=true with (x, y)"])
                }
                var hRect: CGRect? = nil
                if let hw = asDouble(params["width"]), let hh = asDouble(params["height"]), hw > 1, hh > 1 {
                    hRect = CGRect(x: gx, y: gy, width: hw, height: hh)
                }
                let targetPt = hRect.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: gx, y: gy)
                VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                    windowId: 0,
                    pid: 0,
                    axWindow: nil,
                    targetScreenPt: targetPt,
                    windowOrigin: .zero,
                    highlightRect: hRect,
                    badge: badgeText,
                    badgeColorKind: "left",
                    showCursor: true
                )
                if asBool(params["ripple"]) ?? false {
                    VirtualCursorManager.shared.triggerClickEffect(
                        windowId: 0,
                        screenPt: targetPt,
                        button: "left",
                        clickCount: 1,
                        showCursor: true
                    )
                }
                return VirtualCursorManager.shared.getFullState(filterWindowId: 0)
            }

            let resolved = try resolveTargetWindow(windowId: wid, appQuery: appQ, windowTitle: winTitle, autoLaunch: false)
            let winBounds = resolvedWindowBounds(resolved)
            var targetPt: CGPoint
            var hRect: CGRect? = nil

            if let elIdx = asInt(params["elementIndex"]) {
                let entry = try lookupCachedElement(windowId: resolved.windowId, pid: resolved.pid, elementIndex: elIdx)
                guard let eb = axBounds(entry.element) ?? entry.bounds else {
                    throw NSError(domain: "MacCUAHelper", code: 422, userInfo: [NSLocalizedDescriptionKey: "Element [\(elIdx)] has no screen bounds"])
                }
                hRect = eb
                targetPt = CGPoint(x: eb.midX, y: eb.midY)
            } else if let x = asDouble(params["x"]), let y = asDouble(params["y"]) {
                let basePt = globalCoords
                    ? CGPoint(x: x, y: y)
                    : CGPoint(x: winBounds.origin.x + CGFloat(x), y: winBounds.origin.y + CGFloat(y))
                if let hw = asDouble(params["width"]), let hh = asDouble(params["height"]), hw > 1, hh > 1 {
                    let rect = CGRect(origin: basePt, size: CGSize(width: hw, height: hh))
                    hRect = rect
                    targetPt = CGPoint(x: rect.midX, y: rect.midY)
                } else {
                    targetPt = basePt
                }
            } else {
                throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "cursor_control '\(subAction)' requires elementIndex or (x, y)"])
            }

            VirtualCursorManager.shared.glideToAndAwaitCloseEnough(
                windowId: resolved.windowId,
                pid: resolved.pid,
                axWindow: resolved.axWindow,
                targetScreenPt: targetPt,
                windowOrigin: winBounds.origin,
                highlightRect: hRect,
                badge: badgeText,
                badgeColorKind: "left",
                showCursor: true
            )
            if asBool(params["ripple"]) ?? false {
                VirtualCursorManager.shared.triggerClickEffect(
                    windowId: resolved.windowId,
                    screenPt: targetPt,
                    button: "left",
                    clickCount: 1,
                    showCursor: true
                )
            }
            if asBool(params["dispatchMoveEvent"]) ?? (subAction == "hover") {
                performCoordinateHoverMove(
                    screenPt: targetPt,
                    pid: resolved.pid,
                    windowId: resolved.windowId,
                    windowOrigin: winBounds.origin,
                    globalTap: false,
                    restoreCursor: true
                )
            }
            return VirtualCursorManager.shared.getFullState(filterWindowId: resolved.windowId)

        default:
            throw NSError(domain: "MacCUAHelper", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unknown cursor_control action: \(subAction). Supported: get_state, move, hover, highlight, hide, clear_all, configure"])
        }

    default:
        throw NSError(domain: "MacCUAHelper", code: 404, userInfo: [NSLocalizedDescriptionKey: "Unknown method: \(method)"])
    }
}

// MARK: - Main Entrypoint

@main
struct MacCUAHelperMain {
    static var sigTermSource: DispatchSourceSignal? = nil
    static var sigIntSource: DispatchSourceSignal? = nil

    static func main() {
        // Initialize NSApplication as Dock-hidden background accessory so NSWorkspace, NSScreen, NSPasteboard & VirtualCursor NSWindows operate live
        let _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        _ = VirtualCursorManager.shared

        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            VirtualCursorManager.shared.shutdownAll()
            exit(0)
        }
        termSrc.resume()
        sigTermSource = termSrc

        let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSrc.setEventHandler {
            VirtualCursorManager.shared.shutdownAll()
            exit(0)
        }
        intSrc.resume()
        sigIntSource = intSrc

        let inFlight = DispatchGroup()

        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                guard let data = trimmed.data(using: .utf8),
                      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    writeResponse(id: nil, ok: false, error: "Malformed JSON request")
                    continue
                }
                let reqId = json["id"]
                inFlight.enter()
                DispatchQueue.global(qos: .userInteractive).async {
                    defer { inFlight.leave() }
                    do {
                        let res = try handleRequest(json)
                        writeResponse(id: reqId, ok: true, result: res)
                    } catch {
                        writeResponse(id: reqId, ok: false, error: error.localizedDescription)
                    }
                }
            }
            _ = inFlight.wait(timeout: .now() + .seconds(2))
            VirtualCursorManager.shared.shutdownAll()
            exit(0)
        }

        NSApp.run()
    }
}
