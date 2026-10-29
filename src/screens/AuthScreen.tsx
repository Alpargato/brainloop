/**
 * Portada de Brainloop: crear acceso local la primera vez, y después entrar con
 * contraseña o huella. Nada sale del teléfono.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, ShieldCheck, User } from 'lucide-react-native';
import { THEME } from '../theme';
import {
  MAX_FREE_ATTEMPTS,
  Session,
  biometricAvailable,
  createAccount,
  getAccountInfo,
  getLockout,
  loginWithBiometric,
  loginWithPassword,
  validateAlias,
  validatePassword,
} from '../security/auth';
import { wipeAllData } from '../security/storage';

const LOGO = require('../../assets/logo.png');

type Mode = 'loading' | 'register' | 'login';

interface Props {
  onUnlock: (session: Session) => void;
}

export default function AuthScreen({ onUnlock }: Props) {
  const [mode, setMode] = useState<Mode>('loading');
  const [account, setAccount] = useState<Session | null>(null);
  const [alias, setAlias] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [useBio, setUseBio] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const autoPrompted = useRef(false);

  const refresh = useCallback(async () => {
    const [info, bio, lock] = await Promise.all([getAccountInfo(), biometricAvailable(), getLockout()]);
    setAccount(info);
    setBioAvailable(bio);
    setUseBio(bio);
    setLockedUntil(lock.lockedUntil);
    setMode(info ? 'login' : 'register');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cuenta atrás del bloqueo por intentos fallidos
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= lockedUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const tryBiometric = useCallback(async () => {
    setError(null);
    const session = await loginWithBiometric();
    if (session) onUnlock(session);
  }, [onUnlock]);

  // Lanza la huella automáticamente una vez al abrir la portada
  useEffect(() => {
    if (mode === 'login' && account?.biometric && bioAvailable && !autoPrompted.current) {
      autoPrompted.current = true;
      tryBiometric();
    }
  }, [mode, account, bioAvailable, tryBiometric]);

  const handleRegister = async () => {
    const aliasErr = validateAlias(alias);
    const pwErr = validatePassword(password, confirm);
    if (aliasErr || pwErr) {
      setError(aliasErr || pwErr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await createAccount(alias, password, bioAvailable && useBio);
      setPassword('');
      setConfirm('');
      onUnlock(session);
    } catch {
      setError('No se pudo guardar el acceso en el almacén cifrado del dispositivo.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await loginWithPassword(password);
      if (res.ok) {
        setPassword('');
        onUnlock(res.session);
        return;
      }
      setPassword('');
      setLockedUntil(res.lockedUntil);
      setNow(Date.now());
      if (res.lockedUntil > Date.now()) {
        setError('Demasiados intentos fallidos. Acceso bloqueado temporalmente.');
      } else {
        setError(
          `Contraseña incorrecta. ${res.attemptsLeft} intento${res.attemptsLeft === 1 ? '' : 's'} antes del bloqueo.`
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgot = () => {
    Alert.alert(
      'Restablecer Brainloop',
      'No existe recuperación de contraseña: para crear un acceso nuevo se BORRARÁN tu API Key, el historial y las estadísticas de este teléfono. ¿Continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar todo',
          style: 'destructive',
          onPress: async () => {
            await wipeAllData();
            autoPrompted.current = true;
            setAlias('');
            setPassword('');
            setConfirm('');
            setError(null);
            await refresh();
          },
        },
      ]
    );
  };

  const lockSecondsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const isLocked = lockSecondsLeft > 0;

  if (mode === 'loading') {
    return (
      <View style={[styles.root, styles.center]}>
        <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        <ActivityIndicator color={THEME.neonCyan} style={{ marginTop: 24 }} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Halo ambiental */}
      <View pointerEvents="none" style={[styles.halo, styles.haloPurple]} />
      <View pointerEvents="none" style={[styles.halo, styles.haloCyan]} />

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brand}>
            <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            <Text style={styles.wordmark}>BRAINLOOP</Text>
            <Text style={styles.tagline}>AI TERMINAL · CEREBRAS WSE-3</Text>
          </View>

          <View style={styles.card}>
            {mode === 'register' ? (
              <>
                <Text style={styles.cardTitle}>CREAR ACCESO LOCAL</Text>
                <Text style={styles.cardHelp}>
                  Tu cuenta solo existe cifrada en este teléfono. No hay servidores ni registro online.
                </Text>

                <Field icon={<User size={16} color={THEME.textMuted} />}>
                  <TextInput
                    style={styles.input}
                    placeholder="Usuario"
                    placeholderTextColor={THEME.textDim}
                    value={alias}
                    onChangeText={setAlias}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={24}
                    importantForAutofill="no"
                  />
                </Field>
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  placeholder={`Contraseña (mín. 8, letras y números)`}
                  show={showPw}
                  onToggle={() => setShowPw((v) => !v)}
                />
                <PasswordField
                  value={confirm}
                  onChange={setConfirm}
                  placeholder="Repite la contraseña"
                  show={showPw}
                  onSubmit={handleRegister}
                />

                {bioAvailable && (
                  <View style={styles.switchRow}>
                    <View style={styles.switchLabel}>
                      <Fingerprint size={18} color={THEME.neonCyan} />
                      <Text style={styles.switchText}>Desbloquear con huella</Text>
                    </View>
                    <Switch
                      value={useBio}
                      onValueChange={setUseBio}
                      trackColor={{ false: THEME.border, true: 'rgba(0,245,212,0.45)' }}
                      thumbColor={useBio ? THEME.neonCyan : THEME.textMuted}
                    />
                  </View>
                )}

                {error && <Text style={styles.error}>{error}</Text>}

                <PrimaryButton
                  label="CREAR ACCESO"
                  icon={<ShieldCheck size={16} color="#000" />}
                  onPress={handleRegister}
                  busy={busy}
                />
                <Text style={styles.footNote}>
                  Sin recuperación: si olvidas la contraseña tendrás que borrar los datos de la app.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.cardTitle}>ACCESO</Text>
                <Text style={styles.cardHelp}>
                  Operador <Text style={{ color: THEME.neonCyan }}>@{account?.alias}</Text>
                </Text>

                <PasswordField
                  value={password}
                  onChange={setPassword}
                  placeholder="Contraseña"
                  show={showPw}
                  onToggle={() => setShowPw((v) => !v)}
                  onSubmit={handleLogin}
                  editable={!isLocked}
                />

                {isLocked ? (
                  <Text style={styles.error}>
                    Bloqueado {lockSecondsLeft}s tras {MAX_FREE_ATTEMPTS}+ intentos fallidos.
                  </Text>
                ) : (
                  error && <Text style={styles.error}>{error}</Text>
                )}

                <PrimaryButton
                  label="ENTRAR"
                  icon={<KeyRound size={16} color="#000" />}
                  onPress={handleLogin}
                  busy={busy}
                  disabled={isLocked || !password}
                />

                {account?.biometric && bioAvailable && (
                  <TouchableOpacity style={styles.outlineButton} onPress={tryBiometric} disabled={busy}>
                    <Fingerprint size={18} color={THEME.neonCyan} />
                    <Text style={styles.outlineButtonText}>ENTRAR CON HUELLA</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity onPress={handleForgot} style={styles.linkBtn}>
                  <Text style={styles.linkText}>¿Olvidaste la contraseña?</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          <View style={styles.footer}>
            <LockKeyhole size={12} color={THEME.textDim} />
            <Text style={styles.footerText}>Cifrado en el dispositivo · Sin servidores · Sin rastreo</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      {icon}
      {children}
    </View>
  );
}

function PasswordField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  show: boolean;
  onToggle?: () => void;
  onSubmit?: () => void;
  editable?: boolean;
}) {
  return (
    <Field icon={<KeyRound size={16} color={THEME.textMuted} />}>
      <TextInput
        style={styles.input}
        placeholder={props.placeholder}
        placeholderTextColor={THEME.textDim}
        value={props.value}
        onChangeText={props.onChange}
        secureTextEntry={!props.show}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        editable={props.editable !== false}
        returnKeyType="done"
        onSubmitEditing={props.onSubmit}
        maxLength={128}
      />
      {props.onToggle && (
        <TouchableOpacity onPress={props.onToggle} hitSlop={10}>
          {props.show ? (
            <EyeOff size={16} color={THEME.textMuted} />
          ) : (
            <Eye size={16} color={THEME.textMuted} />
          )}
        </TouchableOpacity>
      )}
    </Field>
  );
}

function PrimaryButton(props: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const disabled = props.busy || props.disabled;
  return (
    <TouchableOpacity
      style={[styles.primaryButton, disabled && { opacity: 0.45 }]}
      onPress={props.onPress}
      disabled={disabled}
    >
      {props.busy ? <ActivityIndicator size="small" color="#000" /> : props.icon}
      <Text style={styles.primaryButtonText}>{props.busy ? 'VERIFICANDO…' : props.label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: THEME.bg, overflow: 'hidden' },
  center: { justifyContent: 'center', alignItems: 'center' },
  flexOne: { flex: 1 },
  halo: { position: 'absolute', width: 520, height: 520, borderRadius: 260 },
  haloPurple: { backgroundColor: 'rgba(139, 92, 246, 0.10)', bottom: -260, left: -220 },
  haloCyan: { backgroundColor: 'rgba(0, 245, 212, 0.06)', top: -280, right: -240 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 40 },
  brand: { alignItems: 'center', marginBottom: 26 },
  logo: { width: 150, height: 150 },
  wordmark: {
    color: THEME.text,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 8,
    marginTop: 10,
  },
  tagline: {
    color: THEME.neonCyan,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 3,
    marginTop: 6,
  },
  card: {
    backgroundColor: 'rgba(16, 18, 29, 0.92)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 18,
  },
  cardTitle: { color: THEME.text, fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  cardHelp: { color: THEME.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6, marginBottom: 14 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: THEME.bg,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  input: { flex: 1, color: THEME.text, fontSize: 14, paddingVertical: 12 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginBottom: 4,
  },
  switchLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchText: { color: THEME.text, fontSize: 13, fontWeight: '600' },
  error: { color: THEME.danger, fontSize: 12, fontWeight: '600', marginTop: 2, marginBottom: 8 },
  primaryButton: {
    marginTop: 6,
    backgroundColor: THEME.neonCyan,
    paddingVertical: 13,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  primaryButtonText: { color: '#000', fontWeight: '900', fontSize: 13, letterSpacing: 1 },
  outlineButton: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: THEME.neonCyan,
    backgroundColor: 'rgba(0, 245, 212, 0.08)',
    paddingVertical: 12,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  outlineButtonText: { color: THEME.neonCyan, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  linkBtn: { alignSelf: 'center', marginTop: 14, padding: 4 },
  linkText: { color: THEME.textMuted, fontSize: 12, textDecorationLine: 'underline' },
  footNote: { color: THEME.textDim, fontSize: 11, lineHeight: 16, marginTop: 12, textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 22,
  },
  footerText: { color: THEME.textDim, fontSize: 11 },
});
