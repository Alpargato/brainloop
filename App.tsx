/**
 * Brainloop — raíz de la app.
 *
 * Flujo: Portada (crear acceso / login con contraseña o huella) → Terminal.
 * - Auto-bloqueo tras AUTO_LOCK_MS en segundo plano.
 * - FLAG_SECURE (sin capturas, grabación ni miniatura en Recientes) activable en la Bóveda.
 * - La API Key y el historial solo se leen del almacén cifrado DESPUÉS de autenticarse.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type * as ScreenCaptureTypes from 'expo-screen-capture';
import AuthScreen from './src/screens/AuthScreen';
import MainApp from './src/screens/MainApp';
import type { Session } from './src/security/auth';
import { DEFAULT_PREFS, SecurityPrefs, loadPrefs, savePrefs } from './src/security/storage';
import { THEME } from './src/theme';

const AUTO_LOCK_MS = 60_000;
const CAPTURE_KEY = 'brainloop';

// Carga perezosa del módulo anti-capturas: si fallase en algún móvil, Brainloop
// arranca igualmente (sin FLAG_SECURE) en lugar de quedarse en negro.
let screenCapture: typeof ScreenCaptureTypes | null | undefined;
function getScreenCapture(): typeof ScreenCaptureTypes | null {
  if (screenCapture === undefined) {
    try {
      screenCapture = require('expo-screen-capture') as typeof ScreenCaptureTypes;
    } catch {
      screenCapture = null;
    }
  }
  return screenCapture;
}

/** Si algo falla al dibujar, muestra el error en pantalla en lugar de dejarla en negro. */
class StartupGuard extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={guard.root}>
        <Image source={require('./assets/logo.png')} style={guard.logo} resizeMode="contain" />
        <Text style={guard.title}>Brainloop no ha podido abrirse</Text>
        <Text style={guard.msg} selectable>
          {this.state.error}
        </Text>
        <TouchableOpacity style={guard.btn} onPress={() => this.setState({ error: null })}>
          <Text style={guard.btnText}>REINTENTAR</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const guard = StyleSheet.create({
  root: { flex: 1, backgroundColor: THEME.bg, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  logo: { width: 110, height: 110 },
  title: { color: THEME.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  msg: { color: THEME.textMuted, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },
  btn: { marginTop: 8, backgroundColor: THEME.neonCyan, paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  btnText: { color: '#000', fontWeight: '900', letterSpacing: 1 },
});

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [prefs, setPrefs] = useState<SecurityPrefs>(DEFAULT_PREFS);
  const backgroundAt = useRef<number | null>(null);

  useEffect(() => {
    loadPrefs().then(setPrefs).catch(() => undefined);
  }, []);

  // FLAG_SECURE activo por defecto (también en la portada)
  useEffect(() => {
    const sc = getScreenCapture();
    if (!sc) return;
    (prefs.blockScreenshots
      ? sc.preventScreenCaptureAsync(CAPTURE_KEY)
      : sc.allowScreenCaptureAsync(CAPTURE_KEY)
    ).catch(() => undefined);
  }, [prefs.blockScreenshots]);

  // Auto-bloqueo al volver de segundo plano
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundAt.current = Date.now();
      } else if (state === 'active') {
        if (backgroundAt.current && Date.now() - backgroundAt.current > AUTO_LOCK_MS) {
          setSession(null);
        }
        backgroundAt.current = null;
      }
    });
    return () => sub.remove();
  }, []);

  const toggleScreenshots = useCallback(async (value: boolean) => {
    const next = { ...prefs, blockScreenshots: value };
    setPrefs(next);
    await savePrefs(next).catch(() => undefined);
  }, [prefs]);

  const lock = useCallback(() => setSession(null), []);
  const wiped = useCallback(() => {
    setPrefs(DEFAULT_PREFS);
    setSession(null);
  }, []);

  return (
    <StartupGuard>
      <StatusBar style="light" backgroundColor={THEME.bg} />
      {session ? (
        <MainApp
          session={session}
          blockScreenshots={prefs.blockScreenshots}
          onToggleScreenshots={toggleScreenshots}
          onLock={lock}
          onWiped={wiped}
        />
      ) : (
        <AuthScreen onUnlock={setSession} />
      )}
    </StartupGuard>
  );
}
