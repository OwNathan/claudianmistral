import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost, ProviderSelectionInputs } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderModelPolicy } from '../../../core/providers/types';
import { decodeVibeConfig, updateVibeConfig } from '../config';
import type { VibeSharedRuntime } from '../execution/VibeSharedRuntime';
import { decodeVibeModelId,type VibeDiscoveredModel } from '../models';
import { VibeModelDiscoveryService } from './VibeModelDiscovery';

/** The workspace-owned model surface: the catalog controller plus its discovery service. */
export interface VibeModelsCatalog {
  readonly catalog: ProviderModelCatalogController;
  readonly modelDiscovery: VibeModelDiscoveryService;
}

/** Constructs the model catalog over Vibe's ACP-discovered model aliases. */
export function createVibeModels(
  host: ProviderRuntimeHost,
  getSharedRuntime: () => VibeSharedRuntime | null | undefined,
): VibeModelsCatalog {
  const modelDiscovery = new VibeModelDiscoveryService(host, getSharedRuntime);
  return {
    modelDiscovery,
    catalog: new ProviderModelCatalogController({
      providerName: 'Mistral Vibe',
      store: createConfigCatalogStore(host, {
        update: updateVibeConfig,
        read: (config, selection) => {
          const current = decodeVibeConfig(config, selection);
          return {
            aliases: current.modelAliases,
            enabled: current.enabled,
            models: current.discoveredModels.map(model => ({
              description: [
                model.description,
                model.thinkingLevels.length > 0
                  ? `thinking: ${model.thinkingLevels.join(', ')}`
                  : '',
              ].filter(Boolean).join(' | ') || undefined,
              id: model.encodedId,
              name: model.label,
            })),
            selectedIds: current.visibleModels,
          };
        },
      }),
      // Model membership is fixed per discovery; only the catalog fields refresh.
      discover: async signal => {
        const result = await modelDiscovery.discoverModels();
        if (!result) return { changed: false };
        await host.updateConfig((config, selection) => {
          if (signal.aborted) return false;
          updateVibeConfig(config, selection, { discoveredModels: result.models });
          return true;
        });
        if (signal.aborted) return { changed: false };
        host.notifyChatOptionsChanged();
        return { changed: true, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
      },
    }),
  };
}

/**
 * Warms one model's thinking levels into the discovered catalog. A model the
 * server switches to but reports no thinking select for resolves with an
 * empty level list, so startup does not keep retrying it.
 */
export function createVibeModelMetadataPreparer(
  getModelDiscovery: () => VibeModelDiscoveryService | null | undefined,
): NonNullable<ProviderModelPolicy['prepareModelMetadata']> {
  return async (model, _settings, context) => {
    const rawModelId = decodeVibeModelIdFromSelection(model);
    if (!rawModelId) {
      return;
    }
    const host = context.plugin.getRuntimeHost('vibe');
    if (isVibeModelMetadataResolved(host.config, host.selection, rawModelId)) {
      return;
    }

    const discovery = getModelDiscovery();
    if (!discovery) {
      // Without the workspace's shared runtime there is nothing to warm from.
      return;
    }
    try {
      const warmed = await discovery.warmModelThinkingLevels(rawModelId);
      if (!warmed) return;
      await host.updateConfig((config, selection) => {
        const decoded = decodeVibeConfig(config, selection);
        const models = decoded.discoveredModels.map((candidate: VibeDiscoveredModel) => (
          candidate.rawId === rawModelId
            ? { ...candidate, reasoning: warmed.reasoning, reasoningMetadataResolved: true, thinkingLevels: warmed.thinkingLevels }
            : candidate
        ));
        updateVibeConfig(config, selection, { discoveredModels: models });
        return true;
      });
      host.notifyChatOptionsChanged();
    } catch {
      // Metadata warmup is opportunistic; the first real turn still works.
    }
  };
}

function decodeVibeModelIdFromSelection(model: string | undefined): string | null {
  const decoded = model ? decodeVibeModelId(model) : null;
  return decoded?.modelId ?? null;
}

function isVibeModelMetadataResolved(
  config: Record<string, unknown>,
  selection: ProviderSelectionInputs,
  rawModelId: string,
): boolean {
  const current = decodeVibeConfig(config, selection);
  return current.discoveredModels.some(
    candidate => candidate.rawId === rawModelId && candidate.reasoningMetadataResolved === true,
  );
}

