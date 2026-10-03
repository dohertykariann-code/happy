/**
 * Deterministic initial session title.
 *
 * A new session used to display `New chat` until the agent happened to call
 * `mcp__happy__change_title`. On the Claude backend nothing enforces that call
 * (only a line in the appended system prompt asks for it), so the title could
 * arrive many turns late or never. When it never arrived, `apiSession` instead
 * stamped the first user message, truncated, as the title.
 *
 * Neither state answers the question the session list is actually scanned for:
 * WHICH PROJECT is this session in. This builds a project label out of facts
 * already known at session-creation time, so a session is identifiable the
 * moment it appears. The agent's own `change_title` call still overwrites it
 * later with a task-specific title.
 *
 * One directory needs its own label: the user's home directory is not a
 * project, it is the catch-all "General" chat. Taking its basename like any
 * other cwd produces the literal system username (e.g. `karidoherty`), which
 * answers a different question than "which project" and reads as a stray
 * person's name in the session list.
 */

/** Matches the truncation budget `apiSession` uses for its own fallback title. */
export const INITIAL_SESSION_TITLE_MAX_LENGTH = 60;

/** Used when the working directory has no usable basename (e.g. `/`). */
const UNNAMED_PROJECT_LABEL = 'Session';

/** Used when the working directory IS the user's home directory. */
const GENERAL_SESSION_LABEL = 'General';

const SEPARATOR = ' · ';

function normalizeForComparison(path: string): string {
    return path.replace(/[\\/]+$/, '');
}

function truncate(text: string): string {
    if (text.length <= INITIAL_SESSION_TITLE_MAX_LENGTH) {
        return text;
    }
    const keep = INITIAL_SESSION_TITLE_MAX_LENGTH - 3;
    return `${text.slice(0, keep)}...`;
}

/**
 * The project label for a working directory: `General` for the user's home
 * directory, the last path segment otherwise, falling back to a stable label
 * when there is no usable basename (e.g. `/`).
 *
 * Shared by `buildInitialSessionTitle` (session creation) and
 * `getSessionTitle` (push notifications) so the "which project is this"
 * question gets the same answer in both places. Deliberately has no branch
 * segment or truncation of its own: those are session-title-specific and
 * layered on top by the caller that needs them.
 *
 * @param path - The directory to label.
 * @param homeDir - The user's home directory (e.g. `os.homedir()`), passed in
 *   rather than read here so this stays a pure, easily-tested function.
 */
export function pathProjectLabel(path: string, homeDir?: string): string {
    const normalizedPath = normalizeForComparison(path ?? '');
    const isHomeDirectory = !!homeDir && normalizedPath === normalizeForComparison(homeDir);
    if (isHomeDirectory) {
        return GENERAL_SESSION_LABEL;
    }

    // Not using node:path.basename: it is platform-dependent, and this label
    // is rendered on the phone from a path produced on some other machine.
    const segments = (path ?? '')
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? UNNAMED_PROJECT_LABEL;
}

/**
 * Builds the title a session is created with.
 *
 * @param cwd - The session's working directory.
 * @param gitBranch - Branch name, when the working directory is a git checkout.
 * @param homeDir - The user's home directory (e.g. `os.homedir()`), passed in
 *   rather than read here so this stays a pure, easily-tested function.
 */
export function buildInitialSessionTitle(cwd: string, gitBranch?: string, homeDir?: string): string {
    const project = pathProjectLabel(cwd, homeDir);

    const branch = gitBranch?.trim();
    if (!branch) {
        return truncate(project);
    }
    return truncate(`${project}${SEPARATOR}${branch}`);
}
