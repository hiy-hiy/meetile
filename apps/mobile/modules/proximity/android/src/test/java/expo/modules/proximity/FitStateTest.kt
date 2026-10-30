package expo.modules.proximity

import org.junit.Assert.*
import org.junit.Test

class FitStateTest {
  private val own = ByteArray(16) { 1 }
  private val remote = ByteArray(16) { 2 }

  @Test fun canonicalTokensMatchIosAndRejectAliases() {
    val zero = ByteArray(16)
    assertEquals("AAAAAAAAAAAAAAAAAAAAAA", FitWire.tokenString(zero))
    assertArrayEquals(zero, FitWire.tokenData("AAAAAAAAAAAAAAAAAAAAAA"))
    for (text in listOf("", "A".repeat(21), "A".repeat(23), "A".repeat(21) + "B", "A".repeat(21) + "+", "A".repeat(22) + "=="))
      assertNull(FitWire.tokenData(text))
    for (n in 0..255) {
      val bytes = ByteArray(16) { (n + it).toByte() }
      assertArrayEquals(bytes, FitWire.tokenData(FitWire.tokenString(bytes)!!))
    }
    assertNull(FitWire.tokenString(ByteArray(17)))
  }

  @Test fun environmentServiceAndCapabilityAreExplicit() {
    val local = FitWire.serviceFor("jp.puzzlesns.app.local")
    assertNotNull(local)
    assertNotEquals(local, FitWire.serviceFor("jp.puzzlesns.app.staging"))
    assertNull(FitWire.serviceFor("some.other.app"))
    val capability = FitWire.capability(own)
    assertEquals(18, capability.size)
    assertEquals(1, capability[0].toInt())
    assertEquals(0, capability[1].toInt())
    assertArrayEquals(own, capability.copyOfRange(2, 18))
  }

  @Test fun readOffsetsHandleLongValuesAndTheEmptyNiCharacteristic() {
    val data = ByteArray(100) { it.toByte() }
    assertEquals(22, FitWire.readSlice(data, 0, 23)!!.size)
    assertArrayEquals(data.copyOfRange(22, 44), FitWire.readSlice(data, 22, 23))
    assertArrayEquals(byteArrayOf(), FitWire.readSlice(data, 100, 23))
    assertArrayEquals(byteArrayOf(), FitWire.readSlice(byteArrayOf(), 0, 23))
    assertNull(FitWire.readSlice(data, -1, 23))
    assertNull(FitWire.readSlice(data, 101, 23))
    assertNull(FitWire.readSlice(byteArrayOf(), 1, 23))
  }

  @Test fun stoppedOrExpiredLeaseCannotServeTokensEvenIfCallbacksArriveLater() {
    val lease = FitLease("first", own, 1000)
    assertFalse(lease.alive(999))
    assertTrue(lease.alive(45_999))
    assertNull(lease.token(46_000))
    val returned = lease.token(2000)!!
    returned.fill(9)
    assertArrayEquals(own, lease.token(2001))
    lease.invalidate(); lease.invalidate()
    assertNull(lease.token(2002))
    val replacement = FitLease("second", remote, 2000)
    assertArrayEquals(remote, replacement.token(2002))
    assertNull(lease.token(2002))
  }

  @Test fun operationQueueSerializesAndRejectsWrongCallbackAndConnection() {
    val gate = FitOperationGate()
    val connection = Any()
    assertTrue(gate.begin(connection, "token", 1000))
    assertFalse(gate.begin(connection, "rssi", 1001))
    assertFalse(gate.complete(connection, "rssi"))
    assertFalse(gate.complete(Any(), "token"))
    assertFalse(gate.idle)
    assertFalse(gate.expired(3999))
    assertTrue(gate.expired(4000))
    gate.clear()
    val replacement = Any()
    assertTrue(gate.begin(replacement, "token", 5000))
    assertFalse(gate.complete(connection, "token"))
    assertTrue(gate.complete(replacement, "token"))
    assertTrue(gate.idle)
    assertTrue(gate.begin(replacement, "discover", 6000))
    assertFalse(gate.expired(15_999))
    assertTrue(gate.expired(16_000))
  }

  @Test fun unreadPeerRemainsPresentAndOnlyTokenRotationChangesHandle() {
    var counter = 0
    val peer = FitPeerState { "local-handle-${++counter}" }
    val initial = peer.handle
    assertNull(peer.token)
    assertTrue(peer.read(remote, own))
    assertEquals(initial, peer.handle)
    peer.unread()
    assertNull(peer.token)
    assertEquals(initial, peer.handle)
    assertTrue(peer.read(remote, own))
    assertEquals(initial, peer.handle)
    assertTrue(peer.read(ByteArray(16) { 3 }, own))
    assertNotEquals(initial, peer.handle)
    assertFalse(peer.read(own, own))
    assertNull(peer.token)
    assertFalse(peer.read(ByteArray(15), own))
    assertNull(peer.token)
    peer.clear()
    assertNull(peer.token)
  }

  @Test fun tokenValueCarriesOnlyTheOsClass() {
    assertTrue(FitWire.tokenValue(remote).contentEquals(remote + 2))
    val peer = FitPeerState()
    assertTrue(peer.read(remote + 1, own))
    assertEquals(FitWire.tokenString(remote), peer.token)
    assertEquals("ios", peer.platform)
    assertTrue(peer.read(remote, own))
    assertNull(peer.platform) // 16 bytes: an older build of unknown class.
    assertTrue(peer.read(remote + 9, own))
    assertNull(peer.platform)
    assertFalse(peer.read(own + 1, own))
    assertFalse(peer.read(remote + byteArrayOf(1, 1), own))
    assertNull(peer.token)
    peer.clear()
    assertNull(peer.platform)
  }

  @Test fun peerOwnsItsCopyOfReceivedToken() {
    val peer = FitPeerState()
    val data = remote.copyOf()
    peer.read(data, own)
    data.fill(0)
    assertEquals(FitWire.tokenString(remote), peer.token)
    peer.clear()
    assertNull(peer.token)
  }

  @Test fun peerGetsAHeadStartAndItsLinkIsReused() {
    val seen = 10_000L
    assertFalse(FitConnectOrder.mayInitiate(seen, seen, connectedToUs = false))
    assertFalse(FitConnectOrder.mayInitiate(seen + FitConnectOrder.HEAD_START_MS - 1, seen, connectedToUs = false))
    assertTrue(FitConnectOrder.mayInitiate(seen + FitConnectOrder.HEAD_START_MS, seen, connectedToUs = false))
    assertTrue(FitConnectOrder.mayInitiate(seen, seen, connectedToUs = true))
    val stale = seen + FitConnectOrder.STALE_LINK_MS
    assertFalse(FitConnectOrder.mayInitiate(stale - 1, seen, connectedToUs = false, staleLink = true))
    assertTrue(FitConnectOrder.mayInitiate(stale, seen, connectedToUs = false, staleLink = true))
  }
}
