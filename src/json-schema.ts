/**
 * Minimal Zod (v3) -> JSON Schema converter.
 *
 * The MCP SDK can build a JSON Schema from a Zod shape, but it does so through
 * zod's own v4 converter, which is not reachable from a project pinned to zod
 * v3 - and depending on zod v4 only for `toJSONSchema` would pull a second copy
 * of zod into every install. The tool schemas only use a small, well understood
 * subset of zod, so converting them here keeps the runtime dependency at one
 * zod and makes the emitted schema easy to review.
 *
 * Unsupported constructs throw instead of silently emitting `{}`, so a tool that
 * grows a new schema feature fails loudly in development.
 */
import { z } from 'zod';

/** JSON Schema (draft 2020-12 subset) produced by {@link zodShapeToJsonSchema}. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: JsonSchema | boolean;
}

/** Read the definition of a zod type. */
function def(schema: z.ZodTypeAny): {
  typeName?: string;
  description?: string;
  checks?: { kind: string; value?: unknown; inclusive?: boolean }[];
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  value?: unknown;
  values?: unknown[];
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
} {
  return (schema as unknown as { _def: Record<string, never> })._def;
}

/** Unwrap optional/nullable/default wrappers, collecting side information. */
function unwrap(schema: z.ZodTypeAny): {
  schema: z.ZodTypeAny;
  optional: boolean;
  defaultValue?: unknown;
  nullable: boolean;
} {
  let current = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;

  // Bounded loop: zod wrappers nest shallowly, and an infinite chain is a bug.
  for (let i = 0; i < 10; i += 1) {
    const info = def(current);
    if (info.typeName === 'ZodOptional') {
      optional = true;
      current = info.innerType as z.ZodTypeAny;
      continue;
    }
    if (info.typeName === 'ZodNullable') {
      nullable = true;
      current = info.innerType as z.ZodTypeAny;
      continue;
    }
    if (info.typeName === 'ZodDefault') {
      optional = true;
      const inner = info.innerType as z.ZodTypeAny & { _def: { defaultValue: () => unknown } };
      try {
        defaultValue = inner._def.defaultValue();
      } catch {
        defaultValue = undefined;
      }
      current = inner;
      continue;
    }
    if (info.typeName === 'ZodEffects') {
      current = info.schema as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { schema: current, optional, nullable, defaultValue };
}

/** Apply numeric / length constraints recorded in `_def.checks`. */
function applyChecks(target: JsonSchema, checks: { kind: string; value?: unknown; inclusive?: boolean }[] = []): void {
  for (const check of checks) {
    switch (check.kind) {
      case 'min':
        if (typeof check.value === 'number') {
          if (target.type === 'string') target.minLength = check.value;
          else if (check.inclusive === false) target.minimum = check.value + 1;
          else target.minimum = check.value;
        }
        break;
      case 'max':
        if (typeof check.value === 'number') {
          if (target.type === 'string') target.maxLength = check.value;
          else if (check.inclusive === false) target.maximum = check.value - 1;
          else target.maximum = check.value;
        }
        break;
      case 'int':
        target.type = 'integer';
        break;
      case 'length':
        if (typeof check.value === 'number') {
          target.minLength = check.value;
          target.maxLength = check.value;
        }
        break;
      default:
        break;
    }
  }
}

/** Convert one zod type into a JSON Schema fragment. */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrap(schema);
  const info = def(unwrapped.schema);
  const description = info.description;
  const out = convertCore(unwrapped.schema, info);

  if (description) out.description = description;
  if (unwrapped.nullable && out.type && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (unwrapped.defaultValue !== undefined) out.default = unwrapped.defaultValue;
  return out;
}

function convertCore(schema: z.ZodTypeAny, info: ReturnType<typeof def>): JsonSchema {
  switch (info.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      applyChecks(out, info.checks);
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      applyChecks(out, info.checks);
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral':
      return { const: info.value, type: info.value === null ? 'null' : typeof info.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(info.values ?? [])] };
    case 'ZodNativeEnum':
      return { enum: Object.values((info as { values?: Record<string, unknown> }).values ?? {}) };
    case 'ZodArray': {
      const item = zodToJsonSchema(info.type as z.ZodTypeAny);
      const out: JsonSchema = { type: 'array', items: item };
      applyChecks(out, info.checks);
      return out;
    }
    case 'ZodObject': {
      const rawShape = (info as unknown as { shape: () => Record<string, z.ZodTypeAny> }).shape();
      return zodShapeToJsonSchema(rawShape);
    }
    case 'ZodRecord': {
      const keyType = info.keyType as z.ZodTypeAny | undefined;
      const keyInfo = keyType ? def(keyType) : undefined;
      if (keyInfo && keyInfo.typeName !== 'ZodString') {
        throw new Error(`zodToJsonSchema: only string keys are supported for records, got ${keyInfo.typeName}.`);
      }
      return {
        type: 'object',
        additionalProperties: info.valueType ? zodToJsonSchema(info.valueType) : true,
      };
    }
    case 'ZodUnion': {
      const options = (info.options ?? []).map((option) => zodToJsonSchema(option));
      // Collapse a union of literals into an enum, which is what clients show best.
      if (options.every((option) => option.const !== undefined) && options.length > 0) {
        return { enum: options.map((option) => option.const) };
      }
      return { anyOf: options };
    }
    case 'ZodUnknown':
    case 'ZodAny':
      return {};
    case 'ZodUndefined':
      return {};
    case 'ZodEffects':
      return zodToJsonSchema(info.schema as z.ZodTypeAny);
    default:
      throw new Error(
        `zodToJsonSchema: unsupported zod type "${info.typeName ?? 'unknown'}". ` +
          'Extend src/json-schema.ts when a tool starts using it.',
      );
  }
}

/** Convert a zod object shape into a JSON Schema object. */
export function zodShapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(value);
    if (!unwrap(value).optional) required.push(key);
  }

  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  out.additionalProperties = false;
  return out;
}
