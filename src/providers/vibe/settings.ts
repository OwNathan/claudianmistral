import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '../../core/providers/providerConfig';
import { decodeVibeConfig, updateVibeConfig,type VibeProviderSettings } from './config';

/** Reads the Vibe configuration from the settings document. */
export function getVibeProviderSettings(settings: Record<string, unknown>): VibeProviderSettings {
  return decodeVibeConfig(getProviderConfig(settings, 'vibe'), getProviderSelectionInputs(settings, 'vibe'));
}

/** Writes the Vibe configuration into the settings document. */
export function updateVibeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<VibeProviderSettings>,
): VibeProviderSettings {
  const config = getProviderConfig(settings, 'vibe');
  const next = updateVibeConfig(config, getProviderSelectionInputs(settings, 'vibe'), updates);
  setProviderConfig(settings, 'vibe', config);
  return next;
}

/** Durable projection: full discovered catalogs stay runtime-only. */
export function projectVibeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getVibeProviderSettings(settings);
  const visibleModels = current.visibleModels;
  const selected = new Set(visibleModels);
  const config = {
    ...getProviderConfig(settings, 'vibe'),
    visibleModels,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredThinkingByModel: selectModelMetadata(current.preferredThinkingByModel, selected),
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
  };
  for (const key of ['discoveredModels', 'installationMethod', 'wslDistroOverride']) {
    delete (config as Record<string, unknown>)[key];
  }
  return config;
}
