/**
 * Conectar con Cerebras: el usuario saca su API Key en la web de Cerebras y
 * vuelve a Brainloop, que la detecta, la comprueba y sigue donde estaba.
 *
 * 1. «Abrir Cerebras» abre cloud.cerebras.ai en el navegador.
 * 2. El usuario crea la clave (API Keys → Generate API Key) y la copia.
 * 3. Al volver a la app se mira el portapapeles UNA vez (solo si este flujo está
 *    abierto), se extrae la clave `csk-…`, se valida con GET /v1/models (no gasta
 *    tokens) y se guarda en el Keystore. Después se vacía el portapapeles.
 *
 * Sin dependencias nativas nuevas: Linking y el Clipboard del núcleo de React Native.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CheckCircle2, ClipboardPaste, ExternalLink, KeyRound, X } from 'lucide-react-native';
import { THEME } from '../theme';
import { CEREBRAS_CONSOLE_URL, extractCerebrasKey, verifyCerebrasKey } from '../ai/cerebras';

type ClipboardApi = { getString(): Promise<string>; setString(s: string): void };

/** El módulo nativo se carga solo al usarlo: si faltara, la app no se cae. */
function getClipboard(): ClipboardApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native/Libraries/Components/Clipboard/Clipboard');
    return (mod && (mod.default ?? mod)) as ClipboardApi;
  } catch {
    return null;
  }
}

async function readClipboard(): Promise<string> {
  try {
    return (await getClipboard()?.getString()) ?? '';
  } catch {
    return '';
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'checking'; masked: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; masked: string; models: number };

const mask = (k: string) => `csk-••••${k.slice(-4)}`;

interface Props {
  visible: boolean;
  /** Por qué se pide (aparece arriba). */
  reason?: string;
  onClose: () => void;
  /** Guarda la clave. Si lanza error, se muestra y el flujo sigue abierto. */
  onConnected: (key: string) => Promise<void>;
}

export default function ConnectCerebras({ visible, reason, onClose, onConnected }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [manual, setManual] = useState('');
  const awaitingReturn = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!visible) {
      awaitingReturn.current = false;
      setPhase({ kind: 'idle' });
      setManual('');
    }
  }, [visible]);

  const tryKey = async (raw: string, fromClipboard: boolean) => {
    const key = extractCerebrasKey(raw);
    if (!key) {
      setPhase({
        kind: 'error',
        message: fromClipboard
          ? 'No hay ninguna API Key de Cerebras en el portapapeles. Cópiala con el botón de copiar de la consola y vuelve.'
          : 'Eso no parece una API Key de Cerebras (empiezan por «csk-»).',
      });
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setPhase({ kind: 'checking', masked: mask(key) });
    try {
      const check = await verifyCerebrasKey(key);
      if (!check.ok) {
        setPhase({ kind: 'error', message: check.message });
        return;
      }
      await onConnected(key);
      if (fromClipboard) {
        // La clave no se queda en el portapapeles, donde otras apps podrían leerla.
        try {
          getClipboard()?.setString('');
        } catch {
          // sin portapapeles: nada que limpiar
        }
      }
      setPhase({ kind: 'done', masked: mask(key), models: check.models.length });
      setTimeout(onClose, 1100);
    } catch {
      setPhase({ kind: 'error', message: 'No se pudo guardar la clave en el Keystore del teléfono.' });
    } finally {
      busy.current = false;
    }
  };

  // El listener de AppState usa siempre la versión más reciente (props actuales).
  const tryKeyRef = useRef(tryKey);
  tryKeyRef.current = tryKey;

  // Al volver de la web de Cerebras, se mira el portapapeles (con un pequeño margen:
  // Android solo deja leerlo cuando la ventana ya tiene el foco).
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !awaitingReturn.current) return;
      awaitingReturn.current = false;
      setTimeout(async () => {
        let text = await readClipboard();
        if (!extractCerebrasKey(text)) {
          await new Promise((r) => setTimeout(r, 900));
          text = await readClipboard();
        }
        if (extractCerebrasKey(text)) tryKeyRef.current(text, true);
        else setPhase({ kind: 'error', message: 'Has vuelto, pero no hay ninguna clave copiada. Cópiala en Cerebras o pégala abajo.' });
      }, 600);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const openConsole = async () => {
    try {
      awaitingReturn.current = true;
      setPhase({ kind: 'waiting' });
      await Linking.openURL(CEREBRAS_CONSOLE_URL);
    } catch {
      awaitingReturn.current = false;
      setPhase({ kind: 'error', message: 'No se pudo abrir el navegador. Entra a mano en cloud.cerebras.ai.' });
    }
  };

  const pasteNow = async () => tryKey(await readClipboard(), true);

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <KeyRound size={18} color={THEME.neonCyan} />
            <Text style={styles.title}>CONECTAR CON CEREBRAS</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityLabel="Cerrar">
              <X size={18} color={THEME.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {!!reason && <Text style={styles.reason}>{reason}</Text>}
            <Text style={styles.text}>
              Brainloop usa tu propia cuenta de Cerebras (la capa gratuita basta). Te llevamos a su web para sacar la clave
              y luego vuelves aquí: la app la detecta sola.
            </Text>

            {[
              'Inicia sesión en Cerebras o crea la cuenta gratis.',
              'Entra en «API Keys» y pulsa «Generate API Key».',
              'Copia la clave con el icono de copiar y vuelve a Brainloop.',
            ].map((s, i) => (
              <View key={i} style={styles.step}>
                <Text style={styles.stepNum}>{i + 1}</Text>
                <Text style={[styles.text, styles.flexOne]}>{s}</Text>
              </View>
            ))}

            <TouchableOpacity style={styles.primary} onPress={openConsole} disabled={phase.kind === 'checking'}>
              <ExternalLink size={16} color="#000" />
              <Text style={styles.primaryText}>ABRIR CLOUD.CEREBRAS.AI</Text>
            </TouchableOpacity>

            {phase.kind === 'waiting' && (
              <View style={styles.status}>
                <ActivityIndicator size="small" color={THEME.neonCyan} />
                <Text style={[styles.text, styles.flexOne]}>Esperando a que vuelvas con la clave copiada…</Text>
              </View>
            )}
            {phase.kind === 'checking' && (
              <View style={styles.status}>
                <ActivityIndicator size="small" color={THEME.neonCyan} />
                <Text style={[styles.text, styles.flexOne]}>Comprobando {phase.masked} con Cerebras…</Text>
              </View>
            )}
            {phase.kind === 'done' && (
              <View style={[styles.status, styles.ok]}>
                <CheckCircle2 size={18} color={THEME.neonGreen} />
                <Text style={[styles.text, styles.flexOne, { color: THEME.text }]}>
                  Conectado: {phase.masked} guardada en el Keystore{phase.models ? ` · ${phase.models} modelos disponibles` : ''}.
                </Text>
              </View>
            )}
            {phase.kind === 'error' && (
              <View style={[styles.status, styles.err]}>
                <Text style={[styles.text, styles.flexOne, { color: '#FCA5A5' }]}>{phase.message}</Text>
              </View>
            )}

            <View style={styles.divider} />
            <Text style={styles.label}>¿YA LA TIENES COPIADA?</Text>
            <TouchableOpacity style={styles.secondary} onPress={pasteNow} disabled={phase.kind === 'checking'}>
              <ClipboardPaste size={16} color={THEME.neonCyan} />
              <Text style={styles.secondaryText}>PEGAR DEL PORTAPAPELES</Text>
            </TouchableOpacity>
            <Text style={styles.label}>O ESCRÍBELA A MANO</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.flexOne]}
                value={manual}
                onChangeText={setManual}
                placeholder="csk-…"
                placeholderTextColor={THEME.textDim}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                importantForAutofill="no"
              />
              <TouchableOpacity
                style={[styles.secondary, styles.checkBtn]}
                onPress={() => tryKey(manual.trim(), false)}
                disabled={!manual.trim() || phase.kind === 'checking'}
              >
                <Text style={styles.secondaryText}>COMPROBAR</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.fine}>
              La clave se comprueba contra api.cerebras.ai sin gastar tokens y se guarda cifrada en el Keystore de Android.
              Nunca se incluye en el APK ni se envía a ningún otro sitio.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '92%',
    backgroundColor: THEME.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: THEME.border },
  title: { flex: 1, color: THEME.text, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  body: { padding: 16, paddingBottom: 28, gap: 12 },
  reason: { color: THEME.neonCyan, fontSize: 13, fontWeight: '700', lineHeight: 19 },
  text: { color: THEME.textMuted, fontSize: 13, lineHeight: 19 },
  step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: 12,
    fontWeight: '800',
    color: '#000',
    backgroundColor: THEME.neonCyan,
    overflow: 'hidden',
  },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: THEME.neonCyan,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 4,
  },
  primaryText: { color: '#000', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, padding: 10, backgroundColor: THEME.bg, borderWidth: 1, borderColor: THEME.border },
  ok: { borderColor: THEME.neonGreen, backgroundColor: 'rgba(16,185,129,0.1)' },
  err: { borderColor: THEME.danger, backgroundColor: 'rgba(239,68,68,0.08)' },
  divider: { height: 1, backgroundColor: THEME.border, marginVertical: 4 },
  label: { color: THEME.textDim, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  secondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: THEME.neonCyan,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  secondaryText: { color: THEME.neonCyan, fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    backgroundColor: THEME.bg,
    color: THEME.text,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  checkBtn: { paddingVertical: 10 },
  fine: { color: THEME.textDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
});
