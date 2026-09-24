/**
 * Minimal RIFF/WAVE reader plus signal analysis helpers.
 *
 * No dependencies: this parses the RIFF chunks directly so that the MCP server
 * can report duration, peak level and detected pitch of a FamiStudio render
 * without shelling out to a media toolkit.
 */

/** Error raised when a file is not a readable PCM/float WAVE file. */
export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavError';
  }
}

/** Decoded WAVE data. */
export interface WavFile {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** `true` for IEEE float samples, `false` for integer PCM. */
  float: boolean;
  /** Number of frames (samples per channel). */
  frames: number;
  /** Interleaved samples normalized to -1..1, in file order. */
  samples: Float32Array;
}

/** Decode a WAVE file from a buffer. */
export function decodeWav(data: Buffer): WavFile {
  if (data.byteLength < 12) throw new WavError('File is too short to be a WAVE file.');
  if (data.toString('ascii', 0, 4) !== 'RIFF') throw new WavError('Missing RIFF header.');
  if (data.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('Not a WAVE file (missing "WAVE" form type).');

  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataChunk: Buffer | null = null;

  while (offset + 8 <= data.byteLength) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > data.byteLength) {
      // Tolerate truncated final chunks but keep whatever we already read.
      if (id === 'data' && body < data.byteLength) {
        dataChunk = data.subarray(body);
      }
      break;
    }

    if (id === 'fmt ') {
      fmt = {
        format: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        bitsPerSample: data.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataChunk = data.subarray(body, body + size);
    }

    offset = body + size + (size % 2); // chunks are word aligned
  }

  if (!fmt) throw new WavError('WAVE file has no "fmt " chunk.');
  if (!dataChunk) throw new WavError('WAVE file has no "data" chunk.');
  if (fmt.channels < 1) throw new WavError(`Invalid channel count ${fmt.channels}.`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frames = Math.floor(dataChunk.byteLength / (bytesPerSample * fmt.channels));
  const samples = new Float32Array(frames * fmt.channels);

  for (let i = 0; i < samples.length; i += 1) {
    const at = i * bytesPerSample;
    if (fmt.format === 3) {
      samples[i] = fmt.bitsPerSample === 64 ? dataChunk.readDoubleLE(at) : dataChunk.readFloatLE(at);
    } else {
      switch (fmt.bitsPerSample) {
        case 8:
          samples[i] = (dataChunk.readUInt8(at) - 128) / 128;
          break;
        case 16:
          samples[i] = dataChunk.readInt16LE(at) / 32768;
          break;
        case 24: {
          const raw = dataChunk.readUInt8(at) | (dataChunk.readUInt8(at + 1) << 8) | (dataChunk.readInt8(at + 2) << 16);
          samples[i] = raw / 8388608;
          break;
        }
        case 32:
          samples[i] = dataChunk.readInt32LE(at) / 2147483648;
          break;
        default:
          throw new WavError(`Unsupported bit depth ${fmt.bitsPerSample}.`);
      }
    }
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    float: fmt.format === 3,
    frames,
    samples,
  };
}

/** Summary of a decoded WAVE file. */
export interface WavAnalysis {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  durationSeconds: number;
  /** Peak absolute level, 0..1+. */
  peak: number;
  /** RMS level, 0..1. */
  rms: number;
  /** dBFS of the peak, or `-Infinity` for a silent file. */
  peakDbfs: number;
  /** First and last frame whose level exceeds -60 dBFS. */
  firstAudibleFrame: number;
  lastAudibleFrame: number;
  /** Duration between the first and last audible frame. */
  audibleSeconds: number;
  silent: boolean;
}

/** Compute level/duration statistics for one channel of a WAVE file. */
export function analyzeWav(wav: WavFile, channel = 0): WavAnalysis {
  if (channel < 0 || channel >= wav.channels) {
    throw new WavError(`Channel ${channel} requested but the file has ${wav.channels}.`);
  }
  const threshold = 0.001; // ~ -60 dBFS
  let peak = 0;
  let sumSquares = 0;
  let firstAudibleFrame = -1;
  let lastAudibleFrame = -1;

  for (let frame = 0; frame < wav.frames; frame += 1) {
    const value = wav.samples[frame * wav.channels + channel];
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
    if (magnitude > threshold) {
      if (firstAudibleFrame < 0) firstAudibleFrame = frame;
      lastAudibleFrame = frame;
    }
  }

  const rms = wav.frames > 0 ? Math.sqrt(sumSquares / wav.frames) : 0;
  return {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    frames: wav.frames,
    durationSeconds: wav.frames / wav.sampleRate,
    peak,
    rms,
    peakDbfs: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    firstAudibleFrame: firstAudibleFrame < 0 ? 0 : firstAudibleFrame,
    lastAudibleFrame: lastAudibleFrame < 0 ? 0 : lastAudibleFrame,
    audibleSeconds:
      firstAudibleFrame < 0 ? 0 : (lastAudibleFrame - firstAudibleFrame + 1) / wav.sampleRate,
    silent: peak <= threshold,
  };
}

/** Result of a monophonic pitch estimate over one segment. */
export interface PitchEstimate {
  /** Frequency in Hz, or 0 when no periodicity was found. */
  frequency: number;
  /** Nearest equal-tempered note name using FamiStudio's octave naming. */
  note: string;
  /** Cents deviation from that note. */
  cents: number;
  /** Normalized autocorrelation strength at the chosen lag, 0..1. */
  confidence: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Reference pitch: FamiStudio note value 49 (its "C4") sounds at this frequency. */
export const REFERENCE_FREQUENCY = 523.2511306011972;
/** Note value that {@link REFERENCE_FREQUENCY} corresponds to. */
export const REFERENCE_VALUE = 49;

/** Frequency a FamiStudio note value sounds at, in Hz. */
export function valueToFrequency(value: number, tuning = 440): number {
  // `tuning` only shifts the reference for non-standard A; FamiStudio's value 49
  // is A=440 tuning's C5.
  const tuningRatio = tuning / 440;
  return REFERENCE_FREQUENCY * tuningRatio * 2 ** ((value - REFERENCE_VALUE) / 12);
}

/**
 * Round a cent offset, collapsing `-0` to `0`.
 *
 * `Math.round` returns `-0` for a small negative residual, and `-0` is *not* `0`
 * under `Object.is` - so it fails strict comparisons and leaks a surprising value
 * out of the public API. Whether the residual lands at `-0` or `+0` depends on
 * the last bit of `Math.log2`, which varies between platforms: an exact note must
 * report plain `0` everywhere.
 */
function roundCents(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Convert a frequency to the FamiStudio-spelled note name plus cent offset.
 *
 * This is the exact inverse of {@link noteNameToValue} for the frequencies
 * FamiStudio renders: value `v` sounds at `523.2511 * 2 ** ((v - 49) / 12)`
 * because FamiStudio names note values one octave above standard pitch (its
 * "C4", value 49, is 523.25 Hz). Deriving the octave with the same
 * `octave = floor((value - 1) / 12)` relation keeps a spec's note names and the
 * analysed names in agreement.
 */
export function frequencyToNote(frequency: number): { note: string; cents: number } {
  if (frequency <= 0) return { note: '', cents: 0 };
  const exactValue = REFERENCE_VALUE + 12 * Math.log2(frequency / REFERENCE_FREQUENCY);
  const nearest = Math.round(exactValue);
  const cents = roundCents((exactValue - nearest) * 100);
  const octave = Math.floor((nearest - 1) / 12);
  const semitone = (((nearest - 1) % 12) + 12) % 12;
  return { note: `${NOTE_NAMES[semitone]}${octave}`, cents };
}

/**
 * Estimate the fundamental frequency of a segment.
 *
 * Uses normalized autocorrelation with an octave-error guard. Autocorrelation of
 * a periodic signal peaks at every multiple of the true period, so naively
 * taking the first local maximum reports harmonics (a third of the period ~ a
 * twelfth too high) and naively taking the global maximum can report a
 * subharmonic. The guard used here is the standard one: find the strongest peak
 * anywhere, then walk back to the *shortest* lag whose correlation is within
 * `octaveTolerance` of it, which is the fundamental.
 */
export function estimatePitch(
  samples: Float32Array,
  startFrame: number,
  frameCount: number,
  sampleRate: number,
  options: { minFrequency?: number; maxFrequency?: number; octaveTolerance?: number } = {},
): PitchEstimate {
  const minFrequency = options.minFrequency ?? 40;
  const maxFrequency = options.maxFrequency ?? 4000;
  const octaveTolerance = options.octaveTolerance ?? 0.9;
  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(Math.floor(sampleRate / minFrequency), Math.floor(frameCount / 2));

  const estimateEmpty: PitchEstimate = { frequency: 0, note: '', cents: 0, confidence: 0 };
  if (maxLag <= minLag + 2 || frameCount < 32) return estimateEmpty;

  const window = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    // Hann window keeps the correlation well behaved at the edges.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameCount - 1 || 1));
    window[i] = (samples[startFrame + i] ?? 0) * w;
  }

  let energy = 0;
  for (let i = 0; i < frameCount; i += 1) energy += window[i] * window[i];
  if (energy <= 1e-9) return estimateEmpty;

  const correlations = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    const count = frameCount - lag;
    for (let i = 0; i < count; i += 1) {
      const a = window[i];
      const b = window[i + lag];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    correlations[lag] = normA > 0 && normB > 0 ? sum / Math.sqrt(normA * normB) : 0;
  }

  // Strongest local maximum anywhere in the search range.
  let strongestLag = -1;
  let strongest = 0;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const value = correlations[lag];
    if (value <= 0) continue;
    if (value >= correlations[lag - 1] && value >= correlations[lag + 1] && value > strongest) {
      strongest = value;
      strongestLag = lag;
    }
  }
  if (strongestLag < 0) {
    strongestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (correlations[lag] > strongest) {
        strongest = correlations[lag];
        strongestLag = lag;
      }
    }
  }
  if (strongest < 0.3) return { ...estimateEmpty, confidence: Math.max(0, strongest) };

  // Walk back to the shortest lag that is still essentially as good, which is
  // the fundamental period rather than one of its multiples.
  let bestLag = strongestLag;
  for (let lag = minLag + 1; lag < strongestLag; lag += 1) {
    if (correlations[lag] < strongest * octaveTolerance) continue;
    if (correlations[lag] >= correlations[lag - 1] && correlations[lag] >= correlations[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  const bestValue = correlations[bestLag];

  // Parabolic interpolation around the integer lag for sub-sample accuracy.
  const y0 = correlations[bestLag - 1] ?? bestValue;
  const y1 = bestValue;
  const y2 = correlations[bestLag + 1] ?? bestValue;
  const denominator = y0 - 2 * y1 + y2;
  const delta = denominator !== 0 ? (0.5 * (y0 - y2)) / denominator : 0;
  const refinedLag = bestLag + Math.max(-1, Math.min(1, delta));
  const frequency = sampleRate / refinedLag;
  const { note, cents } = frequencyToNote(frequency);
  return { frequency, note, cents, confidence: bestValue };
}

/** One detected note segment. */
export interface DetectedSegment {
  startFrame: number;
  startSeconds: number;
  endFrame: number;
  endSeconds: number;
  frequency: number;
  note: string;
  cents: number;
  confidence: number;
}

/**
 * Segment a channel into stable-pitch regions and report the pitch of each.
 *
 * The input is expected to be a monophonic render (e.g. one channel exported
 * with `-wav-export-separate-channels`).
 */
export function detectPitches(
  wav: WavFile,
  options: {
    channel?: number;
    minFrequency?: number;
    maxFrequency?: number;
    /** Analysis window in seconds. */
    windowSeconds?: number;
    /** Hop between windows in seconds. */
    hopSeconds?: number;
    /** Minimum confidence to accept a window. */
    minConfidence?: number;
    /** Merge neighbouring segments closer than this many cents. */
    mergeCents?: number;
  } = {},
): DetectedSegment[] {
  const channel = options.channel ?? 0;
  const minConfidence = options.minConfidence ?? 0.5;
  const mergeCents = options.mergeCents ?? 60;
  const windowFrames = Math.max(256, Math.round((options.windowSeconds ?? 0.08) * wav.sampleRate));
  const hopFrames = Math.max(64, Math.round((options.hopSeconds ?? 0.02) * wav.sampleRate));

  const monoSamples = new Float32Array(wav.frames);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    monoSamples[frame] = wav.samples[frame * wav.channels + channel];
  }

  const raw: DetectedSegment[] = [];
  for (let start = 0; start + windowFrames <= wav.frames; start += hopFrames) {
    const estimate = estimatePitch(monoSamples, start, windowFrames, wav.sampleRate, options);
    if (estimate.frequency <= 0 || estimate.confidence < minConfidence) continue;
    const frameValue = estimate.frequency;
    if (frameValue <= 0) continue;
    raw.push({
      startFrame: start,
      startSeconds: start / wav.sampleRate,
      endFrame: start + windowFrames,
      endSeconds: (start + windowFrames) / wav.sampleRate,
      frequency: estimate.frequency,
      note: estimate.note,
      cents: estimate.cents,
      confidence: estimate.confidence,
    });
  }

  // Merge consecutive windows reporting the same note.
  const merged: DetectedSegment[] = [];
  for (const segment of raw) {
    const previous = merged[merged.length - 1];
    const sameNote =
      previous &&
      previous.note === segment.note &&
      Math.abs(previous.cents - segment.cents) <= mergeCents &&
      segment.startFrame - previous.endFrame <= hopFrames;
    if (sameNote) {
      const total = previous.endFrame - previous.startFrame + (segment.endFrame - segment.startFrame);
      previous.frequency =
        (previous.frequency * (previous.endFrame - previous.startFrame) +
          segment.frequency * (segment.endFrame - segment.startFrame)) /
        total;
      previous.endFrame = segment.endFrame;
      previous.endSeconds = segment.endSeconds;
      previous.cents = roundCents(
        (previous.cents * (total - (segment.endFrame - segment.startFrame)) +
          segment.cents * (segment.endFrame - segment.startFrame)) /
          total,
      );
      previous.confidence = Math.max(previous.confidence, segment.confidence);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}
