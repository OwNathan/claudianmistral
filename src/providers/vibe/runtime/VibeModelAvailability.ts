import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeVibeConfig, getOrderedVibeVisibleModelIds } from '../config';
import { decodeVibeModelId, encodeVibeModelId } from '../models';

/** Fails closed when the requested Vibe model alias is not in the discovered catalog. */
export function assertVibeModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeVibeConfig(host.config, host.selection);
  const decoded = decodeVibeModelId(model);
  const id = decoded?.modelId ?? '';
  const encodedId = id ? encodeVibeModelId(id) : '';
  if (!(
    config.enabled
    && getOrderedVibeVisibleModelIds(config).includes(encodedId)
    && config.discoveredModels.some(candidate => candidate.rawId === id)
  )) {
    throw new ProviderModelUnavailableError('Mistral Vibe');
  }
}
