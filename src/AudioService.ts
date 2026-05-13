import { Audio } from 'expo-av';
import { MeteringPoint } from './types';

export class AudioService {
  private recording: Audio.Recording | null = null;
  private playbackSound: Audio.Sound | null = null;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;

  async requestPermissions(): Promise<boolean> {
    const { status } = await Audio.requestPermissionsAsync();
    return status === 'granted';
  }

  async startCapture(
    onMetering: (point: MeteringPoint) => void
  ): Promise<void> {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    this.recording = new Audio.Recording();
    await this.recording.prepareToRecordAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });

    this.recording.setOnRecordingStatusUpdate(status => {
      if (status.isRecording && status.metering !== undefined) {
        onMetering({ timeMs: status.durationMillis, db: status.metering });
      }
    });

    await this.recording.startAsync();
  }

  async stopCapture(): Promise<string | null> {
    if (!this.recording) return null;
    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;
      return uri ?? null;
    } catch {
      this.recording = null;
      return null;
    }
  }

  async playSegment(
    uri: string,
    startMs: number,
    endMs: number,
    onFinish: () => void
  ): Promise<void> {
    await this.stopPlayback();

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });

    const { sound } = await Audio.Sound.createAsync({ uri });
    this.playbackSound = sound;

    await sound.setPositionAsync(startMs);
    await sound.playAsync();

    this.playbackTimer = setInterval(async () => {
      try {
        const status = await sound.getStatusAsync();
        if (!status.isLoaded) return;
        if (status.positionMillis >= endMs || !status.isPlaying) {
          this.stopPlayback().then(onFinish);
        }
      } catch {
        this.stopPlayback().then(onFinish);
      }
    }, 150);
  }

  async stopPlayback(): Promise<void> {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.playbackSound) {
      try {
        await this.playbackSound.stopAsync();
        await this.playbackSound.unloadAsync();
      } catch { /* already unloaded */ }
      this.playbackSound = null;
    }
  }

  // Tracking uses a fresh short recording to read live metering
  private trackingRecording: Audio.Recording | null = null;

  async startTracking(onMetering: (db: number) => void): Promise<void> {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    this.trackingRecording = new Audio.Recording();
    await this.trackingRecording.prepareToRecordAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });

    this.trackingRecording.setOnRecordingStatusUpdate(status => {
      if (status.isRecording && status.metering !== undefined) {
        onMetering(status.metering);
      }
    });

    await this.trackingRecording.startAsync();
  }

  async stopTracking(): Promise<void> {
    if (!this.trackingRecording) return;
    try {
      await this.trackingRecording.stopAndUnloadAsync();
    } catch { /* ignore */ }
    this.trackingRecording = null;
  }
}
