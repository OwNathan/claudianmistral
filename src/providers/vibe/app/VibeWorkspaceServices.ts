import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { VibeCommandCatalog } from '../commands/VibeCommandCatalog';
import { acquireVibeSharedRuntime, VibeSharedRuntime } from '../execution/VibeSharedRuntime';
import { VibeCLIResolver } from '../runtime/VibeCLIResolver';
import { createVibeModels, type VibeModelsCatalog } from '../runtime/VibeModels';
import { createVibeSettingsTabRenderer } from '../ui/VibeSettingsTab';
import { VibeCommandLoader } from './VibeCommandLoader';
import { VibeCommandProbe } from './VibeCommandProbe';

export interface VibeWorkspaceServices extends ProviderWorkspaceServices {
  /** The one shared vibe-acp process owner; every consumer multiplexes over it. */
  readonly sharedRuntime: VibeSharedRuntime;
  readonly modelDiscovery: VibeModelsCatalog['modelDiscovery'];
  readonly commandCatalog: ProviderCommandCatalog;
  readonly cliResolver: VibeCLIResolver;
  dispose(): Promise<void>;
}

export async function createVibeWorkspaceServices(plugin: ProviderHost): Promise<VibeWorkspaceServices> {
  const runtimeHost = plugin.getRuntimeHost('vibe');
  const sharedRuntime = new VibeSharedRuntime();
  const models = createVibeModels(runtimeHost, () => sharedRuntime);
  const commandProbe = new VibeCommandProbe(runtimeHost, () => sharedRuntime);
  const cliResolver = new VibeCLIResolver();

  const unregisterTransitionHook = plugin.executionLifecycleRegistry.registerTransitionHook('vibe', {
    // Runtime-input changes (CLI path, environment) swap the whole process,
    // so in-flight discovery and probes must drain before it disappears.
    beforeTransition: async () => {
      models.catalog.beginTransition();
      commandProbe.beginEnvironmentTransition();
      await Promise.all([models.catalog.quiesce(), commandProbe.quiesceForEnvironmentChange()]);
      await sharedRuntime.shutdown();
    },
    afterTransition: async () => {
      try {
        await commandProbe.quiesceForEnvironmentChange();
      } finally {
        cliResolver.reset();
        commandProbe.endEnvironmentTransition();
        models.catalog.endTransition();
      }
    },
  });

  return {
    sharedRuntime,
    startRuntime: async () => {
      await acquireVibeSharedRuntime(runtimeHost, sharedRuntime);
    },
    modelCatalog: models.catalog,
    modelDiscovery: models.modelDiscovery,
    commandCatalog: new VibeCommandCatalog(),
    commandLoader: new VibeCommandLoader(commandProbe),
    settingsTabRenderer: createVibeSettingsTabRenderer({ cliResolver, modelCatalog: models.catalog }),
    cliResolver,
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([commandProbe.dispose(), models.catalog.dispose()]);
      await sharedRuntime.dispose();
    },
  };
}

export const vibeWorkspaceRegistration: ProviderWorkspaceRegistration<VibeWorkspaceServices> = {
  consumesAgentSkills: true,
  initialize: async ({ plugin }) => createVibeWorkspaceServices(plugin),
};

export function getVibeWorkspaceServices(): VibeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('vibe') as VibeWorkspaceServices;
}

export function maybeGetVibeWorkspaceServices(): VibeWorkspaceServices | undefined {
  return ProviderWorkspaceRegistry.getIfInitialized('vibe') as VibeWorkspaceServices | undefined;
}
