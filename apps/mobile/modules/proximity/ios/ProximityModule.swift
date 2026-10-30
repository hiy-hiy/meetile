import ExpoModulesCore
import UIKit

public class ProximityModule: Module {
  private var radio: FitRadio?
  private var currentRun: String?

  public func definition() -> ModuleDefinition {
    Name("Proximity")
    Events("observation", "unavailable")
    // Hardware identifier (e.g. iPhone17,3) for the local RSSI correction table. Never transmitted.
    Constant("model") { () -> String in
      var system = utsname()
      uname(&system)
      return withUnsafeBytes(of: &system.machine) { bytes in
        String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
      }
    }
    AsyncFunction("start") { (token: String, service: String, runId: String) in
      self.radio?.stop()
      let radio = FitRadio { [weak self] name, value in self?.sendEvent(name, value) }
      self.radio = radio
      self.currentRun = runId
      radio.start(token: token, service: service, runId: runId)
    }.runOnQueue(.main)
    AsyncFunction("stop") { (runId: String) in
      guard self.currentRun == runId else { return }
      self.currentRun = nil
      self.radio?.stop()
      self.radio = nil
    }.runOnQueue(.main)
    OnDestroy {
      // Capture the old radio so a delayed teardown cannot stop a newer module instance.
      let radio = self.radio
      DispatchQueue.main.async { radio?.stop() }
    }
  }
}
