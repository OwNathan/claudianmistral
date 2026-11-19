import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Session logs live in `<vibe home>/logs/session`; the current layout nests under `unified`. */
const VIBE_UNIFIED_LAYOUT = 'unified';

/**
 * Resolves the vibe home directory the way vibe-acp sees it: an absolute
 * `VIBE_HOME` override wins, else the OS home carries `.vibe`.
 */
export function resolveVibeHome(environment: NodeJS.ProcessEnv): string | null {
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  const configuredHome = environment.VIBE_HOME?.trim();
  if (configuredHome && paths.isAbsolute(configuredHome)) {
    return paths.resolve(configuredHome);
  }
  const home = process.platform === 'win32'
    ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
    : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return home && paths.isAbsolute(home) ? path.resolve(home, '.vibe') : path.win32.join(homedir(), '.vibe');
}

function resolveSessionLogRoot(environment: NodeJS.ProcessEnv): string {
  const home = resolveVibeHome(environment);
  return home ? path.join(home, 'logs', 'session') : '';
}

/**
 * Locates the directory holding one session's persisted records. Both the
 * `unified/<id>` layout and dated folders are probed; opaque candidates that do
 * not carry `meta.json` fail closed as missing.
 */
export async function resolveVibeSessionDirectory(
  sessionId: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const normalized = sessionId?.trim() ?? '';
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return null;
  }

  const root = resolveSessionLogRoot(environment);
  if (!root) {
    return null;
  }

  const candidates = [
    path.join(root, VIBE_UNIFIED_LAYOUT, normalized),
    path.join(root, normalized),
  ];
  for (const candidate of candidates) {
    if (await isVibeSessionDirectory(candidate)) {
      return candidate;
    }
  }

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === VIBE_UNIFIED_LAYOUT) {
      continue;
    }
    const candidate = path.join(root, entry.name, normalized);
    if (await isVibeSessionDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isVibeSessionDirectory(directory: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directory);
    if (!stats.isDirectory()) return false;
    await fs.access(path.join(directory, 'meta.json'));
    return true;
  } catch {
    return false;
  }
}

