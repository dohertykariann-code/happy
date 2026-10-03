import { describe, expect, it } from 'vitest';
import {
    INITIAL_SESSION_TITLE_MAX_LENGTH,
    buildInitialSessionTitle,
} from './initialSessionTitle';

describe('buildInitialSessionTitle', () => {
    it('uses the working directory basename when there is no branch', () => {
        expect(buildInitialSessionTitle('/Users/kari/code/happy')).toBe('happy');
    });

    it('appends the git branch when one is known', () => {
        expect(buildInitialSessionTitle('/Users/kari/code/happy', 'fix/session-title'))
            .toBe('happy · fix/session-title');
    });

    it('ignores a blank branch rather than emitting a dangling separator', () => {
        expect(buildInitialSessionTitle('/Users/kari/code/happy', '   ')).toBe('happy');
        expect(buildInitialSessionTitle('/Users/kari/code/happy', '')).toBe('happy');
    });

    it('strips trailing slashes before taking the basename', () => {
        expect(buildInitialSessionTitle('/Users/kari/code/happy/')).toBe('happy');
    });

    it('keeps dotted project directories readable', () => {
        expect(buildInitialSessionTitle('/Users/kari/.claude', 'chore/archive')).toBe('.claude · chore/archive');
    });

    it('truncates to the max length with an ellipsis', () => {
        const longBranch = 'feature/' + 'x'.repeat(100);
        const title = buildInitialSessionTitle('/Users/kari/code/happy', longBranch);
        expect(title.length).toBe(INITIAL_SESSION_TITLE_MAX_LENGTH);
        expect(title.endsWith('...')).toBe(true);
        // The project name is the part she scans for, so it must survive truncation.
        expect(title.startsWith('happy · ')).toBe(true);
    });

    it('truncates a pathologically long project name too', () => {
        const title = buildInitialSessionTitle('/Users/kari/code/' + 'y'.repeat(200));
        expect(title.length).toBe(INITIAL_SESSION_TITLE_MAX_LENGTH);
        expect(title.endsWith('...')).toBe(true);
    });

    it('falls back to a stable label when there is no usable directory name', () => {
        expect(buildInitialSessionTitle('/')).toBe('Session');
        expect(buildInitialSessionTitle('')).toBe('Session');
    });

    it('still returns the fallback plus branch at the filesystem root', () => {
        expect(buildInitialSessionTitle('/', 'main')).toBe('Session · main');
    });

    it('labels the home directory as General instead of the system username', () => {
        expect(buildInitialSessionTitle('/Users/karidoherty', undefined, '/Users/karidoherty'))
            .toBe('General');
    });

    it('ignores a trailing slash on either side when matching the home directory', () => {
        expect(buildInitialSessionTitle('/Users/karidoherty/', undefined, '/Users/karidoherty'))
            .toBe('General');
        expect(buildInitialSessionTitle('/Users/karidoherty', undefined, '/Users/karidoherty/'))
            .toBe('General');
    });

    it('does not mistake a project directory for the home directory', () => {
        expect(buildInitialSessionTitle('/Users/karidoherty/code/happy', undefined, '/Users/karidoherty'))
            .toBe('happy');
    });

    it('appends the branch when the home directory is itself a git checkout', () => {
        expect(buildInitialSessionTitle('/Users/karidoherty', 'main', '/Users/karidoherty'))
            .toBe('General · main');
    });

    it('treats the home directory normally when homeDir is not provided', () => {
        expect(buildInitialSessionTitle('/Users/karidoherty')).toBe('karidoherty');
    });
});
