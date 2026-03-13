import { Audio } from 'expo-av';

let soundObject: Audio.Sound | null = null;
let isAudioSessionActive = false;

/**
 * Initialize Audio Session for Background Playback
 * เตรียมระบบเสียงให้ทำงานในพื้นหลังแม้เมื่อปิดแอป
 */
export const initAudioSession = async (): Promise<void> => {
    try {
        if (isAudioSessionActive) return;

        await Audio.setAudioModeAsync({
            staysActiveInBackground: true,
            shouldDuckAndroid: false,
            playThroughEarpiece: false,
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
        });

        isAudioSessionActive = true;
        console.log('✅ Audio session initialized for background playback');
    } catch (error: any) {
        console.warn('⚠️ Audio session init error:', error?.message);
    }
};

/**
 * Load the beet.mp3 file from assets
 * เรียกไฟล์เสียงจากโฟลเดอร์ assets
 */
export const loadNotificationSound = async (): Promise<void> => {
    try {
        await initAudioSession();

        // สำหรับ Android และ iOS ต้องโหลดจากไฟล์ assets
        const { sound } = await Audio.Sound.createAsync(
            require('../assets/beet.mp3'),
            { shouldPlay: false }
        );

        soundObject = sound;
        console.log('✅ Notification sound loaded successfully');
        console.log('📁 Sound file: assets/beet.mp3');
    } catch (error: any) {
        console.error('❌ Load sound error:', error?.message);
    }
};

/**
 * Play the notification sound
 * เล่นเสียงแจ้งเตือนทั้งเมื่อแอปเปิดและปิด
 */
export const playNotificationSound = async (): Promise<void> => {
    try {
        if (!isAudioSessionActive) {
            await initAudioSession();
        }

        // หากยังไม่ได้โหลด ให้โหลดก่อน
        if (!soundObject) {
            await loadNotificationSound();
        }

        if (soundObject) {
            // ตั้งค่าเสียงให้เล่นซ้ำจากจุดเริ่มต้น
            await soundObject.setPositionAsync(0);

            // เล่นเสียงจำนวน 3 ครั้งเพื่อให้ผู้ใช้สามารถได้ยินอย่างชัดเจน
            for (let i = 0; i < 3; i++) {
                await soundObject.playAsync();
                // รอให้เสียงเล่นจบ (800ms)
                await new Promise(resolve => setTimeout(resolve, 800));
            }

            console.log('▶️ Notification sound played (3 times)');
        }
    } catch (error: any) {
        console.error('❌ Play sound error:', error?.message);
    }
};

/**
 * Stop the currently playing sound
 */
export const stopNotificationSound = async (): Promise<void> => {
    try {
        if (soundObject) {
            await soundObject.stopAsync();
            console.log('⏹️ Sound stopped');
        }
    } catch (error: any) {
        console.warn('⚠️ Stop sound error:', error?.message);
    }
};

/**
 * Unload and cleanup sound resources
 * ปลดปล่อยทรัพยากรเสียง
 */
export const unloadNotificationSound = async (): Promise<void> => {
    try {
        if (soundObject) {
            await soundObject.unloadAsync();
            soundObject = null;
            isAudioSessionActive = false;
            console.log('✅ Sound resources cleaned up');
        }
    } catch (error: any) {
        console.error('❌ Unload error:', error?.message);
    }
};

/**
 * Get current sound status
 * ตรวจสอบสถานะเสียง
 */
export const getSoundStatus = async (): Promise<any> => {
    if (soundObject) {
        return await soundObject.getStatusAsync();
    }
    return null;
};