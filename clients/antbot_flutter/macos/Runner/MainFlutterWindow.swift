import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    self.minSize = NSSize(width: 1120, height: 760)
    self.setContentSize(NSSize(width: 1280, height: 860))
    self.titleVisibility = .visible

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
