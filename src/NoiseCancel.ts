import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { SoundFeatures } from './types';

const SAMPLE_RATE = 22050;
const LOOP_DURATION = 2; // seconds per loop tile

// ── WAV encoder ─────────────────────────────────────────────────────────────

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWAV(samples: Float32Array): Uint8Array {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);            // PCM
  v.setUint16(22, 1, true);            // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(offset, Math.max(-1, Math.min(1, samples[i])) * 0x7FFF, true);
    offset += 2;
  }
  return new Uint8Array(buf);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Signal generators ────────────────────────────────────────────────────────

function fade(samples: Float32Array): Float32Array {
  const len = Math.min(512, Math.floor(samples.length * 0.02));
  for (let i = 0; i < len; i++) {
    const w = i / len;
    samples[i] *= w;
    samples[samples.length - 1 - i] *= w;
  }
  return samples;
}

// Anti-phase sine at `freq` Hz — cancels a pure tone
function antiSine(freq: number, amp: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE + Math.PI) * amp;
  }
  return fade(s);
}

// Anti-phase multi-sine for tonal sounds with unknown exact frequency
// Covers common fundamental + harmonics in the 80–600 Hz range
function antiMultiTone(fundamentalHz: number, amp: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION);
  const s = new Float32Array(n);
  const harmonics = [1, 2, 3, 4];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const h of harmonics) {
      v += Math.sin(2 * Math.PI * fundamentalHz * h * i / SAMPLE_RATE + Math.PI) / harmonics.length;
    }
    s[i] = v * amp;
  }
  return fade(s);
}

// Pink noise (Voss-McCartney) — broadband masker
function pinkNoise(amp: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION);
  const s = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    s[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * amp * 0.11;
    b6 = w * 0.115926;
  }
  return fade(s);
}

// Brown noise (integrated white) — heavy low-frequency masker for rumble/hum
function brownNoise(amp: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION);
  const s = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = Math.max(-1, Math.min(1, last + (Math.random() * 2 - 1) * 0.015));
    s[i] = last * amp;
  }
  return fade(s);
}

// Voice-band masker: dense sine cluster 300–3400 Hz (speech frequencies)
function voiceBandMasker(amp: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * LOOP_DURATION);
  const s = new Float32Array(n);
  // Spread of frequencies across the speech band
  const freqs = [320, 480, 680, 900, 1200, 1600, 2100, 2800, 3200];
  // Random phase per frequency so they don't all align and create a tone
  const phases = freqs.map(() => Math.random() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let f = 0; f < freqs.length; f++) {
      v += Math.sin(2 * Math.PI * freqs[f] * i / SAMPLE_RATE + phases[f]);
    }
    s[i] = (v / freqs.length) * amp;
  }
  return fade(s);
}

// ── Strategy selection ───────────────────────────────────────────────────────

export type CancelStrategy = {
  label: string;
  description: string;
  samples: Float32Array;
};

export function pickStrategy(features: SoundFeatures, amplitude = 0.75): CancelStrategy {
  const { periodicity, zcr, crestFactor, avgAmp } = features;

  // Strong periodicity → likely a machine hum or mains buzz
  // Estimate fundamental: mains = 50 or 60 Hz, machinery 100–400 Hz
  // We pick a range mid-point; the multi-harmonic spread covers small errors
  if (periodicity > 0.55) {
    // High ZCR + periodic → faster oscillation (fan, motor)
    const fundamental = zcr > 0.3 ? 180 : 60;
    return {
      label: 'Anti-Tone',
      description: `Counter-wave at ~${fundamental} Hz`,
      samples: antiMultiTone(fundamental, amplitude),
    };
  }

  // Percussive / impulsive → pink noise covers broadband transients
  if (crestFactor > 0.45) {
    return {
      label: 'Pink Noise',
      description: 'Broadband masking signal',
      samples: pinkNoise(amplitude),
    };
  }

  // Voice-range sound
  if (zcr > 0.25 && avgAmp > 0.1) {
    return {
      label: 'Voice Masker',
      description: 'Speech-band counter-signal',
      samples: voiceBandMasker(amplitude),
    };
  }

  // Low steady hum / ambient
  if (avgAmp > 0.15 && zcr < 0.2) {
    return {
      label: 'Brown Noise',
      description: 'Low-frequency masking signal',
      samples: brownNoise(amplitude),
    };
  }

  // Default: pink noise
  return {
    label: 'Pink Noise',
    description: 'Broadband masking signal',
    samples: pinkNoise(amplitude),
  };
}

// ── Write WAV to cache and play it ───────────────────────────────────────────

export async function playStrategy(strategy: CancelStrategy): Promise<Audio.Sound> {
  const wav = encodeWAV(strategy.samples);
  const base64 = uint8ToBase64(wav);
  const path = `${FileSystem.cacheDirectory}antinoise.wav`;
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
  });
  const { sound } = await Audio.Sound.createAsync(
    { uri: path },
    { isLooping: true, volume: 0.9 },
  );
  await sound.playAsync();
  return sound;
}
