import type {
  ACPClientConnection,
  ACPSessionConfigOption,
} from '@/providers/acp';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { VibeSharedRuntime } from '../execution/VibeSharedRuntime';
import { acquireVibeSharedRuntime } from '../execution/VibeSharedRuntime';
import type { VibeDiscoveredModel } from '../models';
import {
  findVibeSelectOption,
  flattenVibeSelectOptions,
  readVibeSelectValues,
} from './VibeSessionConfig';

export interface VibeModelDiscoveryResult {
  readonly diagnostics?: string;
  readonly models: VibeDiscoveredModel[];
}

/**
 * Native model discovery through short-lived auxiliary ACP sessions on the
 * shared vibe-acp process. The `model` select option is the server-side
 * catalog of everything the current Vibe config offers; the active model's
 * `thinking` select reports its native thinking levels.
 */
export class VibeModelDiscoveryService {
  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly getSharedRuntime: () => VibeSharedRuntime | null | undefined,
  ) {}

  /** Reads the full model catalog and the active model's thinking levels. */
  async discoverModels(): Promise<VibeModelDiscoveryResult | null> {
    return this.#withAuxSession(async (_client, _sessionId, configOptions) => {
      const modelSelect = findVibeSelectOption(configOptions, 'model');
      if (!modelSelect) {
        return { models: [] };
      }

      const activeThinkingLevels = readVibeSelectValues(configOptions, 'thinking');
      const models: VibeDiscoveredModel[] = [];
      for (const option of flattenVibeSelectOptions(modelSelect.options)) {
        const isActiveModel = option.value === modelSelect.currentValue;
        const thinkingLevels = isActiveModel ? activeThinkingLevels : [];
        const reasoning = thinkingLevels.length === 0
          || thinkingLevels.some(level => level !== 'off');
        models.push({
          ...(option.description ? { description: option.description } : {}),
          encodedId: encodeVibeId(option.value),
          label: option.name || option.value,
          rawId: option.value,
          reasoning,
          ...(isActiveModel && activeThinkingLevels.length > 0 ? { reasoningMetadataResolved: true } : {}),
          thinkingLevels,
        });
      }
      return { models };
    });
  }

  /**
   * Reads one model's native thinking levels by switching the auxiliary
   * session to it, then restoring the previously active model.
   */
  async warmModelThinkingLevels(rawModelId: string): Promise<VibeDiscoveredModel | null> {
    return this.#withAuxSession(async (client, sessionId, configOptions) => {
      const modelSelect = findVibeSelectOption(configOptions, 'model');
      const eligible = !modelSelect || flattenVibeSelectOptions(modelSelect.options)
        .some(option => option.value === rawModelId);
      if (!eligible) {
        return null;
      }
      const previousModel = modelSelect?.currentValue ?? null;

      const response = await client.setConfigOption({
        configId: 'model',
        sessionId,
        value: rawModelId,
      });
      const thinkingLevels = readVibeSelectValues(response?.configOptions ?? configOptions, 'thinking');
      const warmed = buildThinkingModel(rawModelId, thinkingLevels);

      if (!previousModel || previousModel === rawModelId) {
        return warmed;
      }
      try {
        await client.setConfigOption({
          configId: 'model',
          sessionId,
          value: previousModel,
        });
      } catch {
        // Restoring is best-effort; the user's active model stays native state.
      }
      return warmed;
    });
  }

  async #withAuxSession<T>(
    visit: (
      client: ACPClientConnection,
      sessionId: string,
      configOptions: ACPSessionConfigOption[],
    ) => Promise<T>,
  ): Promise<T | null> {
    const sharedRuntime = this.getSharedRuntime();
    if (!sharedRuntime) {
      return null;
    }
    const { context, owner } = await acquireVibeSharedRuntime(this.host, sharedRuntime);

    const response = await owner.native.client.newSession({
      cwd: context.hostCwd,
      mcpServers: [],
    });
    try {
      return await visit(owner.native.client, response.sessionId, response.configOptions ?? []);
    } finally {
      await owner.native.client.closeSession({ sessionId: response.sessionId }).catch(() => undefined);
    }
  }
}

function encodeVibeId(rawId: string): string {
  return `vibe/${rawId}`;
}

/**
 * One warmed model. A model whose session reports no `thinking` select has no
 * native think control; it resolves with an empty level list rather than
 * staying unresolved, so startup metadata filling does not retry forever.
 */
function buildThinkingModel(
  rawModelId: string,
  thinkingLevels: string[],
): VibeDiscoveredModel {
  return {
    encodedId: encodeVibeId(rawModelId),
    label: rawModelId,
    rawId: rawModelId,
    reasoning: thinkingLevels.length === 0 || thinkingLevels.some(level => level !== 'off'),
    reasoningMetadataResolved: true,
    thinkingLevels,
  };
}
