"use client";

/**
 * UI-facing device-fleet operations (docs/MULTI_DEVICE_PLAN.md M2–M4), thin
 * wrappers over charproof with our per-backend providers applied. Everything
 * here concerns the member's OWN devices — the roster/threads never see
 * devices at all (guardrail G1): the vouched key is the identity, devices
 * are transport for it.
 */

import { esignCharproof, type CustodyUser } from "./custody";

export interface DeviceEnv {
  backend: "mock" | "firestore";
  me: CustodyUser;
}

export interface PendingDeviceRequest {
  deviceId: string;
  publicKey: string;
  decryptedDeviceName?: string;
  status?: string;
  createdAt?: number;
}

export interface AuthorizedDevice {
  deviceId: string;
  decryptedDeviceName: string;
  publicKey: string;
  createdAt: number;
}

function lib(env: DeviceEnv) {
  return esignCharproof(env.backend, env.me);
}

/** This browser's stable device id (for "this device" markers). */
export async function currentDeviceId(env: DeviceEnv): Promise<string> {
  return (await lib(env)).getDeviceId();
}

/**
 * New-device path 2 (§M2): file a pending authorization request and return
 * the 6-digit code the member reads off this screen and types into their
 * already-authorized device.
 */
export async function requestAuthorization(env: DeviceEnv): Promise<string> {
  const cp = await lib(env);
  await cp.requestDeviceAuthorization();
  const code = await cp.getLocalVerificationCode();
  if (!code) throw new Error("Could not compute this device's verification code");
  return code;
}

/** Resolves the unsubscribe fn; fires onAuthorized when the fleet lets this device in. */
export async function watchAuthorization(
  env: DeviceEnv,
  onAuthorized: () => void
): Promise<() => void> {
  const cp = await lib(env);
  return cp.subscribeCurrentDeviceStatus(onAuthorized);
}

export async function watchPendingRequests(
  env: DeviceEnv,
  onUpdate: (requests: PendingDeviceRequest[]) => void
): Promise<() => void> {
  const cp = await lib(env);
  return cp.subscribePendingRequests((requests) => {
    onUpdate(
      (requests as unknown as PendingDeviceRequest[]).filter(
        (r) => r.status !== "authorized" && r.status !== "rejected"
      )
    );
  });
}

/**
 * Approve on the OLD device. The typed code is enforced (D3): charproof
 * recomputes the code from the pending request's public key and hard-fails
 * on mismatch, so a swapped-in attacker key can't be authorized by habit.
 */
export async function approveDevice(
  env: DeviceEnv,
  request: PendingDeviceRequest,
  typedCode: string
): Promise<void> {
  const cp = await lib(env);
  const expected = typedCode.replace(/\D/g, "");
  if (expected.length !== 6) throw new Error("Type the 6-digit code shown on the new device");
  try {
    await cp.approveDeviceAuthorization(
      request as unknown as Parameters<typeof cp.approveDeviceAuthorization>[0],
      { expectedVerificationCode: expected }
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("VERIFICATION_CODE_MISMATCH")) {
      throw new Error("That code doesn't match the new device — check its screen and retype");
    }
    throw err;
  }
}

export async function rejectDevice(env: DeviceEnv, deviceId: string): Promise<void> {
  await (await lib(env)).rejectDeviceRequest(deviceId);
}

export async function watchAuthorizedDevices(
  env: DeviceEnv,
  onUpdate: (devices: AuthorizedDevice[]) => void
): Promise<() => void> {
  const cp = await lib(env);
  return cp.subscribeAuthorizedDevices((devices) => onUpdate(devices as AuthorizedDevice[]));
}

/** Sign a device out of the fleet: rotates the AMK for everyone remaining. */
export async function removeDevice(env: DeviceEnv, deviceId: string): Promise<void> {
  await (await lib(env)).revokeDevice(deviceId);
}

export interface RecoveryOverview {
  hasPhrase: boolean;
  hasPasskeyHere: boolean;
  methods: string[];
}

export async function recoveryOverview(env: DeviceEnv): Promise<RecoveryOverview> {
  const cp = await lib(env);
  const status = await cp.getRecoveryStatus();
  const methods = status?.methods ?? [];
  return {
    hasPhrase: methods.some((m) => /phrase/i.test(m)),
    hasPasskeyHere: status?.isCurrentPrfSealed ?? false,
    methods,
  };
}

/** Generate + register the 24-word phrase; caller shows it ONCE and confirms words back. */
export async function setupPhrase(env: DeviceEnv): Promise<string> {
  return (await lib(env)).setupPhraseRecovery();
}

/** New-device path 3 (§M2): phrase recovery on a clean device. */
export async function recoverWithPhrase(env: DeviceEnv, mnemonic: string): Promise<void> {
  const cp = await lib(env);
  const words = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  const { amk, amkId } = await cp.recoverAmkWithPhrase(words);
  await cp.registerCurrentDevice(amk, amkId);
}

/**
 * Last resort (§M2 path 4): wipe the remote account-keys document and keystore
 * for this user and start from nothing. Every other device is locked out, the
 * member's NEXT enrollment mints a new key, and they must be re-vouched. The
 * TOFU root pin in our own IndexedDB survives on purpose.
 */
export async function startOver(env: DeviceEnv): Promise<void> {
  const cp = await lib(env);
  await cp.resetUserAccountRemote();
  await cp.resetLocalStorage();
  cp.clearAmkSessionCache();
  cp.clearPrfSessionCache();
}
