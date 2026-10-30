package expo.modules.installation
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class InstallationModule : Module() {
  private fun marker(): File {
    val context = requireNotNull(appContext.reactContext)
    return File(context.noBackupFilesDir, "puzzle-installation")
  }
  override fun definition() = ModuleDefinition {
    Name("Installation")
    Function("localBuildEnabled") {
      val context = requireNotNull(appContext.reactContext)
      val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      context.packageName == "jp.puzzlesns.app.local" &&
        (info.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
        info.metaData?.getBoolean("jp.puzzlesns.LOCAL_MODE", false) == true
    }
    AsyncFunction("needsReset") { !marker().exists() }
    AsyncFunction("commit") {
      val temporary = File(marker().parentFile, "puzzle-installation.tmp")
      temporary.writeText("v1")
      check(temporary.renameTo(marker()))
    }
  }
}
