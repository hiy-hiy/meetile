package expo.modules.proximity

import java.util.UUID

/** Invalidated synchronously on pause, before queued Bluetooth cleanup runs. */
internal class FitLease(val runId: String, token: ByteArray, private val startedAt: Long) {
  @Volatile private var active = true
  private val bytes = token.copyOf()
  fun alive(now: Long): Boolean = active && now >= startedAt && now - startedAt < 45_000
  @Synchronized fun token(now: Long): ByteArray? = if (alive(now)) bytes.copyOf() else null
  @Synchronized fun invalidate() { active = false; bytes.fill(0) }
}

/** One outstanding GATT operation; callbacks cannot finish a different operation or connection. */
internal class FitOperationGate {
  private var owner: Any? = null
  private var kind: String? = null
  private var deadline = 0L
  val idle: Boolean get() = kind == null
  fun begin(connection: Any, operation: String, now: Long): Boolean {
    if (!idle) return false
    // A full discovery of an iPhone's database as its peripheral took over 3 s on Android 13.
    owner = connection; kind = operation; deadline = now + if (operation == "discover") 10_000 else 3_000
    return true
  }
  fun complete(connection: Any, operation: String): Boolean {
    if (owner !== connection || kind != operation) return false
    clear(); return true
  }
  fun expired(now: Long): Boolean = !idle && now >= deadline
  fun clear() { owner = null; kind = null; deadline = 0 }
}

/**
 * An iPhone advertises and connects from one address. If we connect first, its connection back to our
 * advertising address is refused and it sees us twice. Give peers a head start and reuse their link.
 */
internal object FitConnectOrder {
  const val HEAD_START_MS = 2_000L
  /** A link left from our previous run (token rotation) pins our old address; let it drop first. */
  const val STALE_LINK_MS = 6_000L
  fun mayInitiate(now: Long, firstSeenAt: Long, connectedToUs: Boolean, staleLink: Boolean = false): Boolean =
    connectedToUs || now - firstSeenAt >= if (staleLink) STALE_LINK_MS else HEAD_START_MS
}

/** An unread peer still exists. A rotated token gets a new, uncorrelatable JS handle. */
internal class FitPeerState(private val newHandle: () -> String = { UUID.randomUUID().toString() }) {
  var handle: String = newHandle(); private set
  private var previous: ByteArray? = null
  private var readable = false
  val token: String? get() = if (readable) previous?.let(FitWire::tokenString) else null
  /** OS class from the token value; selects RSSI correction in JS only. */
  var platform: String? = null; private set
  fun read(value: ByteArray?, ownToken: ByteArray): Boolean {
    val data = value?.takeIf { it.size == 16 || it.size == 17 }?.copyOfRange(0, 16)
    if (data == null || data.contentEquals(ownToken)) {
      unread(); return false
    }
    if (previous != null && !data.contentEquals(previous)) handle = newHandle()
    previous?.fill(0); previous = data; readable = true
    platform = FitWire.platform(value)
    return true
  }
  fun unread() { readable = false }
  fun clear() { unread(); previous?.fill(0); previous = null; platform = null }
}
