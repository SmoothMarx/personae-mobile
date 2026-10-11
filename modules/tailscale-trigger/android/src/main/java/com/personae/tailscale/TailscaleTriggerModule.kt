package com.personae.tailscale

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetSocketAddress
import java.net.Socket

private const val TAG = "TailscaleTrigger"

/**
 * The stock Tailscale client's exported control actions.
 *
 * Upstream declares `IPNReceiver` as `android:exported="true"` with NO `android:permission`, so any
 * app on the device can drive it. Personae uses exactly one of them: CONNECT_VPN.
 */
private const val ACTION_CONNECT_VPN = "com.tailscale.ipn.CONNECT_VPN"
private const val ACTION_DISCONNECT_VPN = "com.tailscale.ipn.DISCONNECT_VPN"

/**
 * Drives a VpnService-based client (Tailscale) through its exported control receiver, and answers
 * the one question that actually matters: can we open a TCP connection to the target?
 *
 * Two things this deliberately does NOT do:
 *  1. It never treats `TRANSPORT_VPN` on the active network as proof the tunnel we need is up. A
 *     competing VPN makes that flag true while Tailscale is disconnected. It is exposed for the
 *     diagnostics panel only, and is labelled as a hint.
 *  2. It never assumes the broadcast worked. `sendBroadcast` is fire-and-forget: the receiver may
 *     have connected, or posted a "please open Tailscale" notification, and either way nothing
 *     reports back to us. Readiness is therefore proven by probing, never by the broadcast result.
 */
class TailscaleTriggerModule : Module() {

  private val context: Context?
    get() = appContext.reactContext

  override fun definition() = ModuleDefinition {
    Name("TailscaleTrigger")

    /**
     * Detecting another package requires package visibility on Android 11+; the
     * `<queries><package android:name="com.tailscale.ipn"/></queries>` entry declared by this
     * module's config plugin is what makes this answer `true` instead of always `false`.
     */
    AsyncFunction("isPackageInstalled") { pkg: String ->
      isInstalled(pkg)
    }

    /** Fire-and-forget. `sent` means "an intent was handed to the OS", never "it connected". */
    AsyncFunction("triggerConnect") { pkg: String ->
      trigger(pkg, ACTION_CONNECT_VPN)
    }

    AsyncFunction("triggerDisconnect") { pkg: String ->
      trigger(pkg, ACTION_DISCONNECT_VPN)
    }

    AsyncFunction("openApp") { pkg: String ->
      openApp(pkg)
    }

    /** Cheap hint for the diagnostics panel. Never used as a readiness test. */
    AsyncFunction("vpnTransportActive") {
      vpnTransportActive()
    }

    /**
     * A real TCP connect, with a real timeout. This is the readiness test.
     *
     * `Socket.connect` blocks, so it is moved off the JS thread explicitly rather than trusting the
     * module's dispatcher.
     *
     * Known and expected limitation: a MagicDNS name (`host.tailnet.ts.net`) does not resolve until
     * the tunnel is already up, so probing by name simply fails until Tailscale is connected and
     * then starts answering. That is the correct behaviour for a readiness poll — it is also why
     * the raw `100.x.y.z` route is kept as a fallback candidate.
     */
    AsyncFunction("probeTcp") { host: String, port: Int, timeoutMs: Int, promise: Promise ->
      val worker = Thread {
        promise.resolve(probeTcp(host, port, timeoutMs))
      }
      worker.isDaemon = true
      worker.start()
    }
  }

  private fun isInstalled(pkg: String): Boolean {
    val ctx = context ?: return false
    if (pkg.isBlank()) return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.packageManager.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        ctx.packageManager.getPackageInfo(pkg, 0)
      }
      true
    } catch (e: PackageManager.NameNotFoundException) {
      false
    } catch (e: Exception) {
      Log.w(TAG, "package visibility lookup for $pkg failed", e)
      false
    }
  }

  /**
   * `setPackage()` is MANDATORY. Without it Android 8.0+ drops the broadcast for a receiver that is
   * not the target of an explicit intent, and NOTHING logs an error - the feature simply appears to
   * do nothing. This is the single most likely bug in the whole mechanism.
   *
   * The broadcast is NOT gated on `isInstalled`. An explicit broadcast needs no package visibility,
   * while the visibility lookup does - and `<queries>` is compile-time. Gating the send on the
   * lookup would therefore make the documented "point `tailscalePackage` at a fork" case fail: the
   * fork would be invisible to `getPackageInfo`, so we would never even try. Sending to a package
   * that is absent is harmless (the OS drops it), so the two are reported separately and the
   * caller decides.
   */
  private fun trigger(pkg: String, action: String): Bundle {
    val ctx = context
    val present = isInstalled(pkg)
    var sent = false
    if (ctx != null && pkg.isNotBlank()) {
      try {
        ctx.sendBroadcast(Intent(action).setPackage(pkg))
        sent = true
      } catch (e: Exception) {
        Log.w(TAG, "broadcast $action to $pkg failed", e)
      }
    }
    return Bundle().apply {
      putBoolean("installed", present)
      putBoolean("sent", sent)
    }
  }

  private fun openApp(pkg: String): Boolean {
    val ctx = context ?: return false
    val launch = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
      ctx.startActivity(launch)
      true
    } catch (e: Exception) {
      Log.w(TAG, "could not open $pkg", e)
      false
    }
  }

  private fun vpnTransportActive(): Boolean = try {
    val ctx = context
    val manager = ctx?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val network = manager?.activeNetwork
    val capabilities = if (manager != null && network != null) manager.getNetworkCapabilities(network) else null
    capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
  } catch (e: Exception) {
    Log.w(TAG, "could not read the active network's transports", e)
    false
  }

  private fun probeTcp(host: String, port: Int, timeoutMs: Int): Boolean {
    if (host.isBlank() || port !in 1..65535) return false
    val timeout = if (timeoutMs > 0) timeoutMs else 1500
    var socket: Socket? = null
    return try {
      socket = Socket()
      socket.connect(InetSocketAddress(host, port), timeout)
      true
    } catch (e: Exception) {
      false
    } finally {
      try {
        socket?.close()
      } catch (e: Exception) {
        // Nothing useful to do: the connection already failed or succeeded and is being discarded.
      }
    }
  }
}
