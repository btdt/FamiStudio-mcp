/**
 * Tool registry assembly: the single place that knows the full tool surface.
 */
import { registerProjectTools } from './mcp/tools-project.js';
import { registerInspectTools } from './mcp/tools-inspect.js';
import { registerExportTools, registerAnalysisTools } from './mcp/tools-export.js';
import { createRegistry, type ToolRegistry } from './server.js';

/** Names of every tool this server exposes, in registration order. */
export const TOOL_NAMES = [
  'famistudio_info',
  'compute_ticks',
  'compile_song_spec',
  'create_fms',
  'validate_fms',
  'read_fms',
  'summarize_fms',
  'diff_fms',
  'export_audio',
  'export_text',
  'verify_roundtrip',
  'analyze_audio',
  'run_famistudio',
] as const;

/** Build the registry with every tool registered. */
export function buildRegistry(): ToolRegistry {
  const registry = createRegistry();
  registerAnalysisTools(registry);
  registerProjectTools(registry);
  registerInspectTools(registry);
  registerExportTools(registry);
  return registry;
}
