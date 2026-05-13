import { CapturedSound, MeteringPoint, SoundFeatures } from './types';

const SILENCE_DB = -70;
const MIN_SILENCE_MS = 150;
const MIN_SEGMENT_MS = 80;
const MAX_SEGMENT_MS = 15000;
const WINDOW_MS = 100; // finer window for better feature resolution

const TYPE_COLORS: Record<string, string> = {
  Percussive: '#E53935',
  Voice:      '#43A047',
  Tonal:      '#8E24AA',
  Sharp:      '#FB8C00',
  Steady:     '#0288D1',
  Ambient:    '#607D8B',
};

function normalize(db: number): number {
  return Math.max(0, Math.min(1, (db + 80) / 80));
}

function sliceProfile(
  history: MeteringPoint[],
  startMs: number,
  endMs: number,
): number[] {
  const profile: number[] = [];
  for (let t = startMs; t < endMs; t += WINDOW_MS) {
    const slice = history.filter(p => p.timeMs >= t && p.timeMs < t + WINDOW_MS);
    if (slice.length === 0) {
      profile.push(0);
    } else {
      const avgDb = slice.reduce((a, b) => a + b.db, 0) / slice.length;
      profile.push(normalize(avgDb));
    }
  }
  return profile;
}

function extractFeatures(profile: number[]): SoundFeatures {
  const n = profile.length;
  if (n === 0) {
    return { avgAmp: 0, peakAmp: 0, crestFactor: 0, attackRate: 0, decayRate: 0, zcr: 0, periodicity: 0, variance: 0, energyBalance: 0 };
  }

  // Basic amplitude stats
  const avg = profile.reduce((a, b) => a + b, 0) / n;
  const peak = Math.max(...profile);
  const rms = Math.sqrt(profile.reduce((a, b) => a + b * b, 0) / n);
  // Crest factor: peak/RMS normalised to 0..1 (divide by 4 since max theoretical ratio ~4)
  const crestFactor = rms > 0.01 ? Math.min(1, (peak / rms - 1) / 3) : 0;
  const variance = profile.reduce((a, b) => a + (b - avg) ** 2, 0) / n;

  // Attack: position of peak relative to length (early peak = fast attack)
  const peakIdx = profile.indexOf(peak);
  const attackRate = n > 1 ? 1 - peakIdx / (n - 1) : 1;

  // Decay: how much the tail (last 25%) drops relative to peak
  const tailStart = Math.max(0, Math.floor(n * 0.75));
  const tailSlice = profile.slice(tailStart);
  const tailAvg = tailSlice.reduce((a, b) => a + b, 0) / Math.max(1, tailSlice.length);
  const decayRate = peak > 0.01 ? Math.max(0, 1 - tailAvg / peak) : 0;

  // Zero-crossing rate of the amplitude envelope around its mean
  // High ZCR → rapid amplitude fluctuation → higher frequency content
  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if ((profile[i] > avg) !== (profile[i - 1] > avg)) crossings++;
  }
  const zcr = n > 1 ? crossings / (n - 1) : 0;

  // Periodicity via normalised autocorrelation
  // A tonal / rhythmic sound repeats → high autocorrelation at some lag
  const centered = profile.map(v => v - avg);
  const selfCorr = centered.reduce((a, b) => a + b * b, 0);
  let maxCorr = 0;
  if (selfCorr > 0.001 && n >= 6) {
    const maxLag = Math.floor(n / 2);
    for (let lag = 2; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < n - lag; i++) {
        corr += centered[i] * centered[i + lag];
      }
      maxCorr = Math.max(maxCorr, corr / selfCorr);
    }
  }
  const periodicity = Math.max(0, Math.min(1, maxCorr));

  // Energy balance: >0 means energy concentrated later (rising), <0 front-loaded
  const half = Math.floor(n / 2);
  const firstEnergy = profile.slice(0, half).reduce((a, b) => a + b, 0);
  const secondEnergy = profile.slice(half).reduce((a, b) => a + b, 0);
  const totalEnergy = firstEnergy + secondEnergy;
  const energyBalance = totalEnergy > 0.01 ? (secondEnergy - firstEnergy) / totalEnergy : 0;

  return {
    avgAmp: avg,
    peakAmp: peak,
    crestFactor,
    attackRate,
    decayRate,
    zcr,
    periodicity,
    variance,
    energyBalance,
  };
}

function classify(f: SoundFeatures): string {
  // Percussive: fast attack, high crest factor (impulsive), fast decay
  if (f.attackRate > 0.65 && f.crestFactor > 0.4 && f.decayRate > 0.45) return 'Percussive';

  // Tonal: strong autocorrelation periodicity → repeating pattern (music, beeps, hum)
  if (f.periodicity > 0.55 && f.avgAmp > 0.1) return 'Tonal';

  // Voice: irregular but high ZCR (vocal tract creates rapid amplitude modulation)
  if (f.zcr > 0.28 && f.avgAmp > 0.12 && f.periodicity < 0.55) return 'Voice';

  // Sharp / high-frequency: very high ZCR (whistles, high-pitched beeps, 's' sounds)
  if (f.zcr > 0.45) return 'Sharp';

  // Steady: sustained loud sound with low variance (fan, machine noise, TV hum)
  if (f.avgAmp > 0.35 && f.variance < 0.04) return 'Steady';

  return 'Ambient';
}

// ─── Public: segment metering into distinct sound events ────────────────────

export function segmentSounds(
  history: MeteringPoint[],
  uri: string,
): CapturedSound[] {
  if (history.length === 0) return [];

  const silenceThreshold = normalize(SILENCE_DB);
  const segments: Array<{ startMs: number; endMs: number }> = [];
  let segStart = -1;
  let silenceStart = -1;

  for (const { timeMs, db } of history) {
    const amp = normalize(db);
    const isSilent = amp < silenceThreshold;

    if (!isSilent) {
      if (segStart === -1) segStart = timeMs;
      silenceStart = -1;
    } else {
      if (silenceStart === -1) silenceStart = timeMs;
      if (segStart !== -1 && timeMs - silenceStart > MIN_SILENCE_MS) {
        const dur = silenceStart - segStart;
        if (dur >= MIN_SEGMENT_MS && dur <= MAX_SEGMENT_MS) {
          segments.push({ startMs: segStart, endMs: silenceStart });
        }
        segStart = -1;
        silenceStart = -1;
      }
    }
  }

  // Trailing segment
  if (segStart !== -1) {
    const endMs = history[history.length - 1].timeMs;
    const dur = endMs - segStart;
    if (dur >= MIN_SEGMENT_MS) {
      segments.push({ startMs: segStart, endMs });
    }
  }

  return segments.map((seg, i) => {
    const slice = history.filter(p => p.timeMs >= seg.startMs && p.timeMs <= seg.endMs);
    const dbs = slice.map(p => p.db);
    const avgDb = dbs.length ? dbs.reduce((a, b) => a + b, 0) / dbs.length : SILENCE_DB;
    const peakDb = dbs.length ? Math.max(...dbs) : SILENCE_DB;

    const profile = sliceProfile(history, seg.startMs, seg.endMs);
    const features = extractFeatures(profile);
    const soundType = classify(features);

    return {
      id: i + 1,
      uri,
      startMs: seg.startMs,
      endMs: seg.endMs,
      durationMs: seg.endMs - seg.startMs,
      avgDb,
      peakDb,
      soundType,
      color: TYPE_COLORS[soundType] ?? '#607D8B',
      meteringProfile: profile,
      features,
    };
  });
}

// ─── Public: multi-feature similarity for tracking ──────────────────────────

export function computeSimilarity(
  liveDb: number,
  targetSound: CapturedSound,
): number {
  const liveAmp = normalize(liveDb);
  const f = targetSound.features;

  // Amplitude proximity — tighter window for sustained sounds, looser for impulsive
  const window = 0.15 + f.crestFactor * 0.25; // 0.15..0.40
  const ampDist = Math.abs(liveAmp - f.avgAmp);
  const ampSim = Math.max(0, 1 - ampDist / window);

  // Level boost: if live is louder than target average, sound is closer → push score up
  const boost = liveAmp > f.avgAmp ? Math.min(0.4, (liveAmp - f.avgAmp) * 1.2) : 0;

  // Penalty: if target was a sharp/impulsive sound, exact level match matters more
  const impulsivePenalty = f.crestFactor > 0.6 && liveAmp < f.avgAmp * 0.5 ? 0.2 : 0;

  return Math.min(1, Math.max(0, ampSim + boost - impulsivePenalty));
}
