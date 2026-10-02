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
 */

/** Matches the truncation budget `apiSession` uses for its own fallback title. */
export const INITIAL_SESSION_TITLE_MAX_LENGTH = 60;

/** Used when the working directory has no usable basename (e.g. `/`). */
const UNNAMED_PROJECT_LABEL = 'Session';

const SEPARATOR = ' · ';

function truncate(text: string): string {
    if (text.length <= INITIAL_SESSION_TITLE_MAX_LENGTH) {
        return text;
    }
    const keep = INITIAL_SESSION_TITLE_MAX_LENGTH - 3;
    return `${text.slice(0, keep)}...`;
}

/**
 * Builds the title a session is created with.
 *
 * @param cwd - The session's working directory.
 * @param gitBranch - Branch name, when the working directory is a git checkout.
 */
export function buildInitialSessionTitle(cwd: string, gitBranch?: string): string {
    // Not using node:path.basename: it is platform-dependent, and this label is
    // rendered on the phone from a path produced on some other machine.
    const segments = (cwd ?? '')
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0);
    const project = segments[segments.length - 1] ?? UNNAMED_PROJECT_LABEL;

    const branch = gitBranch?.trim();
    if (!branch) {
        return truncate(project);
    }
    return truncate(`${project}${SEPARATOR}${branch}`);
}
