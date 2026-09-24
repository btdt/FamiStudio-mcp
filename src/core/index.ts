/**
 * Public API of the FamiStudio `.fms` toolkit.
 *
 * Everything here is dependency-free and usable without an MCP host:
 *
 * ```ts
 * import { compileSongSpec, writeFms } from 'famistudio-mcp/core';
 * const { project } = compileSongSpec({ name: 'Blip', channels: [{ channel: 'Square1', notes: [{ note: 'C4' }] }] });
 * await fs.writeFile('blip.fms', writeFms(project));
 * ```
 */
export * from './constants.js';
export * from './effects.js';
export * from './primitives.js';
export * from './model.js';
export * from './report.js';
export * from './fms.js';
export * from './compiler.js';
export * from './wav.js';
export * from './famistudio.js';
