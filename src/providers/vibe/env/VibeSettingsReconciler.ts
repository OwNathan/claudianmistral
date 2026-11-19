import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import {
  decodeVibeModelId,
  encodeVibeModelId,
} from '../models';
import { computeVibeRuntimeInputHash } from '../runtime/VibeRuntimeEnvironment';
import {
  getVibeProviderSettings,
  updateVibeProviderSettings,
} from '../settings';

export const vibeSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(settings, context) {
    if (!getVibeProviderSettings(settings).enabled) {
      return { changed: false };
    }

    const current = getVibeProviderSettings(settings);
    const target = resolveExecutionTarget({ settings: current, hostVaultPath: context?.vaultPath });
    const environmentText = getRuntimeEnvironmentText(settings, 'vibe');
    const environmentHash = computeVibeRuntimeInputHash(current, environmentText, target);
    if (current.environmentHash === environmentHash) return { changed: false };
    updateVibeProviderSettings(settings, { environmentHash });
    return { changed: true };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = false;
    changed = normalizeSelectionAt(settings, 'model') || changed;
    changed = normalizeSelectionAt(settings, 'titleGenerationModel') || changed;

    const savedProviderModel = settings.savedProviderModel;
    if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
      changed = normalizeSelectionAt(
        savedProviderModel as Record<string, unknown>,
        'vibe',
      ) || changed;
    }
    return changed;
  },
};

function normalizeSelectionAt(settings: Record<string, unknown>, key: string): boolean {
  const current = settings[key];
  if (typeof current !== 'string') {
    return false;
  }

  const trimmed = current.trim();
  let normalized: string | null = null;
  const decoded = decodeVibeModelId(trimmed);
  if (decoded) {
    normalized = encodeVibeModelId(decoded.modelId);
  }

  if (normalized === null || normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}
