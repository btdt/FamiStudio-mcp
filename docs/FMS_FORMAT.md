# The FamiStudio `.fms` format, as implemented here

This documents exactly what `src/core/fms.ts` writes and reads: FamiStudio **4.5.x**
project files, serialization version **19**. It is derived from the FamiStudio 4.5.x
sources:

| Source file | Contents |
|---|---|
| `Source/Project/Project.cs` | `Project.Serialize` plus the twelve export-config classes |
| `Source/Project/ProjectBuffer.cs` | Serialization primitives |
| `Source/Project/Instrument.cs`, `Envelope.cs` | Instrument and envelope layout |
| `Source/Project/Song.cs`, `Channel.cs`, `Pattern.cs`, `Note.cs` | Song and note layout |
| `Source/IO/ProjectFile.cs`, `Source/Utils/Compression.cs` | Container header and deflate |

---

## 1. Container

```
┌────────────┬─────────────┬──────────────────────┬────────────────────────────────┐
│ "FMS!"     │ version u32 │ uncompressedSize u32 │ raw DEFLATE (RFC 1951) payload │
│ 4 bytes    │ 4 bytes     │ 4 bytes              │ rest of file                   │
└────────────┴─────────────┴──────────────────────┴────────────────────────────────┘
```

- Magic `0x21534D46` (ASCII `"FMS!"`), little-endian.
- `version` is `19` for 4.5.x. A file whose version exceeds the reader's is rejected.
- "Raw" DEFLATE means **no zlib header and no checksum**: `zlib.deflateRawSync` /
  `inflateRawSync` in Node, or `zlib.compress(data, 9, wbits=-15)` in Python.
- FamiStudio validates `uncompressedSize` after decompressing, so it must be correct.

> **Note on byte identity.** Different DEFLATE encoders (and .NET's
> `DeflateStream` with `CompressionLevel.Optimal`) produce different bytes for the same
> input. Re-encoding a project therefore reproduces the *payload* exactly, not
> necessarily the container. This library's tests compare payloads.

---

## 2. Primitives (`ProjectBuffer`)

All little-endian, no variable-length integers.

| C# type | Bytes | Encoding |
|---|---|---|
| `bool` | 1 | 0 / 1 |
| `byte`, `sbyte` | 1 | raw |
| `short`, `ushort` | 2 | little-endian |
| `int`, `uint` | 4 | little-endian; object references are `int` (`-1` = null) |
| `long`, `ulong` | 8 | little-endian |
| `float` | 4 | IEEE 754 |
| `Color` | 4 | ARGB as `uint` (`0xFFRRGGBB`) — exceeds `int32`, so write unsigned |
| `string` | 4+ | `-1` for null/empty, else `u32` **byte length** + UTF-16LE bytes |
| `byte[]` | 4+ | `u32` length + raw bytes (also for `sbyte[]`) |
| `short[]`, `int[]` | 4+ | `-1` for null, else `u32` count + elements |

Two asymmetries in the original code are preserved here:

- `ProjectLoadBuffer.Serialize(ref int[] dest)` advances `idx` by `sizeof(int)` per
  element while reading `ToInt16` — harmless in practice because only `null`/`-1`
  arrays (`groove`) are affected, but it means a non-null `int[]` is read inconsistently
  by FamiStudio. This library writes `int[]` as documented above.
- `ProjectBuffer.Serialize(ref int i, bool id = false)` takes an unused `id` flag; only
  the CRC buffer's override gives it meaning.

---

## 3. Payload layout (version 19)

Fields are in this exact order — there are no tags or counts to resynchronize on, so a
single wrong width corrupts everything after it.

### 3.1 Header and metadata

| # | Field | Type |
|---|---|---|
| 1 | `nextUniqueId` | int — must exceed every object id |
| 2 | `sortSongs`, `sortInstruments`, `sortSamples`, `sortArpeggios` | bool ×4 |
| 3 | `name`, `author`, `copyright` | string ×3 |
| 4 | `expansionMask` | int (0 = plain 2A03) |
| 5 | `expansionNumN163Channels` | int |
| 6 | `tempoMode` | int (0 = FamiStudio, 1 = FamiTracker) |
| 7 | `pal` | bool |

### 3.2 Twelve export configs

Order matters: the last four are **Music, Sfx, Music, Sfx** — interleaved, not grouped.

1. `AudioExportConfig` — `songId`(-1), `format`, `samplerate`, `bitRate`, `loopMode`
   (string ×4), `loopCount`(1), `duration`(120), `delay`(0) (int ×3), `separateFiles`,
   `separateIntro`, `stereo` (bool ×3), `channelCount` + channels
2. `VideoExportConfig` — `songId`, 5 × string, `loopCount`, `delay`, `oscColumns`(-1),
   `oscWindow`(2), `oscThickness`(2) (int ×3), 3 × string, `pianoRollRows`(-1),
   `pianoRollPerspective` (string), `overlayRegisters`, `stereo` (bool ×2),
   `channelCount` + channels
3. `NsfExportConfig` — 5 × string, `songCount` + songs
4. `RomFdsExportConfig` — 4 × string, `songCount` + songs
5. `MidiExportConfig` — `songId`, `volumeVelocity`(true), `slidesAsPitch`(true),
   `pitchWheelRange`(24), `mode`, `instCount` + instruments
6. `VgmExportConfig` — `songId`, 7 × string, `smoothLoop`(true)
7. `FamiStudioTextExportConfig` — `deleteUnusedData`, `songCount` + songs
8. `FamiTrackerTextExportConfig` — `songCount` + songs
9. `MusicCodeExportConfig` (FamiStudio) — `format`, `separate`, `songName`, `dmcName`,
   `dmcExportMode`, `unusedMappings`, `songListInclude`, `songCount` + songs
10. `SfxExportConfig` (FamiStudio) — `format`, `mode`, `include`, `songCount` + songs
11. `MusicCodeExportConfig` (FamiTone2) — as 9
12. `SfxExportConfig` (FamiTone2) — as 10

Where a "channel" entry is `songId`, `channelType`, `enabled` (bool), `panning`,
`transpose`, `trigger`, and a "song" entry is `songId`, `enabled` (bool).

**Symptom of getting this order wrong:** `tuning = -1`, `songs = 0`, `VolumeDb = NaN`
in FamiStudio's text export.

### 3.3 Settings, folders, mixer

| Field | Type |
|---|---|
| `tuning` | int (440) |
| `folderCount` + folders | each `type`, `name`, `expanded` |
| `soundEngineUsesExtendedInstruments`, `...ExtendedDpcm`, `...BankSwitching` | bool ×3 |
| `overrideBassCutoffHz` | bool; if true, `bassCutoffHz` (int) follows |
| `overrideMask` | int; one `ExpansionMixerSettings` per set bit (`i16` ×5) |

`allowMixerOverride` is only serialized for undo/redo buffers and is never written to a
file.

### 3.4 DPCM samples

`count` (int), then per sample:

`id`, `name`, `sourceDataIsWav` (bool), source data (`sampleRate` int + `short[]`, or
`byte[]`), `color`, `bank`, `folderName`, `sampleRate`, `previewRate`, `volumeAdjust`,
`paddingMode` (int ×4), `reverseBits`, `trimZeroVolume`, `palProcessing` (bool ×3), four
`SampleVolumePair` (`int` sample + **`float`** volume), `sourceFilename`,
`finePitch` (float), `dmcInitialValueDiv2` (int).

This library does not interpret this payload: it captures the raw bytes on read and
writes them back verbatim, so projects containing DPCM samples round-trip losslessly
without reimplementing the DPCM pipeline.

### 3.5 Instruments

`count` (int), then per instrument:

| Field | Type |
|---|---|
| `id` | int |
| `name` | string |
| `color` | uint |
| `expansion` | int (0 for 2A03) |
| `envelopeMask` | **ushort** |
| one `Envelope` per set bit, in bit order | see below |
| `folderName` | string |
| `mappingCount` + DPCM mappings | v15+; mapping notes (`int` ×N) then mappings (`sample` ref, `loop` bool, `pitch` int, `overrideDmcInitialValue` bool, `dmcInitialValueDiv2` int) |

`Envelope`: `length` (int), `loop` (int, `-1` = none), `release` (int, `-1` = none),
`relative` (bool), `values` (**`sbyte[]`, always 256 entries**).

Three rules that are easy to break:

1. **A regular instrument must set bits 0–3** (`0x000F`) and carry all four envelopes.
   FamiStudio's DEBUG build asserts on load; the release GUI dereferences the missing
   envelope and crashes. Empty envelopes are still required — the text export simply
   omits them.
2. **`mappingCount` must always be written** (write `0` when there are none). Omitting
   it makes FamiStudio read the next instrument's `id` as a mapping count.
3. **`values` is always 256 bytes.** FamiStudio does not zero the slots past `length`;
   its defaults put `15,14,…,1,0` there, so a re-encode that pads with zeroes differs
   from the original payload (and feeds FamiStudio different data). This library keeps
   the full array as read.

### 3.6 Arpeggios

`count` (int), then per arpeggio: `id`, `name`, `color`, `folderName`, `Envelope`.

### 3.7 Songs

`count` (int), then per song:

| Field | Type |
|---|---|
| `id` | int |
| `patternLength` | int (128) |
| `songLength` | int |
| `beatLength` | int (32) |
| `name` | string |
| `famitrackerTempo`, `famitrackerSpeed` | int ×2 (placeholders in FamiStudio tempo) |
| `color` | uint |
| `loopPoint`, `noteLength` | int ×2 |
| `groove` | `int[]` |
| `groovePaddingMode` | int (0 Beginning, 1 Middle, 2 End) |
| `patternCustomSettings` | exactly `songLength` entries: `useCustomSettings` (bool), `patternLength`, `noteLength`, `beatLength` (int ×3), `groove` (`int[]`), `groovePaddingMode` (int) |
| `folderName` | string |
| 5 × channel | Square1, Square2, Triangle, Noise, DPCM in that order |

Per channel: `song` (ref), `patternCount` (int), `type` (int), then each pattern, then
**exactly 256** `patternInstances` ints (`-1` for unused slots).

Per pattern: `id`, `name`, `channelType`, `color`, `song` (ref), `notesCount` (int),
then each note as a `short` time followed by the note body.

### 3.8 Note bodies

```
value:  u8     # 0 = stop, 1..0x60 = C0..B7, 0x80 = release, 0xFF = empty
flags:  u8     # bit 0 = no-attack
if musical (value not in {0, 0x80, 0xFF}):
  slide: u8
  instrument: int (ref, -1 = none)
if musical:
  duration: u16
  release:  u16
effectMask: u16
# one value per set bit, each at ITS OWN width:
#   bit 0  volume        u8
#   bit 1  vibrato       u8   (written when either vibrato bit is set; speed<<4 | depth)
#   bit 2  vibrato depth (no separate value)
#   bit 3  finePitch     sbyte
#   bit 4  speed         u8
#   bit 5  fdsModDepth   u8
#   bit 6  fdsModSpeed   ushort
#   bit 7  dutyCycle     u8
#   bit 8  noteDelay     u8
#   bit 9  cutDelay      u8
#   bit 10 volumeSlide   u8   (only when bit 0 is also set)
#   bit 11 dmcCounter    u8
#   bit 12 phaseReset    u8
#   bit 13 envPeriod     ushort
arpeggio: int (ref, -1 = none)
```

**Bit indices do not follow the serialization order.** `Note.EffectFdsModSpeed` is 6 and
`Note.EffectDutyCycle` is 7, while in the value stream `speed` (bit 4) precedes
`finePitch` (bit 3) and `fdsModSpeed` (bit 6) precedes `fdsModDepth` (bit 5). Getting
either order wrong desynchronizes the stream from that note onward.

Also note that effect values are **not `int`**: each is written by passing the underlying
C# field to an overloaded `Serialize`, so `byte`, `sbyte` and `ushort` fields produce
1- or 2-byte writes. Writing 4 bytes makes FamiStudio report "Project file appears to be
corrupted".

---

## 4. Timing

In FamiStudio tempo mode with a **uniform** groove, `ShouldAdvanceSong` is always true,
so the play head advances one tick per frame:

```
seconds ≈ totalTicks / frameRate      totalTicks = patternLength × songLength
frameRate = 60.0988118623484 (NTSC) | 50.0069768347802 (PAL)
```

Non-uniform grooves (e.g. `12-6-6`) insert padding frames and change the tick duration.

---

## 5. Note value ↔ frequency

FamiStudio spells note values one octave above standard pitch:

```
value 49  = "C4" = 523.2511 Hz      (standard C5)
value 46  = "A3" = 440 Hz           (standard A4)
value  1  = "C0"
value 96  = "B7"

frequency(value) = 523.2511306011972 * 2 ** ((value - 49) / 12)
value(frequency) = 49 + 12 * log2(frequency / 523.2511306011972)
```

FamiStudio's piano-roll naming counts notes per octave from C, so octave is
`floor((value - 1) / 12)` and the semitone is `(value - 1) % 12`. The NES Triangle
channel renders the same note value one octave lower than Square because of the
hardware frequency divider.

---

## 6. Verifying a generated file

1. **Payload identity.** Decode and re-encode a real project; the decompressed payload
   must match byte for byte (`npm run oracle`).
2. **FamiStudio agrees.** `FamiStudio in.fms famistudio-txt-export out.txt` must succeed
   and the text must contain sane properties — `Tuning="-1"` or `VolumeDb="NaN"` means
   the field order is wrong.
3. **It renders.** `FamiStudio in.fms wav-export out.wav -wav-export-rate:44100` must
   produce audio of the expected length and level, not silence.
4. **The pitches are right.** Export one channel
   (`-wav-export-separate-channels`) and check the detected pitches against the spec;
   FamiStudio can also dump an emulator register trace via `unit-test` on a DEBUG build,
   which is the most direct way to confirm exact pitch and timing.
