import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator, Alert, Animated,
    AppState, AppStateStatus,
    KeyboardAvoidingView,
    Linking, Platform, SafeAreaView, ScrollView, StatusBar, StyleSheet,
    Text, TextInput, TouchableOpacity,
    Vibration,
    View
} from 'react-native';
import { loadNotificationSound, playNotificationSound, unloadNotificationSound } from './audioService';

// ─── Types ───
interface Reminder {
    id: string;
    title: string;
    message: string;
    hour: number;
    minute: number;
    day: number;
    month: number;
    year: number;
    recurrence: 'once' | 'monthly' | 'yearly';
    isCompleted: boolean;
    createdAt: string;
    notifId: string | null;
    triggeredAt?: string;
}

interface Habit {
    id: number;
    name: string;
    done: boolean;
    streak: number;
}

interface Transaction {
    id: number;
    desc: string;
    amount: number;
    type: 'income' | 'expense';
    cat: string;
    date: string;
}

interface ChatMessage {
    id: string;
    role: 'ai' | 'user';
    text: string;
}

interface GeminiHistoryItem {
    role: 'user' | 'model';
    parts: { text: string }[];
}

interface Toast {
    msg: string;
    color: string;
}

interface TabItem {
    id: string;
    label: string;
    icon: string;
}

interface ScreenProps {
    showToast: (msg: string, color?: string) => void;
}

interface FormData {
    title: string;
    message: string;
    hour: number;
    minute: number;
    day: number;
    month: number;
    year: number;
    recurrence: 'once' | 'monthly' | 'yearly';
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ───
// ═══════════════════════════════════════════════════════════════════════════

const IS_EXPO_GO = (() => {
    try {
        const v = require('expo-constants').default?.appOwnership ?? require('expo-constants').default?.executionEnvironment;
        return v === 'expo' || v === 'storeClient';
    } catch { return false; }
})();

const NOTIF_CHANNEL_ID = 'nexus_alarm_channel_v6';
const NOTIFICATION_TASK_NAME = 'NEXUS_NOTIFICATION_TASK';
const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';

const C = {
    bg: '#04040f', bg2: '#080818',
    cyan: '#00f5ff', magenta: '#ff00aa', yellow: '#ffea00', green: '#00ff88',
    orange: '#ff8800',
    border: 'rgba(0,245,255,0.18)', panel: 'rgba(0,245,255,0.04)',
    text: '#a0b8d0', bright: '#e0f0ff',
};

const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-1.0-pro'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_SYSTEM = 'คุณคือ NEXUS AI ผู้ช่วยส่วนตัวสไตล์ไฮเทค Cyberpunk ตอบภาษาไทยเป็นหลัก กระชับ ฉลาด มีสไตล์ ให้ความรู้สึกเหมือน AI จากอนาคต ตอบได้ทุกคำถาม ทั้งชีวิตประจำวัน การเงิน เทคโนโลยี ความรัก งาน ความบันเทิง ใช้ emoji บ้างเล็กน้อย ตอบตรงประเด็น ห้ามพูดว่าตนเองเป็น Gemini หรือ Google';

const SKEYS = {
    API_KEY: 'nexus_apikey',
    HABITS: 'nexus_habits',
    HABIT_RESET: 'nexus_habitreset',
    TRANSACTIONS: 'nexus_tx_v5',
    REMINDERS: 'nexus_reminders_v6',
    TRIGGERED_REMINDERS: 'nexus_triggered_v6',
};

const CAT_ICONS = {
    อาหาร: '🍜', เดินทาง: '🚗', 'ช้อปปิ้ง': '🛍',
    บันเทิง: '🎮', สุขภาพ: '💊', เงินเดือน: '💳', 'อื่นๆ': '📦',
};
const CATS = Object.keys(CAT_ICONS);

// ═══════════════════════════════════════════════════════════════════════════
// ─── BACKGROUND TASK SETUP ───
// ═══════════════════════════════════════════════════════════════════════════

TaskManager.defineTask(NOTIFICATION_TASK_NAME, async ({ data, error }) => {
    if (error) {
        console.error('Background task error:', error);
        return;
    }

    try {
        const reminders = await AsyncStorage.getItem(SKEYS.REMINDERS);
        if (!reminders) return;

        const remindersList = JSON.parse(reminders) as Reminder[];
        const now = new Date();

        for (const reminder of remindersList) {
            if (reminder.isCompleted) continue;

            const reminderTime = new Date(
                reminder.year, reminder.month - 1, reminder.day,
                reminder.hour, reminder.minute, 0
            );

            if (Math.abs(now.getTime() - reminderTime.getTime()) < 60000) {
                await triggerReminderNotification(reminder);
            }
        }
    } catch (e) {
        console.error('Background task processing error:', e);
    }
});

const triggerReminderNotification = async (reminder: Reminder): Promise<void> => {
    try {
        await setupNotifChannel();

        const notifId = await Notifications.scheduleNotificationAsync({
            content: {
                title: `⏰ ${reminder.title}`,
                body: reminder.message || 'ถึงเวลาแจ้งเตือนแล้ว!',
                sound: 'beet',
                data: {
                    nexusReminder: true,
                    reminderId: reminder.id,
                    reminderTitle: reminder.title,
                    reminderMessage: reminder.message,
                },
                ...(Platform.OS === 'android' && { channelId: NOTIF_CHANNEL_ID }),
            },
            trigger: { type: 'date', date: new Date(Date.now() + 1000) },
        });

        console.log('✓ Notification triggered from background:', notifId);
    } catch (e) {
        console.error('Trigger notification error:', e);
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ─── SETUP ───
// ═══════════════════════════════════════════════════════════════════════════

const setupNotifChannel = async () => {
    if (Platform.OS !== 'android') return;

    try {
        await Notifications.setNotificationChannelAsync(NOTIF_CHANNEL_ID, {
            name: '⏰ NEXUS ALARM SYSTEM v6.0',
            description: 'Alarm Clock Notification - Works in Background, Lock Screen & Closed App',

            // ⚠️ สำคัญ: sound ต้องตรงกับชื่อไฟล์ที่ android/app/src/main/res/raw/
            sound: 'beet',
            audioAttributes: {
                usage: 6,      // USAGE_ALARM
                contentType: 4,
            },

            vibrationPattern: [
                0, 500, 200, 500, 200, 500, 200, 500, 200, 500,
            ],

            importance: Notifications.AndroidImportance.MAX,
            enableVibrate: true,
            enableLights: true,
            lightColor: '#00f5ff',

            lockscreenVisibility: Notifications.AndroidNotificationVisibility?.PUBLIC ?? 1,
            bypassDnd: true,  // ทะลวง Do Not Disturb
            showBadge: true,

            soundAttributesUsage: 6,  // USAGE_ALARM
        });

        console.log('✅ Notification Channel Ready:');
        console.log('   • Sound: beet.mp3');
        console.log('   • Importance: MAX');
        console.log('   • Vibration: Enabled');
        console.log('   • Bypass DND: YES ✓');
        console.log('   • Works when app closed: YES ✓');
    } catch (e) {
        console.warn('⚠️ Channel setup warning:', e.message);
    }
};

Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const data = notification.request.content.data;

        if (data?.nexusReminder) {
            console.log('🔔 Notification handler triggered:', data.reminderTitle);

            // Play alarm sound when notification is received (app open)
            setTimeout(async () => {
                try {
                    await playVibrationAlarm(data.reminderTitle, data.reminderMessage);
                } catch (e) {
                    console.warn('⚠️ Alarm play error:', e);
                }
            }, 500);
        }

        // Return how the notification should be displayed
        return {
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
        };
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── UNIFIED ALARM FUNCTION WITH VOICE ───
// ═══════════════════════════════════════════════════════════════════════════

const playVibrationAlarm = async (
    title: string = 'แจ้งเตือน',
    message: string = ''
): Promise<void> => {
    try {
        console.log('🔔 ALARM TRIGGERED:', title);
        console.log('   Message:', message);

        // Step 1: Load and play notification sound
        await playNotificationSound();

        // Step 2: Trigger vibration on Android (if app is open)
        if (Platform.OS === 'android') {
            try {
                Vibration?.vibrate?.([0, 500, 200, 500, 200, 500, 200, 500, 200, 500]);
                console.log('📳 Vibration triggered');
            } catch (e) {
                console.warn('⚠️ Vibration error:', e);
            }
        }

        // When app is closed, Android system handles sound/vibration automatically

        console.log('✅ Alarm completed');
    } catch (e) {
        console.warn('⚠️ Alarm error:', e);
    }
};

// ─── Helper Functions ───

const fmtNum = (n: number): string => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pad2 = (n: number): string => String(n).padStart(2, '0');
const formatTime = (hour: number, minute: number): string => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
const formatDate = (day: number, month: number, year: number): string => `${day}/${month}/${year}`;
const buildDateLabel = (d: number, m: number, y: number, h: number, min: number): string => `${pad2(d)}/${pad2(m)}/${y}  ${pad2(h)}:${pad2(min)} น.`;
const nowLabel = (): string => {
    const d = new Date();
    return buildDateLabel(d.getDate(), d.getMonth() + 1, d.getFullYear(), d.getHours(), d.getMinutes());
};

const callGemini = async (key: string, hist: GeminiHistoryItem[], idx: number = 0): Promise<{ text: string; model: string }> => {
    if (idx >= GEMINI_MODELS.length) throw new Error('QUOTA_ALL');
    const url = `${GEMINI_BASE}/${GEMINI_MODELS[idx]}:generateContent?key=${key}`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
                contents: hist,
                generationConfig: { maxOutputTokens: 1024, temperature: 0.9 },
            }),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const code = data?.error?.code ?? res.status;
            const msg = (data?.error?.message || '').toLowerCase();
            if (code === 404 || msg.includes('not found') || msg.includes('deprecated')) return callGemini(key, hist, idx + 1);
            if (code === 429 || msg.includes('quota') || msg.includes('rate limit')) {
                if (idx + 1 < GEMINI_MODELS.length) return callGemini(key, hist, idx + 1);
                throw new Error('QUOTA_ALL');
            }
            if (code === 400 || code === 403) throw new Error('KEY_INVALID');
            throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'Error');
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return callGemini(key, hist, idx + 1);
        return { text, model: GEMINI_MODELS[idx] };
    } catch (e) {
        if (e.message === 'TypeError: Failed to fetch') throw new Error('NETWORK');
        throw e;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ─── MAIN APP ───
// ═══════════════════════════════════════════════════════════════════════════

export default function NexusApp() {
    const [tab, setTab] = useState('reminder');
    const [clock, setClock] = useState('');
    const [toast, setToast] = useState<Toast | null>(null);
    const toastAnim = useRef(new Animated.Value(0)).current;
    const pulseAnim = useRef(new Animated.Value(0.5)).current;
    const appState = useRef<AppStateStatus>(AppState.currentState);

    useEffect(() => {
        // ✅ INIT AUDIO FOR BACKGROUND PLAYBACK
        const initializeApp = async () => {
            try {
                // Step 1: Set up audio session
                await Audio.setAudioModeAsync({
                    staysActiveInBackground: true,
                    shouldDuckAndroid: false,
                    playThroughEarpiece: false,
                    allowsRecordingIOS: false,
                    playsInSilentModeIOS: true,
                });
                console.log('✅ Audio session initialized');
            } catch (e) {
                console.warn('⚠️ Audio init warning:', e);
            }

            try {
                // Step 2: Set up notification channel
                await setupNotifChannel();

                // Step 3: Load beet.mp3 sound
                await loadNotificationSound();

                console.log('✅ NEXUS ALARM SYSTEM v6.0 Initialized');
                console.log('   • Sound file: beet.mp3 ✓');
                console.log('   • Background mode: Enabled ✓');
                console.log('   • App closed notifications: Enabled ✓');
            } catch (e) {
                console.warn('⚠️ Initialization warning:', e);
            }
        };

        initializeApp();

        const iv = setInterval(() => setClock(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })), 1000);

        Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
                Animated.timing(pulseAnim, { toValue: 0.3, duration: 700, useNativeDriver: true }),
            ])
        ).start();

        Notifications.addNotificationReceivedListener(async (notif) => {
            const data = notif.request.content?.data;
            if (data?.nexusReminder) {
                console.log('🔔 Notification received:', notif.request.content.title);

                setTimeout(async () => {
                    await playVibrationAlarm(data.reminderTitle, data.reminderMessage);
                }, 500);
            }
        });

        Notifications.addNotificationResponseReceivedListener(async (res) => {
            const data = res.notification.request.content?.data;
            if (data?.nexusReminder) {
                console.log('👆 Notification tapped:', res.notification.request.content.title);
            }
        });

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            clearInterval(iv);
            subscription.remove();
            unloadNotificationSound();
        };
    }, []);

    const handleAppStateChange = (nextAppState: AppStateStatus): void => {
        if (appState.current !== nextAppState) {
            appState.current = nextAppState;
            console.log(`App state changed: ${appState.current}`);
        }
    };

    const showToast = (msg: string, color: string = C.green): void => {
        setToast({ msg, color });
        Animated.sequence([
            Animated.timing(toastAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.delay(2200),
            Animated.timing(toastAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]).start(() => setToast(null));
    };

    const TABS: TabItem[] = [
        { id: 'reminder', label: 'REMINDER', icon: 'bell' },
        { id: 'ai', label: 'AI CORE', icon: 'zap' },
        { id: 'habit', label: 'HABITS', icon: 'check-circle' },
        { id: 'finance', label: 'FINANCE', icon: 'dollar-sign' },
    ];

    return (
        <SafeAreaView style={s.root}>
            <StatusBar barStyle="light-content" backgroundColor={C.bg} />

            {toast && (
                <Animated.View style={[s.toast, { opacity: toastAnim, borderColor: toast.color + '80', backgroundColor: toast.color + '18' }]}>
                    <Text style={[s.mono, { color: toast.color, fontSize: 11, letterSpacing: 1 }]}>{toast.msg}</Text>
                </Animated.View>
            )}

            <View style={s.header}>
                <View style={s.logoRow}>
                    <Animated.View style={[s.logoDot, { opacity: pulseAnim }]} />
                    <Text style={s.logoMain}>NEXUS</Text>
                    <Text style={s.logoSlash}> // </Text>
                    <Text style={s.logoOs}>OS</Text>
                    {IS_EXPO_GO && <View style={s.expoGoBadge}><Text style={[s.mono, { color: C.orange, fontSize: 8 }]}>EXPO GO</Text></View>}
                </View>
                <Text style={s.logoSub}>PERSONAL INTELLIGENCE SYSTEM v6.0 🔊</Text>
                <View style={s.tabRow}>
                    {TABS.map((t) => (
                        <TouchableOpacity key={t.id} style={[s.tab, tab === t.id && s.tabActive]} onPress={() => setTab(t.id)}>
                            <Feather name={t.icon} size={13} color={tab === t.id ? C.cyan : 'rgba(160,184,208,0.35)'} />
                            <Text style={[s.tabTxt, tab === t.id && s.tabTxtActive]}>{t.label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>

            <View style={{ flex: 1 }}>
                {tab === 'reminder' && <ReminderScreen showToast={showToast} />}
                {tab === 'ai' && <AIScreen showToast={showToast} />}
                {tab === 'habit' && <HabitScreen showToast={showToast} />}
                {tab === 'finance' && <FinanceScreen showToast={showToast} />}
            </View>

            <View style={s.statusBar}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={s.statusDot} />
                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9, marginLeft: 5 }]}>NEXUS ONLINE</Text>
                </View>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9 }]}>{clock}</Text>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.35)', fontSize: 9 }]}>
                    {new Date().toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                </Text>
            </View>
        </SafeAreaView>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── REMINDER SCREEN ───
// ═══════════════════════════════════════════════════════════════════════════

function ReminderScreen({ showToast }: ScreenProps) {
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [currentTime, setCurrentTime] = useState<Date>(new Date());
    const [showForm, setShowForm] = useState<boolean>(false);
    const [notifPerm, setNotifPerm] = useState<boolean>(false);
    const [filterType, setFilterType] = useState<'all' | 'pending' | 'completed'>('all');

    const [formData, setFormData] = useState<FormData>({
        title: '', message: '', hour: new Date().getHours(), minute: new Date().getMinutes() + 1,
        day: new Date().getDate(), month: new Date().getMonth() + 1, year: new Date().getFullYear(),
        recurrence: 'once',
    });

    useEffect(() => {
        loadReminders();
        checkNotifPerm();
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);

        const sub1 = Notifications.addNotificationReceivedListener(async (notif) => {
            if (!notif.request.content?.data?.nexusReminder) return;
            const rid = notif.request.content.data.reminderId;
            showToast(`⏰ ${notif.request.content.title}`, C.yellow);
            await playVibrationAlarm(notif.request.content.data.reminderTitle, notif.request.content.data.reminderMessage);

            setReminders(prev => {
                const updated = prev.map(r => r.id === rid
                    ? { ...r, isCompleted: true, triggeredAt: new Date().toLocaleTimeString('th-TH') }
                    : r);
                AsyncStorage.setItem(SKEYS.REMINDERS, JSON.stringify(updated));
                return updated;
            });
        });

        const sub2 = Notifications.addNotificationResponseReceivedListener(async (res) => {
            if (!res.notification.request.content?.data?.nexusReminder) return;
            console.log('👆 User tapped notification');
        });

        return () => {
            clearInterval(timer);
            sub1.remove();
            sub2.remove();
        };
    }, []);

    useEffect(() => {
        if (reminders.length > 0) AsyncStorage.setItem(SKEYS.REMINDERS, JSON.stringify(reminders));
    }, [reminders]);

    const loadReminders = async () => {
        try {
            const raw = await AsyncStorage.getItem(SKEYS.REMINDERS);
            if (raw) setReminders(JSON.parse(raw));
        } catch (e) {
            console.error('Load reminders error:', e);
            showToast('❌ ไม่สามารถโหลดแจ้งเตือน', C.magenta);
        }
    };

    const checkNotifPerm = async () => {
        try {
            const { status } = await Notifications.getPermissionsAsync();
            setNotifPerm(status === 'granted');
        } catch (e) {
            console.warn('Permission check error:', e);
        }
    };

    const requestNotifPerm = async () => {
        try {
            const { status } = await Notifications.requestPermissionsAsync();
            setNotifPerm(status === 'granted');
            showToast(status === 'granted' ? '✓ อนุญาต Notification แล้ว' : '⚠️ ไม่ได้รับอนุญาต', status === 'granted' ? C.green : C.yellow);
        } catch (e) {
            showToast('⚠️ เกิดข้อผิดพลาด', C.magenta);
        }
    };

    const scheduleOSNotification = async (reminder: Reminder): Promise<string | null> => {
        await setupNotifChannel();

        const triggerDate = new Date(
            reminder.year,
            reminder.month - 1,
            reminder.day,
            reminder.hour,
            reminder.minute,
            0
        );

        if (triggerDate <= new Date()) {
            showToast('⚠️ เวลาที่ตั้งผ่านไปแล้ว', C.yellow);
            return null;
        }

        try {
            const notifId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: `⏰ ${reminder.title}`,
                    body: reminder.message || 'ถึงเวลาแจ้งเตือนแล้ว!',
                    sound: 'beet',
                    priority: 'high',
                    data: {
                        nexusReminder: true,
                        reminderId: reminder.id,
                        reminderTitle: reminder.title,
                        reminderMessage: reminder.message,
                        timestamp: new Date().toISOString(),
                    },
                    ...(Platform.OS === 'android' && {
                        channelId: NOTIF_CHANNEL_ID,
                        sticky: true,
                        autoDismiss: false,
                    }),
                },
                trigger: {
                    type: 'date',
                    date: triggerDate,
                },
            });

            console.log('✅ Notification scheduled:');
            console.log('   • ID:', notifId);
            console.log('   • Title:', reminder.title);
            console.log('   • Time:', `${reminder.hour}:${String(reminder.minute).padStart(2, '0')}`);
            console.log('   • Date:', `${reminder.day}/${reminder.month}/${reminder.year}`);
            console.log('   • Sound: beet.mp3');
            console.log('   • Will work when app closed: YES ✓');

            return notifId;
        } catch (e) {
            console.error('❌ scheduleNotification error:', e);
            showToast('❌ ตั้งแจ้งเตือนไม่สำเร็จ', C.magenta);
            return null;
        }
    };

    const addReminder = async () => {
        if (!formData.title.trim() || !formData.message.trim()) {
            Alert.alert('⚠️', 'กรุณาระบุชื่อและข้อความแจ้งเตือน');
            return;
        }
        if (!notifPerm) {
            Alert.alert('⚠️ ต้องการสิทธิ์', 'กรุณาอนุญาต Notification ก่อนตั้งการแจ้งเตือน',
                [{ text: 'อนุญาตเลย', onPress: requestNotifPerm }, { text: 'ยกเลิก', style: 'cancel' }]);
            return;
        }

        const newReminder = {
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...formData,
            isCompleted: false,
            createdAt: new Date().toISOString(),
            notifId: null,
        };

        const notifId = await scheduleOSNotification(newReminder);
        if (notifId) newReminder.notifId = notifId;

        const updated = [...reminders, newReminder];
        setReminders(updated);
        await AsyncStorage.setItem(SKEYS.REMINDERS, JSON.stringify(updated));

        showToast(`✓ ตั้งแจ้งเตือน "${formData.title}"`, C.green);
        setFormData({
            title: '', message: '', hour: new Date().getHours(), minute: new Date().getMinutes() + 1,
            day: new Date().getDate(), month: new Date().getMonth() + 1, year: new Date().getFullYear(),
            recurrence: 'once',
        });
        setShowForm(false);
    };

    const deleteReminder = async (id) => {
        const reminder = reminders.find(r => r.id === id);
        if (reminder?.notifId) {
            try { await Notifications.cancelScheduledNotificationAsync(reminder.notifId); } catch (e) { }
        }
        const updated = reminders.filter(r => r.id !== id);
        setReminders(updated);
        await AsyncStorage.setItem(SKEYS.REMINDERS, JSON.stringify(updated));
        showToast('✓ ลบแจ้งเตือนแล้ว', C.magenta);
    };

    const toggleComplete = (id) => {
        setReminders(reminders.map(r => r.id === id ? { ...r, isCompleted: !r.isCompleted, triggeredAt: new Date().toLocaleTimeString('th-TH') } : r));
    };

    const testReminder = async (reminder: Reminder): Promise<void> => {
        showToast(`⏰ Test: ${reminder.title} 🔊`, C.yellow);
        await playVibrationAlarm(reminder.title, reminder.message);
    };

    const getRecurrenceLabel = (recurrence: string): string => {
        switch (recurrence) {
            case 'once': return 'ครั้งเดียว';
            case 'monthly': return 'ทุกเดือน';
            case 'yearly': return 'ทุกปี';
            default: return 'ไม่ระบุ';
        }
    };

    const filteredReminders = reminders.filter(r => {
        if (filterType === 'pending') return !r.isCompleted;
        if (filterType === 'completed') return r.isCompleted;
        return true;
    });

    const pendingCount = reminders.filter(r => !r.isCompleted).length;

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
            <View style={[s.panel, { marginBottom: 12 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <View>
                        <Text style={[s.mono, { color: C.cyan, fontSize: 9, letterSpacing: 1, marginBottom: 4 }]}>// CURRENT TIME</Text>
                        <Text style={[s.mono, { color: C.bright, fontSize: 28, fontWeight: '700' }]}>{formatTime(currentTime.getHours(), currentTime.getMinutes())}</Text>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.5)', fontSize: 9, marginTop: 2 }]}>{currentTime.toLocaleDateString('th-TH')}</Text>
                    </View>
                    <TouchableOpacity style={[s.btn, { borderColor: notifPerm ? C.green : C.yellow }]} onPress={requestNotifPerm}>
                        <Text style={[s.mono, { color: notifPerm ? C.green : C.yellow, fontSize: 9, textAlign: 'center' }]}>
                            {notifPerm ? '✓ NOTIF\nENABLED' : '⚠ ENABLE\nNOTIF'}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            <TouchableOpacity style={[s.btn, { borderColor: C.cyan, padding: 14, marginBottom: 12, alignItems: 'center' }]} onPress={() => setShowForm(!showForm)}>
                <Text style={[s.mono, { color: C.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2 }]}>+ เพิ่มแจ้งเตือนใหม่</Text>
            </TouchableOpacity>

            {showForm && (
                <View style={[s.panel, { marginBottom: 12 }]}>
                    <Text style={s.panelTitle}>สร้างแจ้งเตือนใหม่</Text>
                    <TextInput style={[s.input, { marginBottom: 8 }]} value={formData.title} onChangeText={(v) => setFormData({ ...formData, title: v })}
                        placeholder="ชื่อแจ้งเตือน..." placeholderTextColor="rgba(160,184,208,0.3)" />
                    <TextInput style={[s.input, { marginBottom: 8 }]} value={formData.message} onChangeText={(v) => setFormData({ ...formData, message: v })}
                        placeholder="ข้อความแจ้งเตือน..." placeholderTextColor="rgba(160,184,208,0.3)" />

                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                        <TextInput style={[s.input, { flex: 1 }]} value={String(formData.hour)} onChangeText={(v) => setFormData({ ...formData, hour: Math.min(23, Math.max(0, parseInt(v) || 0)) })}
                            placeholder="ชั่วโมง" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="number-pad" maxLength={2} />
                        <TextInput style={[s.input, { flex: 1 }]} value={String(formData.minute)} onChangeText={(v) => setFormData({ ...formData, minute: Math.min(59, Math.max(0, parseInt(v) || 0)) })}
                            placeholder="นาที" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="number-pad" maxLength={2} />
                    </View>

                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.5)', fontSize: 9, marginBottom: 6, letterSpacing: 1 }]}>// ประเภทการแจ้งเตือน</Text>
                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                        {[{ key: 'once', label: 'ครั้งเดียว' }, { key: 'monthly', label: 'ทุกเดือน' }, { key: 'yearly', label: 'ทุกปี' }].map(r => (
                            <TouchableOpacity key={r.key} style={[s.filterChip, formData.recurrence === r.key && { borderColor: C.cyan, backgroundColor: 'rgba(0,245,255,0.08)' }]}
                                onPress={() => setFormData({ ...formData, recurrence: r.key })}>
                                <Text style={[s.mono, { color: formData.recurrence === r.key ? C.cyan : C.text, fontSize: 9 }]}>{r.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                        <TextInput style={[s.input, { flex: 1 }]} value={String(formData.day)} onChangeText={(v) => setFormData({ ...formData, day: Math.min(31, Math.max(1, parseInt(v) || 1)) })}
                            placeholder="วัน" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="number-pad" maxLength={2} />
                        <TextInput style={[s.input, { flex: 1 }]} value={String(formData.month)} onChangeText={(v) => setFormData({ ...formData, month: Math.min(12, Math.max(1, parseInt(v) || 1)) })}
                            placeholder="เดือน" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="number-pad" maxLength={2} />
                        <TextInput style={[s.input, { flex: 1.2 }]} value={String(formData.year)} onChangeText={(v) => setFormData({ ...formData, year: parseInt(v) || 2025 })}
                            placeholder="ปี" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="number-pad" maxLength={4} />
                    </View>

                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity style={[s.btn, { flex: 1, borderColor: C.green, alignItems: 'center', padding: 12 }]} onPress={addReminder}>
                            <Text style={[s.mono, { color: C.green, fontSize: 10, fontWeight: '700' }]}>บันทึก</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[s.btn, { flex: 1, borderColor: C.magenta, alignItems: 'center', padding: 12 }]} onPress={() => setShowForm(false)}>
                            <Text style={[s.mono, { color: C.magenta, fontSize: 10, fontWeight: '700' }]}>ยกเลิก</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
                {[{ key: 'all', label: 'ทั้งหมด' }, { key: 'pending', label: `อยู่ระหว่าง (${pendingCount})` }, { key: 'completed', label: 'สำเร็จแล้ว' }].map(f => (
                    <TouchableOpacity key={f.key} style={[s.filterChip, filterType === f.key && { borderColor: C.cyan, backgroundColor: 'rgba(0,245,255,0.08)' }]} onPress={() => setFilterType(f.key)}>
                        <Text style={[s.mono, { color: filterType === f.key ? C.cyan : C.text, fontSize: 9 }]}>{f.label}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            <Text style={[s.panelTitle, { marginBottom: 8 }]}>รายการแจ้งเตือน ({filteredReminders.length})</Text>
            {filteredReminders.length === 0 ? (
                <View style={[s.panel, { alignItems: 'center', paddingVertical: 40 }]}>
                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.2)', fontSize: 10, textAlign: 'center' }]}>// ยังไม่มีแจ้งเตือน</Text>
                </View>
            ) : (
                filteredReminders.map((reminder) => (
                    <View key={reminder.id} style={[s.panel, { marginBottom: 8 }]}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                            <TouchableOpacity style={[s.habitCheck, reminder.isCompleted && { borderColor: C.green, backgroundColor: 'rgba(0,255,136,0.15)' }]}
                                onPress={() => toggleComplete(reminder.id)}>
                                {reminder.isCompleted && <Text style={{ color: C.green }}>✓</Text>}
                            </TouchableOpacity>

                            <View style={{ flex: 1 }}>
                                <Text style={[s.mono, { color: reminder.isCompleted ? 'rgba(160,184,208,0.4)' : C.bright, fontSize: 13, fontWeight: '700', textDecorationLine: reminder.isCompleted ? 'line-through' : 'none' }]}>
                                    {reminder.title}
                                </Text>
                                <Text style={[s.mono, { color: reminder.isCompleted ? 'rgba(160,184,208,0.3)' : 'rgba(160,184,208,0.6)', fontSize: 10, marginTop: 4 }]}>
                                    {reminder.message}
                                </Text>
                                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 9, marginTop: 6 }]}>
                                    ⏰ {formatTime(reminder.hour, reminder.minute)} • {formatDate(reminder.day, reminder.month, reminder.year)}
                                </Text>
                                <Text style={[s.mono, { color: 'rgba(255,234,0,0.5)', fontSize: 8, marginTop: 2 }]}>
                                    🔄 {getRecurrenceLabel(reminder.recurrence)}
                                </Text>
                            </View>

                            <View style={{ flexDirection: 'row', gap: 4 }}>
                                {!reminder.isCompleted && (
                                    <TouchableOpacity style={[s.btnSm, { borderColor: C.yellow }]} onPress={() => testReminder(reminder)}>
                                        <Feather name="zap" size={12} color={C.yellow} />
                                    </TouchableOpacity>
                                )}
                                <TouchableOpacity style={[s.btnSm, { borderColor: C.magenta }]} onPress={() => deleteReminder(reminder.id)}>
                                    <Feather name="trash-2" size={12} color={C.magenta} />
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                ))
            )}
        </ScrollView>
    );
}

function AIScreen({ showToast }: ScreenProps) {
    const [apiKey, setApiKey] = useState<string>('');
    const [keyInput, setKeyInput] = useState<string>('');
    const [showKeyPanel, setShowKeyPanel] = useState<boolean>(false);
    const [msgs, setMsgs] = useState<ChatMessage[]>([{ id: '0', role: 'ai', text: 'สวัสดีครับ! ผมคือ NEXUS AI 👾\n\nใส่ Gemini API Key ก่อนนะครับ แล้วถามได้ทุกเรื่องเลย!\n\n💡 รับ Key ฟรีที่ aistudio.google.com\n→ กด "Get API Key" → สร้าง Key ใหม่\n(ไม่ต้องบัตรเครดิต)' }]);
    const [input, setInput] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(false);
    const [history, setHistory] = useState<GeminiHistoryItem[]>([]);
    const [model, setModel] = useState<string>('');
    const scrollRef = useRef<ScrollView>(null);

    useEffect(() => {
        AsyncStorage.getItem(SKEYS.API_KEY).then((k) => {
            if (k) { setApiKey(k); setModel(GEMINI_MODELS[0]); }
            else setShowKeyPanel(true);
        });
    }, []);

    const addMsg = (role: 'ai' | 'user', text: string): void => {
        setMsgs((p) => [...p, { id: Date.now() + '' + Math.random(), role, text }]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
    };

    const saveKey = async () => {
        const k = keyInput.trim();
        if (!k) { Alert.alert('⚠️', 'กรุณาใส่ API Key'); return; }
        if (!k.startsWith('AIza')) {
            Alert.alert('⚠️ Key ไม่ถูกต้อง', 'Gemini API Key ต้องขึ้นต้นด้วย "AIza"\n\nรับ Key ใหม่ที่:\naistudio.google.com → Get API Key',
                [{ text: 'เปิด aistudio.google.com', onPress: () => Linking.openURL('https://aistudio.google.com/apikey') }, { text: 'ตกลง', style: 'cancel' }]);
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

    const send = async (quickText?: string): Promise<void> => {
        const txt = (quickText || input).trim();
        if (!txt || loading) return;
        if (!apiKey) { setShowKeyPanel(true); addMsg('ai', '⚠️ ยังไม่มี API Key ครับ — ใส่ Key ก่อนนะ 🔑\n\nรับฟรีที่ aistudio.google.com'); return; }
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
                addMsg('ai', '🔑 API Key ไม่ถูกต้องหรือหมดอายุแล้วครับ\n\nกรุณาสร้าง Key ใหม่ที่:\naistudio.google.com → Get API Key');
            } else if (e.message === 'QUOTA_ALL') {
                addMsg('ai', '⏳ API Key นี้ใช้เกิน quota แล้วครับ\n\n🔧 วิธีแก้:\n1. รอ 24 ชั่วโมงแล้วลองใหม่\n2. หรือสร้าง Key ใหม่ที่ aistudio.google.com\n\nFree tier = 1,500 requests/day ต่อ Key');
            } else if (e.message === 'NETWORK') {
                addMsg('ai', '📡 ไม่มีอินเทอร์เน็ตครับ\nตรวจสอบ Wi-Fi หรือ Mobile Data แล้วลองใหม่');
            } else {
                addMsg('ai', '⚠️ เกิดข้อผิดพลาด: ' + e.message);
            }
        }
        setLoading(false);
    };

    const QUICK = [
        { icon: '📅', text: 'วางแผนวันนี้ให้หน่อย' }, { icon: '💰', text: 'แนะนำวิธีออมเงิน' },
        { icon: '⚡', text: 'จูงใจให้ผมทำงาน' }, { icon: '🔮', text: 'สรุปเทรนด์เทคโนโลยีปี 2026' },
        { icon: '🎬', text: 'แนะนำหนังหรือซีรีส์น่าดู' }, { icon: '📝', text: 'ช่วยแต่งประโยคภาษาอังกฤษ' },
    ];

    return (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
                {!apiKey && !showKeyPanel && (
                    <TouchableOpacity style={s.apiBanner} onPress={() => setShowKeyPanel(true)}>
                        <Text style={{ fontSize: 22, marginRight: 10 }}>🔑</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={[s.mono, { color: C.magenta, fontSize: 10, letterSpacing: 1 }]}>// ต้องใส่ GEMINI API KEY ก่อน</Text>
                            <Text style={[s.mono, { color: 'rgba(255,0,170,0.5)', fontSize: 10, marginTop: 2 }]}>รับฟรีที่ aistudio.google.com — กดที่นี่</Text>
                        </View>
                    </TouchableOpacity>
                )}

                {showKeyPanel && (
                    <View style={s.panel}>
                        <Text style={s.panelTitle}>LINK GEMINI API KEY</Text>
                        <View style={{ backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.15)', borderRadius: 2, padding: 10, marginBottom: 12 }}>
                            <Text style={[s.mono, { color: C.cyan, fontSize: 10, lineHeight: 17 }]}>{'1. เปิด aistudio.google.com\n2. กด "Get API Key"\n3. กด "Create API Key"\n4. Copy และวางด้านล่าง'}</Text>
                            <TouchableOpacity style={[s.btnSm, { borderColor: 'rgba(0,245,255,0.4)', marginTop: 8, alignSelf: 'flex-start' }]} onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}>
                                <Text style={[s.mono, { color: C.cyan, fontSize: 9 }]}>🔗 เปิด aistudio.google.com</Text>
                            </TouchableOpacity>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                            <TextInput style={[s.input, { flex: 1 }]} value={keyInput} onChangeText={setKeyInput} placeholder="AIzaSy..." placeholderTextColor="rgba(160,184,208,0.3)" secureTextEntry autoCapitalize="none" autoCorrect={false} />
                            <TouchableOpacity style={[s.btn, { borderColor: C.magenta }]} onPress={saveKey}>
                                <Text style={[s.mono, { color: C.magenta, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>LINK</Text>
                            </TouchableOpacity>
                        </View>
                        {apiKey ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Text style={[s.mono, { color: C.green, fontSize: 11, flex: 1 }]}>✓ LINKED — AIza...{apiKey.slice(-6)}</Text>
                                <TouchableOpacity onPress={clearKey}>
                                    <Text style={[s.mono, { color: C.magenta, fontSize: 10 }]}>[CLEAR KEY]</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <Text style={[s.mono, { color: 'rgba(160,184,208,0.4)', fontSize: 10 }]}>Free tier: 1,500 requests/day ไม่ต้องบัตรเครดิต</Text>
                        )}
                    </View>
                )}

                {apiKey && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.3)', fontSize: 9 }]}>// model: {model || '...'}</Text>
                        <TouchableOpacity style={[s.btnSm, { borderColor: 'rgba(255,0,170,0.3)' }]} onPress={() => setShowKeyPanel(!showKeyPanel)}>
                            <Text style={[s.mono, { color: C.magenta, fontSize: 9 }]}>🔑 KEY</Text>
                        </TouchableOpacity>
                    </View>
                )}

                <View style={s.panel}>
                    <Text style={s.panelTitle}>NEURAL LINK</Text>
                    <ScrollView ref={scrollRef} style={{ maxHeight: 400, minHeight: 180 }} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
                        {msgs.map((m) => (
                            <View key={m.id} style={[s.msgRow, m.role === 'user' && { flexDirection: 'row-reverse' }]}>
                                <View style={[s.msgAv, m.role === 'user' && { borderColor: C.magenta, backgroundColor: 'rgba(255,0,170,0.08)', marginRight: 0, marginLeft: 8 }]}>
                                    <Text style={[s.mono, { fontSize: 9, fontWeight: '700', color: m.role === 'ai' ? C.cyan : C.magenta }]}>{m.role === 'ai' ? 'AI' : 'YOU'}</Text>
                                </View>
                                <View style={[s.msgBub, m.role === 'user' && { backgroundColor: 'rgba(255,0,170,0.07)', borderColor: 'rgba(255,0,170,0.2)' }]}>
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
                                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.5)', fontSize: 10 }]}>กำลังคิด...</Text>
                                </View>
                            </View>
                        )}
                    </ScrollView>
                    <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
                        <TextInput style={[s.input, { flex: 1, minHeight: 44 }]} value={input} onChangeText={setInput} placeholder="// พิมพ์ข้อความ แล้วกด SEND"
                            placeholderTextColor="rgba(160,184,208,0.3)" multiline returnKeyType="send" onSubmitEditing={() => send()} blurOnSubmit={false} editable={!loading} />
                        <TouchableOpacity style={[s.btn, loading && { opacity: 0.5 }]} onPress={() => send()} disabled={loading}>
                            <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>SEND</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {QUICK.map((q) => (
                        <TouchableOpacity key={q.text} style={[s.btnSm, loading && { opacity: 0.4 }]} onPress={() => send(q.text)} disabled={loading}>
                            <Text style={[s.mono, { color: C.text, fontSize: 9 }]}>{q.icon} {q.text.slice(0, 12)}{q.text.length > 12 ? '..' : ''}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

function HabitScreen({ showToast }: ScreenProps) {
    const [habits, setHabits] = useState<Habit[]>([]);
    const [newName, setNewName] = useState<string>('');

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

    const persist = async (list: Habit[]): Promise<void> => {
        setHabits(list);
        await AsyncStorage.setItem(SKEYS.HABITS, JSON.stringify(list));
    };

    const addHabit = async () => {
        if (!newName.trim()) return;
        await persist([...habits, { id: Date.now(), name: newName.trim(), done: false, streak: 0 }]);
        setNewName('');
        showToast('✓ เพิ่ม Habit แล้ว');
    };

    const toggleHabit = (id: number): void => persist(habits.map((h) => h.id === id ? { ...h, done: !h.done } : h));
    const deleteHabit = async (id: number): Promise<void> => {
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
                    <TextInput style={[s.input, { flex: 1 }]} value={newName} onChangeText={setNewName} placeholder="// เพิ่ม habit ใหม่..."
                        placeholderTextColor="rgba(160,184,208,0.3)" onSubmitEditing={addHabit} returnKeyType="done" maxLength={40} />
                    <TouchableOpacity style={s.btn} onPress={addHabit}>
                        <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 1 }]}>+ADD</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {habits.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <Text style={[s.mono, { color: 'rgba(0,245,255,0.2)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }]}>{'// NO PROTOCOLS LOADED\nเพิ่ม Habit แรกของคุณ'}</Text>
                </View>
            )}

            {habits.map((h) => (
                <TouchableOpacity key={h.id} style={[s.habitItem, h.done && { borderColor: 'rgba(0,255,136,0.4)', backgroundColor: 'rgba(0,255,136,0.04)' }]}
                    onPress={() => toggleHabit(h.id)} activeOpacity={0.8}>
                    <View style={[s.habitCheck, h.done && { borderColor: C.green, backgroundColor: 'rgba(0,255,136,0.15)' }]}>
                        {h.done && <Text style={{ color: C.green, fontSize: 14 }}>✓</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: h.done ? C.green : C.bright }}>{h.name}</Text>
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

function FinanceScreen({ showToast }: ScreenProps) {
    const [txs, setTxs] = useState<Transaction[]>([]);
    const [txType, setTxType] = useState<'income' | 'expense'>('income');
    const [desc, setDesc] = useState<string>('');
    const [amount, setAmount] = useState<string>('');
    const [cat, setCat] = useState<string>(CATS[0]);
    const [catPickerOpen, setCatPickerOpen] = useState<boolean>(false);
    const [activeTypeFilter, setActiveTypeFilter] = useState<'income' | 'expense' | null>(null);
    const [activeCatFilter, setActiveCatFilter] = useState<string>('all');
    const [expandedTx, setExpandedTx] = useState<number | null>(null);

    useEffect(() => {
        AsyncStorage.getItem(SKEYS.TRANSACTIONS).then((v) => { if (v) setTxs(JSON.parse(v)); });
    }, []);

    const saveTxs = async (list: Transaction[]): Promise<void> => {
        setTxs(list);
        await AsyncStorage.setItem(SKEYS.TRANSACTIONS, JSON.stringify(list));
    };

    const addTx = () => {
        const amt = parseFloat(amount);
        if (!desc.trim() || !amount || isNaN(amt) || amt <= 0) {
            Alert.alert('⚠️', 'กรุณาใส่รายการและจำนวนเงิน');
            return;
        }

        const newTx = {
            id: Date.now(),
            desc: desc.trim(),
            amount: amt,
            type: txType,
            cat,
            date: nowLabel(),
        };

        saveTxs([newTx, ...txs]);
        setDesc(''); setAmount('');
        showToast(`✓ ${txType === 'income' ? '+' : '-'}฿${fmtNum(amt)} บันทึกแล้ว`, txType === 'income' ? C.green : C.magenta);
    };

    const deleteTx = async (id: number): Promise<void> => {
        await saveTxs(txs.filter((t) => t.id !== id));
        showToast('✓ ลบแล้ว', C.magenta);
    };

    const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = txs.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const balance = income - expense;

    let filtered = txs;
    if (activeTypeFilter) filtered = filtered.filter((t) => t.type === activeTypeFilter);
    if (activeCatFilter !== 'all') filtered = filtered.filter((t) => t.cat === activeCatFilter);

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <View style={s.balanceCard}>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 9, letterSpacing: 2 }]}>BALANCE</Text>
                <Text style={[s.balanceAmt, balance < 0 && { color: C.magenta }]}>{balance < 0 ? '-' : ''}฿{fmtNum(Math.abs(balance))}</Text>
                <Text style={[s.mono, { color: 'rgba(0,245,255,0.4)', fontSize: 10, marginTop: 4 }]}>THAI BAHT // NET BALANCE</Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {[{ type: 'income', label: '▲ INCOME', color: C.green, amt: income }, { type: 'expense', label: '▼ EXPENSE', color: C.magenta, amt: expense }].map(({ type, label, color, amt }) => (
                    <TouchableOpacity key={type} style={[s.statCard, { borderColor: color + '4D' }, activeTypeFilter === type && { backgroundColor: color + '14' }]}
                        onPress={() => { setActiveTypeFilter(activeTypeFilter === type ? null : type); setActiveCatFilter('all'); }}>
                        <Text style={[s.mono, { color, fontSize: 8, letterSpacing: 2, marginBottom: 4 }]}>{label}</Text>
                        <Text style={[s.mono, { color, fontSize: 16, fontWeight: '700' }]}>฿{fmtNum(amt)}</Text>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.3)', fontSize: 9, marginTop: 3 }]}>กดดูรายละเอียด</Text>
                    </TouchableOpacity>
                ))}
            </View>

            <View style={s.panel}>
                <Text style={s.panelTitle}>NEW TRANSACTION</Text>

                <View style={{ flexDirection: 'row', marginBottom: 10 }}>
                    {[{ key: 'income', label: '▲ รายรับ', color: C.green }, { key: 'expense', label: '▼ รายจ่าย', color: C.magenta }].map(({ key, label, color }) => (
                        <TouchableOpacity key={key} style={[{ flex: 1, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderRadius: 2 },
                        txType === key ? { borderColor: color, backgroundColor: color + '1E' } : { borderColor: C.border }]}
                            onPress={() => setTxType(key)}>
                            <Text style={[s.mono, { color: txType === key ? color : C.text, fontSize: 11 }]}>{label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>

                <TextInput style={[s.input, { marginBottom: 8 }]} value={desc} onChangeText={setDesc} placeholder="รายการ..." placeholderTextColor="rgba(160,184,208,0.3)" />

                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                    <TextInput style={[s.input, { flex: 1 }]} value={amount} onChangeText={setAmount} placeholder="จำนวน (฿)" placeholderTextColor="rgba(160,184,208,0.3)" keyboardType="decimal-pad" />
                    <TouchableOpacity style={[s.input, { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
                        onPress={() => setCatPickerOpen(!catPickerOpen)}>
                        <Text style={{ color: C.bright, fontFamily: MONO, fontSize: 12 }}>{CAT_ICONS[cat]} {cat}</Text>
                        <Feather name={catPickerOpen ? 'chevron-up' : 'chevron-down'} size={14} color={C.cyan} />
                    </TouchableOpacity>
                </View>

                {catPickerOpen && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        {CATS.map((c) => (
                            <TouchableOpacity key={c} style={[s.filterChip, cat === c && { borderColor: C.cyan, backgroundColor: 'rgba(0,245,255,0.08)' }]}
                                onPress={() => { setCat(c); setCatPickerOpen(false); }}>
                                <Text style={[s.mono, { color: cat === c ? C.cyan : C.text, fontSize: 11 }]}>{CAT_ICONS[c]} {c}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                <TouchableOpacity style={[s.btn, { width: '100%', alignItems: 'center' }]} onPress={addTx}>
                    <Text style={[s.mono, { color: C.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 2 }]}>⬡ EXECUTE TRANSACTION</Text>
                </TouchableOpacity>
            </View>

            <View style={s.panel}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                    <Text style={[s.panelTitle, { marginBottom: 0, flex: 1, color: activeTypeFilter === 'income' ? C.green : activeTypeFilter === 'expense' ? C.magenta : C.cyan }]}>
                        {activeTypeFilter ? (activeTypeFilter === 'income' ? 'INCOME' : 'EXPENSE') + (activeCatFilter !== 'all' ? ' › ' + activeCatFilter : '') : 'TRANSACTION LOG'}
                    </Text>
                    {activeTypeFilter && (
                        <TouchableOpacity style={[s.btnSm, { borderColor: 'rgba(255,234,0,0.4)' }]} onPress={() => { setActiveTypeFilter(null); setActiveCatFilter('all'); }}>
                            <Text style={[s.mono, { color: C.yellow, fontSize: 9 }]}>✕ CLEAR</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {filtered.length === 0 ? (
                    <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                        <Text style={[s.mono, { color: 'rgba(0,245,255,0.2)', fontSize: 11, letterSpacing: 2 }]}>// NO TRANSACTIONS LOGGED</Text>
                    </View>
                ) : (
                    filtered.slice(0, 80).map((t) => (
                        <View key={t.id}>
                            <TouchableOpacity style={[s.txItem, expandedTx === t.id && { borderColor: C.cyan, backgroundColor: 'rgba(0,245,255,0.07)' }]}
                                onPress={() => setExpandedTx(expandedTx === t.id ? null : t.id)} activeOpacity={0.8}>
                                <View style={[s.txDot, { backgroundColor: t.type === 'income' ? C.green : C.magenta }]} />
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={[s.mono, { color: C.bright, fontSize: 13, fontWeight: '600' }]} numberOfLines={1}>
                                        {CAT_ICONS[t.cat] || '📦'} {t.desc}
                                    </Text>
                                    <Text style={[s.mono, { color: 'rgba(160,184,208,0.4)', fontSize: 9, marginTop: 1 }]}>{t.date}</Text>
                                </View>
                                <Text style={[s.mono, { color: t.type === 'income' ? C.green : C.magenta, fontSize: 13, fontWeight: '700', marginRight: 8 }]}>
                                    {t.type === 'income' ? '+' : '-'}฿{fmtNum(t.amount)}
                                </Text>
                                <TouchableOpacity onPress={() => deleteTx(t.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                                    <Feather name="trash-2" size={14} color="rgba(255,0,170,0.5)" />
                                </TouchableOpacity>
                            </TouchableOpacity>
                            {expandedTx === t.id && (
                                <View style={s.txDetail}>
                                    {[['TYPE', t.type === 'income' ? '▲ รายรับ' : '▼ รายจ่าย'], ['CATEGORY', `${CAT_ICONS[t.cat] || ''} ${t.cat}`], ['DATE/TIME', t.date], ['AMOUNT', `${t.type === 'income' ? '+' : '-'}฿${fmtNum(t.amount)}`]].map(([k, v]) => (
                                        <View key={k} style={{ flexDirection: 'row', marginBottom: 5 }}>
                                            <Text style={[s.mono, { color: 'rgba(0,245,255,0.5)', fontSize: 11, width: 90 }]}>{k}</Text>
                                            <Text style={[s.mono, { color: C.bright, fontSize: 11, flex: 1 }]}>{v}</Text>
                                        </View>
                                    ))}
                                </View>
                            )}
                        </View>
                    ))
                )}
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    mono: { fontFamily: MONO },
    toast: { position: 'absolute', top: 16, left: 20, right: 20, zIndex: 9999, borderWidth: 1, borderRadius: 2, padding: 10, alignItems: 'center' },
    header: { backgroundColor: C.bg2, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: 16, paddingTop: 10 },
    logoRow: { flexDirection: 'row', alignItems: 'center' },
    logoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.magenta, marginRight: 8 },
    logoMain: { fontFamily: MONO, fontSize: 18, fontWeight: '900', color: C.cyan, letterSpacing: 4 },
    logoSlash: { fontFamily: MONO, fontSize: 18, color: C.magenta, fontWeight: '900' },
    logoOs: { fontFamily: MONO, fontSize: 12, color: 'rgba(0,245,255,0.6)' },
    logoSub: { fontFamily: MONO, fontSize: 9, color: 'rgba(0,245,255,0.4)', letterSpacing: 2, marginTop: 2 },
    expoGoBadge: { marginLeft: 8, borderWidth: 1, borderColor: 'rgba(255,136,0,0.5)', borderRadius: 2, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: 'rgba(255,136,0,0.08)' },
    tabRow: { flexDirection: 'row', marginTop: 10 },
    tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 5, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabActive: { borderBottomColor: C.cyan },
    tabTxt: { fontFamily: MONO, fontSize: 9, fontWeight: '700', color: 'rgba(160,184,208,0.35)', letterSpacing: 1 },
    tabTxtActive: { color: C.cyan },
    statusBar: { backgroundColor: C.bg2, borderTopWidth: 1, borderTopColor: C.border, paddingHorizontal: 14, paddingVertical: 5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.green },
    panel: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 2, padding: 14, marginBottom: 12 },
    panelTitle: { fontFamily: MONO, fontSize: 10, fontWeight: '700', color: C.cyan, letterSpacing: 2, marginBottom: 12 },
    input: { backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.2)', color: C.bright, fontFamily: MONO, fontSize: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 2 },
    btn: { borderWidth: 1, borderColor: C.cyan, borderRadius: 2, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
    btnSm: { borderWidth: 1, borderColor: C.border, borderRadius: 2, paddingHorizontal: 8, paddingVertical: 6 },
    apiBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,0,170,0.06)', borderWidth: 1, borderColor: 'rgba(255,0,170,0.35)', borderRadius: 2, padding: 12, marginBottom: 10 },
    msgRow: { flexDirection: 'row', marginBottom: 10, alignItems: 'flex-end' },
    msgAv: { width: 28, height: 28, borderRadius: 2, borderWidth: 1, borderColor: C.cyan, backgroundColor: 'rgba(0,245,255,0.08)', justifyContent: 'center', alignItems: 'center', marginRight: 8, flexShrink: 0 },
    msgBub: { flex: 1, backgroundColor: 'rgba(0,245,255,0.05)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.15)', borderRadius: 2, padding: 10 },
    progressBg: { height: 6, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 2, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: C.cyan, borderRadius: 2 },
    habitItem: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 2, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
    habitCheck: { width: 28, height: 28, borderRadius: 2, borderWidth: 2, borderColor: 'rgba(0,245,255,0.4)', justifyContent: 'center', alignItems: 'center' },
    balanceCard: { backgroundColor: 'rgba(0,245,255,0.04)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.3)', borderRadius: 2, padding: 20, marginBottom: 12, alignItems: 'center' },
    balanceAmt: { fontFamily: MONO, fontSize: 32, fontWeight: '900', color: C.cyan, marginTop: 6 },
    statCard: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderRadius: 2, padding: 12, alignItems: 'center' },
    filterChip: { borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
    txItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginBottom: 5, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 2 },
    txDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    txDetail: { backgroundColor: 'rgba(0,245,255,0.03)', borderWidth: 1, borderColor: 'rgba(0,245,255,0.12)', borderRadius: 2, padding: 10, marginBottom: 5 },
});