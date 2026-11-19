import type { ProviderChatUIConfig } from '@/core/providers/types';
import { VIBE_PROVIDER_ICON } from '@/shared/icons';

import { maybeGetVibeWorkspaceServices } from '../app/VibeWorkspaceServices';
import { VIBE_PERMISSION_MODE_OPTIONS } from '../permissionModes';
import { createVibeModelMetadataPreparer } from '../runtime/VibeModels';
import { vibeModelPolicy } from '../VibeModelPolicy';

export const vibeChatUIConfig: ProviderChatUIConfig = {
  ...vibeModelPolicy,
  prepareModelMetadata: createVibeModelMetadataPreparer(
    () => maybeGetVibeWorkspaceServices()?.modelDiscovery ?? null,
  ),
  getPermissionModeOptions() {
    return VIBE_PERMISSION_MODE_OPTIONS;
  },
  getProviderIcon() {
    return VIBE_PROVIDER_ICON;
  },
};
