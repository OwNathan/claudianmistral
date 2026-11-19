import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getVibeProviderSettings } from '../settings';

/** Resolves the vibe-acp executable for this installation; unproved paths stay unproved. */
export class VibeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'vibe-acp',
    getSettingsProjection: settings => {
      const providerSettings = getVibeProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'vibe'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'vibe',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
