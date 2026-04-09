/**
 * TDOA (Time Difference of Arrival) Direction Estimation
 *
 * Two MEMS mics at left/right temples, ~17cm apart.
 * Max inter-mic delay = 0.17m / 343 m/s = 496µs = 7.9 samples @ 16kHz
 *
 * Cross-correlate filtered signals over ±8 lag window.
 * Peak lag → angle: θ = arcsin(Δt × c / d)
 *
 * Cost: ~4100 MAC operations — trivial on any MCU.
 */

export interface TDOAResult {
  lag: number;              // peak lag in samples (negative = left, positive = right)
  lagUs: number;            // lag in microseconds
  angle: number;            // degrees from broadside (-90 = full left, +90 = full right)
  direction: 'LEFT' | 'RIGHT' | 'BEHIND' | 'FRONT';
  confidence: number;       // peak-to-sidelobe ratio (higher = more confident)
  correlogram: number[];    // full cross-correlation array for visualization
  correlogramLags: number[];// corresponding lag values
}

export interface TDOAConfig {
  micSpacing: number;       // meters (default 0.17)
  speedOfSound: number;     // m/s (default 343)
  sampleRate: number;       // Hz (default 16000)
  maxLag: number;           // max lag in samples to search (default 8)
}

const DEFAULT_TDOA_CONFIG: TDOAConfig = {
  micSpacing: 0.17,
  speedOfSound: 343,
  sampleRate: 16000,
  maxLag: 8,
};

/**
 * Compute normalized cross-correlation between left and right mic signals.
 * Returns correlogram over ±maxLag samples.
 *
 * Positive lag = right mic leads = sound from LEFT
 * Negative lag = left mic leads = sound from RIGHT
 */
export function computeTDOA(
  leftSamples: Float32Array,
  rightSamples: Float32Array,
  config: TDOAConfig = DEFAULT_TDOA_CONFIG
): TDOAResult {
  const { maxLag, sampleRate, micSpacing, speedOfSound } = config;
  const N = Math.min(leftSamples.length, rightSamples.length);

  // Compute cross-correlation for lags from -maxLag to +maxLag
  const numLags = 2 * maxLag + 1;
  const correlogram: number[] = new Array(numLags);
  const correlogramLags: number[] = new Array(numLags);

  // Compute energy for normalization
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < N; i++) {
    leftEnergy += leftSamples[i] * leftSamples[i];
    rightEnergy += rightSamples[i] * rightSamples[i];
  }
  const normFactor = Math.sqrt(leftEnergy * rightEnergy);

  let peakValue = -Infinity;
  let peakLag = 0;

  for (let lagIdx = 0; lagIdx < numLags; lagIdx++) {
    const lag = lagIdx - maxLag; // -maxLag to +maxLag
    correlogramLags[lagIdx] = lag;

    let sum = 0;
    const start = Math.max(0, lag);
    const end = Math.min(N, N + lag);

    for (let i = start; i < end; i++) {
      sum += leftSamples[i] * rightSamples[i - lag];
    }

    // Normalize
    correlogram[lagIdx] = normFactor > 0 ? sum / normFactor : 0;

    if (correlogram[lagIdx] > peakValue) {
      peakValue = correlogram[lagIdx];
      peakLag = lag;
    }
  }

  // Compute confidence: peak-to-next-peak ratio
  const sortedCorr = [...correlogram].sort((a, b) => b - a);
  const confidence = sortedCorr[1] > 0 ? sortedCorr[0] / sortedCorr[1] : sortedCorr[0] > 0 ? 10 : 0;

  // Convert lag to time and angle
  const lagUs = (peakLag / sampleRate) * 1e6;
  const lagSeconds = peakLag / sampleRate;

  // θ = arcsin(Δt × c / d)
  const sinTheta = (lagSeconds * speedOfSound) / micSpacing;
  const clampedSinTheta = Math.max(-1, Math.min(1, sinTheta));
  const angle = (Math.asin(clampedSinTheta) * 180) / Math.PI;

  // Map angle to direction zone
  // Positive lag (right mic receives first) → sound from LEFT
  // Negative lag (left mic receives first) → sound from RIGHT
  // Near-zero lag with low amplitude ratio → BEHIND or FRONT
  let direction: TDOAResult['direction'];
  const absAngle = Math.abs(angle);

  if (absAngle < 15) {
    // Near broadside — could be front or behind
    // Use amplitude ratio to disambiguate (rear = attenuated by head)
    const leftAmp = Math.sqrt(leftEnergy / N);
    const rightAmp = Math.sqrt(rightEnergy / N);
    const ampRatio = Math.min(leftAmp, rightAmp) / Math.max(leftAmp, rightAmp);
    direction = ampRatio < 0.7 ? 'BEHIND' : 'FRONT';
  } else if (angle > 0) {
    direction = 'LEFT';
  } else {
    direction = 'RIGHT';
  }

  return {
    lag: peakLag,
    lagUs,
    angle,
    direction,
    confidence,
    correlogram,
    correlogramLags,
  };
}

/**
 * Apply bandpass filter around horn frequencies before TDOA.
 * Simple 2nd-order Butterworth approximation via biquad.
 * Center: 400Hz, BW: 500Hz (150-650Hz passband)
 */
export function bandpassFilter(
  samples: Float32Array,
  sampleRate: number,
  centerFreq: number = 400,
  bandwidth: number = 500
): Float32Array {
  const output = new Float32Array(samples.length);
  const omega = (2 * Math.PI * centerFreq) / sampleRate;
  const bw = (2 * Math.PI * bandwidth) / sampleRate;
  const alpha = Math.sin(bw) / 2;

  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(omega);
  const a2 = 1 - alpha;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return output;
}
