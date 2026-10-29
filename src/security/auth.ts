/**
 * Cuenta local de Brainloop: usuario + contraseña (PBKDF2-HMAC-SHA256) y huella opcional.
 *
 * - No hay servidor: la cuenta solo existe cifrada en este teléfono.
 * - La contraseña nunca se guarda; solo sal aleatoria + hash PBKDF2.
 * - Intentos fallidos con bloqueo progresivo persistente (no se reinicia cerrando la app).
 * - "Olvidé la contraseña" = borrado total (no existe puerta trasera).
 */
import * as Crypto from 'expo-crypto';
import type * as LocalAuthenticationTypes from 'expo-local-authentication';
import { pbkdf2Sha256, toHex, fromHex, timingSafeEqualHex, utf8Encode } from './pbkdf2';
import { KEYS, secureGetJSON, secureSetJSON, secureDelete } from './storage';

export const PBKDF2_ITERATIONS = 25000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

interface StoredAccount {
  v: 1;
  alias: string;
  salt: string;
  hash: string;
  iterations: number;
  biometric: boolean;
  createdAt: string;
}

interface LockoutState {
  failed: number;
  lockedUntil: number;
}

export interface Session {
  alias: string;
  biometric: boolean;
}

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; lockedUntil: number; attemptsLeft: number };

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 60));

function derive(password: string, saltHex: string, iterations: number): string {
  return toHex(pbkdf2Sha256(utf8Encode(password), fromHex(saltHex), iterations, 32));
}

export function validateAlias(alias: string): string | null {
  const a = alias.trim();
  if (a.length < 3 || a.length > 24) return 'El usuario debe tener entre 3 y 24 caracteres.';
  // Sin escapes \p{..}: se compilan igual en Hermes y en cualquier motor JS.
  if (!/^[A-Za-z0-9\u00C0-\u00FF._-]+$/.test(a)) return 'Usa solo letras, números, punto, guion o guion bajo.';
  return null;
}

export function validatePassword(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH)
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (!/[A-Za-zÀ-ÿ]/.test(pw) || !/[0-9]/.test(pw)) return 'Combina letras y números.';
  if (pw !== confirm) return 'Las contraseñas no coinciden.';
  return null;
}

export async function getAccountInfo(): Promise<Session | null> {
  const acc = await secureGetJSON<StoredAccount>(KEYS.account);
  return acc ? { alias: acc.alias, biometric: acc.biometric } : null;
}

export async function createAccount(alias: string, password: string, biometric: boolean): Promise<Session> {
  await yieldToUI();
  const salt = toHex(Crypto.getRandomBytes(16));
  const acc: StoredAccount = {
    v: 1,
    alias: alias.trim(),
    salt,
    hash: derive(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    biometric,
    createdAt: new Date().toISOString(),
  };
  await secureSetJSON(KEYS.account, acc);
  await secureDelete(KEYS.lockout);
  return { alias: acc.alias, biometric };
}

export async function getLockout(): Promise<LockoutState> {
  return (await secureGetJSON<LockoutState>(KEYS.lockout)) ?? { failed: 0, lockedUntil: 0 };
}

export async function loginWithPassword(password: string): Promise<LoginResult> {
  const acc = await secureGetJSON<StoredAccount>(KEYS.account);
  const lock = await getLockout();
  if (!acc) return { ok: false, lockedUntil: 0, attemptsLeft: 0 };
  if (lock.lockedUntil > Date.now()) {
    return { ok: false, lockedUntil: lock.lockedUntil, attemptsLeft: 0 };
  }
  await yieldToUI();
  const ok = timingSafeEqualHex(derive(password, acc.salt, acc.iterations), acc.hash);
  if (ok) {
    await secureDelete(KEYS.lockout);
    return { ok: true, session: { alias: acc.alias, biometric: acc.biometric } };
  }
  const failed = lock.failed + 1;
  const over = failed - MAX_FREE_ATTEMPTS;
  const lockedUntil = over >= 0 ? Date.now() + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS) : 0;
  await secureSetJSON(KEYS.lockout, { failed, lockedUntil });
  return { ok: false, lockedUntil, attemptsLeft: Math.max(0, MAX_FREE_ATTEMPTS - failed) };
}

export async function changePassword(current: string, next: string): Promise<boolean> {
  const acc = await secureGetJSON<StoredAccount>(KEYS.account);
  if (!acc) return false;
  await yieldToUI();
  if (!timingSafeEqualHex(derive(current, acc.salt, acc.iterations), acc.hash)) return false;
  const salt = toHex(Crypto.getRandomBytes(16));
  await secureSetJSON(KEYS.account, {
    ...acc,
    salt,
    hash: derive(next, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
  });
  return true;
}

// ---------- Biometría ----------

// Carga perezosa: si el módulo nativo fallara en algún móvil, la app sigue
// funcionando con contraseña en lugar de quedarse sin arrancar.
let localAuth: typeof LocalAuthenticationTypes | null | undefined;
function getLocalAuth(): typeof LocalAuthenticationTypes | null {
  if (localAuth === undefined) {
    try {
      localAuth = require('expo-local-authentication') as typeof LocalAuthenticationTypes;
    } catch {
      localAuth = null;
    }
  }
  return localAuth;
}

export async function biometricAvailable(): Promise<boolean> {
  const la = getLocalAuth();
  if (!la) return false;
  try {
    return (await la.hasHardwareAsync()) && (await la.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Muestra el diálogo del sistema. Sin alternativa de PIN del móvil: la alternativa es tu contraseña. */
export async function promptBiometric(message = 'Desbloquear Brainloop'): Promise<boolean> {
  const la = getLocalAuth();
  if (!la) return false;
  try {
    const res = await la.authenticateAsync({
      promptMessage: message,
      cancelLabel: 'Usar contraseña',
      disableDeviceFallback: true,
    });
    return res.success;
  } catch {
    return false;
  }
}

export async function loginWithBiometric(): Promise<Session | null> {
  const acc = await secureGetJSON<StoredAccount>(KEYS.account);
  if (!acc || !acc.biometric) return null;
  if (!(await biometricAvailable())) return null;
  if (!(await promptBiometric())) return null;
  await secureDelete(KEYS.lockout);
  return { alias: acc.alias, biometric: true };
}

export async function setBiometric(enabled: boolean): Promise<boolean> {
  const acc = await secureGetJSON<StoredAccount>(KEYS.account);
  if (!acc) return false;
  if (enabled && !(await promptBiometric('Confirma tu huella para activarla'))) return false;
  await secureSetJSON(KEYS.account, { ...acc, biometric: enabled });
  return true;
}
