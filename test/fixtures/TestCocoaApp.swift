import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    var winAlpha: NSWindow!
    var winBeta: NSWindow!
    var counter = 0
    var counterLabel: NSTextField!
    var alphaInput: NSTextField!
    var turboCheckbox: NSButton!

    var betaStatusLabel: NSTextField!
    var betaInput: NSTextField!

    func setupMenuBar() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    @objc func onIncrement(_ sender: Any?) {
        counter += 1
        counterLabel.stringValue = "Counter: \(counter)"
    }

    @objc func onTriggerBeta(_ sender: Any?) {
        betaStatusLabel.stringValue = "Beta: Fired"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenuBar()

        winAlpha = NSWindow(
            contentRect: NSRect(x: 80, y: 120, width: 380, height: 240),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        winAlpha.title = "AGTestWindow Alpha"
        winAlpha.isReleasedWhenClosed = false

        let alphaContent = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 240))
        counterLabel = NSTextField(labelWithString: "Counter: 0")
        counterLabel.frame = NSRect(x: 20, y: 185, width: 200, height: 24)
        alphaContent.addSubview(counterLabel)

        let incBtn = NSButton(title: "Increment Counter", target: self, action: #selector(onIncrement(_:)))
        incBtn.frame = NSRect(x: 20, y: 140, width: 170, height: 32)
        alphaContent.addSubview(incBtn)

        alphaInput = NSTextField(string: "Initial Alpha Text")
        alphaInput.placeholderString = "AlphaInput"
        alphaInput.setAccessibilityTitle("AlphaInput")
        alphaInput.frame = NSRect(x: 20, y: 90, width: 300, height: 28)
        alphaContent.addSubview(alphaInput)

        turboCheckbox = NSButton(checkboxWithTitle: "Enable Turbo", target: nil, action: nil)
        turboCheckbox.frame = NSRect(x: 20, y: 45, width: 160, height: 24)
        alphaContent.addSubview(turboCheckbox)

        winAlpha.contentView = alphaContent
        winAlpha.orderFrontRegardless()

        winBeta = NSWindow(
            contentRect: NSRect(x: 490, y: 120, width: 380, height: 240),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        winBeta.title = "AGTestWindow Beta"
        winBeta.isReleasedWhenClosed = false

        let betaContent = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 240))
        betaStatusLabel = NSTextField(labelWithString: "Beta: Ready")
        betaStatusLabel.frame = NSRect(x: 20, y: 185, width: 200, height: 24)
        betaContent.addSubview(betaStatusLabel)

        let betaBtn = NSButton(title: "Trigger Beta", target: self, action: #selector(onTriggerBeta(_:)))
        betaBtn.frame = NSRect(x: 20, y: 140, width: 160, height: 32)
        betaContent.addSubview(betaBtn)

        betaInput = NSTextField(string: "Hello World Beta")
        betaInput.placeholderString = "BetaInput"
        betaInput.setAccessibilityTitle("BetaInput")
        betaInput.frame = NSRect(x: 20, y: 90, width: 300, height: 28)
        betaContent.addSubview(betaInput)

        winBeta.contentView = betaContent
        winBeta.orderFrontRegardless()

        // Failsafe self-exit after 30s so fixture can never linger even on test crash
        DispatchQueue.main.asyncAfter(deadline: .now() + 30.0) {
            NSApp.terminate(nil)
        }
    }
}

@main
struct TestCocoaMain {
    static let sharedDelegate = AppDelegate()
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.delegate = sharedDelegate
        app.run()
    }
}
