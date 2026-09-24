/**
 * FamiStudio per-note effects (`Note.EffectXxx`).
 *
 * Only these fourteen slots exist in FamiStudio 4.5.x; `effectMask` bit `n`
 * corresponds to `EFFECT_ORDER[n]`.
 */

/**
 * Effect slot names.
 *
 * This is the *serialization* order used by `Note.Serialize`, which is NOT the
 * numeric order of FamiStudio's `Note.EffectXxx` constants (see
 * {@link EffectBit}). Keeping both orders explicit prevents the two from being
 * confused - that mistake desynchronizes the byte stream.
 *
 * Reference (`Note.cs`): volume 0, vibratoSpeed 1, vibratoDepth 2, finePitch 3,
 * speed 4, fdsModDepth 5, fdsModSpeed 6, dutyCycle 7, noteDelay 8, cutDelay 9,
 * volumeSlide 10, deltaCounter 11, phaseReset 12, envelopePeriod 13.
 */
export const EFFECT_ORDER = [
  'volume',
  'vibrato',
  'speed',
  'finePitch',
  'fdsModSpeed',
  'fdsModDepth',
  'dutyCycle',
  'noteDelay',
  'cutDelay',
  'volumeSlide',
  'dmcCounter',
  'phaseReset',
  'envPeriod',
] as const;

export type EffectName = (typeof EFFECT_ORDER)[number];

/** `effectMask` bit index of every effect (`Note.EffectXxx`). */
export const EffectBit: Record<EffectName, number> = {
  volume: 0,
  vibrato: 1, // covers both vibrato bits 1 and 2
  speed: 4,
  finePitch: 3,
  fdsModDepth: 5,
  fdsModSpeed: 6,
  dutyCycle: 7,
  noteDelay: 8,
  cutDelay: 9,
  volumeSlide: 10,
  dmcCounter: 11,
  phaseReset: 12,
  envPeriod: 13,
};

/**
 * `Note.EffectVibratoMask` - vibrato occupies two adjacent bits.
 *
 * FamiStudio sets both bits when a vibrato effect exists, so the mask is
 * emitted with both bits whenever `effects.vibrato` is present.
 */
export const VIBRATO_BITS = [1, 2] as const;
