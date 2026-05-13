export type AppState =
  | 'idle'
  | 'recording'
  | 'processing'
  | 'sounds'
  | 'playing'
  | 'tracking';

export interface MeteringPoint {
  timeMs: number;
  db: number;
}

export interface SoundFeatures {
  avgAmp: number;       // mean normalized amplitude 0..1
  peakAmp: number;      // peak normalized amplitude 0..1
  crestFactor: number;  // peak/RMS — high = impulsive, low = sustained
  attackRate: number;   // 0..1, higher = faster attack (percussive)
  decayRate: number;    // 0..1, higher = faster decay
  zcr: number;          // zero-crossing rate of amplitude envelope (frequency proxy)
  periodicity: number;  // autocorrelation score 0..1 (tonal = high)
  variance: number;     // amplitude spread
  energyBalance: number;// -1 front-loaded .. +1 back-loaded
}

export interface CapturedSound {
  id: number;
  uri: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  avgDb: number;
  peakDb: number;
  soundType: string;
  color: string;
  meteringProfile: number[];
  features: SoundFeatures;
}
