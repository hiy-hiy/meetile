@file:Suppress("MissingPermission")

package expo.modules.proximity

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.SystemClock
import java.util.UUID
import java.util.concurrent.Executor

/** One foreground scan. All OS callbacks are serialized; no radio state is persisted. */
internal class FitRadio(
  private val context: Context,
  private val lease: FitLease,
  private val serviceUuid: UUID,
  private val observation: (Map<String, Any?>) -> Unit,
  private val failure: (String) -> Unit
) {
  private class Peer(val device: BluetoothDevice, val key: String, val firstSeenAt: Long) {
    val state = FitPeerState()
    val gate = FitOperationGate()
    var gatt: BluetoothGatt? = null
    var tokenCharacteristic: BluetoothGattCharacteristic? = null
    var capabilityCharacteristic: BluetoothGattCharacteristic? = null
    var oobCharacteristic: BluetoothGattCharacteristic? = null
    var capabilityChecked = false
    var canRange = false
    var mtu = 23
    var writingSession: FitOobSession? = null
    var connected = false
    var attemptAt = 0L
    var retryAt = 0L
    var tokenReadAt = 0L
    var rssiReadAt = 0L
    var seenAt = 0L
    var seenWall = 0L
    var rssi: Int? = null
  }
  private val thread = HandlerThread("PuzzleFitRadio").apply { start() }
  private val handler = Handler(thread.looper)
  private val peers = linkedMapOf<String, Peer>()
  private val incoming = linkedMapOf<String, BluetoothDevice>()
  private val incomingMtu = mutableMapOf<String, Int>()
  private var adapter: BluetoothAdapter? = null
  private var scanner: BluetoothLeScanner? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var server: BluetoothGattServer? = null
  private var registered = false
  private var scanning = false
  private var advertising = false
  private var serviceAdded = false
  private var radioRequestedAt = 0L
  private var rangingPort: FitRangingPort? = null
  private var rangingAvailable: Boolean? = false
  private var rangingAttempted = false
  private var decisionAt: Long? = null
  private var rangingPeer: Peer? = null
  private var rangingSession: FitOobSession? = null
  private var boundIncoming: String? = null
  private val receivers = mutableMapOf<String, FitOobReceiver>()
  private val pendingHellos = mutableMapOf<String, Pair<FitOobMessage, Long>>()
  private var closed = false
  private val startedAt = SystemClock.elapsedRealtime()
  private val now: Long get() = SystemClock.elapsedRealtime()

  fun start() = post { begin() }
  fun stop(completed: () -> Unit = {}) {
    lease.invalidate()
    if (!handler.post { try { cleanup() } finally { completed() } }) completed()
  }

  private fun post(block: () -> Unit) {
    handler.post {
      if (closed) return@post
      if (!lease.alive(now)) { fail("interrupted"); return@post }
      try { block() }
      catch (_: SecurityException) { fail("permission") }
      catch (_: RuntimeException) { fail("interrupted") }
    }
  }

  private fun begin() {
    if (!hasPermissions()) { fail("permission"); return }
    adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    val bluetooth = adapter
    if (bluetooth == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      fail("unsupported"); return
    }
    if (!bluetooth.isEnabled) { fail("bluetooth-off"); return }
    scanner = bluetooth.bluetoothLeScanner
    advertiser = bluetooth.bluetoothLeAdvertiser
    if (scanner == null || advertiser == null) { fail("unsupported"); return }
    val filter = IntentFilter().apply {
      addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    if (Build.VERSION.SDK_INT >= 33)
      context.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
    else context.registerReceiver(receiver, filter, null, handler)
    registered = true
    prepareRanging()
    server = context.getSystemService(BluetoothManager::class.java)?.openGattServer(context, serverCallback)
    val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    for (uuid in listOf(FitWire.tokenUuid, FitWire.nearbyUuid, FitWire.capabilityUuid)) {
      service.addCharacteristic(BluetoothGattCharacteristic(uuid,
        BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
    }
    service.addCharacteristic(BluetoothGattCharacteristic(FitWire.oobUuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE))
    if (server?.addService(service) != true) { fail("unsupported"); return }
    handler.postDelayed(tick, 250)
  }

  private fun startRadios() {
    if (scanning || !serviceAdded || rangingAvailable == null) return
    radioRequestedAt = now
    // MEDIUM (the default) read about -52 to -65 dBm on an iPhone 16 at contact distance (5-5d).
    // Distance thresholds and per-model correction remain G-PROX decisions.
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true).setTimeout(0).build()
    val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(serviceUuid))
      .setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build()
    advertiser?.startAdvertising(settings, data, advertiseCallback)
    scanner?.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build()),
      ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build(), scanCallback)
    scanning = true
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) { post { advertising = true } }
    override fun onStartFailure(errorCode: Int) { post { fail("unsupported") } }
  }
  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val observedAt = result.timestampNanos / 1_000_000
      post { discovered(result.device, result.rssi, observedAt) }
    }
    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      for (result in results) onScanResult(0, result)
    }
    override fun onScanFailed(errorCode: Int) { post { fail("interrupted") } }
  }

  private fun discovered(device: BluetoothDevice, rssi: Int, observedAt: Long) {
    if (now - observedAt !in 0..1000 || rssi !in -127..-1) return
    val key = device.address
    val peer = peers[key] ?: run {
      if (peers.size >= 16) { fail("interrupted"); return }
      Peer(device, key, now).also { peers[key] = it }
    }
    observed(peer, rssi, observedAt)
    connect(peer)
  }

  private fun observed(peer: Peer, rssi: Int, observedAt: Long) {
    if (rssi !in -127..-1 || observedAt < peer.seenAt || now - observedAt !in 0..1000) return
    peer.rssi = rssi; peer.seenAt = observedAt
    peer.seenWall = System.currentTimeMillis() - (now - observedAt)
    emit(peer)
  }

  private fun emit(peer: Peer) {
    val rssi = peer.rssi ?: return
    if (!lease.alive(now) || now - peer.seenAt > 500) return
    val session = if (rangingPeer === peer) rangingSession else null
    val allowed = rangingAvailable != null && (rangingAvailable == false || peer.capabilityChecked) &&
      (session?.reportable(now) ?: (!peer.canRange || rangingAttempted))
    observation(mapOf("runId" to lease.runId, "deviceId" to peer.state.handle,
      "token" to if (allowed) peer.state.token else null,
      "peerPlatform" to if (allowed && peer.state.token != null) peer.state.platform else null, "rssi" to rssi, "distanceMeters" to session?.distance(now),
      "atMs" to peer.seenWall))
  }

  private fun connect(peer: Peer) {
    if (peer.gatt != null || now < peer.retryAt || peers.values.count { it.gatt != null } >= 2) return
    val staleLink = !incoming.containsKey(peer.key) && context.getSystemService(BluetoothManager::class.java)
      ?.getConnectionState(peer.device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
    if (!FitConnectOrder.mayInitiate(now, peer.firstSeenAt, incoming.containsKey(peer.key), staleLink)) return
    peer.attemptAt = now
    peer.gatt = peer.device.connectGatt(context, false, callback(peer), BluetoothDevice.TRANSPORT_LE)
    if (peer.gatt == null) peer.retryAt = now + 1000
  }

  private fun current(peer: Peer, gatt: BluetoothGatt): Boolean = peers[peer.key] === peer && peer.gatt === gatt

  private fun callback(peer: Peer) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      post {
        if (!current(peer, gatt)) return@post
        if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
          disconnect(peer); return@post
        }
        if (newState == BluetoothProfile.STATE_CONNECTED) {
          peer.connected = true
          if (peer.gate.begin(gatt, "discover", now) && !gatt.discoverServices()) disconnect(peer)
        }
      }
    }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      post {
        if (!current(peer, gatt) || !peer.gate.complete(gatt, "discover")) return@post
        val characteristic = gatt.getService(serviceUuid)?.getCharacteristic(FitWire.tokenUuid)
        if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null ||
          characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0) {
          disconnect(peer); return@post
        }
        peer.tokenCharacteristic = characteristic
        peer.capabilityCharacteristic = gatt.getService(serviceUuid)?.getCharacteristic(FitWire.capabilityUuid)
        peer.oobCharacteristic = gatt.getService(serviceUuid)?.getCharacteristic(FitWire.oobUuid)
        if (peer.gate.begin(gatt, "mtu", now) && !gatt.requestMtu(185)) {
          peer.gate.complete(gatt, "mtu"); readToken(peer, gatt)
        }
      }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      post {
        if (current(peer, gatt) && peer.gate.complete(gatt, "mtu")) {
          peer.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu.coerceIn(23, 517) else 23
          readToken(peer, gatt)
        }
      }
    }
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic,
      value: ByteArray, status: Int) {
      characteristicRead(peer, gatt, characteristic.uuid, value.copyOf(), status)
    }
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT < 33)
        characteristicRead(peer, gatt, characteristic.uuid, characteristic.value?.copyOf(), status)
    }
    override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
      val observedAt = SystemClock.elapsedRealtime()
      post {
        if (!current(peer, gatt) || !peer.gate.complete(gatt, "rssi")) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) disconnect(peer)
        else { observed(peer, rssi, observedAt); drive(peer) }
      }
    }
    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      post {
        if (!current(peer, gatt) || characteristic.uuid != FitWire.oobUuid || !peer.gate.complete(gatt, "write")) return@post
        val owner = peer.writingSession; peer.writingSession = null
        if (owner === rangingSession) {
          if (status != BluetoothGatt.GATT_SUCCESS || owner?.acknowledge() != true) owner?.fallback()
        }
        drive(peer)
      }
    }
  }

  private fun characteristicRead(peer: Peer, gatt: BluetoothGatt, uuid: UUID, value: ByteArray?, status: Int) {
    post {
      if (!current(peer, gatt)) return@post
      if (uuid == FitWire.tokenUuid && peer.gate.complete(gatt, "token")) {
        val own = lease.token(now) ?: return@post
        val previous = peer.state.token
        if (status != BluetoothGatt.GATT_SUCCESS || !peer.state.read(value, own)) { disconnect(peer); return@post }
        if (previous != peer.state.token) {
          if (rangingPeer === peer) rangingSession?.fallback()
          peer.capabilityChecked = false; peer.canRange = false
        }
      } else if (uuid == FitWire.capabilityUuid && peer.gate.complete(gatt, "capability")) {
        val token = peer.state.token?.let(FitWire::tokenData)
        peer.capabilityChecked = true
        peer.canRange = status == BluetoothGatt.GATT_SUCCESS && token != null && FitWire.canRange(value, token) &&
          peer.oobCharacteristic?.properties?.and(BluetoothGattCharacteristic.PROPERTY_WRITE) != 0 && peer.oobCharacteristic != null
      } else return@post
      resolveCapability(peer)
      maybeRanging()
      emit(peer); drive(peer)
    }
  }

  private fun resolveCapability(peer: Peer) {
    if (rangingAvailable == false || peer.capabilityCharacteristic == null || peer.oobCharacteristic == null) {
      peer.capabilityChecked = true; peer.canRange = false
    }
  }

  @Suppress("DEPRECATION")
  private fun drive(peer: Peer) {
    if (closed || !peer.connected || !peer.gate.idle) return
    val gatt = peer.gatt ?: return
    resolveCapability(peer)
    if (now - peer.tokenReadAt >= 1000) { readToken(peer, gatt); return }
    if (!peer.capabilityChecked && rangingAvailable == true && peer.state.token != null) {
      val characteristic = peer.capabilityCharacteristic ?: return
      if (peer.gate.begin(gatt, "capability", now) && !gatt.readCharacteristic(characteristic)) disconnect(peer)
      return
    }
    if (now - peer.rssiReadAt >= 250 && peer.gate.begin(gatt, "rssi", now)) {
      peer.rssiReadAt = now
      if (!gatt.readRemoteRssi()) disconnect(peer)
      return
    }
    if (rangingPeer !== peer) return
    val owner = rangingSession ?: return
    val frame = owner.nextFrame(peer.mtu) ?: return
    val characteristic = peer.oobCharacteristic ?: return owner.fallback()
    if (!peer.gate.begin(gatt, "write", now)) return
    peer.writingSession = owner
    val sent = if (Build.VERSION.SDK_INT >= 33)
      gatt.writeCharacteristic(characteristic, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
    else {
      characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      characteristic.value = frame
      gatt.writeCharacteristic(characteristic)
    }
    if (!sent) { peer.gate.complete(gatt, "write"); peer.writingSession = null; owner.fallback() }
  }

  private fun readToken(peer: Peer, gatt: BluetoothGatt) {
    val characteristic = peer.tokenCharacteristic ?: return disconnect(peer)
    if (!peer.gate.begin(gatt, "token", now)) return
    peer.tokenReadAt = now
    if (!gatt.readCharacteristic(characteristic)) disconnect(peer)
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      post {
        if (service.uuid != serviceUuid) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) fail("unsupported")
        else { serviceAdded = true; startRadios() }
      }
    }
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      post {
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
          // Links reported before our service exists were made to a previous run's advertisement.
          if (!serviceAdded) return@post
          if (!incoming.containsKey(device.address) && incoming.size >= 16) { fail("interrupted"); return@post }
          incoming[device.address] = device
          peers[device.address]?.let(::connect) // GATT client over the peer's link, not a second link.
        } else {
          incoming.remove(device.address); incomingMtu.remove(device.address)
          receivers.remove(device.address)?.clear(); pendingHellos.remove(device.address)
          if (boundIncoming == device.address) rangingSession?.fallback()
        }
      }
    }
    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      post { if (incoming.containsKey(device.address)) incomingMtu[device.address] = mtu.coerceIn(23, 517) }
    }
    override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int,
      characteristic: BluetoothGattCharacteristic) {
      post {
        val token = lease.token(now) ?: return@post
        val value = when (characteristic.uuid) {
          FitWire.tokenUuid -> FitWire.tokenValue(token)
          FitWire.nearbyUuid -> byteArrayOf()
          FitWire.capabilityUuid -> FitWire.capability(token,
            rangingAvailable == true && (!rangingAttempted || rangingSession?.ble == false))
          else -> null
        }
        val slice = value?.let { FitWire.readSlice(it, offset, incomingMtu[device.address] ?: 23) }
        val status = if (value == null) BluetoothGatt.GATT_READ_NOT_PERMITTED
          else if (slice == null) BluetoothGatt.GATT_INVALID_OFFSET else BluetoothGatt.GATT_SUCCESS
        server?.sendResponse(device, requestId, status, offset, slice)
      }
    }
    override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int,
      characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray) {
      if (!responseNeeded) return
      val copy = if (value.size <= 512) value.copyOf() else null
      post {
        var status = BluetoothGatt.GATT_WRITE_NOT_PERMITTED
        if (characteristic.uuid == FitWire.oobUuid && !preparedWrite && offset == 0 && copy != null && rangingAvailable == true) {
          val key = device.address
          val receiver = receivers[key] ?: if (receivers.size < 4) FitOobReceiver().also { receivers[key] = it } else null
          if (receiver != null) {
            try {
              val message = receiver.accept(copy, now, incomingMtu[key] ?: 23)
              status = if (message == null || receiveOob(key, message)) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE
            } catch (_: IllegalArgumentException) {
              receivers.remove(key)?.clear()
              if (boundIncoming == key) rangingSession?.fallback()
              status = BluetoothGatt.GATT_FAILURE
            }
          }
        }
        copy?.fill(0)
        server?.sendResponse(device, requestId, status, offset, null)
      }
    }
    override fun onDescriptorReadRequest(device: BluetoothDevice, requestId: Int, offset: Int,
      descriptor: BluetoothGattDescriptor) {
      post { server?.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null) }
    }
    override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int,
      descriptor: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
      post { if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null) }
    }
    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      post { server?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null) }
    }
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      post {
        if (intent.action == Intent.ACTION_SCREEN_OFF) fail("interrupted")
        else if (intent.action == BluetoothAdapter.ACTION_STATE_CHANGED &&
          intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR) != BluetoothAdapter.STATE_ON)
          fail("bluetooth-off")
      }
    }
  }

  private fun prepareRanging() {
    if (Build.VERSION.SDK_INT < 36 ||
      context.checkSelfPermission("android.permission.RANGING") != PackageManager.PERMISSION_GRANTED ||
      !context.packageManager.hasSystemFeature(PackageManager.FEATURE_UWB)) return
    rangingAvailable = null
    val executor = Executor { task -> handler.post {
      if (!closed && lease.alive(now)) {
        try { task.run() } catch (_: RuntimeException) { rangingAvailability(false) }
      }
    } }
    try {
      rangingPort = FitRangingApi36(context, executor).also { it.watch(::rangingAvailability) }
    } catch (_: RuntimeException) { rangingAvailability(false) }
    catch (_: LinkageError) { rangingAvailability(false) }
  }

  private fun rangingAvailability(available: Boolean) {
    if (closed || !lease.alive(now) || rangingAvailable == false) return
    val previous = rangingAvailable
    rangingAvailable = available
    if (!available && previous == true) { rangingAttempted = true; rangingSession?.fallback() }
    startRadios()
    for (peer in peers.values.toList()) { resolveCapability(peer); emit(peer); drive(peer) }
  }

  private fun maybeRanging() {
    if (closed || rangingAvailable != true || rangingAttempted) return
    val candidates = peers.values.filter { now - it.seenAt <= 1000 }
    val eligible = candidates.filter { it.capabilityChecked && it.canRange && it.state.token != null }
    if (eligible.isNotEmpty() && decisionAt == null) decisionAt = now
    if (candidates.size != 1 || eligible.size != 1) return
    val peer = eligible.single()
    val local = lease.token(now) ?: return
    val remote = peer.state.token?.let(FitWire::tokenData) ?: return
    val port = rangingPort ?: return
    val session = FitOobSession(local, remote, { now }, { task -> post(task) }, port, {
      emit(peer); drive(peer)
    })
    rangingPeer = peer; rangingSession = session; rangingAttempted = true
    session.begin()
    val pending = pendingHellos.entries.firstOrNull { now < it.value.second && session.matches(it.value.first) }
    if (pending != null) {
      boundIncoming = pending.key
      session.receive(pending.value.first)
      pendingHellos.remove(pending.key)
    }
    drive(peer)
  }

  private fun receiveOob(key: String, message: FitOobMessage): Boolean {
    val session = rangingSession
    if (session != null && session.matches(message) && !session.ble) {
      if (boundIncoming != null && boundIncoming != key) return false
      boundIncoming = key
      return session.receive(message)
    }
    // The other central may finish its READ first. Hold only HELLO, bounded and token-bound,
    // until our reverse connection has independently read that peer's token and capabilities.
    val local = lease.token(now) ?: return false
    if (message.type != FitOobWire.HELLO || !message.recipient.contentEquals(local) ||
      message.sender.contentEquals(local) || !FitOobWire.initiator(message.sender, local) || rangingAttempted) return false
    if (!pendingHellos.containsKey(key) && pendingHellos.size >= 4) return false
    pendingHellos[key] = message to (now + 2000)
    maybeRanging()
    return true
  }

  private val tick = object : Runnable {
    override fun run() {
      post {
        if (!hasPermissions()) { fail("permission"); return@post }
        if (adapter?.isEnabled != true) { fail("bluetooth-off"); return@post }
        if (rangingAvailable == null && now - startedAt >= 5000) {
          rangingAvailability(false); quiet { rangingPort?.close() }; rangingPort = null
        }
        if (rangingPort != null && context.checkSelfPermission("android.permission.RANGING") != PackageManager.PERMISSION_GRANTED) {
          rangingAvailability(false); quiet { rangingPort?.close() }; rangingPort = null
        }
        if (!serviceAdded && now - startedAt > 5000) { fail("interrupted"); return@post }
        if (scanning && !advertising && now - radioRequestedAt > 5000) { fail("interrupted"); return@post }
        val recent = peers.values.count { now - it.seenAt <= 1000 }
        if (recent > 1) rangingSession?.fallback()
        rangingSession?.tick()
        if (!rangingAttempted && decisionAt?.let { now - it >= 5000 } == true) {
          rangingAttempted = true
          for (peer in peers.values) emit(peer)
        }
        for (key in receivers.filterValues { it.expired(now) }.keys.toList()) {
          receivers.remove(key)?.clear()
          if (boundIncoming == key) rangingSession?.fallback()
        }
        for (key in pendingHellos.filterValues { now >= it.second }.keys.toList()) pendingHellos.remove(key)
        for (peer in peers.values.toList()) {
          if (now - peer.seenAt > 4000) {
            disconnect(peer); peer.state.clear(); peers.remove(peer.key)
          } else if (peer.gatt == null) connect(peer)
          else if ((!peer.connected && now - peer.attemptAt > 5000) || peer.gate.expired(now)) disconnect(peer)
          else if (peer.connected && peer.gate.idle) drive(peer)
        }
        maybeRanging()
        if (!closed) handler.postDelayed(this, 250)
      }
    }
  }

  private fun hasPermissions() = fitBluetoothPermissions.all {
    context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
  }

  private fun disconnect(peer: Peer) {
    if (rangingPeer === peer) rangingSession?.fallback()
    val old = peer.gatt
    peer.gatt = null; peer.connected = false; peer.tokenCharacteristic = null
    peer.capabilityCharacteristic = null; peer.oobCharacteristic = null
    peer.capabilityChecked = false; peer.canRange = false; peer.writingSession = null
    peer.gate.clear(); peer.state.unread(); peer.retryAt = now + 1000
    emit(peer) // Same real RSSI timestamp, so null revokes a previous token without fabricating signal data.
    quiet { old?.disconnect() }; quiet { old?.close() }
  }

  private fun fail(kind: String) {
    if (closed) return
    lease.invalidate(); cleanup(); failure(kind)
  }

  private fun quiet(block: () -> Unit) { try { block() } catch (_: RuntimeException) { /* Continue teardown. */ } }

  private fun cleanup() {
    if (closed) return
    closed = true; lease.invalidate()
    rangingSession?.close(); rangingSession = null; rangingPeer = null
    quiet { rangingPort?.close() }; rangingPort = null
    for (receiver in receivers.values) receiver.clear()
    receivers.clear(); pendingHellos.clear(); boundIncoming = null
    handler.removeCallbacksAndMessages(null)
    quiet { scanner?.stopScan(scanCallback) }
    quiet { advertiser?.stopAdvertising(advertiseCallback) }
    for (peer in peers.values) {
      quiet { peer.gatt?.disconnect() }; quiet { peer.gatt?.close() }
      peer.gate.clear(); peer.state.clear(); peer.gatt = null
    }
    for (device in incoming.values) quiet { server?.cancelConnection(device) }
    quiet { server?.clearServices() }; quiet { server?.close() }
    if (registered) quiet { context.unregisterReceiver(receiver) }
    registered = false; peers.clear(); incoming.clear(); incomingMtu.clear()
    server = null; scanner = null; advertiser = null; adapter = null
    thread.quitSafely()
  }
}
