import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { getOrderedVibeVisibleModelIds } from './config';
import {
  decodeVibeModelId,
  encodeVibeModelId,
  findVibeModel,
  getDefaultVibeThinkingLevels,
  isVibeModelSelectionId,
} from './models';
import { VIBE_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  getVibeProviderSettings,
  updateVibeProviderSettings,
} from './settings';

export const vibeModelPolicy: ProviderModelPolicy = {
  permissionModes: VIBE_PERMISSION_MODE_POLICY,
  getModelOptions(settings): ProviderUIOption[] {
    const vibeSettings = getVibeProviderSettings(settings);
    const byEncodedId = new Map(vibeSettings.discoveredModels.map(model => [model.encodedId, model] as const));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const encodedId of getOrderedVibeVisibleModelIds(vibeSettings)) {
      const model = byEncodedId.get(encodedId);
      if (!model || seen.has(encodedId)) {
        continue;
      }
      seen.add(encodedId);
      options.push({
        value: encodedId,
        label: Object.hasOwn(vibeSettings.modelAliases, encodedId)
          ? vibeSettings.modelAliases[encodedId]
          : model.label,
        ...(model.description ? { description: model.description } : {}),
      });
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const vibeSettings = getVibeProviderSettings(settings);
    const firstVisibleModelId = getOrderedVibeVisibleModelIds(vibeSettings)
      .find(encodedId => vibeSettings.discoveredModels.some(model => model.encodedId === encodedId));
    return firstVisibleModelId ?? null;
  },

  ownsModel(model): boolean {
    return isVibeModelSelectionId(model);
  },

  supportsReasoningEffort(model, settings): boolean {
    return getVibeThinkingLevels(model, settings).length > 0;
  },

  getReasoningOptions(model, settings): ProviderUIOption[] {
    return getVibeThinkingLevels(model, settings)
      .map(level => ({ label: formatThinkingLevel(level), value: level }));
  },

  getDefaultReasoningValue(model, settings): string {
    const levels = getVibeThinkingLevels(model, settings);
    if (levels.length === 0) {
      return '';
    }
    const vibeSettings = getVibeProviderSettings(settings);
    const preferred = vibeSettings.preferredThinkingByModel[encodeVibeModelId(decodeVibeModelId(model)!.modelId)];
    if (preferred && levels.includes(preferred)) {
      return preferred;
    }
    // High is always the default effort; a model that does not list it keeps
    // it as the requested value and the execution layer omits the config.
    return 'high';
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isVibeModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedVibeEffortProjection(settings);
    settings.model = normalizedModel;
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedVibeEffortProjection(settings);
    if (!decodeVibeModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const encodedId = normalizeSelection(model);
    if (!isVibeModelSelectionId(encodedId)) {
      clearSavedVibeEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const vibeSettings = getVibeProviderSettings(settings);
    const supportedValues = new Set(getVibeThinkingLevels(model, settings));
    const preferredThinkingByModel = { ...vibeSettings.preferredThinkingByModel };
    if (supportedValues.has(value)) {
      Object.defineProperty(preferredThinkingByModel, encodedId, { value, enumerable: true, writable: true, configurable: true });
    } else {
      delete preferredThinkingByModel[encodedId];
    }
    updateVibeProviderSettings(settings, { preferredThinkingByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },
};

/** Thinking levels for the selected model; unresolved models fall back to provisional levels. */
function getVibeThinkingLevels(model: string, settings: Record<string, unknown>): string[] {
  const decoded = decodeVibeModelId(model);
  if (!decoded) {
    return [];
  }
  const vibeSettings = getVibeProviderSettings(settings);
  const encodedId = encodeVibeModelId(decoded.modelId);
  const discovered = findVibeModel(vibeSettings, encodedId);
  if (!discovered) {
    return getDefaultVibeThinkingLevels();
  }
  if (discovered.thinkingLevels.length === 0) {
    return getDefaultVibeThinkingLevels();
  }
  return [...discovered.thinkingLevels];
}

function formatThinkingLevel(level: string): string {
  const trimmed = level.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.toLowerCase() === 'xhigh') {
    return 'xHigh';
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function normalizeSelection(model: string): string {
  const normalized = model.trim();
  const decoded = decodeVibeModelId(normalized);
  return decoded ? encodeVibeModelId(decoded.modelId) : model;
}

function clearSavedVibeEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.vibe;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
