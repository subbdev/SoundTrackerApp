import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Dimensions,
  Alert,
  ActivityIndicator,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { Audio } from 'expo-av';

import { AudioService } from './src/AudioService';
import { segmentSounds, computeSimilarity } from './src/SoundAnalyzer';
import { AppState, CapturedSound, MeteringPoint } from './src/types';

const { width } = Dimensions.get('window');
const BAR_COUNT = 18;

const audioSvc = new AudioService();

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [sounds, setSounds] = useState<CapturedSound[]>([]);
  const [selected, setSelected] = useState<CapturedSound | null>(null);
  const [similarity, setSimilarity] = useState(0);

  const meteringHistory = useRef<MeteringPoint[]>([]);
  const smoothedSim = useRef(0);

  // ── Animated values ──────────────────────────────────────────────────
  const barAnims = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(6))
  ).current;
  const bubbleSize = useRef(new Animated.Value(80)).current;
  const bubbleOpacity = useRef(new Animated.Value(0.35)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for recording indicator
  useEffect(() => {
    if (appState === 'recording') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [appState]);

  // ── Waveform update ──────────────────────────────────────────────────
  const updateWaveform = useCallback(
    (amp: number) => {
      barAnims.forEach(anim => {
        const noise = 0.5 + Math.random() * 1.0;
        Animated.timing(anim, {
          toValue: Math.max(6, amp * noise * 90),
          duration: 90,
          useNativeDriver: false,
        }).start();
      });
    },
    [barAnims]
  );

  // ── Bubble update ────────────────────────────────────────────────────
  const updateBubble = useCallback(
    (sim: number) => {
      Animated.spring(bubbleSize, {
        toValue: 70 + sim * 210,
        friction: 5,
        tension: 80,
        useNativeDriver: false,
      }).start();
      Animated.timing(bubbleOpacity, {
        toValue: 0.3 + sim * 0.7,
        duration: 200,
        useNativeDriver: false,
      }).start();
    },
    [bubbleSize, bubbleOpacity]
  );

  // ── CAPTURE ──────────────────────────────────────────────────────────
  const handleCapture = async () => {
    const granted = await audioSvc.requestPermissions();
    if (!granted) {
      Alert.alert('Permission required', 'Microphone permission is needed to capture sounds.');
      return;
    }
    meteringHistory.current = [];
    setAppState('recording');
    await audioSvc.startCapture(point => {
      meteringHistory.current.push(point);
      const amp = Math.max(0, (point.db + 80) / 80);
      updateWaveform(amp);
    });
  };

  // ── STOP ─────────────────────────────────────────────────────────────
  const handleStop = async () => {
    setAppState('processing');
    // Reset bars
    barAnims.forEach(a => a.setValue(6));

    const uri = await audioSvc.stopCapture();
    if (!uri) {
      Alert.alert('Error', 'Could not save recording.');
      setAppState('idle');
      return;
    }

    const history = meteringHistory.current;
    const captured = segmentSounds(history, uri);

    if (captured.length === 0) {
      Alert.alert('No sounds detected', 'Try capturing for longer or make some noise.');
      setAppState('idle');
      return;
    }

    setSounds(captured);
    setAppState('sounds');
  };

  // ── PLAY SOUND ───────────────────────────────────────────────────────
  const handleSoundTap = async (sound: CapturedSound) => {
    if (appState === 'playing') {
      await audioSvc.stopPlayback();
    }
    setSelected(sound);
    setAppState('playing');

    await audioSvc.playSegment(sound.uri, sound.startMs, sound.endMs, () => {
      setAppState('sounds');
    });
  };

  // ── TRACK ────────────────────────────────────────────────────────────
  const handleTrack = async () => {
    if (!selected) return;
    await audioSvc.stopPlayback();

    smoothedSim.current = 0;
    setSimilarity(0);
    bubbleSize.setValue(70);
    bubbleOpacity.setValue(0.3);
    setAppState('tracking');

    await audioSvc.startTracking(liveDb => {
      const raw = computeSimilarity(liveDb, selected);
      smoothedSim.current = 0.25 * raw + 0.75 * smoothedSim.current;
      const s = smoothedSim.current;
      setSimilarity(s);
      updateBubble(s);
    });
  };

  // ── STOP TRACKING ────────────────────────────────────────────────────
  const handleStopTracking = async () => {
    await audioSvc.stopTracking();
    setSimilarity(0);
    bubbleSize.setValue(70);
    setAppState('sounds');
  };

  // ── NEW CAPTURE ──────────────────────────────────────────────────────
  const handleNewCapture = async () => {
    await audioSvc.stopPlayback();
    setSounds([]);
    setSelected(null);
    setAppState('idle');
  };

  // ────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle={appState === 'tracking' ? 'light-content' : 'dark-content'}
        backgroundColor={appState === 'tracking' ? '#0D1B2A' : '#FFFFFF'}
      />

      {/* ── IDLE ─────────────────────────────────────────────── */}
      {appState === 'idle' && (
        <View style={styles.center}>
          <Text style={styles.appTitle}>Sound Tracker</Text>
          <Text style={styles.appSub}>Tap to capture surrounding sounds</Text>
          <TouchableOpacity style={styles.captureBtn} onPress={handleCapture} activeOpacity={0.8}>
            <Text style={styles.captureBtnText}>CAPTURE</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── RECORDING ────────────────────────────────────────── */}
      {appState === 'recording' && (
        <View style={styles.center}>
          {/* Waveform */}
          <View style={styles.waveformRow}>
            {barAnims.map((anim, i) => (
              <Animated.View
                key={i}
                style={[styles.waveBar, { height: anim }]}
              />
            ))}
          </View>

          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <View style={styles.listeningBadge}>
              <View style={styles.redDot} />
              <Text style={styles.listeningText}>Listening…</Text>
            </View>
          </Animated.View>

          <Text style={styles.hint}>Tap STOP when done</Text>

          <TouchableOpacity style={styles.stopBtn} onPress={handleStop} activeOpacity={0.8}>
            <Text style={styles.stopBtnText}>STOP</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── PROCESSING ───────────────────────────────────────── */}
      {appState === 'processing' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#2196F3" />
          <Text style={[styles.hint, { marginTop: 20 }]}>Identifying sounds…</Text>
        </View>
      )}

      {/* ── SOUNDS LIST ──────────────────────────────────────── */}
      {(appState === 'sounds' || appState === 'playing') && (
        <View style={styles.flex1}>
          <Text style={styles.sectionTitle}>Captured Sounds</Text>
          <Text style={styles.sectionSub}>
            {sounds.length} sound{sounds.length !== 1 ? 's' : ''} identified — tap to play
          </Text>

          <ScrollView contentContainerStyle={styles.soundsGrid}>
            {sounds.map(s => (
              <TouchableOpacity
                key={s.id}
                style={[
                  styles.soundCard,
                  selected?.id === s.id && appState === 'playing' && styles.soundCardActive,
                ]}
                onPress={() => handleSoundTap(s)}
                activeOpacity={0.75}
              >
                <View style={[styles.soundCircle, { backgroundColor: s.color }]}>
                  <Text style={styles.soundNumber}>{s.id}</Text>
                </View>
                <Text style={styles.soundType}>{s.soundType}</Text>
                <Text style={styles.soundDur}>{(s.durationMs / 1000).toFixed(1)}s</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* TRACK button — only while playing */}
          {appState === 'playing' && selected && (
            <TouchableOpacity style={styles.trackBtn} onPress={handleTrack} activeOpacity={0.8}>
              <Text style={styles.trackBtnText}>🎯  TRACK THIS SOUND</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.newCaptureBtn} onPress={handleNewCapture} activeOpacity={0.8}>
            <Text style={styles.newCaptureBtnText}>NEW CAPTURE</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── TRACKING ─────────────────────────────────────────── */}
      {appState === 'tracking' && (
        <View style={styles.trackingScreen}>
          <Text style={styles.trackingTitle}>Tracking Sound #{selected?.id}</Text>
          <Text style={styles.trackingType}>{selected?.soundType}</Text>
          <Text style={styles.trackingHint}>Point your phone toward the sound source</Text>

          {/* Outer rings */}
          <View style={styles.trackingArea}>
            <View style={[styles.ring, styles.ring3]} />
            <View style={[styles.ring, styles.ring2]} />
            <View style={[styles.ring, styles.ring1]} />

            {/* Bubble */}
            <Animated.View
              style={[
                styles.bubble,
                {
                  width: bubbleSize,
                  height: bubbleSize,
                  borderRadius: 200, // always a circle; max bubble is 280dp
                  opacity: bubbleOpacity,
                  backgroundColor: selected?.color ?? '#2196F3',
                },
              ]}
            />

            {/* Percentage */}
            <Text style={styles.simPercent}>{Math.round(similarity * 100)}%</Text>
          </View>

          <TouchableOpacity
            style={styles.stopTrackingBtn}
            onPress={handleStopTracking}
            activeOpacity={0.8}
          >
            <Text style={styles.stopTrackingText}>STOP TRACKING</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

// ────────────────────────────────────────────────────────────────────
// STYLES
// ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  flex1: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#FFFFFF',
  },

  // ── Idle ──
  appTitle: { fontSize: 30, fontWeight: '700', color: '#1A1A2E', marginBottom: 8 },
  appSub: { fontSize: 14, color: '#888', marginBottom: 48, textAlign: 'center' },
  captureBtn: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#2196F3',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: '#2196F3',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  captureBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 1 },

  // ── Recording ──
  waveformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 100,
    gap: 4,
    marginBottom: 32,
  },
  waveBar: {
    width: 5,
    borderRadius: 3,
    backgroundColor: '#E53935',
  },
  listeningBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  redDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#E53935',
  },
  listeningText: { fontSize: 20, fontWeight: '700', color: '#E53935' },
  hint: { fontSize: 13, color: '#888', marginBottom: 32 },
  stopBtn: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#E53935',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: '#E53935',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  stopBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 1 },

  // ── Sounds list ──
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1A1A2E',
    marginTop: 20,
    marginHorizontal: 20,
  },
  sectionSub: { fontSize: 13, color: '#888', marginHorizontal: 20, marginBottom: 12 },
  soundsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingBottom: 16,
  },
  soundCard: {
    alignItems: 'center',
    width: (width - 24) / 4,
    marginVertical: 8,
  },
  soundCardActive: { opacity: 0.7 },
  soundCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  soundNumber: { color: '#FFF', fontSize: 28, fontWeight: '700' },
  soundType: { fontSize: 10, color: '#555', marginTop: 4, textAlign: 'center' },
  soundDur: { fontSize: 10, color: '#999', textAlign: 'center' },
  trackBtn: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: '#FF9800',
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#FF9800',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  trackBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  newCaptureBtn: {
    marginHorizontal: 20,
    marginBottom: 20,
    backgroundColor: '#607D8B',
    borderRadius: 24,
    paddingVertical: 12,
    alignItems: 'center',
  },
  newCaptureBtnText: { color: '#FFF', fontSize: 14, fontWeight: '600' },

  // ── Tracking ──
  trackingScreen: {
    flex: 1,
    backgroundColor: '#0D1B2A',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 40,
  },
  trackingTitle: { fontSize: 22, fontWeight: '700', color: '#FFF' },
  trackingType: { fontSize: 14, color: '#90CAF9', marginTop: 4 },
  trackingHint: { fontSize: 13, color: '#546E7A', textAlign: 'center', paddingHorizontal: 40 },
  trackingArea: {
    width: 300,
    height: 300,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4FC3F7',
  },
  ring1: { width: 220, height: 220, opacity: 0.25 },
  ring2: { width: 270, height: 270, opacity: 0.15 },
  ring3: { width: 300, height: 300, opacity: 0.08 },
  bubble: {
    position: 'absolute',
    alignSelf: 'center',
    elevation: 12,
    shadowColor: '#2196F3',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 20,
  },
  simPercent: {
    position: 'absolute',
    fontSize: 26,
    fontWeight: '700',
    color: '#FFF',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  stopTrackingBtn: {
    backgroundColor: '#37474F',
    borderRadius: 24,
    paddingVertical: 14,
    paddingHorizontal: 36,
  },
  stopTrackingText: { color: '#FFF', fontSize: 14, fontWeight: '600' },
});
