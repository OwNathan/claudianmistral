import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderCLIResolver } from '@/core/providers/types';

import type { ProviderModelCatalog } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { VIBE_PROVIDER_ICON } from '../../../shared/icons';
import { AccessibleSetting } from '../../../shared/settings/AccessibleSetting';
import { renderCLIInstallationSetting } from '../../../shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { validateExecutionTargetCLIPath } from '../../../shared/settings/ExecutionTargetSettings';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import { inspectVibeInstallation } from '../runtime/VibeCLIInspection';
import { getVibeProviderSettings, updateVibeProviderSettings } from '../settings';

export function createVibeSettingsTabRenderer(
  workspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; modelCatalog: ProviderModelCatalog },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const hostnameKey = context.plugin.storage.installationKey;

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getVibeProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'Mistral Vibe' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(settingsBag, 'vibe', value)) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['vibe'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(settings, 'vibe', value);
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('vibe');
        },
      };

      const installationContainer = container.createDiv();
      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getVibeProviderSettings(settingsBag).visibleModels.length > 0,
        getIsEnabled: () => getVibeProviderSettings(settingsBag).enabled,
        providerId: 'vibe',
        providerName: 'Mistral Vibe',
      });

      const getCLIPlaceholder = () => process.platform === 'win32'
        ? 'C:\\Users\\you\\.local\\bin\\vibe-acp.exe'
        : '/usr/local/bin/vibe-acp';
      renderCLIInstallationSetting({
        cliName: 'Mistral Vibe',
        icon: VIBE_PROVIDER_ICON,
        inspect: () => inspectVibeInstallation(context.plugin.getRuntimeHost('vibe')),
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getVibeProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: t('settings.cliPath.genericName'),
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getVibeProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['vibe'],
            (settings) => {
              updateVibeProviderSettings(settings, {
                cliPathsByHost,
              });
            },
            () => workspace?.cliResolver?.reset(),
          );
          context.notifyProviderModelOptionsChanged('vibe');
        },
        placeholder: getCLIPlaceholder(),
        validate: value => validateExecutionTargetCLIPath(value, getVibeProviderSettings(settingsBag)),
      });

      new AccessibleSetting(container).setName(t('settings.models')).setHeading();
      const modelPicker = renderProviderModelsSection(container, 'vibe', 'Mistral Vibe', workspace.modelCatalog, () => modelWarning.refresh());

      renderEnvironmentSettingsSection({
        container,
        desc: t('settings.vibe.environment.desc'),
        heading: t('settings.environment'),
        name: t('settings.vibe.environment.name'),
        placeholder: 'VIBE_STRICT_CONFIG=true',
        plugin: context.plugin,
        scope: 'provider:vibe',
      });
      return modelPicker;
    },
  };
}
