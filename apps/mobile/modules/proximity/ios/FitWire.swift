import Foundation

/// Shared with Android 5-4: opaque 16-byte token; optional NI archive bound to that token.
/// No names, photos, safety IDs, device identifiers or history are transmitted.
enum FitWire {
  /// G-PROX 5-5e: the token value ends with one OS-class byte for pair-specific RSSI correction.
  /// A 16-byte value (older build) or an unknown class reads as an unknown platform.
  static let platformIOS: UInt8 = 1
  static let platformAndroid: UInt8 = 2
  static let tokenUUID = "BD1E1001-0E40-4CB6-AF31-8B034F29A718"
  static let nearbyUUID = "BD1E1002-0E40-4CB6-AF31-8B034F29A718"
  static let services: [String: String] = [
    "development": "BD1E1000-0E40-4CB6-AF31-8B034F29A718",
    "staging": "BD1E2000-0E40-4CB6-AF31-8B034F29A718",
    "production": "BD1E3000-0E40-4CB6-AF31-8B034F29A718",
    "local": "BD1E4000-0E40-4CB6-AF31-8B034F29A718"
  ]
  static func tokenData(_ token: String) -> Data? {
    guard token.utf8.count == 22,
          token.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
          let data = Data(base64Encoded: token.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "=="),
          data.count == 16, tokenString(data) == token else { return nil }
    return data
  }
  static func tokenString(_ data: Data) -> String? {
    guard data.count == 16 else { return nil }
    return data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  static func tokenValue(_ token: Data) -> Data { token + Data([platformIOS]) }
  static func tokenRecord(_ value: Data) -> (token: Data, platform: String?)? {
    guard value.count == 16 || value.count == 17 else { return nil }
    let token = value.prefix(16)
    guard tokenString(token) != nil else { return nil }
    let platform: String? = value.count == 17
      ? [platformIOS: "ios", platformAndroid: "android"][value[value.startIndex + 16]] : nil
    return (Data(token), platform)
  }
  static func nearbyPacket(token: Data, archive: Data) -> Data {
    Data([1]) + token + archive
  }
  static func nearbyArchive(_ packet: Data, token: Data) -> Data? {
    guard packet.count > 17, packet.count <= 4096, packet.first == 1,
          packet.subdata(in: 1..<17) == token else { return nil }
    return packet.subdata(in: 17..<packet.count)
  }
  static func readSlice(_ data: Data, offset: Int) -> Data? {
    guard offset >= 0, offset <= data.count else { return nil }
    return data.subdata(in: offset..<data.count)
  }
}
