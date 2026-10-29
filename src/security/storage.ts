/**
 * Almacenamiento cifrado de Brainloop.
 *
 * - Valores pequeños y sensibles (cuenta local, API Key, preferencias, claves del
 *   historial) → expo-secure-store: cada valor se cifra con una clave AES del
 *   Android Keystore del propio dispositivo (límite 2048 bytes por valor).
 * - Historial de chat → cifrado AES-256-CTR + HMAC-SHA256 con claves aleatorias
 *   guardadas en SecureStore; el texto cifrado va en AsyncStorage.
 * - Estadísticas de uso (solo números) → AsyncStorage en claro.
 */
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openString, sealString } from './cipher';
import { fromHex, toHex } from './pbkdf2';

export const KEYS = {
  account: 'brainloop.account.v1',
  lockout: 'brainloop.lockout.v1',
  apiKey: 'brainloop.apikey.v1',
  chatKey: 'brainloop.chatkey.v1',
  chat: 'brainloop.chat.v1', // AsyncStorage (cifrado) — Terminal
  prefs: 'brainloop.prefs.v1',
  stats: 'brainloop.stats.v1', // AsyncStorage (no sensible)
} as const;

/**
 * Borra del teléfono los datos que dejaron versiones anteriores y que esta ya no
 * usa: cualquier clave «brainloop.*» de AsyncStorage que no sea de la versión actual.
 */
export async function migrateLegacy(): Promise<void> {
  try {
    const known = new Set<string>(Object.values(KEYS));
    const all = await AsyncStorage.getAllKeys();
    const stale = all.filter((k) => k.startsWith('brainloop.') && !known.has(k));
    if (stale.length) await AsyncStorage.multiRemove(stale);
  } catch {
    // Si falla, se reintenta en el próximo arranque.
  }
}

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Máximo de mensajes / caracteres que se conservan cifrados en el dispositivo. */
export const MAX_STORED_MESSAGES = 100;
export const MAX_STORED_CHARS = 300_000;

export async function secureGet(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, SECURE_OPTS);
}

export async function secureSet(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, SECURE_OPTS);
}

export async function secureDelete(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, SECURE_OPTS);
}

export async function secureGetJSON<T>(key: string): Promise<T | null> {
  const raw = await secureGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function secureSetJSON(key: string, value: unknown): Promise<void> {
  await secureSet(key, JSON.stringify(value));
}

// ---------- Historial de chat (cifrado autenticado) ----------

async function getChatKeys(create: boolean): Promise<{ enc: Uint8Array; mac: Uint8Array } | null> {
  let hex = await secureGet(KEYS.chatKey);
  if (!hex) {
    if (!create) return null;
    hex = toHex(Crypto.getRandomBytes(64));
    await secureSet(KEYS.chatKey, hex);
  }
  const raw = fromHex(hex);
  return { enc: raw.subarray(0, 32), mac: raw.subarray(32, 64) };
}

/** Recorta por número de mensajes y por tamaño total, conservando los más recientes. */
export function trimHistory<T>(messages: T[]): T[] {
  let kept = messages.slice(-MAX_STORED_MESSAGES);
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_STORED_CHARS) kept = kept.slice(1);
  return kept;
}

export type ChatSlot = 'terminal';
const slotKey = (_slot: ChatSlot) => KEYS.chat;

export async function loadChatHistory<T>(slot: ChatSlot = 'terminal'): Promise<T[]> {
  const sealed = await AsyncStorage.getItem(slotKey(slot));
  if (!sealed) return [];
  const keys = await getChatKeys(false);
  const json = keys ? openString(sealed, keys.enc, keys.mac) : null;
  if (json === null) {
    // Manipulado o sin clave: se descarta en lugar de mostrar datos no verificados.
    await AsyncStorage.removeItem(slotKey(slot));
    return [];
  }
  try {
    return JSON.parse(json) as T[];
  } catch {
    return [];
  }
}

export async function saveChatHistory<T>(messages: T[], slot: ChatSlot = 'terminal'): Promise<void> {
  const keys = await getChatKeys(true);
  if (!keys) return;
  const sealed = sealString(JSON.stringify(trimHistory(messages)), keys.enc, keys.mac, Crypto.getRandomBytes(16));
  await AsyncStorage.setItem(slotKey(slot), sealed);
}

export async function clearChatHistory(slot: ChatSlot = 'terminal'): Promise<void> {
  await AsyncStorage.removeItem(slotKey(slot));
}

// ---------- Preferencias de seguridad ----------

export interface SecurityPrefs {
  /** FLAG_SECURE: bloquea capturas, grabación de pantalla y la miniatura en Recientes. */
  blockScreenshots: boolean;
}

export const DEFAULT_PREFS: SecurityPrefs = { blockScreenshots: true };

export async function loadPrefs(): Promise<SecurityPrefs> {
  return { ...DEFAULT_PREFS, ...((await secureGetJSON<Partial<SecurityPrefs>>(KEYS.prefs)) ?? {}) };
}

export async function savePrefs(prefs: SecurityPrefs): Promise<void> {
  await secureSetJSON(KEYS.prefs, prefs);
}

// ---------- Borrado total ----------

/** Elimina TODOS los datos de la app del dispositivo (cuenta, API Key, chat y estadísticas). */
export async function wipeAllData(): Promise<void> {
  await Promise.all(
    [KEYS.account, KEYS.lockout, KEYS.apiKey, KEYS.chatKey, KEYS.prefs].map((k) =>
      secureDelete(k).catch(() => undefined)
    )
  );
  await AsyncStorage.clear().catch(() => undefined);
}
