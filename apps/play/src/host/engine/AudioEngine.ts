import type { GameAudioApi } from "@gyro/shared";

const MUTE_KEY = "gyro-audio-muted";

export class AudioEngine implements GameAudioApi {
  private ctx: AudioContext | null = null;
  private muted: boolean;
  private musicTimer: number | null = null;
  private musicStep = 0;

  constructor() {
    this.muted = this.readMutedPref();
  }

  private readMutedPref(): boolean {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(mute: boolean): void {
    this.muted = mute;
    if (mute) {
      this.stopMusic();
    }
    try {
      localStorage.setItem(MUTE_KEY, mute ? "1" : "0");
    } catch {
      // ignore
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  unlock(): void {
    if (!this.ctx && typeof AudioContext !== "undefined") {
      this.ctx = new AudioContext();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  startMusic(bpm = 128): void {
    if (this.musicTimer !== null) return;
    const stepMs = Math.round((60 / bpm / 2) * 1000);
    const bassNotes = [110, 110, 146.83, 130.81, 110, 164.81, 146.83, 130.81];
    this.musicStep = 0;

    this.musicTimer = window.setInterval(() => {
      if (this.muted) return;
      const ctx = this.ctx;
      if (!ctx || ctx.state !== "running") return;

      const now = ctx.currentTime;
      const note = bassNotes[this.musicStep % bassNotes.length] ?? 110;
      const accent = this.musicStep % 2 === 0;
      this.tone(ctx, now, note, note * 0.98, 0.14, "triangle", accent ? 0.042 : 0.025);
      if (this.musicStep % 4 === 2) {
        // Subtle crisp high tick
        this.tone(ctx, now, 1240, 880, 0.035, "sine", 0.018);
      }
      this.musicStep = (this.musicStep + 1) & 0xff;
    }, stepMs);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  play(
    cue:
      | "tick"
      | "go"
      | "pop"
      | "shot"
      | "reload"
      | "hazard"
      | "hit"
      | "combo"
      | "miss"
      | "bow_release"
      | "bat_hit"
      | "end",
  ): void {
    if (this.muted) return;
    if (!this.ctx) this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;

    const now = ctx.currentTime;
    switch (cue) {
      case "tick":
        this.tone(ctx, now, 520, 520, 0.06, "triangle", 0.08);
        break;
      case "go":
        this.tone(ctx, now, 660, 880, 0.14, "triangle", 0.14);
        break;
      case "pop":
        this.tone(ctx, now, 340, 620, 0.09, "sine", 0.12);
        break;
      case "shot":
        this.tone(ctx, now, 420, 140, 0.075, "triangle", 0.11);
        this.tone(ctx, now, 190, 95, 0.06, "square", 0.055);
        break;
      case "reload":
        this.tone(ctx, now, 360, 480, 0.055, "square", 0.075);
        this.tone(ctx, now + 0.07, 560, 780, 0.085, "triangle", 0.11);
        break;
      case "hazard":
        this.tone(ctx, now, 165, 88, 0.24, "sawtooth", 0.14);
        this.tone(ctx, now + 0.06, 130, 72, 0.22, "square", 0.08);
        break;
      case "hit":
        this.tone(ctx, now, 220, 110, 0.11, "square", 0.11);
        this.tone(ctx, now, 780, 1040, 0.12, "triangle", 0.1);
        break;
      case "combo":
        this.tone(ctx, now, 523.25, 659.25, 0.09, "triangle", 0.12);
        this.tone(ctx, now + 0.07, 659.25, 987.77, 0.14, "triangle", 0.13);
        break;
      case "miss":
        this.tone(ctx, now, 200, 120, 0.16, "sawtooth", 0.08);
        break;
      case "bow_release":
        this.tone(ctx, now, 420, 160, 0.14, "triangle", 0.11);
        break;
      case "bat_hit":
        this.tone(ctx, now, 180, 75, 0.1, "square", 0.16);
        break;
      case "end":
        this.tone(ctx, now, 523.25, 523.25, 0.1, "triangle", 0.12);
        this.tone(ctx, now + 0.1, 659.25, 659.25, 0.12, "triangle", 0.12);
        this.tone(ctx, now + 0.22, 783.99, 1046.5, 0.24, "triangle", 0.14);
        break;
    }
  }

  private tone(
    ctx: AudioContext,
    startTime: number,
    f0: number,
    f1: number,
    dur: number,
    type: OscillatorType,
    peakGain: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, startTime);
    if (f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), startTime + dur);
    }
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.01);
  }
}
