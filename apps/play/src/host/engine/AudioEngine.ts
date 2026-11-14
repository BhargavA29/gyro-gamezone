import type { GameAudioApi } from "@gyro/shared";

const MUTE_KEY = "gyro-audio-muted";

export class AudioEngine implements GameAudioApi {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
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
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      if (!this.noiseBuffer) {
        this.noiseBuffer = this.buildNoiseBuffer(this.ctx);
      }
    }
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.3));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      channel[i] = Math.random() * 2 - 1;
    }
    return buffer;
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
    cue: Parameters<GameAudioApi["play"]>[0],
  ): void {
    if (this.muted) return;
    if (!this.ctx) this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    if (!this.noiseBuffer) {
      this.noiseBuffer = this.buildNoiseBuffer(ctx);
    }

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
        // Crisp arcade blaster/clay-shot pop: filtered noise transient + low body thump
        this.noiseBurst(ctx, now, 0.055, "bandpass", 2200, 620, 0.11, 1.3);
        this.tone(ctx, now, 310, 92, 0.075, "triangle", 0.115);
        this.tone(ctx, now, 175, 76, 0.055, "square", 0.045);
        break;
      case "dry_fire":
        // Hollow mechanical double-click signaling an empty chamber
        this.noiseBurst(ctx, now, 0.022, "bandpass", 3100, 1800, 0.065, 2.5);
        this.tone(ctx, now, 980, 340, 0.024, "triangle", 0.075);
        this.tone(ctx, now + 0.032, 620, 240, 0.028, "square", 0.05);
        break;
      case "low_ammo":
        // Light brass chamber ping slightly trailing the shot
        this.tone(ctx, now + 0.04, 1567.98, 1480, 0.075, "sine", 0.065);
        break;
      case "reload_start":
        // Eject slide-out whoosh
        this.noiseBurst(ctx, now, 0.11, "bandpass", 920, 2400, 0.08, 1.8);
        this.tone(ctx, now, 490, 210, 0.09, "triangle", 0.085);
        break;
      case "reload":
        // Crisp bolt clack + chamber lock harmonic
        this.noiseBurst(ctx, now, 0.045, "bandpass", 2600, 1400, 0.075, 1.8);
        this.tone(ctx, now, 390, 560, 0.05, "square", 0.065);
        this.tone(ctx, now + 0.055, 587.33, 880, 0.1, "triangle", 0.11);
        break;
      case "hazard":
        this.noiseBurst(ctx, now, 0.14, "lowpass", 720, 180, 0.12, 1.0);
        this.tone(ctx, now, 165, 88, 0.24, "sawtooth", 0.13);
        this.tone(ctx, now + 0.06, 130, 72, 0.22, "square", 0.075);
        break;
      case "hit":
        // Crisp steel plate knock + ping
        this.noiseBurst(ctx, now, 0.035, "highpass", 1800, 1200, 0.055, 1.0);
        this.tone(ctx, now, 240, 118, 0.09, "square", 0.09);
        this.tone(ctx, now, 840, 1120, 0.11, "triangle", 0.105);
        break;
      case "bullseye":
        // Clean bell harmonic over steel knock for center hits
        this.tone(ctx, now, 1046.5, 1046.5, 0.13, "sine", 0.12);
        this.tone(ctx, now + 0.025, 1567.98, 2093.0, 0.16, "triangle", 0.11);
        break;
      case "gold_spawn":
        // Airy upward sparkle triad announcing a bonus golden saucer
        this.tone(ctx, now, 880, 920, 0.07, "sine", 0.065);
        this.tone(ctx, now + 0.055, 1174.66, 1220, 0.07, "sine", 0.07);
        this.tone(ctx, now + 0.11, 1567.98, 1680, 0.11, "triangle", 0.08);
        break;
      case "gold_hit":
        // Rewarding 3-note gold chime chord
        this.tone(ctx, now, 783.99, 783.99, 0.12, "triangle", 0.11);
        this.tone(ctx, now + 0.045, 987.77, 987.77, 0.14, "triangle", 0.11);
        this.tone(ctx, now + 0.09, 1174.66, 1567.98, 0.22, "sine", 0.13);
        break;
      case "combo":
        this.tone(ctx, now, 523.25, 659.25, 0.09, "triangle", 0.12);
        this.tone(ctx, now + 0.07, 659.25, 987.77, 0.14, "triangle", 0.13);
        break;
      case "miss":
        this.tone(ctx, now, 200, 120, 0.16, "sawtooth", 0.08);
        break;
      case "swipe":
        // Light crisp katana air-cut whoosh
        this.noiseBurst(ctx, now, 0.085, "bandpass", 1900, 720, 0.055, 1.5);
        break;
      case "slice":
        // Sharp blade swish + juicy fruit pop
        this.noiseBurst(ctx, now, 0.075, "highpass", 2800, 1100, 0.09, 1.1);
        this.tone(ctx, now, 540, 210, 0.075, "sine", 0.115);
        this.tone(ctx, now + 0.015, 1180, 1680, 0.055, "triangle", 0.07);
        break;
      case "bomb_fuse":
        // Subtle sizzling spark warning on bomb launch
        this.noiseBurst(ctx, now, 0.12, "bandpass", 3600, 2200, 0.045, 2.2);
        this.tone(ctx, now, 160, 115, 0.09, "triangle", 0.045);
        break;
      case "bomb_boom":
        // Deep punchy arcade bomb blast
        this.noiseBurst(ctx, now, 0.32, "lowpass", 1100, 75, 0.18, 0.9);
        this.tone(ctx, now, 130, 34, 0.32, "sawtooth", 0.16);
        this.tone(ctx, now + 0.03, 95, 28, 0.28, "square", 0.09);
        break;
      case "frenzy":
        // Rising arcade frenzy fanfare arpeggio
        this.tone(ctx, now, 523.25, 523.25, 0.07, "triangle", 0.09);
        this.tone(ctx, now + 0.055, 659.25, 659.25, 0.07, "triangle", 0.095);
        this.tone(ctx, now + 0.11, 783.99, 783.99, 0.08, "triangle", 0.1);
        this.tone(ctx, now + 0.165, 1046.5, 1174.66, 0.16, "sine", 0.12);
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

  private noiseBurst(
    ctx: AudioContext,
    startTime: number,
    dur: number,
    filterType: BiquadFilterType,
    freq0: number,
    freq1: number,
    peakGain: number,
    q: number,
  ): void {
    const buffer = this.noiseBuffer;
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.setValueAtTime(q, startTime);
    filter.frequency.setValueAtTime(freq0, startTime);
    if (freq1 !== freq0) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq1), startTime + dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(startTime);
    src.stop(startTime + dur + 0.01);
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
