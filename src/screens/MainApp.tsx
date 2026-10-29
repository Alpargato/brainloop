import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  ScrollView,
  Switch,
  StatusBar as RNStatusBar
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { THEME } from '../theme';
import {
  KEYS,
  secureGet,
  secureSet,
  secureDelete,
  loadChatHistory,
  saveChatHistory,
  clearChatHistory as clearStoredChat,
  migrateLegacy,
  wipeAllData,
} from '../security/storage';
import {
  Session,
  biometricAvailable,
  setBiometric,
  changePassword,
  validatePassword,
} from '../security/auth';
import {
  MessageSquare,
  BarChart2,
  Shield,
  Send,
  Trash2,
  Key,
  Zap,
  Cpu,
  Clock,
  Lock,
  RefreshCw,
  Terminal,
  Fingerprint,
  LockKeyhole,
  LogOut,
  User,
  EyeOff,
  KeyRound,
} from 'lucide-react-native';
import Markdown from '../components/Markdown';
import ConnectCerebras from '../components/ConnectCerebras';
import { CEREBRAS_MODELS, CompletionResult, cerebrasChat, describeError, nowTime, verifyCerebrasKey } from '../ai/cerebras';

const DAILY_FREE_TOKEN_LIMIT = 1000000; // 1M tokens/day on Cerebras Free Tier
/** «Conectar con Cerebras» se ofrece solo una vez por arranque si no hay clave. */
let offeredConnect = false;
// Modelos de Shared Inference activos en Cerebras (oct 2026). qwen-3-32b, llama-3.3-70b y
// llama3.1-8b fueron retirados; se puede escribir cualquier otro ID a mano en la Bóveda.
const AVAILABLE_MODELS = CEREBRAS_MODELS;

interface MessageMeta {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timeMs: number;
  tokensPerSec: number;
  remainingRequestsDay?: string | null;
  remainingTokensMin?: string | null;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  meta?: MessageMeta;
}

interface UsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  maxTokensPerSec: number;
  lastTokensPerSec: number;
  lastLatencyMs: number;
  // Cerebras Rate Limit Headers
  limitRequestsDay: string;
  remainingRequestsDay: string;
  resetRequestsDay: string;
  limitTokensMin: string;
  remainingTokensMin: string;
  resetTokensMin: string;
  lastUpdated: string;
}

const INITIAL_STATS: UsageStats = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  maxTokensPerSec: 0,
  lastTokensPerSec: 0,
  lastLatencyMs: 0,
  limitRequestsDay: 'N/A',
  remainingRequestsDay: 'N/A',
  resetRequestsDay: 'N/A',
  limitTokensMin: 'N/A',
  remainingTokensMin: 'N/A',
  resetTokensMin: 'N/A',
  lastUpdated: 'Nunca',
};

interface MainAppProps {
  session: Session;
  blockScreenshots: boolean;
  onToggleScreenshots: (value: boolean) => void;
  onLock: () => void;
  onWiped: () => void;
}

export default function MainApp({
  session,
  blockScreenshots,
  onToggleScreenshots,
  onLock,
  onWiped,
}: MainAppProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'stats' | 'security'>('chat');
  const [apiKey, setApiKey] = useState<string>('');
  const [tempKeyInput, setTempKeyInput] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('qwen-3.8-27b');
  const [systemPrompt, setSystemPrompt] = useState<string>(
    'Eres Brainloop, un asistente técnico de alto rendimiento. Responde con precisión, claridad y sin rodeos.'
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputPrompt, setInputPrompt] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [stats, setStats] = useState<UsageStats>(INITIAL_STATS);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(session.biometric);
  const [showPwChange, setShowPwChange] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [connect, setConnect] = useState<{ visible: boolean; reason?: string }>({ visible: false });
  /** Lo que estaba haciendo el usuario cuando se le pidió la API Key; se retoma al conectar. */
  const resumeRef = useRef<((key: string) => void) | null>(null);

  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    loadInitialData();
    biometricAvailable().then(setBioAvailable);
  }, []);

  /** Abre «Conectar con Cerebras». `resume` se ejecuta con la clave nueva al terminar. */
  const requestApiKey = (reason?: string, resume?: (key: string) => void) => {
    resumeRef.current = resume ?? null;
    setConnect({ visible: true, reason });
  };

  const onKeyConnected = async (key: string) => {
    await secureSet(KEYS.apiKey, key);
    setApiKey(key);
    setTempKeyInput('');
    const resume = resumeRef.current;
    resumeRef.current = null;
    if (resume) setTimeout(() => resume(key), 1200);
  };

  const closeConnect = () => {
    setConnect({ visible: false });
    resumeRef.current = null;
  };

  const loadInitialData = async () => {
    // Borra los datos que dejaron versiones anteriores y esta ya no usa.
    await migrateLegacy();
    try {
      const storedKey = await secureGet(KEYS.apiKey);
      if (storedKey) {
        setApiKey(storedKey);
      } else if (!offeredConnect) {
        // Sin clave: se ofrece conectar la cuenta de Cerebras (una vez por arranque de la app).
        offeredConnect = true;
        requestApiKey('Para empezar, conecta tu cuenta gratuita de Cerebras.');
      }

      const storedStats = await AsyncStorage.getItem(KEYS.stats);
      if (storedStats) {
        setStats(JSON.parse(storedStats));
      }

      const storedChat = await loadChatHistory<Message>();
      if (storedChat.length) {
        setMessages(storedChat);
      }
    } catch {
      // No se registra nada en logcat: los errores podrían contener datos del almacén.
    }
  };

  const saveApiKeySecurely = async () => {
    const cleanKey = tempKeyInput.trim();
    if (!cleanKey.startsWith('csk-') || cleanKey.length < 15) {
      Alert.alert(
        'Formato de API Key Inválido',
        'Las claves de Cerebras suelen comenzar por "csk-". Verifica tu clave antes de guardarla.'
      );
      return;
    }
    const store = async () => {
      try {
        await secureSet(KEYS.apiKey, cleanKey);
        setApiKey(cleanKey);
        setTempKeyInput('');
        Alert.alert('Seguridad Activada', 'Tu API Key ha sido cifrada en el Keystore por hardware del dispositivo.');
        setActiveTab('chat');
      } catch (error) {
        Alert.alert('Error de Cifrado', 'No se pudo almacenar la clave en el hardware seguro.');
      }
    };
    // Se comprueba con Cerebras (GET /v1/models, sin gastar tokens) antes de guardarla.
    const check = await verifyCerebrasKey(cleanKey);
    if (check.ok) return store();
    if (check.kind === 'auth' || check.kind === 'format') {
      Alert.alert('API Key rechazada', check.message);
      return;
    }
    Alert.alert('No se pudo comprobar', `${check.message} ¿Guardarla igualmente?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Guardar', onPress: store },
    ]);
  };

  const wipeApiKey = async () => {
    Alert.alert(
      'Revocar Credencial',
      '¿Seguro que deseas eliminar la API Key del hardware seguro del teléfono?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar Clave',
          style: 'destructive',
          onPress: async () => {
            await secureDelete(KEYS.apiKey);
            setApiKey('');
          },
        },
      ]
    );
  };

  const clearChatHistory = async () => {
    Alert.alert('Limpiar Historial', '¿Deseas borrar toda la conversación actual?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar Todo',
        style: 'destructive',
        onPress: async () => {
          setMessages([]);
          await clearStoredChat();
        },
      },
    ]);
  };

  const resetTelemetryStats = async () => {
    Alert.alert('Reiniciar Estadísticas', '¿Deseas poner a cero los contadores acumulados de tokens?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Reiniciar',
        style: 'destructive',
        onPress: async () => {
          setStats(INITIAL_STATS);
          await AsyncStorage.setItem(KEYS.stats, JSON.stringify(INITIAL_STATS));
        },
      },
    ]);
  };

  const sendMessage = async (keyOverride?: string) => {
    const trimmed = inputPrompt.trim();
    if (!trimmed || isLoading) return;
    const key = keyOverride ?? apiKey;

    if (!key) {
      // Se conecta la cuenta de Cerebras y, al volver, el mensaje se envía solo.
      requestApiKey('El Terminal necesita tu API Key de Cerebras. Al conectarla, tu mensaje se envía solo.', (k) =>
        sendMessage(k)
      );
      return;
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: trimmed,
      timestamp: nowTime(),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInputPrompt('');
    setIsLoading(true);

    try {
      const result = await cerebrasChat({
        apiKey: key,
        model: selectedModel,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          ...updatedMessages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        ],
      });

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.content,
        timestamp: nowTime(),
        meta: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          timeMs: result.timeMs,
          tokensPerSec: result.tokensPerSec,
          remainingRequestsDay: result.limits.remainingRequestsDay,
          remainingTokensMin: result.limits.remainingTokensMin,
        },
      };

      const finalMessages = [...updatedMessages, assistantMsg];
      setMessages(finalMessages);
      await saveChatHistory(finalMessages);
      recordUsage(result);
    } catch (err) {
      const e = describeError(err);
      Alert.alert(e.title, e.message);
    } finally {
      setIsLoading(false);
    }
  };

  /** Suma el consumo de cada respuesta a las estadísticas. */
  const recordUsage = (r: CompletionResult) => {
    setStats((prev) => {
      const next: UsageStats = {
        totalRequests: prev.totalRequests + 1,
        totalPromptTokens: prev.totalPromptTokens + r.promptTokens,
        totalCompletionTokens: prev.totalCompletionTokens + r.completionTokens,
        totalTokens: prev.totalTokens + r.totalTokens,
        maxTokensPerSec: Math.max(prev.maxTokensPerSec, r.tokensPerSec),
        lastTokensPerSec: r.tokensPerSec,
        lastLatencyMs: r.timeMs,
        limitRequestsDay: r.limits.limitRequestsDay ?? prev.limitRequestsDay,
        remainingRequestsDay: r.limits.remainingRequestsDay ?? prev.remainingRequestsDay,
        resetRequestsDay: r.limits.resetRequestsDay ?? prev.resetRequestsDay,
        limitTokensMin: r.limits.limitTokensMin ?? prev.limitTokensMin,
        remainingTokensMin: r.limits.remainingTokensMin ?? prev.remainingTokensMin,
        resetTokensMin: r.limits.resetTokensMin ?? prev.resetTokensMin,
        lastUpdated: new Date().toLocaleTimeString(),
      };
      AsyncStorage.setItem(KEYS.stats, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  const toggleBiometric = async (value: boolean) => {
    const ok = await setBiometric(value);
    if (ok) setBioEnabled(value);
    else if (value) Alert.alert('Huella no activada', 'No se pudo verificar tu huella.');
  };

  const submitPasswordChange = async () => {
    const err = validatePassword(pwNext, pwConfirm);
    if (err) {
      Alert.alert('Contraseña no válida', err);
      return;
    }
    setPwBusy(true);
    try {
      const ok = await changePassword(pwCurrent, pwNext);
      if (!ok) {
        Alert.alert('Error', 'La contraseña actual no es correcta.');
        return;
      }
      setPwCurrent('');
      setPwNext('');
      setPwConfirm('');
      setShowPwChange(false);
      Alert.alert('Contraseña actualizada', 'Tu acceso local se ha vuelto a cifrar.');
    } finally {
      setPwBusy(false);
    }
  };

  const wipeEverything = () => {
    Alert.alert(
      'Borrar todos los datos',
      'Se eliminarán tu acceso, la API Key, el chat y las estadísticas de este teléfono. No se puede deshacer.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar todo',
          style: 'destructive',
          onPress: async () => {
            await wipeAllData();
            onWiped();
          },
        },
      ]
    );
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgWrapper, isUser ? styles.msgWrapperUser : styles.msgWrapperAi]}>
        <View style={[styles.msgBubble, isUser ? styles.msgBubbleUser : styles.msgBubbleAi]}>
          <View style={styles.msgHeaderRow}>
            <Text style={[styles.msgRoleText, { color: isUser ? THEME.neonPurple : THEME.neonCyan }]}>
              {isUser ? `OPERADOR // ${session.alias.toUpperCase()}` : `WSE-3 // ${selectedModel.toUpperCase()}`}
            </Text>
            <Text style={styles.msgTimeText}>{item.timestamp}</Text>
          </View>

          {isUser ? (
            <Text style={styles.msgContentText} selectable>
              {item.content}
            </Text>
          ) : (
            <Markdown text={item.content} accent={THEME.neonCyan} />
          )}

          {!isUser && item.meta && (
            <View style={styles.telemetryFooter}>
              <View style={styles.telemetryPill}>
                <Zap size={12} color={THEME.neonCyan} />
                <Text style={styles.telemetryPillText}>{item.meta.tokensPerSec} tok/s</Text>
              </View>
              <View style={styles.telemetryPill}>
                <Cpu size={12} color={THEME.neonPurple} />
                <Text style={styles.telemetryPillText}>{item.meta.totalTokens} tok</Text>
              </View>
              <View style={styles.telemetryPill}>
                <Clock size={12} color={THEME.neonGreen} />
                <Text style={styles.telemetryPillText}>{item.meta.timeMs} ms</Text>
              </View>
              {item.meta.remainingRequestsDay && (
                <View style={styles.telemetryPill}>
                  <Text style={styles.telemetryLimitText}>
                    Restantes hoy: {item.meta.remainingRequestsDay} req
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      </View>
    );
  };

  const dailyPercentUsed = Math.min(100, (stats.totalTokens / DAILY_FREE_TOKEN_LIMIT) * 100);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" backgroundColor={THEME.bg} />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.statusDot} />
          <View>
            <Text style={styles.headerTitle}>
              BRAINLOOP <Text style={{ color: THEME.neonCyan }}>// AI</Text>
            </Text>
            <Text style={styles.headerSubtitle}>
              {`CEREBRAS WSE-3 • ${selectedModel}`}
            </Text>
          </View>
        </View>

        <View style={styles.headerRight}>
          <View style={styles.speedBadge}>
            <Zap size={13} color={THEME.neonCyan} />
            <Text style={styles.speedBadgeText}>
              {stats.lastTokensPerSec > 0 ? `${stats.lastTokensPerSec} T/S` : 'READY'}
            </Text>
          </View>
          <TouchableOpacity onPress={onLock} style={styles.lockBtn} hitSlop={8}>
            <LockKeyhole size={16} color={THEME.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {activeTab === 'chat' && (
        <KeyboardAvoidingView
          style={styles.flexOne}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.SubHeaderBar}>
            <Text style={styles.subHeaderText}>
              CONSUMO SESIÓN: <Text style={{ color: THEME.neonCyan }}>{stats.totalTokens.toLocaleString()}</Text> / 1M TOKENS
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={styles.subHeaderText}>
                REQ DÍA:{' '}
                <Text style={{ color: THEME.neonGreen }}>{stats.remainingRequestsDay}</Text>
              </Text>
              {messages.length > 0 && (
                <TouchableOpacity onPress={clearChatHistory}>
                  <Trash2 size={15} color={THEME.danger} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {messages.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Terminal size={48} color={THEME.neonCyan} />
              <Text style={styles.emptyTitle}>TERMINAL CEREBRAS CS-3 LISTA</Text>
              <Text style={styles.emptySubtitle}>
                Conectado directamente al chip Wafer-Scale Engine de Cerebras: miles de tokens por segundo, con telemetría de velocidad y límites tras cada respuesta.
              </Text>
              {!apiKey && (
                <TouchableOpacity style={styles.ConfigureKeyCta} onPress={() => requestApiKey()}>
                  <Key size={16} color="#000" />
                  <Text style={styles.ConfigureKeyCtaText}>CONECTAR CON CEREBRAS</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.chatList}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            />
          )}

          <View style={styles.inputContainer}>
            <TextInput
              style={styles.textInput}
              placeholder="Escribe un comando…"
              placeholderTextColor={THEME.textDim}
              value={inputPrompt}
              onChangeText={setInputPrompt}
              multiline
              maxLength={8000}
            />
            <TouchableOpacity
              style={[
                styles.sendButton,
                (!inputPrompt.trim() || isLoading) && styles.sendButtonDisabled,
              ]}
              onPress={() => sendMessage()}
              disabled={!inputPrompt.trim() || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Send size={18} color="#000" />
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {activeTab === 'stats' && (
        <ScrollView style={styles.flexOne} contentContainerStyle={styles.scrollContent}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>TELEMETRÍA Y LÍMITES EN TIEMPO REAL</Text>
            <TouchableOpacity onPress={resetTelemetryStats} style={styles.resetBtn}>
              <RefreshCw size={14} color={THEME.neonCyan} />
              <Text style={styles.resetBtnText}>REINICIAR</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.neonCard}>
            <View style={styles.cardHeaderBetween}>
              <Text style={styles.cardLabel}>CUOTA DIARIA CAPA GRATUITA (1M TOKENS)</Text>
              <Text style={styles.cardPercent}>{dailyPercentUsed.toFixed(2)}%</Text>
            </View>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${Math.max(2, dailyPercentUsed)}%` }]} />
            </View>
            <View style={styles.cardFooterBetween}>
              <Text style={styles.cardSubText}>
                Usados: {stats.totalTokens.toLocaleString()} tok
              </Text>
              <Text style={styles.cardSubText}>
                Disponibles: {Math.max(0, DAILY_FREE_TOKEN_LIMIT - stats.totalTokens).toLocaleString()} tok
              </Text>
            </View>
          </View>

          <View style={styles.gridRow}>
            <View style={[styles.neonCard, styles.gridHalf]}>
              <Zap size={20} color={THEME.neonCyan} />
              <Text style={styles.metricBigValue}>{stats.lastTokensPerSec}</Text>
              <Text style={styles.metricTitle}>ÚLTIMA VELOCIDAD (TOK/S)</Text>
              <Text style={styles.metricSub}>Récord: {stats.maxTokensPerSec} tok/s</Text>
            </View>

            <View style={[styles.neonCard, styles.gridHalf]}>
              <Clock size={20} color={THEME.neonPurple} />
              <Text style={styles.metricBigValue}>{stats.lastLatencyMs} ms</Text>
              <Text style={styles.metricTitle}>LATENCIA ÚLTIMO TURNO</Text>
              <Text style={styles.metricSub}>Peticiones totales: {stats.totalRequests}</Text>
            </View>
          </View>

          <View style={styles.neonCard}>
            <Text style={styles.cardLabel}>DESGLOSE DE TOKENS CONSUMIDOS</Text>
            <View style={styles.statLine}>
              <Text style={styles.statLineKey}>Tokens de Entrada (Prompt)</Text>
              <Text style={styles.statLineVal}>{stats.totalPromptTokens.toLocaleString()}</Text>
            </View>
            <View style={styles.statLine}>
              <Text style={styles.statLineKey}>Tokens Generados (Completion)</Text>
              <Text style={styles.statLineVal}>{stats.totalCompletionTokens.toLocaleString()}</Text>
            </View>
            <View style={[styles.statLine, { borderBottomWidth: 0 }]}>
              <Text style={[styles.statLineKey, { color: THEME.neonCyan, fontWeight: '700' }]}>
                Consumo Total Acumulado
              </Text>
              <Text style={[styles.statLineVal, { color: THEME.neonCyan }]}>
                {stats.totalTokens.toLocaleString()}
              </Text>
            </View>
          </View>

          <View style={styles.neonCard}>
            <Text style={styles.cardLabel}>LÍMITES REPORTADOS POR EL SERVIDOR CEREBRAS</Text>
            <Text style={styles.cardHelpText}>
              Extraídos directamente de las cabeceras HTTP x-ratelimit-* tras tu última consulta ({stats.lastUpdated}).
            </Text>

            <View style={styles.statLine}>
              <Text style={styles.statLineKey}>Peticiones Restantes (Día)</Text>
              <Text style={[styles.statLineVal, { color: THEME.neonGreen }]}>
                {stats.remainingRequestsDay} / {stats.limitRequestsDay}
              </Text>
            </View>
            <View style={styles.statLine}>
              <Text style={styles.statLineKey}>Tokens Restantes (Minuto)</Text>
              <Text style={[styles.statLineVal, { color: THEME.neonCyan }]}>
                {stats.remainingTokensMin} / {stats.limitTokensMin}
              </Text>
            </View>
            <View style={[styles.statLine, { borderBottomWidth: 0 }]}>
              <Text style={styles.statLineKey}>Reinicio de Cuota Diaria (seg)</Text>
              <Text style={styles.statLineVal}>{stats.resetRequestsDay}s</Text>
            </View>
          </View>
        </ScrollView>
      )}

      {activeTab === 'security' && (
        <ScrollView style={styles.flexOne} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.sectionTitle}>BÓVEDA CRIPTOGRÁFICA Y CONFIGURACIÓN</Text>

          <View style={styles.neonCard}>
            <View style={styles.cardHeaderBetween}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Lock size={18} color={apiKey ? THEME.neonGreen : THEME.warning} />
                <Text style={styles.cardLabel}>ESTADO DEL KEYSTORE ANDROID</Text>
              </View>
              <View
                style={[
                  styles.statusChip,
                  { backgroundColor: apiKey ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)' },
                ]}
              >
                <Text
                  style={{
                    color: apiKey ? THEME.neonGreen : THEME.warning,
                    fontSize: 11,
                    fontWeight: '700',
                  }}
                >
                  {apiKey ? 'CLAVE CIFRADA ACTIVA' : 'SIN CLAVE'}
                </Text>
              </View>
            </View>

            <Text style={styles.cardHelpText}>
              Tu API Key nunca se incluye en el código fuente del APK. Se guarda cifrada mediante AES-256 en el Hardware Keystore de Android (expo-secure-store).
            </Text>

            {apiKey ? (
              <View style={styles.activeKeyBox}>
                <Text style={styles.maskedKeyText}>
                  csk-••••••••••••{apiKey.slice(-4)}
                </Text>
                <TouchableOpacity style={styles.dangerButton} onPress={wipeApiKey}>
                  <Trash2 size={15} color="#FFF" />
                  <Text style={styles.dangerButtonText}>REVOCAR CLAVE</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ marginTop: 12 }}>
                <TouchableOpacity style={[styles.primaryButton, { marginTop: 0, marginBottom: 12 }]} onPress={() => requestApiKey()}>
                  <KeyRound size={16} color="#000" />
                  <Text style={styles.primaryButtonText}>CONECTAR CON CEREBRAS (WEB)</Text>
                </TouchableOpacity>
                <Text style={[styles.cardHelpText, { marginBottom: 8 }]}>
                  Abre cloud.cerebras.ai, sacas la clave y vuelves: Brainloop la detecta, la comprueba y la guarda. También puedes pegarla aquí:
                </Text>
                <TextInput
                  style={styles.keyInput}
                  placeholder="Pega tu API Key de cloud.cerebras.ai (csk-...)"
                  placeholderTextColor={THEME.textDim}
                  value={tempKeyInput}
                  onChangeText={setTempKeyInput}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity style={styles.primaryButton} onPress={saveApiKeySecurely}>
                  <Key size={16} color="#000" />
                  <Text style={styles.primaryButtonText}>CIFRAR Y GUARDAR EN HARDWARE</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.neonCard}>
            <View style={styles.cardHeaderBetween}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <User size={18} color={THEME.neonCyan} />
                <Text style={styles.cardLabel}>SESIÓN Y BLOQUEO</Text>
              </View>
              <Text style={styles.aliasText}>@{session.alias}</Text>
            </View>
            <Text style={styles.cardHelpText}>
              Brainloop se bloquea solo tras 60 s en segundo plano. Tras 5 contraseñas erróneas el acceso se
              bloquea con espera creciente.
            </Text>

            {bioAvailable && (
              <View style={styles.switchRow}>
                <View style={styles.switchLabel}>
                  <Fingerprint size={16} color={THEME.neonCyan} />
                  <Text style={styles.switchText}>Desbloqueo con huella</Text>
                </View>
                <Switch
                  value={bioEnabled}
                  onValueChange={toggleBiometric}
                  trackColor={{ false: THEME.border, true: 'rgba(0,245,212,0.45)' }}
                  thumbColor={bioEnabled ? THEME.neonCyan : THEME.textMuted}
                />
              </View>
            )}
            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <EyeOff size={16} color={THEME.neonCyan} />
                <Text style={styles.switchText}>Bloquear capturas de pantalla</Text>
              </View>
              <Switch
                value={blockScreenshots}
                onValueChange={onToggleScreenshots}
                trackColor={{ false: THEME.border, true: 'rgba(0,245,212,0.45)' }}
                thumbColor={blockScreenshots ? THEME.neonCyan : THEME.textMuted}
              />
            </View>

            <TouchableOpacity style={styles.outlineButton} onPress={() => setShowPwChange((v) => !v)}>
              <KeyRound size={15} color={THEME.neonCyan} />
              <Text style={styles.outlineButtonText}>CAMBIAR CONTRASEÑA</Text>
            </TouchableOpacity>
            {showPwChange && (
              <View style={{ marginTop: 10, gap: 8 }}>
                {[
                  { v: pwCurrent, set: setPwCurrent, ph: 'Contraseña actual' },
                  { v: pwNext, set: setPwNext, ph: 'Nueva contraseña' },
                  { v: pwConfirm, set: setPwConfirm, ph: 'Repite la nueva contraseña' },
                ].map((f) => (
                  <TextInput
                    key={f.ph}
                    style={styles.keyInput}
                    placeholder={f.ph}
                    placeholderTextColor={THEME.textDim}
                    value={f.v}
                    onChangeText={f.set}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    importantForAutofill="no"
                    maxLength={128}
                  />
                ))}
                <TouchableOpacity
                  style={[styles.primaryButton, pwBusy && { opacity: 0.5 }]}
                  onPress={submitPasswordChange}
                  disabled={pwBusy}
                >
                  {pwBusy ? <ActivityIndicator size="small" color="#000" /> : <KeyRound size={16} color="#000" />}
                  <Text style={styles.primaryButtonText}>{pwBusy ? 'VERIFICANDO…' : 'GUARDAR CONTRASEÑA'}</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.sessionActions}>
              <TouchableOpacity style={[styles.outlineButton, { flex: 1 }]} onPress={onLock}>
                <LogOut size={15} color={THEME.neonCyan} />
                <Text style={styles.outlineButtonText}>BLOQUEAR</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dangerButton, { flex: 1, justifyContent: 'center', paddingVertical: 11 }]} onPress={wipeEverything}>
                <Trash2 size={15} color="#FFF" />
                <Text style={styles.dangerButtonText}>BORRAR TODO</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.neonCard}>
            <Text style={styles.cardLabel}>IDENTIFICADOR DEL MODELO EN CEREBRAS</Text>
            <Text style={styles.cardHelpText}>
              Selecciona el modelo oficial alojado en los sistemas CS-3 o escribe un ID personalizado.
            </Text>

            <View style={styles.modelPillsContainer}>
              {AVAILABLE_MODELS.map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[
                    styles.modelPill,
                    selectedModel === m && styles.modelPillActive,
                  ]}
                  onPress={() => setSelectedModel(m)}
                >
                  <Text
                    style={[
                      styles.modelPillText,
                      selectedModel === m && styles.modelPillTextActive,
                    ]}
                  >
                    {m}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={[styles.keyInput, { marginTop: 10 }]}
              value={selectedModel}
              onChangeText={setSelectedModel}
              placeholder="ID del modelo (ej. qwen-3.8-27b)"
              placeholderTextColor={THEME.textDim}
              autoCapitalize="none"
            />
          </View>

          <View style={styles.neonCard}>
            <Text style={styles.cardLabel}>DIRECTIVA DEL SISTEMA (SYSTEM PROMPT)</Text>
            <TextInput
              style={[styles.keyInput, { height: 90, textAlignVertical: 'top', marginTop: 8 }]}
              value={systemPrompt}
              onChangeText={setSystemPrompt}
              multiline
            />
          </View>
        </ScrollView>
      )}

      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('chat')}
        >
          <MessageSquare
            size={20}
            color={activeTab === 'chat' ? THEME.neonCyan : THEME.textMuted}
          />
          <Text
            style={[
              styles.navText,
              activeTab === 'chat' && { color: THEME.neonCyan, fontWeight: '700' },
            ]}
          >
            TERMINAL
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('stats')}
        >
          <BarChart2
            size={20}
            color={activeTab === 'stats' ? THEME.neonCyan : THEME.textMuted}
          />
          <Text
            style={[
              styles.navText,
              activeTab === 'stats' && { color: THEME.neonCyan, fontWeight: '700' },
            ]}
          >
            ESTADÍSTICAS
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('security')}
        >
          <Shield
            size={20}
            color={activeTab === 'security' ? THEME.neonCyan : THEME.textMuted}
          />
          <Text
            style={[
              styles.navText,
              activeTab === 'security' && { color: THEME.neonCyan, fontWeight: '700' },
            ]}
          >
            BÓVEDA
          </Text>
        </TouchableOpacity>
      </View>

      <ConnectCerebras
        visible={connect.visible}
        reason={connect.reason}
        onClose={closeConnect}
        onConnected={onKeyConnected}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: THEME.bg,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  flexOne: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: THEME.card,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: THEME.neonCyan,
  },
  headerTitle: {
    color: THEME.text,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
  headerSubtitle: {
    color: THEME.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lockBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  aliasText: {
    color: THEME.neonCyan,
    fontSize: 12,
    fontWeight: '800',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  switchLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  switchText: {
    color: THEME.text,
    fontSize: 13,
    fontWeight: '600',
  },
  outlineButton: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: THEME.neonCyan,
    backgroundColor: 'rgba(0, 245, 212, 0.08)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  outlineButtonText: {
    color: THEME.neonCyan,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.5,
  },
  sessionActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
    alignItems: 'flex-end',
  },
  speedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 245, 212, 0.1)',
    borderWidth: 1,
    borderColor: THEME.neonCyan,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  speedBadgeText: {
    color: THEME.neonCyan,
    fontSize: 12,
    fontWeight: '800',
  },
  SubHeaderBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#0B0D16',
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  subHeaderText: {
    color: THEME.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: THEME.text,
    fontSize: 17,
    fontWeight: '800',
    marginTop: 16,
    letterSpacing: 1,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: THEME.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  ConfigureKeyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 22,
    backgroundColor: THEME.neonCyan,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
  },
  ConfigureKeyCtaText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 0.5,
  },
  chatList: {
    padding: 14,
    paddingBottom: 24,
  },
  msgWrapper: {
    marginBottom: 14,
    flexDirection: 'row',
  },
  msgWrapperUser: {
    justifyContent: 'flex-end',
  },
  msgWrapperAi: {
    justifyContent: 'flex-start',
  },
  msgBubble: {
    maxWidth: '90%',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
  },
  msgBubbleUser: {
    backgroundColor: '#17132B',
    borderColor: THEME.neonPurple,
  },
  msgBubbleAi: {
    backgroundColor: THEME.card,
    borderColor: THEME.border,
  },
  msgHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 12,
  },
  msgRoleText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  msgTimeText: {
    fontSize: 10,
    color: THEME.textDim,
  },
  msgContentText: {
    color: THEME.text,
    fontSize: 14,
    lineHeight: 21,
  },
  telemetryFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
  },
  telemetryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: THEME.cardAlt,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  telemetryPillText: {
    color: THEME.text,
    fontSize: 11,
    fontWeight: '700',
  },
  telemetryLimitText: {
    color: THEME.neonGreen,
    fontSize: 11,
    fontWeight: '700',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    backgroundColor: THEME.card,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    gap: 10,
  },
  textInput: {
    flex: 1,
    backgroundColor: THEME.bg,
    color: THEME.text,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 110,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: THEME.neonCyan,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionTitle: {
    color: THEME.neonCyan,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 12,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME.neonCyan,
  },
  resetBtnText: {
    color: THEME.neonCyan,
    fontSize: 11,
    fontWeight: '700',
  },
  neonCard: {
    backgroundColor: THEME.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: THEME.border,
    marginBottom: 14,
  },
  cardHeaderBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardLabel: {
    color: THEME.text,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  cardPercent: {
    color: THEME.neonCyan,
    fontSize: 14,
    fontWeight: '800',
  },
  progressBarBg: {
    height: 10,
    backgroundColor: THEME.bg,
    borderRadius: 5,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: THEME.border,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: THEME.neonCyan,
  },
  cardFooterBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  cardSubText: {
    color: THEME.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  gridRow: {
    flexDirection: 'row',
    gap: 12,
  },
  gridHalf: {
    flex: 1,
    alignItems: 'flex-start',
  },
  metricBigValue: {
    color: THEME.text,
    fontSize: 24,
    fontWeight: '900',
    marginTop: 8,
  },
  metricTitle: {
    color: THEME.textMuted,
    fontSize: 10,
    fontWeight: '800',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  metricSub: {
    color: THEME.neonCyan,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  statLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  statLineKey: {
    color: THEME.textMuted,
    fontSize: 13,
  },
  statLineVal: {
    color: THEME.text,
    fontSize: 13,
    fontWeight: '700',
  },
  cardHelpText: {
    color: THEME.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
    marginBottom: 8,
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  activeKeyBox: {
    marginTop: 10,
    backgroundColor: THEME.bg,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  maskedKeyText: {
    color: THEME.neonCyan,
    fontSize: 13,
    fontWeight: '700',
  },
  keyInput: {
    backgroundColor: THEME.bg,
    color: THEME.text,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  primaryButton: {
    marginTop: 12,
    backgroundColor: THEME.neonCyan,
    paddingVertical: 12,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  primaryButtonText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 13,
  },
  dangerButton: {
    backgroundColor: THEME.danger,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dangerButtonText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '800',
  },
  modelPillsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  modelPill: {
    backgroundColor: THEME.bg,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  modelPillActive: {
    borderColor: THEME.neonCyan,
    backgroundColor: 'rgba(0, 245, 212, 0.12)',
  },
  modelPillText: {
    color: THEME.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  modelPillTextActive: {
    color: THEME.neonCyan,
  },
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: THEME.card,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    paddingVertical: 10,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  navText: {
    color: THEME.textMuted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
