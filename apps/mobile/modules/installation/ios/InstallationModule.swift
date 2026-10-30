import ExpoModulesCore

public class InstallationModule: Module {
  private func marker() throws -> URL {
    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("PuzzleInstallation", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var url = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return directory.appendingPathComponent("initialized")
  }
  public func definition() -> ModuleDefinition {
    Name("Installation")
    Function("localBuildEnabled") { () -> Bool in
      #if DEBUG
      return Bundle.main.bundleIdentifier == "jp.puzzlesns.app.local" &&
        (Bundle.main.object(forInfoDictionaryKey: "PuzzleLocalMode") as? Bool == true)
      #else
      return false
      #endif
    }
    AsyncFunction("needsReset") { () -> Bool in
      return !FileManager.default.fileExists(atPath: try self.marker().path)
    }
    AsyncFunction("commit") { () -> Void in
      try Data("v1".utf8).write(to: self.marker(), options: .atomic)
    }
  }
}
