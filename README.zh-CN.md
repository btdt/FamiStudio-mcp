# famistudio-mcp

[English](README.md) | **简体中文**

> **面向 [FamiStudio](https://famistudio.org) 的 Model Context Protocol 服务器。**
> 用纯 JSON 生成、检查、校验并渲染 NES `.fms` 工程 —— 无需 GUI，无需手工处理二进制格式。

```
compile_song_spec  ──▶  create_fms  ──▶  validate_fms  ──▶  verify_roundtrip  ──▶  export_audio
   JSON 音符            .fms 文件         不变量校验        FamiStudio 认可         .wav
```

FamiStudio 的命令行可以*读取* `.fms`、`.txt`、`.ftm` 和 `.nsf`，但没有 `fms-export`
命令 —— 直接用脚本*产出* `.fms`，写二进制格式是唯一可行的方法。`famistudio-mcp`
按照与 FamiStudio 4.5.x 完全相同的方式写出这些字节，在写盘前校验每一条加载不变量，
并把结果送回 FamiStudio 来证明它确实可用。

---

## 快速开始

无需安装任何东西 —— 让 MCP 宿主直接运行已发布的包即可：

```jsonc
// Claude Desktop / Cursor / 任何通过启动命令来接入的 MCP 客户端
{
  "mcpServers": {
    "famistudio": {
      "command": "npx",
      "args": ["-y", "famistudio-mcp"],
      // 可选兜底配置，详见下文「生成文件写到哪里」。如果你的客户端支持弹窗询问，
      // 你会被问一次，并可以按工程分别指定目录。
      "env": { "FAMISTUDIO_MCP_OUTDIR": "/absolute/path/to/your/audio-work" }
    }
  }
}
```

Bun 用户可以把命令换掉：

```jsonc
{ "command": "bunx", "args": ["famistudio-mcp"] }
```

然后直接向你的 agent 提需求：

> 帮我做一个 2 秒的贪吃蛇移动音效：明亮的 Square1 琶音，下方垫一个低音 Triangle 脉冲，
> 再加一个噪声短促音。写到 `D:/Game Assets/snake_move.fms`，验证 FamiStudio 能加载，
> 并在旁边渲染一个 44100 Hz 的 WAV。

### 不使用 MCP 宿主

同一套引擎也提供 CLI，适合脚本和 CI：

```bash
npx -y famistudio-mcp-cli info
npx -y famistudio-mcp-cli compile examples/snake-move.json -o out/snake.fms
npx -y famistudio-mcp-cli verify out/snake.fms
npx -y famistudio-mcp-cli export out/snake.fms out/snake.wav --rate 44100
npx -y famistudio-mcp-cli analyze out/snake.wav --pitch
```

### 作为库使用

```bash
npm install famistudio-mcp
```

```ts
import { compileSongSpec, writeFms, readProject } from 'famistudio-mcp/core';
import { writeFile } from 'node:fs/promises';

const { project } = compileSongSpec({
  name: 'Blip',
  patternLength: 16,
  channels: [
    { channel: 'Square1', notes: [{ time: 0, note: 'C4', duration: 8 }, { time: 8, note: 'stop' }] },
    { channel: 'Triangle', notes: [{ time: 0, note: 'C1', duration: 16 }] },
  ],
});

await writeFile('blip.fms', writeFms(project));
console.log(readProject(writeFms(project)).songs[0].name); // "Blip"
```

---

## 工具

| 工具 | 用途 |
|---|---|
| `famistudio_info` | 定位 FamiStudio 可执行文件，报告其版本以及允许读写的根目录 |
| `compute_ticks` | 在秒与 tick 之间换算（`秒 = tick / 60.0988`，NTSC） |
| `compile_song_spec` | 把 JSON 歌曲 spec 编译成完整工程对象，可选择写成 `.fms` |
| `create_fms` | 同上，但一定会写出文件 |
| `validate_fms` | 检查 FamiStudio 加载所需的每一条不变量并列出问题 |
| `read_fms` | 把 `.fms` 解码为结构化 JSON（歌曲、声道、pattern、音符、包络） |
| `summarize_fms` | 生成人类可读的工程清单，含每个 pattern 的音符明细 |
| `diff_fms` | 两个工程的结构化差异对比 |
| `verify_roundtrip` | 通过 FamiStudio 往返验证：文本导出 + WAV 渲染，检查字段失步与静音 |
| `export_audio` | 通过 FamiStudio CLI 渲染 WAV / MP3 / OGG |
| `export_text` | FamiStudio 文本、FamiTracker 文本，或声音引擎汇编 |
| `analyze_audio` | WAV 时长、峰值/RMS、静音与音高检测 |
| `run_famistudio` | 逃生通道：运行任意其他 FamiStudio CLI 命令（NSF、ROM 等） |

### 推荐的 agent 工作流

1. `compute_ticks` —— 确定你想要的音效需要多少 tick。
2. `compile_song_spec` —— 构建音符。
3. `create_fms` —— 写出文件（或把返回的 `project` 直接传给下一步）。
4. `verify_roundtrip` —— 证明 FamiStudio 能加载并产出音频。
5. `export_audio` —— 为你的游戏渲染 `.wav`。
6. `analyze_audio` —— 确认时长与音高，例如配合 `separateChannels`。

`verify_roundtrip` 的 `expectDurationSeconds` 比较的是**可听长度**（第一个到最后一个
有声音的帧），而不是 pattern 长度，所以只在你确知声音何时结束时才传它。

---

## 歌曲 spec

一个 spec 就是一个工程，包含一首或多首歌曲，每首歌曲由各声道的音符轨组成。

```jsonc
{
  "name": "Snake Move",
  "author": "you",
  "patternLength": 32,        // 每个 pattern 的 tick 数（默认 128）
  "noteLength": 4,            // 默认音符长度，单位为 tick（默认 8）
  "instruments": [
    { "name": "Blip", "volume": [15, 14, 12, 10, 8, 6, 4, 2, 0], "dutyCycle": [2] }
  ],
  "channels": [
    {
      "channel": "Square1",
      "notes": [
        { "time": 0, "note": "C4", "duration": 4 },
        { "time": 4, "note": "E4", "duration": 4, "volume": 12 },
        { "time": 8, "note": "G4", "duration": 8, "effects": { "dutyCycle": 1, "vibrato": 194 } },
        { "time": 16, "note": "stop" }
      ]
    },
    { "channel": "Triangle", "notes": [{ "time": 0, "note": "C1", "duration": 16 }] },
    { "channel": "Noise",    "notes": [["C4", null, null, null]] },
    { "channel": "Square2",  "patterns": [ /* pattern 0 */, /* pattern 1 */ ] }
  ]
}
```

声道名接受别名：`Square1`/`sq1`/`pulse1`、`Square2`/`sq2`/`pulse2`、`Triangle`/`tri`、
`Noise`、`DPCM`/`dmc`，或索引 `0..4`。省略的声道会以空声道写出，因为 FamiStudio
要求五个声道齐全。

### 两种写音符的方式

**绝对时间** —— 音符对象列表；`time` 可以省略，表示紧接上一个音符继续：

```jsonc
"notes": [ { "time": 0, "note": "C4", "duration": 8 }, { "time": 8, "note": "E4" } ]
```

**Tick 网格** —— 每个 tick 一项；每一项可以是音名、原始音符号、音符对象、它们的数组
（和弦），或 `null` 表示空单元格。没有显式 `duration` 的音符会一直延续到下一个有内容的
单元格；若之后什么都没有，则使用 `noteLength`：

```jsonc
"notes": [ "C4", null, null, null, ["E4", "G4"], null, null, null ]
```

可接受的音名写法：音名（`"C4"`、`"F#3"`、`"Bb2"`）、`"stop"`/`0`、`"release"`/`128`，
以及 C0..B7 对应的原始数值 `1..96`。

### 单音符效果

| 键 | 取值范围 | 说明 |
|---|---|---|
| `volume` | 0..15 | 音量覆盖 |
| `vibrato` | 打包值 | `speed << 4 \| depth`（speed 0..12，depth 0..15） |
| `speed` | 0..255 | Fxx |
| `finePitch` | -128..127 | Pxx |
| `dutyCycle` | 0..3 | Vxx，仅方波声道 |
| `noteDelay` | 0..31 | Gxx |
| `cutDelay` | 0..31 | Sxx |
| `fdsModSpeed` / `fdsModDepth` | 0..4095 / 0..63 | 仅扩展音源 |
| `volumeSlide` | 0..15 | 必须同时设置 `volume` |
| `dmcCounter` | 0..127 | DPCM 声道 |
| `phaseReset` | 0..1 | |
| `envPeriod` | 0..65535 | |

### 音高约定（重要）

FamiStudio 的音名比标准音高**高一个八度**：它的 `"C4"` 发声在 523.25 Hz。除此之外，
由于硬件分频器，NES 的 **Triangle 声道比其音符号低一个八度**。实际影响：

- 写旋律时，比你从 tracker 里听到的音高低一个八度去写。
- Triangle 低音线条**不需要**再额外移低八度。
- `analyze_audio` 使用同一套命名体系，所以 spec 里的 `"C4"` 会被识别为 `C4`。

### 时值换算

在均匀 groove 下，一个 tick 等于一帧，因此 `秒 = tick / 帧率`
（NTSC 60.0988，PAL 50.007）。所以 `songLength` 为 1、`patternLength` 为 128 时，
大约相当于 2.13 秒。

---

## 生成文件写到哪里

这件事不由服务器决定 —— 由你或你的 agent 决定。以下来源按优先级从高到低，第一个命中的生效：

| # | 来源 | 说明 |
|---|---|---|
| 1 | **工具调用中的绝对路径** | `outputPath`，或 `verify_roundtrip` 的 `workDir` |
| 2 | 本次会话记住的选择 | 由同一会话中更早的那次询问确定 |
| 3 | **elicitation 弹窗询问** | 只问一次，预填 `<工作区>/audio/famistudio` |
| 4 | `FAMISTUDIO_MCP_OUTDIR` / `_WORKSPACE` | 当你拒绝选择，或客户端完全无法弹窗时使用 |
| 5 | `<工作区>/audio/famistudio` | 既没有 env 也无法弹窗时 |
| 6 | `<tmp>/famistudio-mcp` | 最终兜底 |

**相对路径**会落在当前输出目录内，且不能用 `..` 爬出去。**绝对路径**按原样使用 ——
指定路径就是你的决定，服务器不会替你二次判断。读取仍然受管控：配置根目录之外的
绝对读路径会被拒绝。

**不会写任何文件来记住这次选择** —— 它只存在于本次会话。当你回答了弹窗后，工具结果会
带上一段提示，请你的 agent 把该目录记录到所在工作区的 `AGENTS.md`（或 `CLAUDE.md`）中，
并在之后每次调用时显式传入。这样既能让选择跨会话保留，服务器又完全不去碰你的文件。

工作区识别优先使用 MCP 的 `roots` 能力（如果你的客户端提供的话），否则在服务器的
工作目录看起来确实像一个工程目录时才使用它。

## 配置

| 变量 | 含义 |
|---|---|
| `FAMISTUDIO_EXE` | FamiStudio 可执行文件的完整路径。否则会探测常见安装位置和 `PATH`，所以通常你**不需要**设置它 —— 只有便携版、非标准安装位置，或需要在多个版本中钉住某一个时才需要。 |
| `FAMISTUDIO_MCP_OUTDIR` | 输出目录。当你拒绝弹窗时使用（以及客户端完全无法弹窗时）。默认 `<tmp>/famistudio-mcp`。 |
| `FAMISTUDIO_MCP_READDIRS` | 服务器可以额外读取工程文件的目录。 |
| `FAMISTUDIO_MCP_WORKSPACE` | 用一个目录同时表示上面两项的简写。 |

多个目录之间：Windows 用 `;`（或 `,`）分隔，POSIX 用 `;` / `:` 分隔。

只有 `export_audio`、`export_text`、`verify_roundtrip`、`run_famistudio` 以及
`famistudio_info` 的版本行需要 FamiStudio 本体。生成、读取、校验和对比工程都不需要它。

---

## 兼容性

- **读写** FamiStudio **4.5.x** 的工程文件：序列化版本 **19**。
- **不支持**读取更早的文件（版本 10–18）；请在 FamiStudio 中打开并另存以升级它们。
  这不影响生成功能。
- 仅支持纯 **2A03**（无扩展音源：VRC6、FDS、N163、S5B、VRC7、EPSM）。已有工程中的
  DPCM 采样会逐字节保留，但无法通过本工具创作。
- 容器按设计使用 `zlib` 原始 deflate，因此重新编码后的容器可能与原文件逐字节不同，
  而解压后的载荷完全一致。

---

## 文档

- [`docs/FMS_FORMAT.md`](docs/FMS_FORMAT.md) —— 本实现所遵循的 `.fms` 容器与载荷布局，
  源自 FamiStudio 4.5.x 源码。
- [`AGENTS.md`](AGENTS.md) —— 构建/测试/验证命令、架构说明，以及不可破坏的格式不变量。
  面向编码 agent 与贡献者。
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 如何参与贡献。
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本历史。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。

FamiStudio 本身是 Mathieu Gauthier-Pilote 的独立项目，采用 MIT 许可；本服务器只读写它的
文件格式并驱动它的命令行。
