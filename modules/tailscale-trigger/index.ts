/**
 * Local Expo module: the Android-native half of Personae's remote access.
 *
 * The JS-facing wrapper actually used by the app is `src/native/tailscale.ts`, which loads this
 * module optionally (it is absent in Expo Go, on iOS and under the Node test runner). This file
 * only exists so the module is a well-formed Expo module.
 */
export * from '../../src/native/tailscale';
