import { CapturedSound, MeteringPoint } from './types';

const SILENCE_DB = -55;
const MIN_SILENCE_MS = 350;
const MIN_SEGMENT_MS = 250;
const MAX_SEGMENT_MS = 15000;

const TYPE_COLORS: Record<string, string> = {
  Voice:  '#43A047',
  Music:  '#8E24AA',
  Bass:   '#E53935',
  Treble: '#FB8C00',
  Noise:  '#0288D1',
};

// Convert raw dB (-160..0) to normalized 0..1
function normalize(db: number): number {
  return Math.max(0, Math.min(1, (db + 80) / 80));
}

// Classify sound from its amplitude profile characteristics
function classify(profile: number[]): string {
  if (profile.length === 0) return 'Noise';

  const avg = profile.reduce((a, b) => a + b, 0) / profile.length;
  const variance =
    profile.reduce((a, b) => a + (b - avg) ** 2, 0) / profile.length;

  // Count how many times amplitude crosses the mid-point (proxy for oscillation rate)
  const mid = avg;
  let crossings = 0;
  for (let i = 1; i < profile.length; i++) {
    if ((profile[i] > mid) !== (profile[i - 1] > mid)) crossings++;
  }

  if (avg > 0.65) return 'Bass';
  if (crossings > 12 && avg > 0.2) return 'Voice';
  if (variance < 0.04 && avg > 0.25) return 'Music';
  if (crossings > 20) return 'Treble';
  return 'Noise';
}

// Slice metering history into a normalized profile for a time window
function sliceProfile(
  history: MeteringPoint[],
  startMs: number,
  endMs: number,
  windowMs = 200
): number[] {
  const profile: number[] = [];
  for (let t = startMs; t < endMs; t += windowMs) {
    const slice = history.filter(p => p.timeMs >= t && p.timeMs < t + windowMs);
    if (slice.length === 0) {
      profile.push(0);
    } else {
      const avgDb = slice.reduce((a, b) => a + b.db, 0) / slice.length;
      profile.push(normalize(avgDb));
    }
  }
  return profile;
}

export function segmentSounds(
  history: MeteringPoint[],
  uri: string
): CapturedSound[] {
  if (history.length === 0) return [];

  const segments: Array<{ startMs: number; endMs: number }> = [];
  let segStart = -1;
  let silenceStart = -1;

  for (const { timeMs, db } of history) {
    const isSilent = db < SILENCE_DB;

    if (!isSilent) {
      if (segStart === -1) segStart = timeMs;
      silenceStart = -1;
    } else {
      if (silenceStart === -1) silenceStart = timeMs;
      if (segStart !== -1 && timeMs - silenceStart > MIN_SILENCE_MS) {
        const dur = silenceStart - segStart;
        if (dur > MIN_SEGMENT_MS && dur < MAX_SEGMENT_MS) {
          segments.push({ startMs: segStart, endMs: silenceStart });
        }
        segStart = -1;
        silenceStart = -1;
      }
    }
  }

  // Capture trailing segment if recording ended mid-sound
  if (segStart !== -1) {
    const endMs = history[history.length - 1].timeMs;
    const dur = endMs - segStart;
    if (dur > MIN_SEGMENT_MS) {
      segments.push({ startMs: segStart, endMs });
    }
  }

  return segments.map((seg, i) => {
    const slice = history.filter(
      p => p.timeMs >= seg.startMs && p.timeMs <= seg.endMs
    );
    const dbs = slice.map(p => p.db);
    const avgDb = dbs.length
      ? dbs.reduce((a, b) => a + b, 0) / dbs.length
      : SILENCE_DB;
    const peakDb = dbs.length ? Math.max(...dbs) : SILENCE_DB;
    const profile = sliceProfile(history, seg.startMs, seg.endMs);
    const soundType = classify(profile);

    return {
      id: i + 1,
      uri,
      startMs: seg.startMs,
      endMs: seg.endMs,
      durationMs: seg.endMs - seg.startMs,
      avgDb,
      peakDb,
      soundType,
      color: TYPE_COLORS[soundType] ?? '#0288D1',
      meteringProfile: profile,
    };
  });
}

// Compute similarity (0..1) between live dB reading and a captured sound's profile
export function computeSimilarity(
  liveDb: number,
  targetSound: CapturedSound
): number {
  const liveNorm = normalize(liveDb);
  const targetNorm = normalize(targetSound.avgDb);

  // Distance in normalized space, max meaningful diff = 0.5
  const dist = Math.abs(liveNorm - targetNorm);
  const sim = Math.max(0, 1 - dist / 0.5);

  // Boost: if live is *above* target average (moving toward source), increase score
  const boost = liveNorm > targetNorm ? (liveNorm - targetNorm) * 0.6 : 0;

  return Math.min(1, sim + boost);
}
