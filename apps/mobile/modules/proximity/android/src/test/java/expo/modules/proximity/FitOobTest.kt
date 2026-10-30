package expo.modules.proximity

import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque
import java.util.concurrent.Executor

class FitOobTest {
  private val a = ByteArray(16)
  private val b = ByteArray(16) { 1 }
  private fun reject(action: () -> Unit) {
    try { action(); fail("Expected malformed OOB data to be rejected") } catch (_: IllegalArgumentException) {}
  }

  @Test fun rolesUseUnsignedBytesAndCapabilitiesAreBoundToTheCurrentToken() {
    assertTrue(FitOobWire.initiator(a, b))
    assertFalse(FitOobWire.initiator(b, a))
    assertFalse(FitOobWire.initiator(ByteArray(16) { 0x80.toByte() }, ByteArray(16) { 0x7f }))
    reject { FitOobWire.initiator(a, a) }
    assertTrue(FitWire.canRange(FitWire.capability(b, true), b))
    assertFalse(FitWire.canRange(FitWire.capability(b, true), a))
    assertFalse(FitWire.canRange(FitWire.capability(b), b))
    assertFalse(FitWire.canRange(FitWire.capability(b, true).also { it[1] = 7 }, b))
  }

  @Test fun payloadsRoundTripAtDefaultAndLargeMtuWithoutSharingCallerBuffers() {
    for (mtu in listOf(23, 185, 517)) for (size in listOf(1, 16, 4096)) {
      val payload = ByteArray(size) { (it % 251).toByte() }
      val original = payload.copyOf()
      val outbox = FitOobOutbox(a, b)
      val receiver = FitOobReceiver()
      assertTrue(outbox.enqueue(FitOobWire.DATA, payload)); payload.fill(0)
      var result: FitOobMessage? = null
      while (true) {
        val frame = outbox.next(mtu) ?: break
        assertTrue(frame.size <= minOf(mtu - 3, 512))
        assertArrayEquals(frame, outbox.next(mtu))
        val received = receiver.accept(frame, 1000, mtu)
        assertNull(receiver.accept(frame, 1000, mtu)) // Exact ATT retry, delivered only once.
        if (received != null) { assertNull(result); result = received }
        assertTrue(outbox.acknowledge())
      }
      assertNotNull(result)
      assertArrayEquals(a, result!!.sender); assertArrayEquals(b, result.recipient)
      assertArrayEquals(original, result.payload)
    }
  }

  @Test fun malformedFragmentsTimeoutsReplayAndOversizedMessagesAreRejected() {
    val outbox = FitOobOutbox(a, b)
    assertFalse(outbox.enqueue(FitOobWire.DATA))
    assertFalse(outbox.enqueue(FitOobWire.HELLO, byteArrayOf(1)))
    assertFalse(outbox.enqueue(FitOobWire.DATA, ByteArray(4097)))
    assertTrue(outbox.enqueue(FitOobWire.HELLO))
    val first = outbox.next(23)!!
    reject { FitOobReceiver().accept(first.copyOf().also { it[0] = 2 }, 0, 23) }
    reject { FitOobReceiver().accept(first.copyOf().also { it[6] = 127 }, 0, 23) }
    reject { FitOobReceiver().accept(first.copyOf().also { it[9] = 1 }, 0, 23) }
    reject { FitOobReceiver().accept(first.copyOf().also { it[5] = 2 }, 0, 23) }
    val receiver = FitOobReceiver()
    receiver.accept(first, 0, 23)
    assertFalse(receiver.expired(1999)); assertTrue(receiver.expired(2000))
    outbox.acknowledge()
    reject { receiver.accept(outbox.next(23)!!, 2000, 23) }
    val reordered = FitOobReceiver(); reordered.accept(first, 0, 23)
    reject { reordered.accept(first.copyOf().also { it[10] = 3 }, 1, 23) }
    val replay = FitOobReceiver(); val queue = FitOobOutbox(a, b)
    queue.enqueue(FitOobWire.HELLO); val original = queue.next(23)!!
    while (true) { val f = queue.next(23) ?: break; replay.accept(f, 0, 23); queue.acknowledge() }
    reject { replay.accept(original, 1, 23) }
  }

  @Test fun outboxBoundsQueuedAndTotalMessages() {
    val queue = FitOobOutbox(a, b)
    repeat(8) { assertTrue(queue.enqueue(FitOobWire.DATA, byteArrayOf(1))) }
    assertFalse(queue.enqueue(FitOobWire.DATA, byteArrayOf(1)))
    while (queue.next(517) != null) queue.acknowledge()
    repeat(24) {
      assertTrue(queue.enqueue(FitOobWire.DATA, byteArrayOf(1)))
      queue.next(517); queue.acknowledge()
    }
    assertFalse(queue.enqueue(FitOobWire.DATA, byteArrayOf(1)))
  }

  private class Receiver : FitOobReceiveCallback {
    val values = mutableListOf<ByteArray>()
    var closed = 0
    override fun data(value: ByteArray) { values.add(value) }
    override fun closed() { closed++ }
    override fun failed() {}
  }
  @Test fun transportUsesTheRegisteredExecutorAndFencesOldCallbacksOnClose() {
    val tasks = ArrayDeque<Runnable>(); val executor = Executor { tasks.add(it) }
    var failures = 0
    val transport = FitOobTransport({ it() }, { true }, {}, { failures++ })
    assertTrue(transport.receive(byteArrayOf(8)))
    val old = Receiver(); transport.register(executor, old)
    val replacement = Receiver(); transport.register(executor, replacement)
    while (tasks.isNotEmpty()) tasks.remove().run()
    assertTrue(old.values.isEmpty())
    transport.receive(byteArrayOf(9))
    assertTrue(replacement.values.isEmpty())
    tasks.remove().run()
    assertArrayEquals(byteArrayOf(9), replacement.values.single()) // The SDK may retain the buffer.
    transport.receive(byteArrayOf(10)); transport.close(); transport.close()
    while (tasks.isNotEmpty()) tasks.remove().run()
    assertEquals(1, replacement.values.size); assertEquals(1, replacement.closed)
    assertFalse(transport.receive(byteArrayOf(11))); assertEquals(0, failures)
  }

  @Test fun transportBoundsPreRegistrationAndPendingSdkSends() {
    val actions = ArrayDeque<() -> Unit>(); var failures = 0
    val transport = FitOobTransport({ actions.add(it) }, { true }, {}, { failures++ })
    repeat(8) { assertTrue(transport.receive(byteArrayOf(1))) }
    assertFalse(transport.receive(byteArrayOf(1)))
    repeat(9) { transport.send(byteArrayOf(2)) }
    while (actions.isNotEmpty()) actions.remove()()
    assertEquals(1, failures)
    assertFalse(transport.receive(byteArrayOf(1)))
  }

  @Test fun aParallelSdkExecutorStillReceivesMessagesInOrder() {
    val tasks = mutableListOf<Runnable>()
    val receiver = Receiver()
    val transport = FitOobTransport({ it() }, { true }, {}, {})
    transport.register(Executor { tasks.add(it) }, receiver)
    transport.receive(byteArrayOf(1)); transport.receive(byteArrayOf(2)); transport.receive(byteArrayOf(3))
    assertEquals(1, tasks.size) // Scheduling one task per message would permit reordering.
    tasks.removeAt(0).run()
    assertEquals(listOf(1, 2, 3), receiver.values.map { it[0].toInt() })
    transport.close()
  }

  private class Port(private val earlyPayload: ByteArray? = null) : FitRangingPort {
    var role: Boolean? = null
    var result: ((Double) -> Unit)? = null
    var failure: (() -> Unit)? = null
    var transport: FitOobTransport? = null
    var closes = 0
    val received = Receiver()
    override fun watch(available: (Boolean) -> Unit) { available(true) }
    override fun start(initiator: Boolean, transport: FitOobTransport, distance: (Double) -> Unit, failed: () -> Unit): AutoCloseable {
      role = initiator; result = distance; failure = failed; this.transport = transport
      earlyPayload?.let { transport.send(it) }
      transport.register(Executor { it.run() }, received)
      return AutoCloseable { closes++ }
    }
    override fun close() {}
  }

  @Test fun responderSdkDataWaitsBehindReadyAndReRegistrationDoesNotSendReadyTwice() {
    val pa = Port(); val pb = Port(byteArrayOf(7))
    val sa = FitOobSession(a, b, { 0 }, { it() }, pa, {})
    val sb = FitOobSession(b, a, { 0 }, { it() }, pb, {})
    sa.begin(); sb.begin()
    val rb = FitOobReceiver(); val ra = FitOobReceiver()
    transfer(sa, sb, rb)
    assertEquals(FitOobWire.READY, sb.nextFrame(23)!![1].toInt())
    transfer(sb, sa, ra)
    assertArrayEquals(byteArrayOf(7), pa.received.values.single())
    pb.transport!!.register(Executor { it.run() }, pb.received)
    assertNull(sb.nextFrame(23))
    sa.close(); sb.close()
  }
  private fun transfer(from: FitOobSession, to: FitOobSession, receiver: FitOobReceiver, mtu: Int = 23) {
    while (true) {
      val frame = from.nextFrame(mtu) ?: break
      val message = receiver.accept(frame, 0, mtu)
      from.acknowledge()
      if (message != null) assertTrue(to.receive(message))
    }
  }

  @Test fun bothRolesHandshakeBeforeSdkDataAndFreshUwbUnblocksReporting() {
    var now = 0L; val pa = Port(); val pb = Port()
    val sa = FitOobSession(a, b, { now }, { it() }, pa, {})
    val sb = FitOobSession(b, a, { now }, { it() }, pb, {})
    sa.begin(); sb.begin()
    assertFalse(sa.reportable(now)); assertFalse(sb.reportable(now)); assertNull(pa.role)
    val ra = FitOobReceiver(); val rb = FitOobReceiver()
    transfer(sa, sb, rb)
    assertEquals(false, pb.role); assertNull(pa.role)
    transfer(sb, sa, ra)
    assertEquals(true, pa.role)
    pa.transport!!.send(byteArrayOf(4, 5)); transfer(sa, sb, rb)
    assertArrayEquals(byteArrayOf(4, 5), pb.received.values.single())
    pa.result!!(0.5); assertTrue(sa.reportable(now)); assertEquals(0.5, sa.distance(now)!!, 0.0)
    now = 1001; assertFalse(sa.reportable(now)); sa.tick()
    assertTrue(sa.ble); assertTrue(sa.reportable(now)); assertNull(sa.distance(now)); assertEquals(1, pa.closes)
    pa.result!!(0.01); assertNull(sa.distance(now)) // A late SDK result cannot revive ranging.
    sa.close(); sb.close()
  }

  @Test fun timeoutBadTokenUnexpectedOrderAndSdkFailureFallBackWithoutInventingDistances() {
    var now = 0L; val port = Port()
    val session = FitOobSession(a, b, { now }, { it() }, port, {})
    session.begin()
    assertFalse(session.receive(FitOobMessage(FitOobWire.READY, a, b, byteArrayOf())))
    assertFalse(session.reportable(now))
    now = 5000; session.tick(); assertTrue(session.reportable(now)); assertNull(session.distance(now))
    val early = FitOobSession(a, b, { now }, { it() }, port, {})
    early.begin()
    assertFalse(early.receive(FitOobMessage(FitOobWire.DATA, b, a, byteArrayOf(1))))
    assertTrue(early.ble)
    val failed = FitOobSession(a, b, { now }, { it() }, port, {})
    failed.begin(); failed.receive(FitOobMessage(FitOobWire.READY, b, a, byteArrayOf()))
    port.failure!!(); assertTrue(failed.ble); assertNull(failed.distance(now))
    port.result!!(0.01); assertNull(failed.distance(now))
    failed.close(); early.close(); session.close()
  }

  @Test fun invalidDistanceOrCloseNeverPublishesAnOldMeasurement() {
    val port = Port(); val session = FitOobSession(a, b, { 0 }, { it() }, port, {})
    session.begin(); session.receive(FitOobMessage(FitOobWire.READY, b, a, byteArrayOf()))
    port.result!!(Double.NaN); assertTrue(session.ble); assertNull(session.distance(0))
    session.close(); port.result!!(0.1); assertFalse(session.reportable(0))
  }

  @Test fun sessionOwnsTokenCopiesAndCloseDropsPendingFrames() {
    val local = a.copyOf(); val peer = b.copyOf()
    val session = FitOobSession(local, peer, { 0 }, { it() }, Port(), {})
    local.fill(9); peer.fill(9)
    assertTrue(session.matches(FitOobMessage(FitOobWire.READY, b, a, byteArrayOf())))
    session.begin(); assertNotNull(session.nextFrame(23))
    session.close(); assertNull(session.nextFrame(23)); assertFalse(session.reportable(0))
    assertArrayEquals(ByteArray(16) { 9 }, local)
    assertArrayEquals(ByteArray(16) { 9 }, peer)
  }
}
