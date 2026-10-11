/**
 * Config plugin: declare the Tailscale client in `<queries>`.
 *
 * Why this is needed at all: sending an **explicit** broadcast (one with `setPackage()`) requires no
 * package visibility. *Detecting* whether the client is installed does — Android 11+ filters
 * `getPackageInfo()` / `getLaunchIntentForPackage()` for packages the app has not declared. Without
 * this entry `isPackageInstalled("com.tailscale.ipn")` always returns false, and the diagnostics
 * panel would claim Tailscale is missing on a phone where it is installed.
 *
 * The default template already ships a `<queries>` element (a VIEW/BROWSABLE intent), so this
 * appends to it instead of replacing it, and is idempotent.
 *
 * Usage in `app.json`:
 *   "plugins": [ ["./modules/tailscale-trigger/app.plugin.js", { "packages": ["com.tailscale.ipn"] }] ]
 *
 * A forked/rebranded client needs its package listed here to be *detectable*; pointing
 * `tailscalePackage` at it in Settings is enough to *drive* it, because the broadcast itself does
 * not need visibility.
 */

const { withAndroidManifest } = require('@expo/config-plugins');

const DEFAULT_PACKAGES = ['com.tailscale.ipn'];

function androidName(entry) {
  return entry && entry.$ ? entry.$['android:name'] : undefined;
}

function withTailscaleQueries(config, options = {}) {
  const packages = Array.isArray(options.packages) && options.packages.length
    ? options.packages.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
    : DEFAULT_PACKAGES;

  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const queries = Array.isArray(manifest.queries) && manifest.queries.length
      ? manifest.queries
      : [{}];
    const bucket = queries[0] || {};
    const existing = Array.isArray(bucket.package) ? bucket.package : [];
    const declared = new Set(existing.map(androidName).filter(Boolean));

    for (const name of packages) {
      if (declared.has(name)) continue;
      existing.push({ $: { 'android:name': name } });
      declared.add(name);
    }

    bucket.package = existing;
    manifest.queries = [bucket, ...queries.slice(1)];
    config.modResults.manifest = manifest;
    return config;
  });
}

module.exports = withTailscaleQueries;
module.exports.default = withTailscaleQueries;
module.exports.DEFAULT_PACKAGES = DEFAULT_PACKAGES;
