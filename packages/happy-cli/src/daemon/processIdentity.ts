import { execSync } from 'child_process';

/** Runs a shell command and returns stdout. Injectable so tests never shell out. */
export type CommandRunner = (command: string) => string;

const defaultRunner: CommandRunner = (command: string) =>
  execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Reads the OS start time of a process as an opaque string.
 *
 * This exists because a pid is not an identity: the OS reuses pids, so a
 * recorded pid that is alive today may be a completely different process.
 * Pairing the pid with its start time makes the pair stable for the life of
 * that process and unforgeable by a later process that inherits the number.
 *
 * Returns undefined whenever identity cannot be established. Callers must
 * treat undefined as "not the same process", never as "probably fine".
 */
export function readProcessStartTime(
  pid: number,
  runCommand: CommandRunner = defaultRunner,
): string | undefined {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const output = runCommand(`ps -o lstart= -p ${pid}`);
    const trimmed = typeof output === 'string' ? output.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True only when both start times are present and identical. Any absent or
 * differing value means we are looking at a different process incarnation.
 */
export function isSameProcessIncarnation(
  recordedStartTime: string | undefined,
  observedStartTime: string | undefined,
): boolean {
  if (!recordedStartTime || !observedStartTime) return false;
  return recordedStartTime === observedStartTime;
}
