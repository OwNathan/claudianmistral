import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getVibeWorkspaceServices,
  vibeWorkspaceRegistration,
} from './app/VibeWorkspaceServices';
import { VIBE_PROVIDER_CAPABILITIES } from './capabilities';
import { vibeSettingsReconciler } from './env/VibeSettingsReconciler';
import { VibeExecutionBackend } from './execution/VibeExecutionBackend';
import { VibeConversationHistoryService } from './history/VibeConversationHistoryService';
import { getVibeProviderSettings, projectVibeModelSettings, updateVibeProviderSettings } from './settings';
import { vibeChatUIConfig } from './ui/VibeChatUIConfig';
import { vibeModelPolicy } from './VibeModelPolicy';

export const vibeProviderRegistration: ProviderModule = {
  id: 'vibe',
  blankTabOrder: 16,
  capabilities: VIBE_PROVIDER_CAPABILITIES,
  chatUIConfig: vibeChatUIConfig,
  createExecutionBackend: plugin => new VibeExecutionBackend(plugin.getRuntimeHost('vibe'), {
    sharedRuntime: getVibeWorkspaceServices().sharedRuntime,
  }),
  displayName: 'Mistral Vibe',
  environmentKeyPatterns: [/^VIBE_/i, /^MISTRAL_/i],
  historyService: new VibeConversationHistoryService(),
  isEnabled: settings => getVibeProviderSettings(settings).enabled,
  modelPolicy: vibeModelPolicy,
  setEnabled: (settings, enabled) => updateVibeProviderSettings(settings, { enabled }),
  settingsReconciler: vibeSettingsReconciler,
  settingsStorage: {
    hostScopedFields: [
      'installationMethodsByHost', 'wslDistroOverridesByHost', 'cliPathsByHost',
    ],
    needsReasoningMetadata(settings) {
      const current = getVibeProviderSettings(settings);
      return current.visibleModels.some(id => {
        const model = current.discoveredModels.find(model => model.encodedId === id);
        return !model || model.reasoningMetadataResolved === false;
      });
    },
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'vibe');
      updateVibeProviderSettings(target, getVibeProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'vibe'),
      );
    },
    projectPersistedConfig: projectVibeModelSettings,
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: vibeWorkspaceRegistration,
};
