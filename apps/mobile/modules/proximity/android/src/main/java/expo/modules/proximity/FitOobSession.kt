package expo.modules.proximity

import java.util.ArrayDeque

/** Serialized protocol/ranging state; tested with fake SDK sessions, not physical distances. */
internal class FitOobSession(
  local: ByteArray,
  peer: ByteArray,
  private val clock: () -> Long,
  dispatch: (() -> Unit) -> Unit,
  private val port: FitRangingPort,
  private val changed: () -> Unit
) : AutoCloseable {
  private val local = local.copyOf()
  private val peer = peer.copyOf()
  private enum class Phase { NEW, HELLO, READY, STARTING, ACTIVE, BLE, CLOSED }
  private var phase = Phase.NEW
  private val initiator = FitOobWire.initiator(this.local, this.peer)
  private val outbox = FitOobOutbox(this.local, this.peer)
  private val pending = ArrayDeque<ByteArray>()
  private var link: AutoCloseable? = null
  private var deadline = 0L
  private var registered = false
  private var distance: Double? = null
  private var distanceAt = 0L
  val ble: Boolean get() = phase == Phase.BLE || phase == Phase.CLOSED
  val transport = FitOobTransport(dispatch, ::send, ::registered, ::fallback)

  fun begin() {
    if (phase != Phase.NEW) return
    deadline = clock() + 5000
    phase = if (initiator) Phase.READY else Phase.HELLO
    if (initiator && !outbox.enqueue(FitOobWire.HELLO)) fallback()
  }
  fun matches(message: FitOobMessage) = message.sender.contentEquals(peer) && message.recipient.contentEquals(local)
  fun receive(message: FitOobMessage): Boolean {
    if (!matches(message) || phase == Phase.CLOSED || phase == Phase.BLE) return false
    when {
      message.type == FitOobWire.ABORT -> fallback()
      message.type == FitOobWire.HELLO && !initiator && phase == Phase.HELLO -> start()
      message.type == FitOobWire.READY && initiator && phase == Phase.READY -> start()
      message.type == FitOobWire.DATA && (phase == Phase.STARTING || phase == Phase.ACTIVE) -> {
        if (!transport.receive(message.payload)) { fallback(); return false }
      }
      else -> { fallback(); return false }
    }
    return true
  }
  private fun start() {
    phase = Phase.STARTING
    try {
      val created = port.start(initiator, transport, distance@ { meters ->
        if (phase != Phase.STARTING && phase != Phase.ACTIVE) return@distance
        if (!meters.isFinite() || meters < 0) { fallback(); return@distance }
        distance = meters; distanceAt = clock(); phase = Phase.ACTIVE; changed()
      }, ::fallback)
      if (phase == Phase.STARTING || phase == Phase.ACTIVE) link = created else created.close()
    } catch (_: RuntimeException) { fallback() }
  }
  private fun registered() {
    if (registered || (phase != Phase.STARTING && phase != Phase.ACTIVE)) return
    registered = true
    if (!initiator && !outbox.enqueue(FitOobWire.READY)) { fallback(); return }
    while (pending.isNotEmpty()) {
      val value = pending.remove()
      val accepted = outbox.enqueue(FitOobWire.DATA, value); value.fill(0)
      if (!accepted) { fallback(); return }
    }
    changed()
  }
  private fun send(value: ByteArray): Boolean {
    if (phase != Phase.STARTING && phase != Phase.ACTIVE) return false
    if (!registered) {
      if (pending.size >= 8) return false
      pending.add(value.copyOf()); return true
    }
    val accepted = outbox.enqueue(FitOobWire.DATA, value)
    if (accepted) changed()
    return accepted
  }
  fun nextFrame(mtu: Int): ByteArray? = if (phase == Phase.BLE || phase == Phase.CLOSED) null else outbox.next(mtu)
  fun acknowledge(): Boolean = outbox.acknowledge()
  fun distance(now: Long): Double? = distance?.takeIf { phase == Phase.ACTIVE && now - distanceAt in 0..1000 }
  fun reportable(now: Long): Boolean = phase == Phase.BLE || distance(now) != null
  fun tick() {
    if ((phase == Phase.HELLO || phase == Phase.READY || phase == Phase.STARTING) && clock() >= deadline) fallback()
    else if (phase == Phase.ACTIVE && clock() - distanceAt > 1000) fallback()
  }
  fun fallback() {
    if (phase == Phase.BLE || phase == Phase.CLOSED) return
    phase = Phase.BLE; dispose(); changed()
  }
  private fun dispose() {
    val old = link; link = null
    try { old?.close() } catch (_: Exception) { /* Continue teardown. */ }
    transport.close(); outbox.clear()
    local.fill(0); peer.fill(0)
    for (value in pending) value.fill(0)
    pending.clear(); distance = null
  }
  override fun close() { if (phase != Phase.CLOSED) { phase = Phase.CLOSED; dispose() } }
}
