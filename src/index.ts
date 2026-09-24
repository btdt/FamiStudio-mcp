#!/usr/bin/env node
/**
 * `famistudio-mcp` executable: starts the MCP server on stdio.
 *
 * Because stdout carries JSON-RPC, every diagnostic here goes to stderr.
 */
import { runStdio, SERVER_NAME, VERSION } from './server.js';
import { TOOL_NAMES } from './tools.js';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    [
      `${SERVER_NAME} ${VERSION} - FamiStudio .fms MCP server`,
      '',
      'Usage:',
      '  famistudio-mcp            serve MCP over stdio (used by MCP clients)',
      '  famistudio-mcp --help     show this help',
      '  famistudio-mcp --version  print the version',
      '  famistudio-mcp --tools    list the exposed tools',
      '',
      'Environment:',
      '  FAMISTUDIO_EXE            full path to FamiStudio(.exe)',
      '  FAMISTUDIO_MCP_OUTDIR     where generated projects/audio are written',
      '  FAMISTUDIO_MCP_READDIRS   extra directories tools may read projects from',
      '  FAMISTUDIO_MCP_WORKSPACE  single-directory shorthand for out+read',
      '',
      `Tools: ${TOOL_NAMES.join(', ')}`,
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (argv.includes('--tools')) {
  process.stdout.write(`${TOOL_NAMES.join('\n')}\n`);
  process.exit(0);
}

try {
  const handle = await runStdio({
    onReady: () => {
      process.stderr.write(`${SERVER_NAME} ${VERSION} listening on stdio (${TOOL_NAMES.length} tools)\n`);
    },
  });

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  process.stderr.write(`${SERVER_NAME} failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
}
