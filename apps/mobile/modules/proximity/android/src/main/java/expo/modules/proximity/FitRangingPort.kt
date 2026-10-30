package expo.modules.proximity

import java.util.ArrayDeque
import java.util.concurrent.Executor

/** No API 36 types may cross this boundary; Android 12–15 can safely load the radio. */
internal interface FitRangingPort : AutoCloseable {
  fun watch(available: (Boolean) -> Unit)
  fun start(initiator: Boolean, transport: FitOobTransport, distance: (Double) -> Unit, failed: () -> Unit): AutoCloseable
}

internal interface FitOobReceiveCallback {
  fun data(value: ByteArray)
  fun closed()
  fun failed()
}

/** Cross-thread SDK bridge with bounded queues and a close fence on queued deliveries. */
internal class FitOobTransport(
  private val dispatch: (() -> Unit) -> Unit,
  private val sendPayload: (ByteArray) -> Boolean,
  private val registered: () -> Unit,
  private val failure: () -> Unit
) : AutoCloseable {
  private var active = true
  private var executor: Executor? = null
  private var callback: FitOobReceiveCallback? = null
  private val pending = ArrayDeque<ByteArray>()
  private var sending = 0
  private var deliveryScheduled = false
  private var generation = 0L

  @Synchronized fun register(executor: Executor, callback: FitOobReceiveCallback) {
    if (!active) return
    if (this.callback != null) {
      for (value in pending) value.fill(0)
      pending.clear()
    }
    generation++; deliveryScheduled = false
    this.executor = executor; this.callback = callback
    dispatch { if (isActive()) registered() }
    scheduleDelivery()
  }
  @Synchronized fun receive(value: ByteArray): Boolean {
    if (!active || value.size !in 1..4096) return false
    if (pending.size >= 8) return false
    pending.add(value.copyOf())
    scheduleDelivery()
    return true
  }
  @Synchronized fun send(value: ByteArray) {
    if (!active) return
    if (value.size !in 1..4096 || sending >= 8) { dispatch { fail() }; return }
    val copy = value.copyOf(); sending++
    dispatch {
      synchronized(this) { sending-- }
      if (isActive() && !sendPayload(copy)) fail()
      copy.fill(0)
    }
  }
  @Synchronized private fun scheduleDelivery() {
    if (!active || pending.isEmpty() || deliveryScheduled) return
    val worker = executor ?: return
    val receiver = callback ?: return
    val epoch = generation
    deliveryScheduled = true
    try {
      worker.execute {
        // SDK executors may be parallel pools: one drain preserves OOB message order.
        while (true) {
          val value = synchronized(this) {
            if (!active || generation != epoch || callback !== receiver) return@execute
            if (pending.isEmpty()) { deliveryScheduled = false; return@execute }
            pending.remove()
          }
          try { receiver.data(value) } // Ownership transfers; the SDK may retain this array.
          catch (_: RuntimeException) { value.fill(0); dispatch { fail() }; return@execute }
        }
      }
    } catch (_: RuntimeException) { deliveryScheduled = false; dispatch { fail() } }
  }
  @Synchronized private fun isActive() = active
  private fun fail() {
    val receiver: FitOobReceiveCallback?; val worker: Executor?
    synchronized(this) { if (!active) return; receiver = callback; worker = executor }
    try { worker?.execute { receiver?.failed() } } catch (_: RuntimeException) { /* Continue closing. */ }
    close(); failure()
  }
  override fun close() {
    val receiver: FitOobReceiveCallback?; val worker: Executor?
    synchronized(this) {
      if (!active) return
      active = false; receiver = callback; worker = executor; callback = null; executor = null
      generation++; deliveryScheduled = false
      for (value in pending) value.fill(0)
      pending.clear()
    }
    try { worker?.execute { receiver?.closed() } } catch (_: RuntimeException) { /* Already closed. */ }
  }
}
