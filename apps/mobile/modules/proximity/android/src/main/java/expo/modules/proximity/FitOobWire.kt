package expo.modules.proximity

import java.nio.ByteBuffer
import java.util.ArrayDeque

/** App envelope only. The OS OOB payload is opaque and is never logged or persisted. */
internal data class FitOobMessage(val type: Int, val sender: ByteArray, val recipient: ByteArray, val payload: ByteArray)

internal object FitOobWire {
  const val HELLO = 1
  const val READY = 2
  const val DATA = 3
  const val ABORT = 4
  const val MAX_BODY = 4128
  fun initiator(local: ByteArray, peer: ByteArray): Boolean {
    require(local.size == 16 && peer.size == 16 && !local.contentEquals(peer))
    for (i in local.indices) {
      val a = local[i].toInt() and 255; val b = peer[i].toInt() and 255
      if (a != b) return a < b
    }
    error("Identical tokens")
  }
  fun validBody(type: Int, length: Int): Boolean =
    type in HELLO..ABORT && if (type == DATA) length in 33..MAX_BODY else length == 32
}

/** One outstanding chunk. A write acknowledgement, not a call to next(), advances the stream. */
internal class FitOobOutbox(private val local: ByteArray, private val peer: ByteArray) {
  private data class Message(val type: Int, val id: Int, val body: ByteArray, var offset: Int = 0)
  private val messages = ArrayDeque<Message>()
  private var nextId = 1
  private var pendingLength = 0
  fun enqueue(type: Int, payload: ByteArray = byteArrayOf()): Boolean {
    if (messages.size >= 8 || nextId > 32 || !FitOobWire.validBody(type, 32 + payload.size)) return false
    messages.add(Message(type, nextId++, local + peer + payload))
    return true
  }
  fun next(mtu: Int): ByteArray? {
    val message = messages.peek() ?: return null
    val capacity = minOf(mtu - 3, 512) - 10
    if (capacity <= 0) return null
    val length = minOf(capacity, message.body.size - message.offset)
    pendingLength = length
    return ByteBuffer.allocate(10 + length).put(1).put(message.type.toByte())
      .putInt(message.id).putShort(message.body.size.toShort()).putShort(message.offset.toShort())
      .put(message.body, message.offset, length).array()
  }
  fun acknowledge(): Boolean {
    val message = messages.peek() ?: return false
    if (pendingLength == 0) return false
    message.offset += pendingLength; pendingLength = 0
    if (message.offset == message.body.size) { messages.remove(); message.body.fill(0) }
    return true
  }
  fun clear() { for (m in messages) m.body.fill(0); messages.clear(); pendingLength = 0 }
}

/** Bounded to one assembly per incoming connection. Native code caps connections at four. */
internal class FitOobReceiver {
  private var body: ByteArray? = null
  private var received = 0
  private var messageId = 0
  private var type = 0
  private var completedId = 0
  private var deadline = 0L
  private var lastFrame: ByteArray? = null
  fun expired(now: Long): Boolean = body != null && now >= deadline
  fun accept(frame: ByteArray, now: Long, mtu: Int): FitOobMessage? {
    require(frame.size in 11..minOf(mtu - 3, 512) && !expired(now)) { "Invalid OOB frame" }
    if (lastFrame?.contentEquals(frame) == true) return null
    val header = ByteBuffer.wrap(frame)
    val version = header.get().toInt() and 255
    val nextType = header.get().toInt() and 255
    val id = header.int
    val total = header.short.toInt() and 65535
    val offset = header.short.toInt() and 65535
    require(version == 1 && id in 1..32 && FitOobWire.validBody(nextType, total)) { "Invalid OOB header" }
    if (body == null) {
      require(id == completedId + 1 && offset == 0) { "Out of order OOB message" }
      body = ByteArray(total); received = 0; messageId = id; type = nextType; deadline = now + 2000
    }
    val value = requireNotNull(body)
    require(id == messageId && nextType == type && total == value.size && offset == received &&
      frame.size - 10 <= total - received) { "Out of order OOB fragment" }
    frame.copyInto(value, received, 10)
    received += frame.size - 10
    lastFrame?.fill(0); lastFrame = frame.copyOf()
    if (received != total) return null
    val message = FitOobMessage(type, value.copyOfRange(0, 16), value.copyOfRange(16, 32), value.copyOfRange(32, total))
    completedId = messageId; value.fill(0); body = null; received = 0
    return message
  }
  fun clear() { body?.fill(0); body = null; lastFrame?.fill(0); lastFrame = null }
}
