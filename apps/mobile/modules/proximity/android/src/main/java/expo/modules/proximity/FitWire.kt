package expo.modules.proximity

import java.util.Base64
import java.util.UUID

/** No Android state: wire format shared with iOS. Never log tokens or Bluetooth addresses. */
internal object FitWire {
  val tokenUuid: UUID = UUID.fromString("BD1E1001-0E40-4CB6-AF31-8B034F29A718")
  val nearbyUuid: UUID = UUID.fromString("BD1E1002-0E40-4CB6-AF31-8B034F29A718")
  val capabilityUuid: UUID = UUID.fromString("BD1E1003-0E40-4CB6-AF31-8B034F29A718")
  val oobUuid: UUID = UUID.fromString("BD1E1004-0E40-4CB6-AF31-8B034F29A718")
  private val services = mapOf(
    "jp.puzzlesns.app.development" to "BD1E1000-0E40-4CB6-AF31-8B034F29A718",
    "jp.puzzlesns.app.staging" to "BD1E2000-0E40-4CB6-AF31-8B034F29A718",
    "jp.puzzlesns.app.production" to "BD1E3000-0E40-4CB6-AF31-8B034F29A718",
    "jp.puzzlesns.app.local" to "BD1E4000-0E40-4CB6-AF31-8B034F29A718"
  )
  /** G-PROX 5-5e: the token value ends with one OS-class byte; 16 bytes or an unknown class = unknown. */
  const val PLATFORM_IOS: Byte = 1
  const val PLATFORM_ANDROID: Byte = 2
  fun tokenValue(token: ByteArray): ByteArray = token + PLATFORM_ANDROID
  fun platform(value: ByteArray): String? = if (value.size != 17) null else when (value[16]) {
    PLATFORM_IOS -> "ios"
    PLATFORM_ANDROID -> "android"
    else -> null
  }
  fun serviceFor(packageName: String): UUID? = services[packageName]?.let(UUID::fromString)
  fun tokenString(data: ByteArray): String? =
    if (data.size == 16) Base64.getUrlEncoder().withoutPadding().encodeToString(data) else null

  fun tokenData(token: String): ByteArray? {
    if (!Regex("^[A-Za-z0-9_-]{22}$").matches(token)) return null
    val data = try { Base64.getUrlDecoder().decode(token) } catch (_: IllegalArgumentException) { return null }
    return data.takeIf { tokenString(it) == token }
  }

  fun capability(token: ByteArray, available: Boolean = false): ByteArray =
    byteArrayOf(1, if (available) 3 else 0) + token
  fun canRange(value: ByteArray?, token: ByteArray): Boolean = value != null && value.size == 18 &&
    value[0] == 1.toByte() && value[1] == 3.toByte() && value.copyOfRange(2, 18).contentEquals(token)
  fun readSlice(value: ByteArray, offset: Int, mtu: Int): ByteArray? {
    if (offset < 0 || offset > value.size || mtu < 23) return null
    return value.copyOfRange(offset, minOf(value.size, offset + mtu - 1))
  }
}
