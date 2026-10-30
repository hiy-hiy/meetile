import Foundation

func check(_ value: @autoclosure () -> Bool, _ label: String) {
  guard value() else { fatalError(label) }
}
let token = Data((0..<16).map { UInt8($0) })
let encoded = FitWire.tokenString(token)!
check(FitWire.tokenData(encoded) == token, "128-bit token round trip")
check(FitWire.tokenData("AAAAAAAAAAAAAAAAAAAAAB") == nil, "reject noncanonical trailing bits")
for invalid in ["", "abc", String(repeating: "+", count: 22), String(repeating: "A", count: 24)] {
  check(FitWire.tokenData(invalid) == nil, "reject malformed token")
}
check(FitWire.tokenString(Data(count: 15)) == nil, "reject wrong byte count")
let archive = Data([10, 20, 30])
check(FitWire.tokenValue(token) == token + Data([1]), "token value carries the iOS class")
check(FitWire.tokenRecord(token + Data([2]))?.platform == "android", "read the Android class")
check(FitWire.tokenRecord(token + Data([2]))?.token == token, "class byte is not part of the token")
check(FitWire.tokenRecord(token).map { $0.platform == nil && $0.token == token } == true, "16-byte value is unknown class")
check(FitWire.tokenRecord(token + Data([9]))?.platform == nil, "unknown class reads as unknown")
check(FitWire.tokenRecord(token + Data([1, 1])) == nil, "reject longer value")
check(FitWire.tokenRecord(Data(count: 15)) == nil, "reject shorter value")
let packet = FitWire.nearbyPacket(token: token, archive: archive)
check(FitWire.nearbyArchive(packet, token: token) == archive, "NI archive binding")
check(FitWire.nearbyArchive(packet, token: Data(count: 16)) == nil, "reject stale token archive")
check(FitWire.nearbyArchive(Data([2]) + packet.dropFirst(), token: token) == nil, "reject protocol version")
check(FitWire.nearbyArchive(Data(count: 4097), token: token) == nil, "reject oversized archive")
check(FitWire.nearbyArchive(Data([1]) + token, token: token) == nil, "reject empty archive")
check(FitWire.readSlice(packet, offset: 0) == packet, "read at start")
check(FitWire.readSlice(packet, offset: 17) == archive, "long GATT read")
check(FitWire.readSlice(packet, offset: packet.count) == Data(), "read at end")
check(FitWire.readSlice(packet, offset: packet.count + 1) == nil, "reject offset beyond end")
check(FitWire.readSlice(packet, offset: -1) == nil, "reject negative offset")
check(Set(FitWire.services.values).count == 4, "isolate environments")
print("FIT wire checks passed (no physical-radio or distance claims)")
