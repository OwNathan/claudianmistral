import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';

/** Vibe advertises per-model `thinking` levels; unknown names keep their server order. */
const VIBE_KNOWN_THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type VibeThinkingLevel = string;

export interface VibeDiscoveredModel {
  contextWindow?: number;
  description?: string;
  encodedId: string;
  label: string;
  rawId: string;
  reasoning: boolean;
  /** False while the model's thinking levels still need native discovery. */
  reasoningMetadataResolved?: boolean;
  thinkingLevels: VibeThinkingLevel[];
}

export interface DecodedVibeModelId {
  modelId: string;
}

export const VIBE_MODEL_PREFIX = 'vibe/';
export const VIBE_DEFAULT_THINKING_LEVEL: VibeThinkingLevel = DEFAULT_REASONING_VALUE;

const KNOWN_LEVEL_RANK: ReadonlyMap<string, number> = new Map(
  VIBE_KNOWN_THINKING_LEVELS.map((level, index) => [level as string, index]),
);
const DEFAULT_REASONING_LEVELS: VibeThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export function isVibeModelSelectionId(model: string): boolean {
  return decodeVibeModelId(model) !== null;
}

export function encodeVibeModelId(modelId: string): string {
  const normalized = modelId.trim();
  return normalized ? `${VIBE_MODEL_PREFIX}${normalized}` : '';
}

export function decodeVibeModelId(model: string): DecodedVibeModelId | null {
  if (!model.startsWith(VIBE_MODEL_PREFIX)) {
    return null;
  }

  const raw = model.slice(VIBE_MODEL_PREFIX.length).trim();
  return raw ? { modelId: raw } : null;
}

export function normalizeVibeThinkingLevel(value: unknown): VibeThinkingLevel | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function sortVibeThinkingLevels(levels: VibeThinkingLevel[]): VibeThinkingLevel[] {
  return [...levels].sort((left, right) => {
    const leftRank = KNOWN_LEVEL_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = KNOWN_LEVEL_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

export function normalizeVibeDiscoveredModels(value: unknown): VibeDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: VibeDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const rawId = firstString(entry.rawId, entry.alias, entry.id, entry.modelId)?.trim() ?? '';
    if (!rawId || seen.has(rawId)) {
      continue;
    }

    seen.add(rawId);
    const label = firstString(entry.label, entry.displayName, entry.name)?.trim() || rawId;
    const description = firstString(entry.description)?.trim();
    const contextWindow = firstFinitePositiveNumber(entry.contextWindow, entry.context_window);
    const thinkingLevels = normalizeVibeThinkingLevels(entry.thinkingLevels);
    const reasoning = thinkingLevels.length === 0
      || thinkingLevels.some(level => level !== 'off');
    // A model warms resolved even with zero levels (its server offers no
    // thinking control); only never-reported levels leave it unresolved.
    const reasoningMetadataResolved = entry.reasoningMetadataResolved === true
      || (entry.reasoningMetadataResolved !== false
        && Array.isArray(entry.thinkingLevels)
        && entry.thinkingLevels.length > 0);

    normalized.push({
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(description ? { description } : {}),
      // Explicit both ways: an empty-level model that already warmed resolved
      // must stay resolved across a storage round-trip.
      ...(reasoningMetadataResolved
        ? { reasoningMetadataResolved: true }
        : { reasoningMetadataResolved: false }),
      encodedId: encodeVibeModelId(rawId),
      label,
      rawId,
      reasoning,
      thinkingLevels,
    });
  }

  return normalized;
}

export function findVibeModel(
  settings: { discoveredModels: VibeDiscoveredModel[] },
  encodedId: string,
): VibeDiscoveredModel | null {
  return settings.discoveredModels.find(model => model.encodedId === encodedId.trim()) ?? null;
}

export function clampVibeThinkingLevel(
  level: string | undefined,
  supportedLevels: VibeThinkingLevel[],
): VibeThinkingLevel {
  const normalized = normalizeVibeThinkingLevel(level);
  if (normalized && supportedLevels.includes(normalized)) {
    return normalized;
  }

  if (supportedLevels.length > 0 && !supportedLevels.some(name => name !== 'off')) {
    return supportedLevels[0] ?? 'off';
  }
  return VIBE_DEFAULT_THINKING_LEVEL;
}

function normalizeVibeThinkingLevels(value: unknown): VibeThinkingLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const levels: VibeThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const level = normalizeVibeThinkingLevel(entry);
    if (!level || seen.has(level)) {
      continue;
    }
    seen.add(level);
    levels.push(level);
  }

  return sortVibeThinkingLevels(levels);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function firstFinitePositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Thinking levels an unresolved model offers until native discovery reports the real set. */
export function getDefaultVibeThinkingLevels(): VibeThinkingLevel[] {
  return [...DEFAULT_REASONING_LEVELS];
}
