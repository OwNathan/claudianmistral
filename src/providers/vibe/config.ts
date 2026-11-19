import { getInstallationKey } from '@/core/device/InstallationKey';
import {
  decodeInstallationSettings,
  type InstallationSettings,
  selectInstallationSettings,
  type StoredInstallationSettings,
  updateInstallationSettings,
} from '@/core/providers/settings/InstallationSettings';

import { replaceProviderConfig } from '../../core/providers/providerConfig';
import type { ProviderSelectionInputs } from '../../core/providers/ProviderRuntimeHost';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import {
  clampVibeThinkingLevel,
  decodeVibeModelId,
  findVibeModel,
  normalizeVibeDiscoveredModels,
  normalizeVibeThinkingLevel,
  type VibeDiscoveredModel,
  type VibeThinkingLevel,
} from './models';

interface PersistedVibeProviderSettings extends StoredInstallationSettings {
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  discoveredModels: VibeDiscoveredModel[];
  enabled: boolean;
  /** Fingerprint of every runtime input; a change restarts runtimes. */
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, VibeThinkingLevel>;
  visibleModels: string[];
}

export type VibeProviderSettings = PersistedVibeProviderSettings & InstallationSettings;

export const DEFAULT_VIBE_PROVIDER_SETTINGS: Readonly<PersistedVibeProviderSettings> = Object.freeze({
  installationMethodsByHost: {},
  wslDistroOverridesByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  visibleModels: [],
});

export function normalizeVibeVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || !decodeVibeModelId(trimmed)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * The user's explicit selection order, durable once made: an empty selection
 * leaves nothing visible rather than collapsing back to the full catalog.
 */
export function getOrderedVibeVisibleModelIds(
  settings: Pick<VibeProviderSettings, 'visibleModels'>,
): string[] {
  return [...settings.visibleModels];
}

export function decodeVibeConfig(
  config: Readonly<Record<string, unknown>>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
): VibeProviderSettings {
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const discoveredModels = normalizeVibeDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  const visibleModels = normalizeVibeVisibleModels(config.visibleModels);
  const persistableIds = getPersistableVibeModelIds(selection, visibleModels);

  const installation = decodeInstallationSettings(config);
  return {
    ...installation,
    ...selectInstallationSettings(installation, getInstallationKey()),
    cliPath: readStoredString(config.cliPath, DEFAULT_VIBE_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost,
    discoveredModels,
    enabled: readStoredBoolean(config.enabled, DEFAULT_VIBE_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_VIBE_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      DEFAULT_VIBE_PROVIDER_SETTINGS.environmentVariables,
    ),
    modelAliases: normalizeVibeModelAliasesForPersistableIds(
      config.modelAliases,
      persistableIds,
    ),
    preferredThinkingByModel: normalizeVibePreferredThinkingForPersistableIds(
      config.preferredThinkingByModel,
      discoveredModels,
      persistableIds,
    ),
    visibleModels,
  };
}

/** Applies updates to a stored Vibe configuration in place, normalizing against the current selections. */
export function updateVibeConfig(
  config: Record<string, unknown>,
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  updates: Partial<VibeProviderSettings>,
): VibeProviderSettings {
  const current = decodeVibeConfig(config, selection);
  const hostnameKey = getInstallationKey();
  const nextDiscoveredModels = normalizeVibeDiscoveredModels(updates.discoveredModels ?? current.discoveredModels);
  const nextVisibleModels = normalizeVibeVisibleModels(updates.visibleModels ?? current.visibleModels);
  const persistableIds = getPersistableVibeModelIds(selection, nextVisibleModels);
  const nextModelAliases = pruneMapToPersistableIds(
    normalizeVibeModelAliasesForPersistableIds(updates.modelAliases ?? current.modelAliases, persistableIds),
    persistableIds,
  );
  const nextPreferredThinkingByModel = pruneMapToPersistableIds(
    normalizeVibePreferredThinkingForPersistableIds(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
      persistableIds,
    ),
    persistableIds,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_VIBE_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_VIBE_PROVIDER_SETTINGS.cliPath;
  }

  const next: PersistedVibeProviderSettings = {
    ...current,
    ...updates,
    ...updateInstallationSettings(current, updates, hostnameKey),
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: nextPreferredThinkingByModel,
    visibleModels: nextVisibleModels,
  };

  replaceProviderConfig(config, {
    installationMethodsByHost: next.installationMethodsByHost,
    wslDistroOverridesByHost: next.wslDistroOverridesByHost,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    visibleModels: next.visibleModels,
  });

  return {
    ...next,
    ...selectInstallationSettings({ ...next }, getInstallationKey()),
  };
}

function normalizeVibeModelAliasesForPersistableIds(
  value: unknown,
  persistableIds: Set<string>,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
    const normalizedEncodedId = normalizeVibePersistableEncodedId(encodedId, persistableIds);
    const normalizedAlias = typeof alias === 'string' ? alias.trim() : '';
    if (!normalizedEncodedId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedEncodedId] = normalizedAlias;
  }

  return normalized;
}

function normalizeVibePreferredThinkingForPersistableIds(
  value: unknown,
  discoveredModels: VibeDiscoveredModel[],
  persistableIds: Set<string>,
): Record<string, VibeThinkingLevel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, VibeThinkingLevel> = {};
  for (const [encodedId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    const normalizedEncodedId = normalizeVibePersistableEncodedId(encodedId, persistableIds);
    const normalizedThinkingLevel = normalizeVibeThinkingLevel(thinkingLevel);
    if (!normalizedEncodedId || !normalizedThinkingLevel) {
      continue;
    }

    const discoveredModel = findVibeModel({ discoveredModels }, normalizedEncodedId);
    normalized[normalizedEncodedId] = discoveredModel
      ? clampVibeThinkingLevel(normalizedThinkingLevel, discoveredModel.thinkingLevels)
      : normalizedThinkingLevel;
  }

  return normalized;
}

function normalizeVibePersistableEncodedId(
  value: string,
  persistableIds: Set<string>,
): string {
  const trimmed = value.trim();
  if (!decodeVibeModelId(trimmed)) {
    return '';
  }
  return persistableIds.has(trimmed) ? trimmed : '';
}

function getPersistableVibeModelIds(
  selection: Pick<ProviderSelectionInputs, 'referencedModelIds'>,
  visibleModels: string[],
): Set<string> {
  const persistableIds = new Set(visibleModels);
  for (const id of selection.referencedModelIds) {
    if (decodeVibeModelId(id)) persistableIds.add(id);
  }
  return persistableIds;
}

function pruneMapToPersistableIds<T extends string>(
  value: Record<string, T>,
  persistableIds: Set<string>,
): Record<string, T> {
  const pruned: Record<string, T> = {};
  for (const [encodedId, entry] of Object.entries(value)) {
    if (persistableIds.has(encodedId)) {
      pruned[encodedId] = entry;
    }
  }
  return pruned;
}
