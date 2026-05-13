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
  meteringProfile: number[]; // normalized 0-1 per 200ms window
}
