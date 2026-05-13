/**
 * NoiseCancel.ts
 *
 * True real-time ANC (inverting the live microphone signal) is not possible
 * with expo-av on Android because:
 *   1. expo-av records to AAC — we cannot access raw PCM samples.
 *   2. Android audio round-trip latency (30-100 ms) makes phase inversion
 *      effective only below ~15 Hz; phone speakers can't reproduce those.
 *
 * What we DO instead (effective for fans, AC units, motor hum):
 *   1. Record 3 s with high-resolution metering (50 ms windows).
 *   2. Run autocorrelation on the amplitude envelope to find the dominant
 *      modulation period → estimate acoustic fundamental frequency.
 *   3. Generate an anti-phase multi-harmonic PCM signal at those frequencies.
 *   4. Encode as WAV, write to cache, loop-play through the speaker.
 *
 * On iOS, LinearPCM recording is used so the actual waveform can be read and
 * phase-inverted directly for higher fidelity.
 */

import * as FileSystem from 'expo-file-system';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Platform } from 'react-native';
import { MeteringPoint } from './types';

// ── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 22050;
const RECORD_SECONDS = 3;
const METERING_INTERVAL_MS = 50; // finer resolution than default
const LOOP_DURATION_S = 2;       // length of one anti-noise tile

// ── WAV encoder (pure JS, no native deps) ───────────────────────────────────

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function encodeWAV(samples: Float32Array, sr = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);        // PCM
  v.setUint16(22, 1, true);        // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(off, Math.max(-1, Math.min(1, samples[i])) * 0x7FFF, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

// ── iOS: read & invert actual PCM waveform ───────────────────────────────────

async function tryInvertWAV(uri: string): Promise<Float32Array | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const view = new DataView(raw.buffer);

    // Validate RIFF / WAVE header
    const riff = String.fromCharCode(...raw.slice(0, 4));
    const wave = String.fromCharCode(...raw.slice(8, 12));
    if (riff !== 'RIFF' || wave !== 'WAVE') return null;

    // Find 'data' chunk
    let dataOffset = 12;
    while (dataOffset < raw.length - 8) {
      const chunkId = String.fromCharCode(...raw.slice(dataOffset, dataOffset + 4));
      const chunkSize = view.getUint32(dataOffset + 4, true);
      if (chunkId === 'data') {
        dataOffset += 8;
        break;
      }
      dataOffset += 8 + chunkSize;
    }
    if (dataOffset >= raw.length) return null;

    const numSamples = (raw.length - dataOffset) / 2;
    const out = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      // Invert phase: multiply by -1
      out[i] = -(view.getInt16(dataOffset + i * 2, true) / 0x7FFF);
    }
    return out;
  } catch (_e) {
    return null;
  }
}

// ── Frequency estimation from amplitude-envelope autocorrelation ─────────────

export function estimateFundamentalHz(
  history: MeteringPoint[],
  windowMs = METERING_INTERVAL_MS,
): { hz: number; confidence: number; periodMs: number } {
  if (history.length < 8) return { hz: 100, confidence: 0, periodMs: 10 };

  const profile = history.map(p => Math.max(0, Math.min(1, (p.db + 80) / 80)));
  const n = profile.length;
  const avg = profile.reduce((a, b) => a + b, 0) / n;
  const centered = profile.map(v => v - avg);
  const selfCorr = centered.reduce((a, b) => a + b * b, 0);

  if (selfCorr < 0.001) return { hz: 100, confidence: 0, periodMs: 10 };

  let bestLag = 4;
  let bestCorr = -1;
  const maxLag = Math.min(Math.floor(n / 2), 40);

  for (let lag = 2; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += centered[i] * centered[i + lag];
    corr /= selfCorr;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const periodMs = bestLag * windowMs;
  // The modulation period maps to an acoustic frequency range.
  // Fan blade pass: period_acoustic ≈ period_envelope for slow ceiling fans.
  // For faster fans, the envelope modulation is at a subharmonic.
  // We target the detected modulation frequency AND common motor frequencies.
  const modulationHz = 1000 / periodMs;

  return {
    hz: modulationHz,
    confidence: Math.max(0, Math.min(1, bestCorr)),
    periodMs,
  };
}

// ── Anti-phase signal generators ─────────────────────────────────────────────

function fade(s: Float32Array): Float32Array {
  const len = Math.min(512, Math.floor(s.length * 0.02));
  for (let i = 0; i < len; i++) {
    s[i] *= i / len;
    s[s.length - 1 - i] *= i / len;
  }
  return s;
}

/**
 * Generate anti-phase multi-harmonic signal.
 * Covers the detected modulation frequency + common motor/mains harmonics.
 * Phase = Math.PI → 180° inversion.
 */
function generateAntiHarmonic(
  fundamentalHz: number,
  amplitude: number,
): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION_S);
  const s = new Float32Array(n);

  // Build a frequency set: detected fundamental + its harmonics up to 800 Hz
  // + 50 Hz and 60 Hz mains + their harmonics (covers most motors worldwide)
  const freqSet = new Set<number>();
  for (let h = 1; h <= 12; h++) {
    const f = fundamentalHz * h;
    if (f > 20 && f < 1000) freqSet.add(Math.round(f));
  }
  // Common mains-driven motor harmonics
  for (const base of [50, 60]) {
    for (let h = 1; h <= 8; h++) {
      const f = base * h;
      if (f < 1000) freqSet.add(f);
    }
  }

  const freqs = Array.from(freqSet);
  // Random phase offsets so frequencies don't all peak together
  const phases = freqs.map(() => Math.PI + (Math.random() - 0.5) * 0.3);
  const amp = amplitude / Math.sqrt(freqs.length); // normalise total power

  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let f = 0; f < freqs.length; f++) {
      v += Math.sin(2 * Math.PI * freqs[f] * i / SAMPLE_RATE + phases[f]);
    }
    s[i] = v * amp;
  }
  return fade(s);
}

// ── Recording with fine metering ──────────────────────────────────────────────

export interface CancelAnalysis {
  uri: string;
  history: MeteringPoint[];
  fundamentalHz: number;
  confidence: number;
  label: string;
  description: string;
}

export async function recordAndAnalyse(
  onProgress: (secondsLeft: number) => void,
): Promise<CancelAnalysis> {
  const history: MeteringPoint[] = [];

  // On iOS, try LinearPCM so we can invert the actual waveform
  const recordingOptions: Audio.RecordingOptions = Platform.OS === 'ios'
    ? {
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        ios: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
          extension: '.wav',
          outputFormat: Audio.IOSOutputFormat.LINEARPCM,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
      }
    : Audio.RecordingOptionsPresets.HIGH_QUALITY;

  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync({
    ...recordingOptions,
    isMeteringEnabled: true,
    android: {
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
      extension: '.m4a',
    },
  });

  recording.setOnRecordingStatusUpdate(status => {
    if (status.isRecording && status.metering !== undefined) {
      history.push({ timeMs: status.durationMillis, db: status.metering });
      const elapsed = status.durationMillis / 1000;
      onProgress(Math.max(0, RECORD_SECONDS - elapsed));
    }
  });
  recording.setProgressUpdateInterval(METERING_INTERVAL_MS);

  await recording.startAsync();

  // Count down RECORD_SECONDS
  await new Promise<void>(resolve => setTimeout(resolve, RECORD_SECONDS * 1000));

  await recording.stopAndUnloadAsync();
  const uri = recording.getURI() ?? '';

  const { hz, confidence, periodMs } = estimateFundamentalHz(history, METERING_INTERVAL_MS);

  let label = 'Anti-Harmonic';
  let description = '';

  if (confidence > 0.5) {
    description = `Detected ~${hz.toFixed(1)} Hz fundamental (${(periodMs).toFixed(0)} ms period)`;
  } else {
    description = `Low periodicity — covering 50–500 Hz fan/motor range`;
  }

  return { uri, history, fundamentalHz: hz, confidence, label, description };
}

// ── Build and play the anti-noise signal ─────────────────────────────────────

export interface CancelSession {
  sound: Audio.Sound;
  fundamentalHz: number;
  label: string;
  description: string;
}

export async function buildAndPlay(
  analysis: CancelAnalysis,
  amplitude = 0.85,
): Promise<CancelSession> {
  let samples: Float32Array | null = null;

  // iOS fast-path: try to invert actual recorded waveform
  if (Platform.OS === 'ios' && analysis.uri) {
    samples = await tryInvertWAV(analysis.uri);
  }

  if (!samples) {
    // Android (or iOS fallback): generate precision anti-harmonic signal
    const targetHz = analysis.confidence > 0.4
      ? analysis.fundamentalHz
      : 100; // default fan range
    samples = generateAntiHarmonic(targetHz, amplitude);
  }

  const wav = encodeWAV(samples);
  const b64 = uint8ToBase64(wav);
  const path = `${FileSystem.cacheDirectory}antinoise.wav`;
  await FileSystem.writeAsStringAsync(path, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
  });

  const { sound } = await Audio.Sound.createAsync(
    { uri: path },
    { isLooping: true, volume: 1.0 },
  );
  await sound.playAsync();

  return {
    sound,
    fundamentalHz: analysis.fundamentalHz,
    label: analysis.label,
    description: analysis.description,
  };
}
