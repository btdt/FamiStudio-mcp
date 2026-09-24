#!/usr/bin/env node
/**
 * MCP protocol smoke test.
 *
 * Spawns the built server as a child process and drives it over stdio with real
 * JSON-RPC frames, exactly as an MCP host would. This is the test that proves
 * the server is usable via `npx famistudio-mcp`, independent of any host.
 *
 *   node test/mcp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const serverPath = join(root, 'dist', 'index.js');

/** A minimal MCP client speaking newline-delimited JSON-RPC over stdio. */
class StdioClient {
  constructor(child, workDir, options = {}) {
    this.child = child;
    this.workDir = workDir;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    /** Requests the server sent us (roots/list, elicitation/create, ...). */
    this.serverRequests = [];
    /** Queued `elicitation/create` results; the last one is reused when exhausted. */
    this.elicitationAnswers = options.elicitationAnswers ?? [];
    /** What `roots/list` answers with. */
    this.roots = options.roots ?? [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
  }

  /** Answer a server -> client request. */
  #onServerRequest(message) {
    this.serverRequests.push(message);
    let result;
    if (message.method === 'roots/list') {
      result = { roots: this.roots };
    } else if (message.method === 'elicitation/create') {
      // Repeat the last answer so a cached decision is not mistaken for a re-ask.
      if (this.elicitationAnswers.length > 1) result = this.elicitationAnswers.shift();
      else result = this.elicitationAnswers[0] ?? { action: 'decline' };
    } else {
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `unsupported: ${message.method}` },
        })}\n`,
      );
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }

  /** How many times the server asked for an elicitation. */
  elicitationCount() {
    return this.serverRequests.filter((request) => request.method === 'elicitation/create').length;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`Server wrote a non-JSON line to stdout: ${line.slice(0, 200)}`);
      }
      if (message.method) {
        this.#onServerRequest(message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending(message);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for ${method}`));
      }, 240_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) rejectPromise(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolvePromise(message.result);
      });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
}

/** Read the concatenated text of a tool result. */
const textOf = (result) => (result.content ?? []).map((part) => part.text ?? '').join('\n');

/**
 * Environment with no famistudio-mcp configuration at all, so the
 * output-directory resolution has to fall back to prompts and defaults.
 */
function bareEnv() {
  const env = { ...process.env };
  for (const key of ['FAMISTUDIO_MCP_OUTDIR', 'FAMISTUDIO_MCP_WORKSPACE', 'FAMISTUDIO_MCP_READDIRS']) {
    delete env[key];
  }
  return env;
}

async function startServer(options = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'famistudio-mcp-test-'));
  const child = spawn(process.execPath, [serverPath], {
    cwd: options.cwd ?? root,
    env: options.bare ? bareEnv() : { ...bareEnv(), FAMISTUDIO_MCP_OUTDIR: options.outDir ?? workDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new StdioClient(child, workDir, options);
  const initialize = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: options.capabilities ?? {},
    clientInfo: { name: 'famistudio-mcp-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized', {});
  return { child, client, workDir, initialize };
}

test('MCP server: protocol handshake, tool listing and tool calls', async (t) => {
  assert.ok(existsSync(serverPath), `run "npm run build" first; missing ${serverPath}`);
  const { child, client, workDir, initialize } = await startServer();

  t.after(async () => {
    child.kill();
    await rm(workDir, { recursive: true, force: true });
  });

  await t.test('initialize reports the server identity', () => {
    assert.equal(initialize.serverInfo.name, 'famistudio-mcp');
    assert.ok(initialize.capabilities.tools, 'expected a tools capability');
  });

  let tools;
  await t.test('tools/list advertises every tool with a JSON Schema', async () => {
    const result = await client.request('tools/list', {});
    tools = result.tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'analyze_audio',
      'compile_song_spec',
      'compute_ticks',
      'create_fms',
      'diff_fms',
      'export_audio',
      'export_text',
      'famistudio_info',
      'read_fms',
      'run_famistudio',
      'summarize_fms',
      'validate_fms',
      'verify_roundtrip',
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.inputSchema.properties, `${tool.name} needs properties`);
    }
    const compile = tools.find((tool) => tool.name === 'compile_song_spec');
    assert.ok(compile.inputSchema.required.includes('spec'), 'spec must be required');
  });

  await t.test('compute_ticks does the FamiStudio tempo arithmetic', async () => {
    const result = await client.callTool('compute_ticks', { seconds: 10, noteLength: 8 });
    assert.ok(!result.isError, textOf(result));
    assert.equal(result.structuredContent.ticks, 601);
    assert.match(textOf(result), /601 ticks/);
  });

  await t.test('famistudio_info reports discovery state', async () => {
    const result = await client.callTool('famistudio_info', {});
    assert.ok(!result.isError, textOf(result));
    assert.equal(typeof result.structuredContent.found, 'boolean');
    assert.ok(Array.isArray(result.structuredContent.probedPaths));
  });

  let project;
  await t.test('create_fms writes a project file', async () => {
    const result = await client.callTool('create_fms', {
      outputPath: 'blip.fms',
      spec: {
        name: 'Blip',
        patternLength: 32,
        noteLength: 4,
        channels: [
          {
            channel: 'Square1',
            notes: [
              { time: 0, note: 'C4', duration: 4 },
              { time: 4, note: 'E4', duration: 4 },
              { time: 8, note: 'G4', duration: 8, dutyCycle: 1 },
              { time: 16, note: 'stop' },
            ],
          },
          { channel: 'Triangle', notes: [{ time: 0, note: 'C2', duration: 16 }] },
          { channel: 'Noise', notes: ['C4', null, null, null] },
        ],
      },
    });
    assert.ok(!result.isError, textOf(result));
    assert.ok(existsSync(join(workDir, 'blip.fms')), 'blip.fms should exist');
    project = result.structuredContent.project;
    assert.equal(project.songs.length, 1);
    assert.equal(project.songs[0].patternLength, 32);
  });

  await t.test('validate_fms accepts an inline project', async () => {
    const result = await client.callTool('validate_fms', { project });
    assert.ok(!result.isError, textOf(result));
    assert.equal(result.structuredContent.valid, true);
    assert.deepEqual(result.structuredContent.problems, []);
  });

  await t.test('validate_fms rejects malformed arguments', async () => {
    const result = await client.callTool('compute_ticks', { seconds: -5 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /seconds/);
  });

  await t.test('read_fms decodes the file back', async () => {
    const result = await client.callTool('read_fms', { path: 'blip.fms' });
    assert.ok(!result.isError, textOf(result));
    const square1 = result.structuredContent.songs[0].channels.find((c) => c.channel === 'Square1');
    const notes = square1.patterns[0].notes;
    assert.equal(notes.length, 4);
    assert.deepEqual(
      notes.map((note) => note.note),
      ['C4', 'E4', 'G4', 'stop'],
    );
    assert.equal(notes[2].effects.dutyCycle, 1);
    const triangle = result.structuredContent.songs[0].channels.find((c) => c.channel === 'Triangle');
    assert.equal(triangle.patterns[0].notes[0].note, 'C2');
  });

  await t.test('summarize_fms lists pattern content', async () => {
    const result = await client.callTool('summarize_fms', { projectPath: 'blip.fms' });
    assert.ok(!result.isError, textOf(result));
    assert.match(textOf(result), /C4/);
  });

  await t.test('diff_fms detects no difference against itself', async () => {
    const result = await client.callTool('diff_fms', {
      projectPathA: 'blip.fms',
      projectPathB: 'blip.fms',
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(result.structuredContent.identical, true);
  });

  await t.test('diff_fms reports a real difference', async () => {
    const result = await client.callTool('diff_fms', {
      projectPathA: 'blip.fms',
      projectB: { ...project, name: 'Blop' },
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(result.structuredContent.identical, false);
    assert.ok(result.structuredContent.differences.some((line) => line.includes('Blop')));
  });

  await t.test('an explicit absolute path is used as given', async () => {
    const target = await mkdtemp(join(tmpdir(), 'famistudio-mcp-explicit-'));
    try {
      const result = await client.callTool('create_fms', {
        outputPath: join(target, 'explicit.fms'),
        spec: { name: 'Explicit', channels: [{ channel: 'Square1', notes: ['C4'] }] },
      });
      assert.ok(!result.isError, textOf(result));
      assert.ok(existsSync(join(target, 'explicit.fms')), 'the caller-chosen path must be honoured');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  await t.test('a relative path cannot climb out of the output directory', async () => {
    const escaped = resolve(workDir, '..', 'escape-attempt.fms');
    const result = await client.callTool('create_fms', {
      outputPath: join('..', 'escape-attempt.fms'),
      spec: { name: 'Escape', channels: [{ channel: 'Square1', notes: ['C4'] }] },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /outside the output directory/);
    assert.ok(!existsSync(escaped), 'a relative path must not escape');
  });

  await t.test('unknown tool returns a helpful error', async () => {
    const result = await client.callTool('nope_not_a_tool', {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown tool/);
  });

  await t.test('famistudio-backed tools run when FamiStudio is installed', async (t2) => {
    const info = await client.callTool('famistudio_info', {});
    if (!info.structuredContent.found) {
      t2.skip('FamiStudio is not installed on this machine');
      return;
    }

    // Audible length is governed by where the last sounding note ends: the
    // Square1 line stops at tick 16 and the Triangle note only lasts 16 ticks,
    // so ~0.266s even though the pattern is 32 ticks long.
    const verify = await client.callTool('verify_roundtrip', {
      projectPath: 'blip.fms',
      expectDurationSeconds: 16 / 60.0988118623484,
    });
    assert.ok(!verify.isError, textOf(verify));
    assert.equal(verify.structuredContent.ok, true, textOf(verify));

    // Pitch detection needs a monophonic render, so export Square1 alone
    // (channel mask bit 0) rather than the mixed track.
    const audio = await client.callTool('export_audio', {
      projectPath: 'blip.fms',
      outputPath: 'blip-square1.wav',
      rate: 44100,
      channelMask: 0x1,
    });
    assert.ok(!audio.isError, textOf(audio));
    assert.equal(audio.structuredContent.analysis.silent, false);
    const wav = await readFile(join(workDir, 'blip-square1.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');

    const analysis = await client.callTool('analyze_audio', {
      path: 'blip-square1.wav',
      detectPitch: true,
    });
    assert.ok(!analysis.isError, textOf(analysis));
    const notes = (analysis.structuredContent.pitchSegments ?? []).map((segment) => segment.note);
    assert.ok(notes.includes('C4'), `expected a C4 in ${notes.join(', ')}`);
    assert.ok(notes.includes('E4'), `expected an E4 in ${notes.join(', ')}`);
  });
});

const SIMPLE_SPEC = { name: 'Blip', channels: [{ channel: 'Square1', notes: ['C4'] }] };

test('MCP server: the output directory is asked for once, then remembered', async (t) => {
  assert.ok(existsSync(serverPath), `run "npm run build" first; missing ${serverPath}`);

  const projectDir = await mkdtemp(join(tmpdir(), 'famistudio-mcp-project-'));
  const chosenDir = join(projectDir, 'assets', 'audio');
  const { child, client, workDir } = await startServer({
    bare: true,
    capabilities: { roots: {}, elicitation: {} },
    roots: [{ uri: pathToFileURL(projectDir).href, name: 'project' }],
    elicitationAnswers: [{ action: 'accept', content: { outputDirectory: chosenDir } }],
  });

  t.after(async () => {
    child.kill();
    await rm(workDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  let first;

  await t.test('the client workspace root is requested, and the user is prompted', async () => {
    first = await client.callTool('create_fms', { outputPath: 'blip.fms', spec: SIMPLE_SPEC });
    assert.ok(!first.isError, textOf(first));
    assert.ok(
      client.serverRequests.some((request) => request.method === 'roots/list'),
      'the server should ask the client for its workspace roots',
    );
    assert.equal(client.elicitationCount(), 1, 'the user should be asked exactly once');
    assert.ok(existsSync(join(chosenDir, 'blip.fms')), 'blip.fms should be in the chosen directory');
  });

  await t.test('the choice is remembered for the rest of the session', async () => {
    const second = await client.callTool('create_fms', { outputPath: 'blip2.fms', spec: SIMPLE_SPEC });
    assert.ok(!second.isError, textOf(second));
    assert.equal(client.elicitationCount(), 1, 'the server must not ask a second time');
    assert.ok(existsSync(join(chosenDir, 'blip2.fms')));
  });

  await t.test('the result tells the agent to record the choice in AGENTS.md', () => {
    const hint = first.structuredContent.agentHint;
    assert.equal(hint.kind, 'record-output-directory');
    assert.equal(hint.outputDirectory, chosenDir);
    assert.match(hint.suggestedAgentsMdSection, /## famistudio-mcp/);
    assert.match(textOf(first), /AGENTS\.md/);
    assert.ok(!existsSync(join(projectDir, 'AGENTS.md')), 'the server must not write the agent docs itself');
  });

  await t.test('the hint is not repeated on later calls', async () => {
    const third = await client.callTool('create_fms', { outputPath: 'blip3.fms', spec: SIMPLE_SPEC });
    assert.ok(!third.isError, textOf(third));
    assert.equal(third.structuredContent.agentHint, undefined);
  });
});

test('MCP server: declining the prompt falls back to the workspace default', async (t) => {
  assert.ok(existsSync(serverPath), `run "npm run build" first; missing ${serverPath}`);

  const projectDir = await mkdtemp(join(tmpdir(), 'famistudio-mcp-project-'));
  const { child, client, workDir } = await startServer({
    bare: true,
    capabilities: { roots: {}, elicitation: {} },
    roots: [{ uri: pathToFileURL(projectDir).href, name: 'project' }],
    elicitationAnswers: [{ action: 'decline' }],
  });

  t.after(async () => {
    child.kill();
    await rm(workDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  await t.test('output lands in <workspace>/audio/famistudio', async () => {
    const result = await client.callTool('create_fms', { outputPath: 'blip.fms', spec: SIMPLE_SPEC });
    assert.ok(!result.isError, textOf(result));
    assert.equal(client.elicitationCount(), 1);
    assert.ok(
      existsSync(join(projectDir, 'audio', 'famistudio', 'blip.fms')),
      'a declined prompt should use the workspace default',
    );
  });
});

test('MCP server: a client that cannot be prompted uses the workspace default silently', async (t) => {
  assert.ok(existsSync(serverPath), `run "npm run build" first; missing ${serverPath}`);

  const projectDir = await mkdtemp(join(tmpdir(), 'famistudio-mcp-project-'));
  const { child, client, workDir } = await startServer({
    bare: true,
    capabilities: { roots: {} },
    roots: [{ uri: pathToFileURL(projectDir).href, name: 'project' }],
  });

  t.after(async () => {
    child.kill();
    await rm(workDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  await t.test('no prompt is attempted and the workspace default is used', async () => {
    const result = await client.callTool('create_fms', { outputPath: 'blip.fms', spec: SIMPLE_SPEC });
    assert.ok(!result.isError, textOf(result));
    assert.equal(client.elicitationCount(), 0);
    assert.ok(existsSync(join(projectDir, 'audio', 'famistudio', 'blip.fms')));
    assert.equal(result.structuredContent.agentHint, undefined, 'nothing was asked, so nothing to record');
  });
});
