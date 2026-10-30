@file:Suppress("MissingPermission")

package expo.modules.proximity

import android.content.Context
import android.ranging.*
import android.ranging.oob.*
import androidx.annotation.RequiresApi
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/** Loaded only after the API/permission/feature gate. No framework payload enters logs. */
@RequiresApi(36)
internal class FitRangingApi36(context: Context, private val executor: Executor) : FitRangingPort {
  private val manager = context.getSystemService(RangingManager::class.java)
  private var capabilitiesCallback: RangingManager.RangingCapabilitiesCallback? = null
  private var closed = false
  override fun watch(available: (Boolean) -> Unit) {
    if (closed) return
    val api = manager
    if (api == null) { available(false); return }
    val callback = object : RangingManager.RangingCapabilitiesCallback {
      override fun onRangingCapabilities(value: RangingCapabilities) {
        if (!closed) available(value.technologyAvailability[RangingManager.UWB] == RangingCapabilities.ENABLED &&
          value.uwbCapabilities?.isDistanceMeasurementSupported == true)
      }
    }
    capabilitiesCallback = callback
    try { api.registerCapabilitiesCallback(executor, callback) }
    catch (_: RuntimeException) { available(false) }
  }
  override fun start(initiator: Boolean, transport: FitOobTransport,
    distance: (Double) -> Unit, failed: () -> Unit): AutoCloseable {
    check(!closed)
    val api = requireNotNull(manager)
    val active = AtomicBoolean(true)
    val peer = RangingDevice.Builder().setUuid(UUID.randomUUID()).build()
    val handle = object : TransportHandle {
      override fun registerReceiveCallback(worker: Executor, receiver: TransportHandle.ReceiveCallback) {
        transport.register(worker, object : FitOobReceiveCallback {
          override fun data(value: ByteArray) { receiver.onReceiveData(value) }
          override fun closed() { receiver.onClose() }
          override fun failed() { receiver.onSendFailed() }
        })
      }
      override fun sendData(value: ByteArray) { transport.send(value) }
      override fun close() {
        transport.close()
        executor.execute { if (active.get()) failed() }
      }
    }
    val callback = object : RangingSession.Callback {
      override fun onOpened() {}
      override fun onOpenFailed(reason: Int) { if (active.get()) failed() }
      override fun onClosed(reason: Int) { if (active.get()) failed() }
      override fun onStopped(device: RangingDevice, technology: Int) { if (active.get() && device == peer) failed() }
      override fun onStarted(device: RangingDevice, technology: Int) {
        if (active.get() && (device != peer || technology != RangingManager.UWB)) failed()
      }
      override fun onResults(device: RangingDevice, value: RangingData) {
        if (!active.get()) return
        if (device != peer || value.rangingTechnology != RangingManager.UWB) { failed(); return }
        // Framework timestamp is wall-clock milliseconds. Afterwards the core uses monotonic age.
        if (System.currentTimeMillis() - value.timestampMillis !in 0..1000) return
        val meters = value.distance?.measurement ?: return
        if (meters.isFinite() && meters >= 0) distance(meters) else failed()
      }
    }
    val session = requireNotNull(api.createRangingSession(executor, callback))
    val owner = AutoCloseable {
      if (active.getAndSet(false)) {
        try { session.stop() } catch (_: RuntimeException) { /* Still close resources. */ }
        try { session.close() } catch (_: RuntimeException) { /* Already closed. */ }
        transport.close()
      }
    }
    try {
      val device = DeviceHandle.Builder(peer, handle).build()
      val config: RangingConfig = if (initiator) OobInitiatorRangingConfig.Builder()
        .addDeviceHandle(device)
        .setRangingMode(OobInitiatorRangingConfig.RANGING_MODE_HIGH_ACCURACY)
        .setSecurityLevel(OobInitiatorRangingConfig.SECURITY_LEVEL_SECURE)
        .setFastestRangingInterval(Duration.ofMillis(100))
        .setSlowestRangingInterval(Duration.ofMillis(500)).build()
      else OobResponderRangingConfig.Builder(device).build()
      session.start(RangingPreference.Builder(
        if (initiator) RangingPreference.DEVICE_ROLE_INITIATOR else RangingPreference.DEVICE_ROLE_RESPONDER, config)
        .setSessionConfig(SessionConfig.Builder().setAngleOfArrivalNeeded(false).build()).build())
    } catch (_: RuntimeException) { owner.close(); failed() }
    return owner
  }
  override fun close() {
    if (closed) return
    closed = true
    capabilitiesCallback?.let { callback ->
      try { manager?.unregisterCapabilitiesCallback(callback) } catch (_: RuntimeException) { /* Already unavailable. */ }
    }
    capabilitiesCallback = null
  }
}
