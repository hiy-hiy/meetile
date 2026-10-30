import CoreBluetooth
import Foundation
import NearbyInteraction
import UIKit

/// All state and OS delegates run on the main queue. JS alone judges proximity.
final class FitRadio: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate,
  CBPeripheralDelegate, NISessionDelegate {
  private final class Peer {
    let peripheral: CBPeripheral
    let handle = UUID().uuidString // Per scan; never expose Core Bluetooth's persistent identifier.
    var token: Data?
    var platform: String? // OS class from the token value; selects RSSI correction in JS only.
    var tokenCharacteristic: CBCharacteristic?
    var nearbyCharacteristic: CBCharacteristic?
    var rssi = -127
    var lastSeen = 0.0
    var adoptedAt = 0.0 // Retention only; never a radio sample.
    var connectedAt = 0.0
    var lastTokenRead = 0.0
    var distance: Float?
    var distanceAt = 0.0
    var discoveryToken: NIDiscoveryToken?
    init(_ peripheral: CBPeripheral) { self.peripheral = peripheral }
  }
  private let emit: (String, [String: Any]) -> Void
  private var central: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?
  private var serviceUUID: CBUUID?
  private var localToken: Data?
  private var runId: String?
  private var service: CBMutableService?
  private var peers: [UUID: Peer] = [:]
  private var timer: Timer?
  private var inactiveObserver: NSObjectProtocol?
  private var nearby: NISession?
  private var nearbyPacket: Data?
  private var rangingPeer: UUID?
  private var rangingStartedAt = 0.0
  private var scanStartedAt = 0.0
  private var nearbyDisabled = false
  private var active = false
  private var uptime: Double { ProcessInfo.processInfo.systemUptime }

  init(emit: @escaping (String, [String: Any]) -> Void) { self.emit = emit }

  func start(token: String, service: String, runId: String) {
    stop()
    self.runId = runId
    guard let bytes = FitWire.tokenData(token),
          let expected = expectedService(), service.uppercased() == expected else {
      fail("unsupported"); return
    }
    guard UIApplication.shared.applicationState == .active else { fail("interrupted"); return }
    localToken = bytes
    serviceUUID = CBUUID(string: expected)
    active = true
    scanStartedAt = uptime
    inactiveObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.fail("interrupted") }
    central = CBCentralManager(delegate: self, queue: .main,
      options: [CBCentralManagerOptionShowPowerAlertKey: false])
    peripheralManager = CBPeripheralManager(delegate: self, queue: .main,
      options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
  }

  /// Native bundle registration also checks the environment; an arbitrary JS UUID is rejected.
  private func expectedService() -> String? {
    switch Bundle.main.bundleIdentifier {
    case "jp.puzzlesns.app.local": return FitWire.services["local"]
    case "jp.puzzlesns.app.development": return FitWire.services["development"]
    case "jp.puzzlesns.app.staging": return FitWire.services["staging"]
    case "jp.puzzlesns.app.production": return FitWire.services["production"]
    default: return nil
    }
  }

  func stop() {
    active = false
    timer?.invalidate(); timer = nil
    if let observer = inactiveObserver { NotificationCenter.default.removeObserver(observer) }
    inactiveObserver = nil
    central?.stopScan()
    for peer in peers.values {
      peer.peripheral.delegate = nil
      central?.cancelPeripheralConnection(peer.peripheral)
    }
    central?.delegate = nil
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    peripheralManager?.delegate = nil
    nearby?.delegate = nil
    nearby?.invalidate()
    nearby = nil; nearbyPacket = nil; rangingPeer = nil
    central = nil; peripheralManager = nil; service = nil
    peers.removeAll(); localToken = nil; serviceUUID = nil; runId = nil
    nearbyDisabled = false
  }

  private func fail(_ kind: String) {
    let id = runId
    stop()
    if let id = id { emit("unavailable", ["runId": id, "kind": kind]) }
  }

  private func checkState(_ state: CBManagerState) -> Bool {
    guard active else { return false }
    switch state {
    case .poweredOn: return true
    case .unauthorized: fail("permission")
    case .poweredOff: fail("bluetooth-off")
    case .unsupported: fail("unsupported")
    case .resetting: fail("interrupted")
    case .unknown: break // Wait for OS initialization or the permission answer.
    @unknown default: fail("unsupported")
    }
    return false
  }
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard central === self.central, checkState(central.state), let uuid = serviceUUID else { return }
    central.scanForPeripherals(withServices: [uuid], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
  }
  func peripheralManagerDidUpdateState(_ manager: CBPeripheralManager) {
    guard manager === peripheralManager, checkState(manager.state), let uuid = serviceUUID else { return }
    let service = CBMutableService(type: uuid, primary: true)
    service.characteristics = [FitWire.tokenUUID, FitWire.nearbyUUID].map {
      CBMutableCharacteristic(type: CBUUID(string: $0), properties: [.read], value: nil, permissions: [.readable])
    }
    self.service = service
    manager.add(service)
  }
  func peripheralManager(_ manager: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    guard active, manager === peripheralManager, service === self.service, let uuid = serviceUUID else { return }
    guard error == nil else { fail("unsupported"); return }
    // No local name, manufacturer data, FIT token or persistent identity in the advertisement.
    manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [uuid]])
  }
  func peripheralManagerDidStartAdvertising(_ manager: CBPeripheralManager, error: Error?) {
    guard active, manager === peripheralManager else { return }
    if error != nil { fail("unsupported") }
  }
  func peripheralManager(_ manager: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard active, manager === peripheralManager, UIApplication.shared.applicationState == .active,
          uptime - scanStartedAt < 45 else {
      manager.respond(to: request, withResult: .unlikelyError); return
    }
    let value: Data?
    switch request.characteristic.uuid.uuidString {
    case FitWire.tokenUUID: value = localToken.map(FitWire.tokenValue)
    case FitWire.nearbyUUID:
      prepareNearby()
      value = nearbyPacket ?? Data() // Empty means NI unavailable; BLE remains usable.
    default: manager.respond(to: request, withResult: .attributeNotFound); return
    }
    guard let data = value, let slice = FitWire.readSlice(data, offset: request.offset) else {
      manager.respond(to: request, withResult: .invalidOffset); return
    }
    request.value = slice
    manager.respond(to: request, withResult: .success)
    if request.characteristic.uuid.uuidString == FitWire.tokenUUID { adopt(request.central) }
  }

  /// An Android central that connected first can block our own connection to it (one LE link per pair).
  /// Read its token over that existing link instead. It is still emitted only with a real RSSI sample.
  private func adopt(_ remote: CBCentral) {
    guard active, let central = central, central.state == .poweredOn else { return }
    let peer: Peer
    if let existing = peers[remote.identifier] { peer = existing }
    else {
      guard peers.count < 16, let peripheral = central.retrievePeripherals(withIdentifiers: [remote.identifier]).first,
            peripheral.identifier == remote.identifier else { return }
      peer = Peer(peripheral); peers[peripheral.identifier] = peer
      peripheral.delegate = self
    }
    peer.adoptedAt = uptime
    if peer.peripheral.state == .disconnected, uptime - peer.connectedAt > 1 {
      peer.connectedAt = uptime
      central.connect(peer.peripheral)
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard active, central === self.central, validRSSI(RSSI) else { return }
    let peer: Peer
    if let existing = peers[peripheral.identifier] { peer = existing }
    else {
      // Retain several candidates even before token exchange; unread peers still block FIT.
      guard peers.count < 16 else { return }
      peer = Peer(peripheral); peers[peripheral.identifier] = peer
      peripheral.delegate = self
    }
    observe(peer, rssi: RSSI.intValue)
    if peripheral.state == .disconnected, uptime - peer.connectedAt > 1 {
      peer.connectedAt = uptime
      central.connect(peripheral)
    }
  }
  private func validRSSI(_ value: NSNumber) -> Bool { (-127 ... -1).contains(value.intValue) }
  private func observe(_ peer: Peer, rssi: Int) {
    peer.rssi = rssi; peer.lastSeen = uptime
    sendObservation(peer)
  }
  private func sendObservation(_ peer: Peer) {
    guard active, let runId = runId else { return }
    let distance: Any = uptime - peer.distanceAt <= 1 ? (peer.distance.map { Double($0) } as Any? ?? NSNull()) : NSNull()
    emit("observation", ["runId": runId, "deviceId": peer.handle,
      "token": peer.token.flatMap { FitWire.tokenString($0) } as Any? ?? NSNull(),
      "peerPlatform": (peer.token == nil ? nil : peer.platform) as Any? ?? NSNull(),
      "rssi": peer.rssi, "distanceMeters": distance,
      "atMs": Date().timeIntervalSince1970 * 1000])
  }
  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard active, central === self.central, let peer = peers[peripheral.identifier], peer.peripheral === peripheral,
          let uuid = serviceUUID else { return }
    peripheral.discoverServices([uuid])
  }
  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    disconnected(peripheral, central: central)
  }
  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    disconnected(peripheral, central: central)
  }
  private func disconnected(_ peripheral: CBPeripheral, central: CBCentralManager) {
    guard active, central === self.central, let peer = peers[peripheral.identifier], peer.peripheral === peripheral else { return }
    peer.token = nil; peer.platform = nil; peer.tokenCharacteristic = nil; peer.nearbyCharacteristic = nil
    peer.distance = nil; peer.discoveryToken = nil
    if rangingPeer == peripheral.identifier { disableNearby() }
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard active, let peer = peers[peripheral.identifier], peer.peripheral === peripheral, error == nil else { return }
    for service in peripheral.services ?? [] where service.uuid == serviceUUID {
      peripheral.discoverCharacteristics([CBUUID(string: FitWire.tokenUUID), CBUUID(string: FitWire.nearbyUUID)], for: service)
    }
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard active, let peer = peers[peripheral.identifier], peer.peripheral === peripheral,
          service.uuid == serviceUUID, error == nil else { return }
    peer.tokenCharacteristic = service.characteristics?.first { $0.uuid == CBUUID(string: FitWire.tokenUUID) }
    peer.nearbyCharacteristic = service.characteristics?.first { $0.uuid == CBUUID(string: FitWire.nearbyUUID) }
    if let characteristic = peer.tokenCharacteristic { peripheral.readValue(for: characteristic) }
  }
  /// The peer restarted its GATT server (token rotation or a new run). Android then advertises from a new
  /// address that we cannot connect to while this link lasts, so drop the link and the handle.
  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    guard active, peers[peripheral.identifier]?.peripheral === peripheral else { return }
    forget(peripheral.identifier)
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard active, let peer = peers[peripheral.identifier], peer.peripheral === peripheral else { return }
    let isToken = characteristic.uuid == CBUUID(string: FitWire.tokenUUID)
    if isToken, error != nil { forget(peripheral.identifier); return }
    guard error == nil, let data = characteristic.value else { return }
    if isToken {
      guard let record = FitWire.tokenRecord(data), record.token != localToken else { peer.token = nil; return }
      // A rotated token is a new candidate with a new handle, as on Android.
      if let previous = peer.token, previous != record.token { forget(peripheral.identifier); return }
      peer.platform = record.platform
      if peer.token == nil { peer.token = record.token; peer.distance = nil; peer.discoveryToken = nil }
      if let characteristic = peer.nearbyCharacteristic, peer.discoveryToken == nil, !nearbyDisabled {
        peripheral.readValue(for: characteristic)
      }
      // A GATT response is not a fresh RSSI sample. Wait for scan/readRSSI before emitting.
    } else if characteristic.uuid == CBUUID(string: FitWire.nearbyUUID), let token = peer.token,
      let archive = FitWire.nearbyArchive(data, token: token),
      let discovery = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: archive) {
      if #available(iOS 17.0, *), !discovery.deviceCapabilities.supportsPreciseDistanceMeasurement { return }
      peer.discoveryToken = discovery
      prepareNearby()
      if let session = nearby, rangingPeer == nil {
        rangingPeer = peripheral.identifier; rangingStartedAt = uptime
        session.run(NINearbyPeerConfiguration(peerToken: discovery))
      }
    }
  }
  func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    guard active, let peer = peers[peripheral.identifier], peer.peripheral === peripheral,
          error == nil, validRSSI(RSSI) else { return }
    observe(peer, rssi: RSSI.intValue)
  }
  private func poll() {
    guard active, UIApplication.shared.applicationState == .active else { fail("interrupted"); return }
    // A stalled JS runtime must not keep serving a token indefinitely. Server expiry still decides validity.
    guard uptime - scanStartedAt < 45 else { fail("interrupted"); return }
    for (id, peer) in peers {
      if uptime - max(peer.lastSeen, peer.adoptedAt) > 4 {
        forget(id)
      } else if peer.peripheral.state == .connected {
        peer.peripheral.readRSSI()
        if let characteristic = peer.tokenCharacteristic, uptime - peer.lastTokenRead > 1 {
          peer.lastTokenRead = uptime; peer.peripheral.readValue(for: characteristic)
        }
      } else if peer.peripheral.state == .connecting, uptime - peer.connectedAt > 5 {
        central?.cancelPeripheralConnection(peer.peripheral)
      }
    }
    if let id = rangingPeer, let peer = peers[id], peer.distance == nil, uptime - rangingStartedAt > 5 {
      disableNearby() // Startup timeout: BLE fallback; no invented UWB distance.
    }
  }

  private func forget(_ id: UUID) {
    guard let peer = peers.removeValue(forKey: id) else { return }
    peer.peripheral.delegate = nil
    central?.cancelPeripheralConnection(peer.peripheral)
    if rangingPeer == id { disableNearby() }
  }

  private func prepareNearby() {
    guard nearby == nil, !nearbyDisabled, NISession.deviceCapabilities.supportsPreciseDistanceMeasurement,
          let localToken = localToken else { return }
    let session = NISession()
    guard let token = session.discoveryToken,
          let archive = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true),
          archive.count <= 4079 else { session.invalidate(); return }
    session.delegate = self
    nearby = session
    nearbyPacket = FitWire.nearbyPacket(token: localToken, archive: archive)
  }
  private func disableNearby() {
    nearbyDisabled = true
    nearby?.delegate = nil; nearby?.invalidate(); nearby = nil; nearbyPacket = nil
    if let id = rangingPeer { peers[id]?.distance = nil }
    rangingPeer = nil
  }
  func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
    guard active, session === nearby, let id = rangingPeer, let peer = peers[id] else { return }
    for object in nearbyObjects where object.discoveryToken == peer.discoveryToken {
      guard let distance = object.distance, distance.isFinite, distance >= 0 else { peer.distance = nil; continue }
      peer.distance = distance; peer.distanceAt = uptime
      // Emit only alongside a fresh BLE sample, so UWB cannot make a departed BLE peer present.
      if uptime - peer.lastSeen < 0.5 { sendObservation(peer) }
    }
  }
  func session(_ session: NISession, didInvalidateWith error: Error) {
    guard session === nearby else { return }
    disableNearby() // Includes NI permission refusal. Do not disable BLE.
  }
  func sessionWasSuspended(_ session: NISession) {
    guard session === nearby else { return }
    disableNearby()
  }
  func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject], reason: NINearbyObject.RemovalReason) {
    guard session === nearby else { return }
    disableNearby()
  }
}
