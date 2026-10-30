package expo.modules.proximity

import android.Manifest
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

internal val fitBluetoothPermissions = arrayOf(
  Manifest.permission.BLUETOOTH_SCAN,
  Manifest.permission.BLUETOOTH_ADVERTISE,
  Manifest.permission.BLUETOOTH_CONNECT
)

class ProximityModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var lease: FitLease? = null
  @Volatile private var radio: FitRadio? = null
  private var focusView: View? = null
  private var focusListener: ViewTreeObserver.OnWindowFocusChangeListener? = null

  override fun definition() = ModuleDefinition {
    Name("Proximity")
    Events("observation", "unavailable")
    // Local RSSI correction table key (e.g. PDRM00). Never transmitted.
    Constant("model") { Build.MODEL.orEmpty() }
    AsyncFunction("start") { token: String, serviceUuid: String, runId: String ->
      stopCurrent()
      val context = appContext.reactContext
      val bytes = FitWire.tokenData(token)
      val expected = context?.let { FitWire.serviceFor(it.packageName) }
      val supplied = try { UUID.fromString(serviceUuid) } catch (_: IllegalArgumentException) { null }
      if (Build.VERSION.SDK_INT < 31 || context == null || bytes == null ||
        expected == null || supplied != expected || runId.isEmpty() || runId.length > 128 ||
        !localRegistrationAllowed()) {
        unavailable(runId, "unsupported")
      } else if (!foreground()) {
        unavailable(runId, "interrupted")
      } else {
        val current = FitLease(runId, bytes, SystemClock.elapsedRealtime())
        lease = current
        val view = appContext.currentActivity?.window?.decorView
        val listener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
          if (!focused && lease === current) stopCurrent("interrupted")
        }
        focusView = view; focusListener = listener
        view?.viewTreeObserver?.addOnWindowFocusChangeListener(listener)
        val requested = if (Build.VERSION.SDK_INT >= 36 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_UWB))
          fitBluetoothPermissions + "android.permission.RANGING" else fitBluetoothPermissions
        if (requested.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
          launch(current, expected)
        } else {
          val permissions = appContext.permissions
          if (permissions == null) stopCurrent("permission")
          else permissions.askForPermissions(PermissionsResponseListener {
            main.post {
              // A dialog/pause or an old permission response cannot restart a cancelled run.
              if (lease === current) {
                if (fitBluetoothPermissions.any { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED })
                  stopCurrent("permission")
                else if (!foreground()) stopCurrent("interrupted")
                else launch(current, expected)
              }
            }
          }, *requested)
        }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { runId: String, promise: Promise ->
      if (lease?.runId == runId) stopCurrent(completed = { promise.resolve(null) })
      else promise.resolve(null)
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { stopFromLifecycle() }
    OnUserLeavesActivity { stopFromLifecycle() }
    OnActivityDestroys { stopFromLifecycle() }
    OnDestroy { stopFromLifecycle() }
  }

  private fun foreground(): Boolean {
    val activity = appContext.currentActivity ?: return false
    val state = (activity as? LifecycleOwner)?.lifecycle?.currentState ?: return false
    return state.isAtLeast(Lifecycle.State.RESUMED) && activity.hasWindowFocus() && !activity.isFinishing
  }

  private fun localRegistrationAllowed(): Boolean {
    val context = appContext.reactContext ?: return false
    if (context.packageName != "jp.puzzlesns.app.local") return true
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    return (info.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
      info.metaData?.getBoolean("jp.puzzlesns.LOCAL_MODE", false) == true
  }

  private fun launch(current: FitLease, service: UUID) {
    if (lease !== current || !current.alive(SystemClock.elapsedRealtime()) || !foreground()) {
      if (lease === current) stopCurrent("interrupted")
      return
    }
    val context = appContext.reactContext ?: return stopCurrent("interrupted")
    val next = FitRadio(context.applicationContext, current, service,
      observation = { value -> main.post {
        if (lease === current && current.alive(SystemClock.elapsedRealtime())) sendEvent("observation", value)
      } },
      failure = { kind -> main.post { if (lease === current) stopCurrent(kind) } }
    )
    radio = next
    next.start()
  }

  private fun unavailable(runId: String, kind: String) {
    sendEvent("unavailable", mapOf("runId" to runId, "kind" to kind))
  }

  private fun stopFromLifecycle() {
    val previous = lease
    previous?.invalidate() // Deny GATT immediately, including when the JS runtime is stalled.
    if (Looper.myLooper() == Looper.getMainLooper()) stopCurrent("interrupted")
    else main.post { if (lease === previous) stopCurrent("interrupted") }
  }

  private fun stopCurrent(kind: String? = null, completed: () -> Unit = {}) {
    val previous = lease
    lease = null
    previous?.invalidate()
    val oldRadio = radio; radio = null
    val view = focusView
    val listener = focusListener
    if (view?.viewTreeObserver?.isAlive == true && listener != null)
      view.viewTreeObserver.removeOnWindowFocusChangeListener(listener)
    focusView = null; focusListener = null
    if (kind != null && previous != null) unavailable(previous.runId, kind)
    if (oldRadio != null) oldRadio.stop(completed) else completed()
  }
}
