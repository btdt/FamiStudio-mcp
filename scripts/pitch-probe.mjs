#!/usr/bin/env node
/**
 * Dev-only: check pitch detection against synthetic tones with known
 * frequencies, including an NES-style square wave whose strong harmonics are
 * what trip naive autocorrelation.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const core = await import(pathToFileURL(join(root, 'dist', 'core', 'index.js')).href);

const sampleRate = 44100;
// Names use FamiStudio's own numbering. Its value 49 is "C4" = 523.25 Hz, so
// 440 Hz is value 46 = "A3", and 65.41 Hz is "C1". The name<->frequency round
// trip at the bottom of this file is the authoritative check of that mapping.
const cases = [
  ['square C4', 523.2511, 'C4', 'square'],
  ['square E4', 659.2551, 'E4', 'square'],
  ['square G4', 783.9909, 'G4', 'square'],
  ['square C5', 1046.502, 'C5', 'square'],
  ['square C3', 261.6256, 'C3', 'square'],
  ['square A440', 440.0, 'A3', 'square'],
  ['sine C4', 523.2511, 'C4', 'sine'],
  ['pulse25 C4', 523.2511, 'C4', 'pulse25'],
  ['triangle C1', 65.4064, 'C1', 'triangle'],
];

let failures = 0;
for (const [label, frequency, expectedNote, waveform] of cases) {
  const frames = Math.round(sampleRate * 0.4);
  const buffer = new Float32Array(frames);
  const period = sampleRate / frequency;
  for (let i = 0; i < frames; i += 1) {
    const phase = (i % period) / period;
    let value;
    if (waveform === 'square') value = phase < 0.5 ? 1 : -1;
    else if (waveform === 'pulse25') value = phase < 0.25 ? 1 : -1;
    else if (waveform === 'sine') value = Math.sin(2 * Math.PI * phase);
    else value = 1 - 4 * Math.abs(phase - 0.5); // triangle
    buffer[i] = value * 0.5;
  }

  const window = 4096;
  const estimate = core.estimatePitch(buffer, 1000, window, sampleRate, {
    minFrequency: 40,
    maxFrequency: 4000,
  });
  const centsOff = estimate.frequency > 0 ? 1200 * Math.log2(estimate.frequency / frequency) : Infinity;
  const ok = estimate.note === expectedNote && Math.abs(centsOff) < 40;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(14)} -> ${estimate.note.padEnd(4)} ` +
      `${estimate.frequency.toFixed(2).padStart(9)} Hz (want ${frequency.toFixed(2).padStart(9)} = ${expectedNote}), ` +
      `${centsOff >= 0 ? '+' : ''}${centsOff.toFixed(1)} cents, conf ${estimate.confidence.toFixed(3)}`,
  );
}

// Every name must survive name -> value -> frequency -> name unchanged.
let roundTripFailures = 0;
for (const octave of [0, 1, 2, 3, 4, 5, 6, 7]) {
  for (let semitone = 0; semitone < 12; semitone += 1) {
    const name = `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][semitone]}${octave}`;
    let value;
    try {
      value = core.noteNameToValue(name);
    } catch {
      continue; // outside the FamiStudio note range
    }
    const frequency = core.valueToFrequency(value);
    const back = core.frequencyToNote(frequency);
    if (back.note !== name || Math.abs(back.cents) > 1) {
      roundTripFailures += 1;
      if (roundTripFailures <= 8) {
        console.log(
          `  FAIL round trip   ${name} (value ${value}, ${frequency.toFixed(2)} Hz) -> ${back.note} (${back.cents} cents)`,
        );
      }
    }
  }
}
console.log(
  `  ${roundTripFailures === 0 ? 'OK  ' : 'FAIL'} name<->frequency round trip over C0..B7` +
    (roundTripFailures > 0 ? `: ${roundTripFailures} mismatch(es)` : ''),
);
failures += roundTripFailures;

// Silence and noise must not produce a confident pitch.
const silence = new Float32Array(sampleRate / 4);
const silent = core.estimatePitch(silence, 0, 4096, sampleRate);
console.log(`  ${silent.frequency === 0 ? 'OK  ' : 'FAIL'} silence        -> frequency ${silent.frequency}`);
if (silent.frequency !== 0) failures += 1;

const noise = new Float32Array(sampleRate / 4);
for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 2 - 1) * 0.5;
const noisy = core.estimatePitch(noise, 0, 4096, sampleRate);
const noiseAcceptable = noisy.confidence < 0.6;
console.log(
  `  ${noiseAcceptable ? 'OK  ' : 'FAIL'} white noise    -> confidence ${noisy.confidence.toFixed(3)} (want < 0.6)`,
);
if (!noiseAcceptable) failures += 1;

console.log(`\n${failures === 0 ? 'pitch detection OK' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
