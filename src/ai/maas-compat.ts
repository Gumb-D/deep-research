import { generateText, type FinishReason, type LanguageModelV1 } from 'ai';
import { z } from 'zod';

const DEFAULT_MAAS_JSON_MAX_TOKENS = 4096;
const DEFAULT_MAAS_REPORT_MAX_TOKENS = 16000;
const DEFAULT_MAAS_JSON_RETRIES = 2;
const MAX_MAAS_JSON_RETRIES = 5;

export type MaasConfig = {
  enabled: boolean;
  jsonMaxTokens: number;
  reportMaxTokens: number;
  jsonRetries: number;
};

type GenerateTextResultLike = Awaited<ReturnType<typeof generateText>>;

type GenerateTextImpl = (options: {
  model: LanguageModelV1;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  maxTokens?: number;
}) => Promise<GenerateTextResultLike>;

export function isMaasPromptJsonEnabled(
  value = process.env.MAAS_PROMPT_JSON,
): boolean {
  return value === 'true';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getMaasConfig(
  env: NodeJS.ProcessEnv = process.env,
): MaasConfig {
  return {
    enabled: isMaasPromptJsonEnabled(env.MAAS_PROMPT_JSON),
    jsonMaxTokens: parsePositiveInt(
      env.MAAS_JSON_MAX_TOKENS,
      DEFAULT_MAAS_JSON_MAX_TOKENS,
    ),
    reportMaxTokens: parsePositiveInt(
      env.MAAS_REPORT_MAX_TOKENS,
      DEFAULT_MAAS_REPORT_MAX_TOKENS,
    ),
    jsonRetries: clamp(
      parsePositiveInt(env.MAAS_JSON_RETRIES, DEFAULT_MAAS_JSON_RETRIES),
      0,
      MAX_MAAS_JSON_RETRIES,
    ),
  };
}

function describeScalar(
  typeName: string,
  description?: string,
  optional = false,
): string {
  const suffix = description ? `: ${description}` : '';
  const optionalSuffix = optional ? ' (optional)' : '';
  return `<${typeName}${optionalSuffix}${suffix}>`;
}

function schemaToContractValue(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return describeOptional(schema._def.innerType);
  }

  if (schema instanceof z.ZodNullable) {
    return {
      anyOf: [schemaToContractValue(schema.unwrap()), 'null'],
    };
  }

  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(
        ([key, value]) => [key, schemaToContractValue(value)],
      ),
    );
  }

  if (schema instanceof z.ZodArray) {
    return [schemaToContractValue(schema.element)];
  }

  if (schema instanceof z.ZodString) {
    return describeScalar('string', schema.description);
  }

  if (schema instanceof z.ZodNumber) {
    return describeScalar('number', schema.description);
  }

  if (schema instanceof z.ZodBoolean) {
    return describeScalar('boolean', schema.description);
  }

  if (schema instanceof z.ZodEnum) {
    return {
      enum: [...schema.options],
    };
  }

  if (schema instanceof z.ZodLiteral) {
    return schema.value;
  }

  return describeScalar('value', schema.description);
}

function describeOptional(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) {
    return describeScalar('string', schema.description, true);
  }

  if (schema instanceof z.ZodNumber) {
    return describeScalar('number', schema.description, true);
  }

  if (schema instanceof z.ZodBoolean) {
    return describeScalar('boolean', schema.description, true);
  }

  return `<optional>`;
}

function buildPromptJsonSystem(system: string | undefined): string {
  return [
    system,
    'Return only valid JSON.',
    'Do not use markdown, code fences, commentary, or XML.',
    'Do not include reasoning.',
    'The response must be a single JSON object that matches the provided contract exactly.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPromptJsonPrompt(prompt: string, schema: z.ZodTypeAny): string {
  const contract = JSON.stringify(schemaToContractValue(schema), null, 2);

  return `${prompt}

JSON output rules:
- Return exactly one JSON object.
- Use double-quoted JSON keys and strings.
- Do not include any text before or after the JSON object.
- If you cannot comply, still return the best valid JSON object that matches the contract.

JSON contract:
${contract}`;
}

export function extractJsonObject(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) {
    return direct;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fenced = tryParseJsonObject(fencedMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  const extracted = extractBalancedJsonObject(trimmed);
  return extracted ? tryParseJsonObject(extracted) : null;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractBalancedJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth++;
      continue;
    }

    if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function summarizeValidationError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export async function generateObjectWithPromptJson<T extends z.ZodTypeAny>({
  model,
  taskName,
  system,
  prompt,
  schema,
  config = getMaasConfig(),
  abortSignal,
  maxTokens = config.jsonMaxTokens,
  generateTextImpl = generateText,
}: {
  model: LanguageModelV1;
  taskName: string;
  system?: string;
  prompt: string;
  schema: T;
  config?: MaasConfig;
  abortSignal?: AbortSignal;
  maxTokens?: number;
  generateTextImpl?: GenerateTextImpl;
}): Promise<{
  object: z.infer<T>;
  finishReason: FinishReason;
}> {
  const attemptSummaries: string[] = [];
  const totalAttempts = config.jsonRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const result = await generateTextImpl({
      model,
      system: buildPromptJsonSystem(system),
      prompt: buildPromptJsonPrompt(prompt, schema),
      abortSignal,
      maxTokens,
    });

    if (result.finishReason !== 'stop') {
      attemptSummaries.push(
        `attempt ${attempt}: finishReason=${result.finishReason}`,
      );
      continue;
    }

    const parsedJson = extractJsonObject(result.text);
    if (!parsedJson) {
      attemptSummaries.push(`attempt ${attempt}: finishReason=stop non-json`);
      continue;
    }

    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
      attemptSummaries.push(
        `attempt ${attempt}: finishReason=stop validation=${summarizeValidationError(validated.error)}`,
      );
      continue;
    }

    return {
      object: validated.data,
      finishReason: result.finishReason,
    };
  }

  throw new Error(
    `MAAS prompt JSON failed for "${taskName}" after attempts=${totalAttempts}. ${attemptSummaries.join(' | ')}`,
  );
}

export async function generateTextWithStop({
  model,
  taskName,
  system,
  prompt,
  abortSignal,
  maxTokens,
}: {
  model: LanguageModelV1;
  taskName: string;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  maxTokens: number;
}): Promise<string> {
  const result = await generateText({
    model,
    system,
    prompt,
    abortSignal,
    maxTokens,
  });

  if (result.finishReason !== 'stop') {
    throw new Error(
      `MAAS text generation failed for "${taskName}" with finishReason=${result.finishReason}`,
    );
  }

  return result.text;
}
