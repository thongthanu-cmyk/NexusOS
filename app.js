import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator, Alert, Animated, KeyboardAvoidingView,
    Linking, Platform, ScrollView, StatusBar, StyleSheet,
    Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ── expo-speech (TTS) ──────────────────────────────────────────────────────
let Speech = null;
try { Speech = require('expo-speech'); } catch { /* not installed */ }

// ── expo-notifications ─────────────────────────────────────────────────────
let Notifications = null;
const IS_EXPO_GO = (() => {
    try {
        const Constants = require('expo-constants').default;
        const appOwnership = Constants?.appOwnership ?? Constants?.executionEnvironment;
        return appOwnership === 'expo' || appOwnership === 'storeClient';
    } catch { return false; }
})();

if (!IS_EXPO_GO) {
    try {
        Notifications = require('expo-notifications');
        Notifications.setNotificationHandler({
            handleNotification: async () => ({
                shouldShowAlert: true,
                shouldPlaySound: true,
                shouldSetBadge: true,
            }),
        });
    } catch { /* expo-notifications not installed */ }
}

// ── เสียง TTS ──────────────────────────────────────────────────────────────
const PAYDAY_MSG = 'วันนี้เงินเดือนออกแล้ว อย่าลืมมาวางแผนการเงินกันนะ';
const speakPayday = () => {
    if (!Speech) { Alert.alert('💰 PAYDAY!', PAYDAY_MSG); return; }
    try { Speech.stop(); } catch { /* ignore */ }
    Speech.speak(PAYDAY_MSG, { language: 'th-TH', pitch: 1.05, rate: 0.9 });
};

// ─── THEME ─────────────────────────────────────────────────────────────────
const C = {
    bg: '#04040f', bg2: '#080818',
    cyan: '#00f5ff', magenta: '#ff00aa', yellow: '#ffea00', green: '#00ff88',
    orange: '#ff8800',
    border: 'rgba(0,245,255,0.18)', panel: 'rgba(0,245,255,0.04)',
    text: '#a0b8d0', bright: '#e0f0ff',
};
const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const GEMINI_MODELS = [
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.0-pro',
];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_SYSTEM =
    'คุณคือ NEXUS AI ผู้ช่วยส่วนตัวสไตล์ไฮเทค Cyberpunk ' +
    'ตอบภาษาไทยเป็นหลัก กระชับ ฉลาด มีสไตล์ ให้ความรู้สึกเหมือน AI จากอนาคต ' +
    'ตอบได้ทุกคำถาม ทั้งชีวิตประจำวัน การเงิน เทคโนโลยี ความรัก งาน ความบันเทิง ' +
    'ใช้ emoji บ้างเล็กน้อย ตอบตรงประเด็น ห้ามพูดว่าตนเองเป็น Gemini หรือ Google';

const SKEYS = {
    API_KEY: 'nexus_apikey',
    HABITS: 'nexus_habits',
    HABIT_RESET: 'nexus_habitreset',
    TRANSACTIONS: 'nexus_tx',
    PAYDAY: 'nexus_payday_v4',
    PAYDAY_ALERTED: 'nexus_pd_alerted_v4',
};

const CAT_ICONS = {
    'อาหาร': '🍜', 'เดินทาง': '🚗', 'ช้อปปิ้ง': '🛍',
    'บันเทิง': '🎮', 'สุขภาพ': '💊', 'เงินเดือน': '💳', 'อื่นๆ': '📦',
};
const CATS = Object.keys(CAT_ICONS);

// ─── HELPERS ───────────────────────────────────────────────────────────────
const fmtNum = (n) =>
    Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const fmtDate = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ─── GEMINI API ────────────────────────────────────────────────────────────
const callGemini = async (key, hist, idx = 0) => {
    if (idx >= GEMINI_MODELS.length) throw new Error('QUOTA_ALL');
    const url = `${GEMINI_BASE}/${GEMINI_MODELS[idx]}:generateContent?key=${key}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
                contents: hist,
                generationConfig: { maxOutputTokens: 1024, temperature: 0.9 },
            }),
        });
    } catch {
        throw new Error('NETWORK');
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const code = data?.error?.code ?? res.status;
        const msg = (data?.error?.message || '').toLowerCase();
        if (code === 404 || msg.includes('not found') || msg.includes('deprecated'))
            return callGemini(key, hist, idx + 1);
        if (code === 429 || msg.includes('quota') || msg.includes('rate limit')) {
            if (idx + 1 < GEMINI_MODELS.length) return callGemini(key, hist, idx + 1);
            throw new Error('QUOTA_ALL');
        }
        if (code === 400 || code === 403) throw new Error('KEY_INVALID');
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.error) {
        const code = data.error.code;
        const msg = (data.error.message || '').toLowerCase();
        if (code === 404 || msg.includes('not found')) return callGemini(key, hist, idx + 1);
        if (code === 429) {
            if (idx + 1 < GEMINI_MODELS.length) return callGemini(key, hist, idx + 1);
            throw new Error('QUOTA_ALL');
        }
        if (code === 400 || code === 403) throw new Error('KEY_INVALID');
        throw new Error(data.error.message || 'Error');
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return callGemini(key, hist, idx + 1);
    return { text, model: GEMINI_MODELS[idx] };
};

// ─── ROOT COMPONENT ────────────────────────────────────────────────────────
export default function NexusApp() {
    const [tab, setTab] = useState('ai');
    const [clock, setClock] = useState('');
    const [toast, setToast] = useState(null);
    const toastAnim = useRef(new Animated.Value(0)).current;
    const pulseAnim = useRef(new Animated.Value(0.5)).current;
    const notifListener = useRef(null);

    useEffect(() => {
        const iv = setInterval(() =>
            setClock(new Date().toLocaleTimeString('th-TH', {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            })), 1000);
        Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
                Animated.timing(pulseAnim, { toValue: 0.3, duration: 700, useNativeDriver: true }),
            ])
        ).start();

        if (Notifications) {
            notifListener.current = Notifications.addNotificationResponseReceivedListener((res) => {
                if (res.notification.request.content?.data?.nexusPayday) {
                    setTimeout(() => speakPayday(), 600);
                }
            });
        }

        return () => {
            clearInterval(iv);
            if (notifListener.current) notifListener.current.remove();
        };
    }, []);

    const showToast = (msg, color = C.green) => {
        setToast({ msg, color });
        Animated.sequence([
            Animated.timing(toastAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.delay(2200),
            Animated.timing(toastAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]).start(() => setToast(null));
    };

    const TABS = [
        { id: 'ai', label: 'AI CORE', icon: 'zap' },
        { id: 'habit', label: 'HABITS', icon: 'check-circle' },
        { id: 'finance', label: 'FINANCE', icon: 'dollar-sign' },
    ];

    return (
        <SafeAreaView style={s.root}>
            <StatusBar barStyle="light-content" backgroundColor={C.bg} />

            {toast && (
                <Animated.View style={[s.toast, {
                    opacity: toastAnim,
                    borderColor: toast.color + '80',
                    backgroundColor: toast.color + '18',
                }]}>
                    <Text style={[s.mono, { color: toast.color, fontSize: 11, letterSpacing: 1 }]}>
                        {toast.msg}
                    </Text>
                </Animated.View>
            )}

            <View style={s.header}>
                <View style={s.logoRow}>
                    <Animated.View style={[s.logoDot, { opacity: pulseAnim }]} />
                    <Text style={s.logoMain}>NEXUS</Text>
                    <Text style={s.logoSlash}> // </Text>
                    <Text style={s.logoOs}>OS</Text>
                    {IS_EXPO_GO && (
                        <View style={s.expoGoBadge}>
                            <Text style={[s.mono, { color: C.orange, fontSize: 8 }]}>EXPO GO</Text>
                        </View>
                    )}
                </View>
                <Text style={s.logoSub}>PERSONAL INTELLIGENCE SYSTEM v4.0</Text>
                <View style={s.tabRow}>
                    {TABS.map((t) => (
                        <TouchableOpacity
                            key={t.id}
                            style={[s.tab, tab === t.id && s.tabActive]}
                            onPress={() => setTab(t.id)}
                        >
                            <Feather name={t.icon} size={13} color={tab === t.id ? C.cyan : 'rgba(160,184,208,0.35)'} />
                            <Text style={[s.tabTxt, tab === t.id && s.tabTxtActive]}>{t.label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>

            <View style={{ flex: 1 }}>
                {tab === 'ai' && <AIScreen showToast={showToast} />}
                {tab === 'habit' && <HabitScreen showToast={showToast} />}
                {tab === 'finance' && <FinanceScreen showToast={showToast} />}
            </View>

            <View style={s.statusBar}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={s.statusDot} />
                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9, marginLeft: 5 }]}>
                        NEXUS ONLINE
                    </Text>
                </View>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9 }]}>{clock}</Text>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9 }]}>
                    {new Date().toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                </Text>
            </View>
        </SafeAreaView>
    );
}

// ─── AI SCREEN ─────────────────────────────────────────────────────────────
function AIScreen({ showToast }) {
    const [apiKey, setApiKey] = useState('');
    const [keyInput, setKeyInput] = useState('');
    const [showKeyPanel, setShowKeyPanel] = useState(false);
    const [msgs, setMsgs] = useState([{
        id: '0', role: 'ai',
        text: 'สวัสดีครับ! ผมคือ NEXUS AI 👾\n\nใส่ Gemini API Key ก่อนนะครับ แล้วถามได้ทุกเรื่องเลย!\n\n💡 รับ Key ฟรีที่ aistudio.google.com\n→ กด "Get API Key" → สร้าง Key ใหม่\n(ไม่ต้องบัตรเครดิต)',
    }]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [history, setHistory] = useState([]);
    const [model, setModel] = useState('');
    const scrollRef = useRef(null);

    useEffect(() => {
        AsyncStorage.getItem(SKEYS.API_KEY).then((k) => {
            if (k) { setApiKey(k); setModel(GEMINI_MODELS[0]); }
            else setShowKeyPanel(true);
        });
    }, []);

    const addMsg = (role, text) => {
        setMsgs((p) => [...p, { id: Date.now() + '' + Math.random(), role, text }]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
    };

    const saveKey = async () => {
        const k = keyInput.trim();
        if (!k) { Alert.alert('⚠️', 'กรุณาใส่ API Key'); return; }
        if (!k.startsWith('AIza')) {
            Alert.alert('⚠️ Key ไม่ถูกต้อง',
                'Gemini API Key ต้องขึ้นต้นด้วย "AIza"\n\nรับ Key ใหม่ที่:\naistudio.google.com → Get API Key',
                [
                    { text: 'เปิด aistudio.google.com', onPress: () => Linking.openURL('https://aistudio.google.com/apikey') },
                    { text: 'ตกลง', style: 'cancel' },
                ]
            );
            return;
        }
        await AsyncStorage.setItem(SKEYS.API_KEY, k);
        setApiKey(k); setKeyInput(''); setShowKeyPanel(false); setModel(GEMINI_MODELS[0]);
        addMsg('ai', '✅ เชื่อมต่อ Gemini สำเร็จแล้วครับ! ถามอะไรก็ได้เลย 🚀');
        showToast('✓ เชื่อมต่อ Gemini แล้ว');
    };

    const clearKey = async () => {
        await AsyncStorage.removeItem(SKEYS.API_KEY);
        setApiKey(''); setModel(''); setShowKeyPanel(true);
        showToast('ลบ API Key แล้ว', C.magenta);
    };

    const send = async (quickText) => {
        const txt = (quickText || input).trim();
        if (!txt || loading) return;
        if (!apiKey) {
            setShowKeyPanel(true);
            addMsg('ai', '⚠️ ยังไม่มี API Key ครับ — ใส่ Key ก่อนนะ 🔑\n\nรับฟรีที่ aistudio.google.com');
            return;
        }
        setInput('');
        addMsg('user', txt);
        const newHist = [...history, { role: 'user', parts: [{ text: txt }] }];
        setHistory(newHist);
        setLoading(true);

        try {
            const res = await callGemini(apiKey, newHist);
            setModel(res.model);
            setHistory((h) => [...h.slice(-18), { role: 'model', parts: [{ text: res.text }] }]);
            addMsg('ai', res.text);
        } catch (e) {
            setHistory((h) => h.slice(0, -1));
            if (e.message === 'KEY_INVALID') {
                clearKey();
                addMsg('ai',
                    '🔑 API Key ไม่ถูกต้องหรือหมดอายุแล้วครับ\n\n' +
                    'กรุณาสร้าง Key ใหม่ที่:\naistudio.google.com → Get API Key\n\n' +
                    'แล้วใส่ Key ใหม่ในช่อง LINK GEMINI API KEY ด้านบน'
                );
            } else if (e.message === 'QUOTA_ALL') {
                addMsg('ai',
                    '⏳ API Key นี้ใช้เกิน quota แล้วครับ\n\n' +
                    '🔧 วิธีแก้:\n' +
                    '1. รอ 24 ชั่วโมงแล้วลองใหม่\n' +
                    '2. หรือสร้าง Key ใหม่ที่ aistudio.google.com\n\n' +
                    'Free tier = 1,500 requests/day ต่อ Key'
                );
            } else if (e.message === 'NETWORK') {
                addMsg('ai', '📡 ไม่มีอินเทอร์เน็ตครับ\nตรวจสอบ Wi-Fi หรือ Mobile Data แล้วลองใหม่');
            } else {
                addMsg('ai', '⚠️ เกิดข้อผิดพลาด: ' + e.message);
            }
        }
        setLoading(false);
    };

    const QUICK = [
        { icon: '📅', text: 'วางแผนวันนี้ให้หน่อย' },
        { icon: '💰', text: 'แนะนำวิธีออมเงิน' },
        { icon: '⚡', text: 'จูงใจให้ผมทำงาน' },
    ];

    return (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
                {!apiKey && !showKeyPanel && (
                    <TouchableOpacity style={s.apiBanner} onPress={() => setShowKeyPanel(true)}>
                        <Text style={{ fontSize: 22, marginRight: 10 }}>🔑</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={[s.mono, { color: C.magenta, fontSize: 10, letterSpacing: 1 }]}>
                                // ต้องใส่ GEMINI API KEY ก่อน
                            </Text>
                            <Text style={[s.mono, { color: 'rgba(255,0,170,0.5)', fontSize: 10, marginTop: 2 }]}>
                                รับฟรีที่ aistudio.google.com — กดที่นี่
                            </Text>
                        </View>
                    </TouchableOpacity>
                )}

                {showKeyPanel && (
                    <View style={s.panel}>
                        <Text style={s.panelTitle}>LINK GEMINI API KEY</Text>

                        <View style={{ backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.15)', borderRadius: 2, padding: 10, marginBottom: 12 }}>
                            <Text style={[s.mono, { color: C.cyan, fontSize: 10, lineHeight: 17 }]}>
                                {'1. เปิด aistudio.google.com\n2. กด "Get API Key"\n3. กด "Create API Key"\n4. Copy และวางด้านล่าง'}
                            </Text>
                            <TouchableOpacity
                                style={[s.btnSm, { borderColor: 'rgba(0,245,255,0.4)', marginTop: 8, alignSelf: 'flex-start' }]}
                                onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}
                            >
                                <Text style={[s.mono, { color: C.cyan, fontSize: 9 }]}>🔗 เปิด aistudio.google.com</Text>
                            </TouchableOpacity>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                            <TextInput
                                style={[s.input, { flex: 1 }]}
                                value={keyInput}
                                onChangeText={setKeyInput}
                                placeholder="AIzaSy..."
                                placeholderTextColor="rgba(160,184,208,0.3)"
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <TouchableOpacity style={[s.btn, { borderColor: C.magenta }]} onPress={saveKey}>
                                <Text style={[s.mono, { color: C.magenta, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>LINK</Text>
                            </TouchableOpacity>
                        </View>
                        {apiKey ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Text style={[s.mono, { color: C.green, fontSize: 11, flex: 1 }]}>
                                    ✓ LINKED — AIza...{apiKey.slice(-6)}
                                </Text>
                                <TouchableOpacity onPress={clearKey}>
                                    <Text style={[s.mono, { color: C.magenta, fontSize: 10 }]}>[CLEAR KEY]</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <Text style={[s.mono, { color: 'rgba(160,184,208,0.4)', fontSize: 10 }]}>
                                Free tier: 1,500 requests/day ไม่ต้องบัตรเครดิต
                            </Text>
                        )}
                    </View>
                )}

                {apiKey && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.3)', fontSize: 9 }]}>
                            // model: {model || '...'}
                        </Text>
                        <TouchableOpacity
                            style={[s.btnSm, { borderColor: 'rgba(255,0,170,0.3)' }]}
                            onPress={() => setShowKeyPanel(!showKeyPanel)}
                        >
                            <Text style={[s.mono, { color: C.magenta, fontSize: 9 }]}>🔑 KEY</Text>
                        </TouchableOpacity>
                    </View>
                )}

                <View style={s.panel}>
                    <Text style={s.panelTitle}>NEURAL LINK</Text>

                    <ScrollView
                        ref={scrollRef}
                        style={{ maxHeight: 350, minHeight: 180 }}
                        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
                    >
                        {msgs.map((m) => (
                            <View key={m.id} style={[s.msgRow, m.role === 'user' && { flexDirection: 'row-reverse' }]}>
                                <View style={[s.msgAv, m.role === 'user' && { borderColor: C.magenta, backgroundColor: 'rgba(255,0,170,0.08)', marginRight: 0, marginLeft: 8 }]}>
                                    <Text style={[s.mono, { fontSize: 9, fontWeight: '700', color: m.role === 'ai' ? C.cyan : C.magenta }]}>
                                        {m.role === 'ai' ? 'AI' : 'YOU'}
                                    </Text>
                                </View>
                                <View style={[
                                    s.msgBub,
                                    m.role === 'user' && { backgroundColor: 'rgba(255,0,170,0.07)', borderColor: 'rgba(255,0,170,0.2)' },
                                ]}>
                                    <Text style={{ color: C.bright, fontSize: 13, lineHeight: 20 }}>{m.text}</Text>
                                </View>
                            </View>
                        ))}
                        {loading && (
                            <View style={s.msgRow}>
                                <View style={s.msgAv}>
                                    <Text style={[s.mono, { fontSize: 9, color: C.cyan }]}>AI</Text>
                                </View>
                                <View style={[s.msgBub, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                                    <ActivityIndicator size="small" color={C.cyan} />
                                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.5)', fontSize: 10 }]}>
                                        กำลังคิด...
                                    </Text>
                                </View>
                            </View>
                        )}
                    </ScrollView>

                    <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
                        <TextInput
                            style={[s.input, { flex: 1, minHeight: 44 }]}
                            value={input}
                            onChangeText={setInput}
                            placeholder="// พิมพ์ข้อความ แล้วกด SEND"
                            placeholderTextColor="rgba(160,184,208,0.3)"
                            multiline
                            returnKeyType="send"
                            onSubmitEditing={() => send()}
                            blurOnSubmit={false}
                            editable={!loading}
                        />
                        <TouchableOpacity
                            style={[s.btn, loading && { opacity: 0.5 }]}
                            onPress={() => send()}
                            disabled={loading}
                        >
                            <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>SEND</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {QUICK.map((q) => (
                        <TouchableOpacity
                            key={q.text}
                            style={[s.btnSm, loading && { opacity: 0.4 }]}
                            onPress={() => send(q.text)}
                            disabled={loading}
                        >
                            <Text style={[s.mono, { color: C.text, fontSize: 9 }]}>
                                {q.icon} {q.text.slice(0, 12)}{q.text.length > 12 ? '..' : ''}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

// ─── HABIT SCREEN ──────────────────────────────────────────────────────────
function HabitScreen({ showToast }) {
    const [habits, setHabits] = useState([]);
    const [newName, setNewName] = useState('');

    useEffect(() => { loadHabits(); }, []);

    const loadHabits = async () => {
        const raw = await AsyncStorage.getItem(SKEYS.HABITS);
        const lastReset = await AsyncStorage.getItem(SKEYS.HABIT_RESET);
        let list = raw ? JSON.parse(raw) : [];
        const today = new Date().toDateString();
        if (lastReset !== today) {
            list = list.map((h) => ({ ...h, streak: h.done ? (h.streak || 0) + 1 : 0, done: false }));
            await AsyncStorage.setItem(SKEYS.HABIT_RESET, today);
            await AsyncStorage.setItem(SKEYS.HABITS, JSON.stringify(list));
        }
        setHabits(list);
    };

    const persist = async (list) => {
        setHabits(list);
        await AsyncStorage.setItem(SKEYS.HABITS, JSON.stringify(list));
    };

    const addHabit = async () => {
        if (!newName.trim()) return;
        await persist([...habits, { id: Date.now(), name: newName.trim(), done: false, streak: 0 }]);
        setNewName('');
        showToast('✓ เพิ่ม Habit แล้ว');
    };

    const toggleHabit = (id) =>
        persist(habits.map((h) => h.id === id ? { ...h, done: !h.done } : h));

    const deleteHabit = async (id) => {
        await persist(habits.filter((h) => h.id !== id));
        showToast('✓ ลบแล้ว', C.magenta);
    };

    const done = habits.filter((h) => h.done).length;
    const pct = habits.length ? Math.round((done / habits.length) * 100) : 0;

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
            <View style={s.panel}>
                <Text style={s.panelTitle}>DAILY PROTOCOL</Text>
                {habits.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                        <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                            <Text style={[s.mono, { color: C.cyan, fontSize: 9, flex: 1, letterSpacing: 1 }]}>PROTOCOL COMPLETION</Text>
                            <Text style={[s.mono, { color: C.cyan, fontSize: 11 }]}>{done}/{habits.length}</Text>
                        </View>
                        <View style={s.progressBg}>
                            <View style={[s.progressFill, { width: pct + '%' }]} />
                        </View>
                        <Text style={[s.mono, { color: C.cyan, fontSize: 10, textAlign: 'right', marginTop: 4 }]}>{pct}% COMPLETE</Text>
                    </View>
                )}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                        style={[s.input, { flex: 1 }]}
                        value={newName}
                        onChangeText={setNewName}
                        placeholder="// เพิ่ม habit ใหม่..."
                        placeholderTextColor="rgba(160,184,208,0.3)"
                        onSubmitEditing={addHabit}
                        returnKeyType="done"
                        maxLength={40}
                    />
                    <TouchableOpacity style={s.btn} onPress={addHabit}>
                        <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 1 }]}>+ADD</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {habits.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.2)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }]}>
                        {'// NO PROTOCOLS LOADED\nเพิ่ม Habit แรกของคุณ'}
                    </Text>
                </View>
            )}

            {habits.map((h) => (
                <TouchableOpacity
                    key={h.id}
                    style={[s.habitItem, h.done && { borderColor: 'rgba(0,255,136,0.4)', backgroundColor: 'rgba(0,255,136,0.04)' }]}
                    onPress={() => toggleHabit(h.id)}
                    activeOpacity={0.8}
                >
                    <View style={[s.habitCheck, h.done && { borderColor: C.green, backgroundColor: 'rgba(0,255,136,0.15)' }]}>
                        {h.done && <Text style={{ color: C.green, fontSize: 14 }}>✓</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={[{ fontSize: 15, fontWeight: '700', color: h.done ? C.green : C.bright }]}>{h.name}</Text>
                        <Text style={[s.mono, { color: C.yellow, fontSize: 10, marginTop: 2 }]}>🔥 STREAK: {h.streak || 0} DAYS</Text>
                    </View>
                    <TouchableOpacity onPress={() => deleteHabit(h.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                        <Feather name="x" size={16} color="rgba(255,0,170,0.4)" />
                    </TouchableOpacity>
                </TouchableOpacity>
            ))}
        </ScrollView>
    );
}

// ─── FINANCE SCREEN ────────────────────────────────────────────────────────
function FinanceScreen({ showToast }) {
    const [txs, setTxs] = useState([]);
    const [txType, setTxType] = useState('income');
    const [desc, setDesc] = useState('');
    const [amount, setAmount] = useState('');
    const [cat, setCat] = useState(CATS[0]);
    const [txDay, setTxDay] = useState('');
    const [txMonth, setTxMonth] = useState('');
    const [txYear, setTxYear] = useState('');

    useEffect(() => {
        AsyncStorage.getItem(SKEYS.TRANSACTIONS).then((v) => { if (v) setTxs(JSON.parse(v)); });
        const now = new Date();
        setTxDay(String(now.getDate()));
        setTxMonth(String(now.getMonth() + 1));
        setTxYear(String(now.getFullYear()));
    }, []);

    const saveTxs = async (list) => {
        setTxs(list);
        await AsyncStorage.setItem(SKEYS.TRANSACTIONS, JSON.stringify(list));
    };

    const addTx = async () => {
        const amt = parseFloat(amount);
        const d = parseInt(txDay), mo = parseInt(txMonth), y = parseInt(txYear);

        if (!desc.trim() || !amount || isNaN(amt) || amt <= 0) {
            Alert.alert('⚠️', 'กรุณาใส่รายการและจำนวนเงิน');
            return;
        }
        if (!d || d < 1 || d > 31) {
            Alert.alert('⚠️', 'วันที่ต้องอยู่ระหว่าง 1–31');
            return;
        }
        if (!mo || mo < 1 || mo > 12) {
            Alert.alert('⚠️', 'เดือนต้องอยู่ระหว่าง 1–12');
            return;
        }
        if (!y || y < 2000) {
            Alert.alert('⚠️', 'กรุณาใส่ปี ค.ศ. เช่น 2025');
            return;
        }

        const p = (n) => String(n).padStart(2, '0');
        const txDate = `${p(d)}/${p(mo)}/${y}`;
        const newTx = { id: Date.now(), desc: desc.trim(), amount: amt, type: txType, cat, txDate, dateAdded: fmtDate() };
        await saveTxs([newTx, ...txs]);
        setDesc(''); setAmount('');
        const now = new Date();
        setTxDay(String(now.getDate()));
        setTxMonth(String(now.getMonth() + 1));
        setTxYear(String(now.getFullYear()));
        showToast(`✓ ${txType === 'income' ? '+' : '-'}฿${fmtNum(amt)} บันทึกแล้ว`,
            txType === 'income' ? C.green : C.magenta);
    };

    const deleteTx = async (id) => {
        await saveTxs(txs.filter((t) => t.id !== id));
        showToast('✓ ลบแล้ว', C.magenta);
    };

    const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = txs.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const balance = income - expense;

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            <View style={s.balanceCard}>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 9, letterSpacing: 2 }]}>BALANCE</Text>
                <Text style={[s.balanceAmt, balance < 0 && { color: C.magenta }]}>
                    {balance < 0 ? '-' : ''}฿{fmtNum(Math.abs(balance))}
                </Text>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 10, marginTop: 4 }]}>THAI BAHT // NET BALANCE</Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {[
                    { type: 'income', label: '▲ INCOME', color: C.green, amt: income },
                    { type: 'expense', label: '▼ EXPENSE', color: C.magenta, amt: expense },
                ].map(({ type, label, color, amt }) => (
                    <View key={type} style={[s.statCard, { borderColor: color + '4D' }]}>
                        <Text style={[s.mono, { color, fontSize: 8, letterSpacing: 2, marginBottom: 4 }]}>{label}</Text>
                        <Text style={[s.mono, { color, fontSize: 16, fontWeight: '700' }]}>฿{fmtNum(amt)}</Text>
                    </View>
                ))}
            </View>

            <View style={s.panel}>
                <Text style={s.panelTitle}>NEW TRANSACTION</Text>
                <View style={{ flexDirection: 'row', marginBottom: 10 }}>
                    {[
                        { key: 'income', label: '▲ รายรับ', color: C.green },
                        { key: 'expense', label: '▼ รายจ่าย', color: C.magenta },
                    ].map(({ key, label, color }) => (
                        <TouchableOpacity key={key}
                            style={[{ flex: 1, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderRadius: 2 },
                            txType === key ? { borderColor: color, backgroundColor: color + '1E' } : { borderColor: C.border }]}
                            onPress={() => setTxType(key)}
                        >
                            <Text style={[s.mono, { color: txType === key ? color : C.text, fontSize: 11 }]}>{label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
                <TextInput style={[s.input, { marginBottom: 8 }]} value={desc} onChangeText={setDesc}
                    placeholder="รายการ..." placeholderTextColor="rgba(160,184,208,0.3)" />
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                    <TextInput style={[s.input, { flex: 1 }]} value={amount} onChangeText={setAmount}
                        placeholder="จำนวน (฿)" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="decimal-pad" />
                    <TouchableOpacity
                        style={[s.input, { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
                        onPress={() => setCat(CATS[(CATS.indexOf(cat) + 1) % CATS.length])}
                    >
                        <Text style={{ color: C.bright, fontFamily: MONO, fontSize: 12 }}>{CAT_ICONS[cat]} {cat}</Text>
                        <Feather name="chevron-down" size={14} color={C.cyan} />
                    </TouchableOpacity>
                </View>

                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 9, marginBottom: 6 }]}>วัน / เดือน / ปี</Text>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                    {[
                        { label: 'วันที่', ph: '1', val: txDay, set: setTxDay, len: 2 },
                        { label: 'เดือน', ph: '1', val: txMonth, set: setTxMonth, len: 2 },
                        { label: 'ปี ค.ศ.', ph: '2025', val: txYear, set: setTxYear, len: 4 },
                    ].map(({ label, ph, val, set, len }) => (
                        <View key={label} style={{ flex: 1 }}>
                            <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 8, marginBottom: 3 }]}>{label}</Text>
                            <TextInput style={s.input} value={val} onChangeText={set}
                                placeholder={ph} placeholderTextColor="rgba(160,184,208,0.3)"
                                keyboardType="number-pad" maxLength={len} />
                        </View>
                    ))}
                </View>

                <TouchableOpacity style={[s.btn, { width: '100%', alignItems: 'center' }]} onPress={addTx}>
                    <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>⬡ EXECUTE TRANSACTION</Text>
                </TouchableOpacity>
            </View>

            <View style={s.panel}>
                <Text style={s.panelTitle}>TRANSACTION LOG</Text>
                {txs.length === 0 ? (
                    <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.2)', fontSize: 11, letterSpacing: 2 }]}>// NO TRANSACTIONS LOGGED</Text>
                    </View>
                ) : txs.slice(0, 30).map((t) => (
                    <View key={t.id} style={s.txItem}>
                        <View style={[s.txDot, { backgroundColor: t.type === 'income' ? C.green : C.magenta }]} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[s.mono, { color: C.bright, fontSize: 13, fontWeight: '600' }]} numberOfLines={1}>
                                {CAT_ICONS[t.cat] || '📦'} {t.desc}
                            </Text>
                            <Text style={[s.mono, { color: 'rgba(160,184,208,0.4)', fontSize: 9, marginTop: 1 }]}>{t.txDate}</Text>
                        </View>
                        <Text style={[s.mono, { color: t.type === 'income' ? C.green : C.magenta, fontSize: 13, fontWeight: '700', marginRight: 8 }]}>
                            {t.type === 'income' ? '+' : '-'}฿{fmtNum(t.amount)}
                        </Text>
                        <TouchableOpacity onPress={() => deleteTx(t.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                            <Feather name="x" size={13} color="rgba(255,0,170,0.3)" />
                        </TouchableOpacity>
                    </View>
                ))}
            </View>
        </ScrollView>
    );
}

// ─── STYLES ────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    mono: { fontFamily: MONO },
    toast: {
        position: 'absolute', top: 16, left: 20, right: 20, zIndex: 9999,
        borderWidth: 1, borderRadius: 2, padding: 10, alignItems: 'center',
    },
    header: {
        backgroundColor: C.bg2, borderBottomWidth: 1, borderBottomColor: C.border,
        paddingHorizontal: 16, paddingTop: 10,
    },
    logoRow: { flexDirection: 'row', alignItems: 'center' },
    logoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.magenta, marginRight: 8 },
    logoMain: { fontFamily: MONO, fontSize: 18, fontWeight: '900', color: C.cyan, letterSpacing: 4 },
    logoSlash: { fontFamily: MONO, fontSize: 18, color: C.magenta, fontWeight: '900' },
    logoOs: { fontFamily: MONO, fontSize: 12, color: 'rgba(0,245,255,0.6)' },
    logoSub: { fontFamily: MONO, fontSize: 9, color: 'rgba(0,245,255,0.4)', letterSpacing: 2, marginTop: 2 },
    expoGoBadge: {
        marginLeft: 8, borderWidth: 1, borderColor: 'rgba(255,136,0,0.5)',
        borderRadius: 2, paddingHorizontal: 5, paddingVertical: 2,
        backgroundColor: 'rgba(255,136,0,0.08)',
    },
    tabRow: { flexDirection: 'row', marginTop: 10 },
    tab: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        paddingVertical: 10, gap: 5, borderBottomWidth: 2, borderBottomColor: 'transparent',
    },
    tabActive: { borderBottomColor: C.cyan },
    tabTxt: { fontFamily: MONO, fontSize: 9, fontWeight: '700', color: 'rgba(160,184,208,0.35)', letterSpacing: 1 },
    tabTxtActive: { color: C.cyan },
    statusBar: {
        backgroundColor: C.bg2, borderTopWidth: 1, borderTopColor: C.border,
        paddingHorizontal: 14, paddingVertical: 5, flexDirection: 'row',
        justifyContent: 'space-between', alignItems: 'center',
    },
    statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.green },
    panel: {
        backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
        borderRadius: 2, padding: 14, marginBottom: 12,
    },
    panelTitle: {
        fontFamily: MONO, fontSize: 10, fontWeight: '700',
        color: C.cyan, letterSpacing: 2, marginBottom: 12,
    },
    input: {
        backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.2)',
        color: C.bright, fontFamily: MONO, fontSize: 12,
        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 2,
    },
    btn: {
        borderWidth: 1, borderColor: C.cyan, borderRadius: 2,
        paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
    },
    btnSm: {
        borderWidth: 1, borderColor: C.border, borderRadius: 2,
        paddingHorizontal: 10, paddingVertical: 6,
    },
    apiBanner: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: 'rgba(255,0,170,0.06)', borderWidth: 1,
        borderColor: 'rgba(255,0,170,0.35)', borderRadius: 2, padding: 12, marginBottom: 10,
    },
    msgRow: { flexDirection: 'row', marginBottom: 10, alignItems: 'flex-end' },
    msgAv: {
        width: 28, height: 28, borderRadius: 2, borderWidth: 1, borderColor: C.cyan,
        backgroundColor: 'rgba(0,245,255,0.08)', justifyContent: 'center', alignItems: 'center',
        marginRight: 8, flexShrink: 0,
    },
    msgBub: {
        flex: 1, backgroundColor: 'rgba(0,245,255,0.05)', borderWidth: 1,
        borderColor: 'rgba(0,245,255,0.15)', borderRadius: 2, padding: 10,
    },
    progressBg: {
        height: 6, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 2,
        borderWidth: 1, borderColor: C.border, overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: C.cyan, borderRadius: 2 },
    habitItem: {
        backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 2,
        padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12,
    },
    habitCheck: {
        width: 28, height: 28, borderRadius: 2, borderWidth: 2,
        borderColor: 'rgba(0,245,255,0.4)', justifyContent: 'center', alignItems: 'center',
    },
    balanceCard: {
        backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1,
        borderColor: 'rgba(0,245,255,0.3)', borderRadius: 2,
        padding: 20, marginBottom: 12, alignItems: 'center',
    },
    balanceAmt: { fontFamily: MONO, fontSize: 32, fontWeight: '900', color: C.cyan, marginTop: 6 },
    statCard: {
        flex: 1, backgroundColor: C.panel, borderWidth: 1,
        borderRadius: 2, padding: 12, alignItems: 'center',
    },
    txItem: {
        flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10,
        marginBottom: 5, backgroundColor: C.panel,
        borderWidth: 1, borderColor: C.border, borderRadius: 2,
    },
    txDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
});