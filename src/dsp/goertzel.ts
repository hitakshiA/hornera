/**
 * Goertzel Algorithm — Dual-Band Horn Detection
 *
 * Two frequency bands based on real Indian traffic analysis:
 *   LOW  (300-600Hz):  Car, truck, auto-rickshaw horns
 *   HIGH (2500-4000Hz): Scooty/scooter electric disc horns
 *
 * 10ms frames (N=160 @ 16kHz) to catch short scooty bursts (30-50ms).
 * Inner loop: s[n] = x[n] + 2·cos(2πk/N)·s[n-1] - s[n-2]
 */

export interface GoertzelBin {
  freq: number;
  k: number;
  coeff: number;
  magSq: number;
  band: 'LOW' | 'HIGH';
  label: string;
}

export interface GoertzelConfig {
  sampleRate: number;
  frameSize: number;
}

export const LOW_BAND_FREQS = [300, 400, 500, 600];
export const MID_BAND_FREQS = [800, 1000, 1200, 1500, 2000];
export const HIGH_BAND_FREQS = [2500, 2800, 3100, 3300, 3500, 3700];
export const ALL_TARGET_FREQS = [...LOW_BAND_FREQS, ...MID_BAND_FREQS, ...HIGH_BAND_FREQS];

export const FREQ_LABELS: Record<number, string> = {
  300: 'Auto', 400: 'Car', 500: 'Bike', 600: 'Horn',
  800: '800', 1000: '1k', 1200: '1.2k', 1500: '1.5k', 2000: '2k',
  2500: 'Sct-1', 2800: 'Sct-2', 3100: 'Sct-3', 3300: 'Sct-4', 3500: 'Sct-5', 3700: 'Sct-6',
};

export function initGoertzelBins(config: GoertzelConfig): GoertzelBin[] {
  const { sampleRate, frameSize } = config;
  return ALL_TARGET_FREQS.map((freq) => {
    const k = (freq * frameSize) / sampleRate;
    const coeff = 2 * Math.cos((2 * Math.PI * k) / frameSize);
    return {
      freq,
      k,
      coeff,
      magSq: 0,
      band: freq >= 2500 ? 'HIGH' : 'LOW',
      label: FREQ_LABELS[freq] || `${freq}Hz`,
    };
  });
}

export function processGoertzelFrame(
  samples: Float32Array,
  bins: GoertzelBin[]
): GoertzelBin[] {
  for (const bin of bins) {
    let s1 = 0, s2 = 0;
    for (let n = 0; n < samples.length; n++) {
      const s0 = samples[n] + bin.coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    bin.magSq = s1 * s1 + s2 * s2 - bin.coeff * s1 * s2;
  }
  return bins.map((b) => ({ ...b }));
}

export function computeBandEnergy(bins: GoertzelBin[], band: 'LOW' | 'HIGH'): number {
  return bins.filter((b) => b.band === band).reduce((s, b) => s + b.magSq, 0);
}

export function computeFrameRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Spectral flatness — low = tonal (horn), high = noisy (speech/broadband).
 * Geometric mean / arithmetic mean of bin magnitudes.
 */
export function computeSpectralFlatness(bins: GoertzelBin[], band: 'LOW' | 'HIGH'): number {
  const bandBins = bins.filter((b) => b.band === band);
  if (bandBins.length === 0) return 1;
  const logSum = bandBins.reduce((s, b) => s + Math.log(b.magSq + 1e-10), 0);
  const geoMean = Math.exp(logSum / bandBins.length);
  const arithMean = bandBins.reduce((s, b) => s + b.magSq, 0) / bandBins.length;
  return arithMean > 0 ? geoMean / arithMean : 1;
}

/**
 * Spectral centroid — "center of mass" of the spectrum.
 * Horn: centroid > 2200Hz (energy concentrated in high band)
 * Speech: centroid ~1500Hz (energy spread across formants)
 * This is the single most powerful horn discriminator.
 */
export function computeSpectralCentroid(bins: GoertzelBin[]): number {
  const totalMag = bins.reduce((s, b) => s + Math.sqrt(b.magSq), 0);
  if (totalMag <= 0) return 0;
  return bins.reduce((s, b) => s + b.freq * Math.sqrt(b.magSq), 0) / totalMag;
}

/**
 * Peak frequency — which bin has the highest energy.
 */
export function getPeakBin(bins: GoertzelBin[]): GoertzelBin {
  return bins.reduce((best, b) => (b.magSq > best.magSq ? b : best));
}
