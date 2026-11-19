import { parseEnvironmentVariables } from '@/core/process/env';
import { type CLIInstallation,probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeVibeConfig } from '../config';

/**
 * Probes the configured vibe-acp executable for the settings UI. `--version`
 * is answered by the launcher argument parser, so it works even when the
 * runtime module gate would abort a real server start.
 */
export async function inspectVibeInstallation(host: ProviderRuntimeHost): Promise<CLIInstallation> {
  const settings = decodeVibeConfig(host.config, host.selection);
  const configuredPath = settings.cliPathsByHost[host.storage.installationKey] || settings.cliPath;
  const command = await host.resolveCliPath();
  if (!command) {
    return { path: null, version: null, source: configuredPath.trim() ? 'custom' : 'auto' };
  }
  const env = { ...process.env, ...parseEnvironmentVariables(host.environmentText) };
  return probeCLIInstallation({
    path: command,
    configuredPath,
    args: ['--version'],
    env,
  });
}
