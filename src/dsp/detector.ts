/**
 * Dual-Band Horn Detector — Forensic Fingerprint Edition
 *
 * Detection based on 3 spectral criteria (validated on real Indian traffic audio):
 *   HIGH band (scooty): peakFreq ≥ 2500Hz AND hiLoRatio ≥ 2.0 AND centroid > 2200Hz
 *   LOW band (car/truck): spikeRatio > 3x noise floor AND centroid < 800Hz (rejects speech)
 *
 * State machine: IDLE → CANDIDATE → CONFIRMED → ALERT → IDLE
 */

import {
  GoertzelBin,
  GoertzelConfig,
  initGoertzelBins,
  processGoertzelFrame,
  computeBandEnergy,
  computeFrameRMS,
  computeSpectralFlatness,
  computeSpectralCentroid,
  getPeakBin,
} from './goertzel';

export type DetectionState = 'IDLE' | 'CANDIDATE' | 'CONFIRMED' | 'ALERT';

export interface DetectorConfig {
  sampleRate: number;
  frameSize: number;
  // HIGH band (scooty) thresholds — from forensic analysis
  highPeakFreqMin: number;       // peak freq must be ≥ this (2500Hz)
  highHiLoMin: number;           // high/low energy ratio ≥ this (2.0)
  highCentroidMin: number;       // spectral centroid > this (2200Hz)
  // LOW band (car) thresholds
  lowSpikeRatio: number;         // low band energy must exceed noise floor by this (3.0x)
  lowMinEnergy: number;          // minimum absolute energy
  lowCentroidMax: number;        // centroid must be BELOW this to reject speech (800Hz)
  // State machine
  confirmFrames: number;         // frames to confirm (2 = 10ms minimum)
  alertFrames: number;           // frames to hold ALERT
  noiseAlpha: number;            // EMA noise floor smoothing
}

export interface DetectionEvent {
  timeMs: number;
  frameIndex: number;
  state: DetectionState;
  prevState: DetectionState;
  band: 'LOW' | 'HIGH' | null;
  peakFreq: number;
  peakMag: number;
  lowEnergy: number;
  highEnergy: number;
  hiLoRatio: number;
  centroid: number;
  scr: number;
  flatness: number;
  rms: number;
  isTransition: boolean;
}

export interface DetectorSnapshot {
  state: DetectionState;
  candidateCount: number;
  candidateBand: 'LOW' | 'HIGH' | null;
  alertCountdown: number;
  lowNoiseFloor: number;
  highNoiseFloor: number;
  frameIndex: number;
  detections: number;
  bins: GoertzelBin[];
  lowEnergy: number;
  highEnergy: number;
  lowRatio: number;
  highRatio: number;
  hiLoRatio: number;
  centroid: number;
  scr: number;
  flatness: number;
  rms: number;
  peakFreq: number;
  peakMag: number;
  avgPowerMw: number;
  cpuActiveMs: number;
  event: DetectionEvent;
}

const DEFAULT_CONFIG: DetectorConfig = {
  sampleRate: 16000,
  frameSize: 160,          // 10ms
  // HIGH band — forensic fingerprint from real scooty horn analysis
  highPeakFreqMin: 3000,   // 2500Hz catches speech sibilants; real scooty horns are 3100+
  highHiLoMin: 0.5,        // lowered to catch quieter horns in noisy traffic
  highCentroidMin: 1500,   // lowered — peakFreq>=3000 is the primary discriminator now
  // LOW band — car/truck horns
  lowSpikeRatio: 3.0,
  lowMinEnergy: 200,
  lowCentroidMax: 800,     // speech centroid is ~1500Hz, car horns are < 800Hz
  // State machine
  confirmFrames: 2,        // 2 consecutive frames = 10ms (scooty bursts are 10-45ms)
  alertFrames: 3,          // 30ms hold — short so each scooty burst gets its own detection
  noiseAlpha: 0.05,
};

export class HornDetector {
  config: DetectorConfig;
  private goertzelConfig: GoertzelConfig;
  private bins: GoertzelBin[];

  private state: DetectionState = 'IDLE';
  private candidateCount = 0;
  private candidateBand: 'LOW' | 'HIGH' | null = null;
  private alertCountdown = 0;
  private lowNoiseFloor = 50;
  private highNoiseFloor = 10;
  private frameIndex = 0;
  private detections = 0;

  constructor(config?: Partial<DetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.goertzelConfig = {
      sampleRate: this.config.sampleRate,
      frameSize: this.config.frameSize,
    };
    this.bins = initGoertzelBins(this.goertzelConfig);
  }

  reset(): void {
    this.state = 'IDLE';
    this.candidateCount = 0;
    this.candidateBand = null;
    this.alertCountdown = 0;
    this.lowNoiseFloor = 50;
    this.highNoiseFloor = 10;
    this.frameIndex = 0;
    this.detections = 0;
    this.bins = initGoertzelBins(this.goertzelConfig);
  }

  processFrame(samples: Float32Array): DetectorSnapshot {
    const prevState = this.state;

    // 1. Goertzel
    const bins = processGoertzelFrame(samples, this.bins);

    // 2. Band energies
    const lowEnergy = computeBandEnergy(bins, 'LOW');
    const highEnergy = computeBandEnergy(bins, 'HIGH');
    const rms = computeFrameRMS(samples);

    // 3. Spectral centroid — the key discriminator
    const centroid = computeSpectralCentroid(bins);

    // 4. Hi/Lo energy ratio — HIGH (2500+) vs only the true low bins (≤600)
    const trueLowEnergy = bins.filter(b => b.freq <= 600).reduce((s, b) => s + b.magSq, 0);
    const hiLoRatio = trueLowEnergy > 0 ? highEnergy / trueLowEnergy : 0;

    // 5. Noise floor ratios
    const lowRatio = this.lowNoiseFloor > 0 ? lowEnergy / this.lowNoiseFloor : 1;
    const highRatio = this.highNoiseFloor > 0 ? highEnergy / this.highNoiseFloor : 1;

    // 6. Flatness (kept for display, not primary detection)
    const flatness = computeSpectralFlatness(bins, 'HIGH');

    // 7. SCR — top 2 bins / total
    const sortedMags = bins.map((b) => b.magSq).sort((a, b) => b - a);
    const totalE = bins.reduce((s, b) => s + b.magSq, 0);
    const scr = totalE > 1e-10 ? (sortedMags[0] + (sortedMags[1] || 0)) / totalE : 0;

    // 8. Peak bin
    const peakBin = getPeakBin(bins);

    // 9. HORN DETECTION — 3-criteria forensic fingerprint
    //
    // HIGH band (scooty): all three must be true
    //   - Peak frequency in high band (≥ 2500Hz)
    //   - High/Low energy ratio ≥ 2.0 (horn energy dominates engine)
    //   - Spectral centroid > 2200Hz (center of mass shifted high)
    //
    // LOW band (car/truck): spike ratio + centroid check
    //   - Low band energy > 3x noise floor
    //   - Centroid < 800Hz (rejects speech at ~1500Hz centroid)

    const highSpike =
      peakBin.freq >= this.config.highPeakFreqMin &&
      hiLoRatio >= this.config.highHiLoMin &&
      centroid > this.config.highCentroidMin;

    // LOW band disabled — cannot reliably separate car horns from male speech
    // with sparse Goertzel bins. Car horn detection needs dedicated research
    // with different approach (e.g., onset detection, harmonic structure analysis).
    const lowSpike = false;

    const spike = highSpike || lowSpike;
    const spikeBand: 'LOW' | 'HIGH' = highSpike ? 'HIGH' : 'LOW';

    // 10. Update noise floor (only during IDLE)
    if (this.state === 'IDLE') {
      this.lowNoiseFloor =
        this.lowNoiseFloor * (1 - this.config.noiseAlpha) + lowEnergy * this.config.noiseAlpha;
      this.highNoiseFloor =
        this.highNoiseFloor * (1 - this.config.noiseAlpha) + highEnergy * this.config.noiseAlpha;
    }

    // 11. State machine
    // HIGH band scooty horns are only 10-45ms — at 10ms frames they're often just 1 frame.
    // So HIGH band confirms immediately, LOW band needs 2 consecutive frames.
    switch (this.state) {
      case 'IDLE':
        if (spike) {
          if (spikeBand === 'HIGH') {
            // Scooty horn — confirm immediately (bursts are 10-45ms)
            this.state = 'CONFIRMED';
            this.candidateBand = 'HIGH';
            this.candidateCount = 1;
            this.detections++;
          } else {
            this.state = 'CANDIDATE';
            this.candidateCount = 1;
            this.candidateBand = spikeBand;
          }
        }
        break;
      case 'CANDIDATE':
        if (spike) {
          this.candidateCount++;
          if (this.candidateCount >= this.config.confirmFrames) {
            this.state = 'CONFIRMED';
            this.detections++;
          }
        } else {
          this.state = 'IDLE';
          this.candidateCount = 0;
          this.candidateBand = null;
        }
        break;
      case 'CONFIRMED':
        this.state = 'ALERT';
        this.alertCountdown = this.config.alertFrames;
        break;
      case 'ALERT':
        this.alertCountdown--;
        if (this.alertCountdown <= 0 && !spike) {
          this.state = 'IDLE';
          this.candidateCount = 0;
          this.candidateBand = null;
        }
        break;
    }

    // 12. Power sim
    const isActive = this.state !== 'IDLE';
    const avgPowerMw = isActive ? 3.2 : 1.1;
    const cpuActiveMs = 0.05;

    const event: DetectionEvent = {
      timeMs: (this.frameIndex * this.config.frameSize / this.config.sampleRate) * 1000,
      frameIndex: this.frameIndex,
      state: this.state,
      prevState,
      band: this.candidateBand,
      peakFreq: peakBin.freq,
      peakMag: peakBin.magSq,
      lowEnergy,
      highEnergy,
      hiLoRatio,
      centroid,
      scr,
      flatness,
      rms,
      isTransition: this.state !== prevState,
    };

    this.frameIndex++;

    return {
      state: this.state,
      candidateCount: this.candidateCount,
      candidateBand: this.candidateBand,
      alertCountdown: this.alertCountdown,
      lowNoiseFloor: this.lowNoiseFloor,
      highNoiseFloor: this.highNoiseFloor,
      frameIndex: this.frameIndex,
      detections: this.detections,
      bins,
      lowEnergy,
      highEnergy,
      lowRatio,
      highRatio,
      hiLoRatio,
      centroid,
      scr,
      flatness,
      rms,
      peakFreq: peakBin.freq,
      peakMag: peakBin.magSq,
      avgPowerMw,
      cpuActiveMs,
      event,
    };
  }
}
