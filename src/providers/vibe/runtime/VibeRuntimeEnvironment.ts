import { getInstallationKey } from '@/core/device/InstallationKey';
import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';

import { createCLIPathFingerprintInputs } from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { VibeProviderSettings } from '../config';

export function buildVibeRuntimeEnv(
  environmentText: string,
  cliPath: string,
  target?: ExecutionTarget,
): NodeJS.ProcessEnv {
  const configuredEnvironment = parseEnvironmentVariables(environmentText);
  // Vibe resolves its own credentials (shell env, ~/.vibe/.env, OS keyring);
  // the plugin only forwards the user's environment and configured overrides.
  return {
    ...process.env,
    ...configuredEnvironment,
    ...(target?.method === 'wsl' ? {} : { PATH: getEnhancedPath(configuredEnvironment.PATH, cliPath || undefined) }),
  };
}

/** Fingerprint of Vibe's runtime inputs: the CLI path for this installation and the environment. */
export function computeVibeRuntimeInputHash(
  settings: Pick<VibeProviderSettings, 'cliPath' | 'cliPathsByHost'> & Partial<Pick<VibeProviderSettings, 'installationMethod' | 'wslDistroOverride'>>,
  environmentText: string,
  target = resolveExecutionTarget({ settings: { installationMethod: settings.installationMethod ?? 'native-windows', wslDistroOverride: settings.wslDistroOverride ?? '' } }),
): string {
  const cliPathInputs = createCLIPathFingerprintInputs(
    settings.cliPathsByHost[getInstallationKey()],
    settings.cliPath,
  );
  const environment = Object.entries(parseEnvironmentVariables(environmentText))
    .sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: { ...cliPathInputs, target: JSON.stringify(target) },
    environmentKeys: environment.map(([key]) => key),
    environmentText,
  });
}
