import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, machineSpawnNewSession, sessionArchive, sessionKill, sessionSetAgentModes, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine, useSetting } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta, UnsupportedPermissionModeError } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

// A session's model is fixed at creation and there is no cross-provider "copy
// thread" primitive, so a second opinion from another model works by serializing
// this conversation to plain text and opening a fresh session on the target model
// with that text as the kickoff. Capped so a long session doesn't send a huge
// payload — keeps the most recent turns within budget.
const TRANSCRIPT_CHAR_BUDGET = 12000;
export function buildSecondOpinionMessage(sessionId: string): string | null {
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    const turns = messages
        // Exclude thinking blocks (agent-text with isThinking): they're reasoning
        // noise, and forwarding raw chain-of-thought to a different model isn't
        // something the user opted into.
        .filter((m): m is Extract<typeof m, { kind: 'user-text' | 'agent-text' }> =>
            m.kind === 'user-text' || (m.kind === 'agent-text' && !m.isThinking))
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((m) => `${m.kind === 'user-text' ? 'User' : 'Assistant'}: ${m.text}`);
    if (turns.length === 0) return null;

    // Fill from the most recent turn backwards until the budget is hit.
    let transcript = '';
    let truncated = false;
    for (let i = turns.length - 1; i >= 0; i--) {
        const candidate = transcript ? `${turns[i]}\n\n${transcript}` : turns[i];
        if (candidate.length > TRANSCRIPT_CHAR_BUDGET) {
            truncated = true;
            // If even the newest turn alone blows the budget, keep its tail rather
            // than sending it uncapped (the `&& transcript` guard used to skip this).
            if (!transcript) transcript = turns[i].slice(-TRANSCRIPT_CHAR_BUDGET);
            break;
        }
        transcript = candidate;
    }
    const preface = truncated ? '[Earlier conversation truncated.]\n\n' : '';
    return `Here is a conversation I have been having with another AI coding assistant. I would like your independent take, a second opinion. Please review it and respond with your own analysis or recommendation.\n\n---\n\n${preface}${transcript}`;
}

type HandoffAgent = 'claude' | 'codex' | 'gemini' | 'openhands_local' | 'openhands_deepinfra';
type HandoffAvailabilityKey = Exclude<HandoffAgent, 'openhands_local' | 'openhands_deepinfra'> | 'openhands';
const HANDOFF_AGENTS: Array<{ agent: HandoffAgent; label: string }> = [
    { agent: 'claude', label: 'Ask Claude' },
    { agent: 'codex', label: 'Ask Codex' },
    { agent: 'gemini', label: 'Ask Gemini' },
    { agent: 'openhands_local', label: 'Ask OpenHands (Local)' },
    { agent: 'openhands_deepinfra', label: 'Ask OpenHands (DeepInfra)' },
];

export function getHandoffAvailabilityKey(agent: HandoffAgent): HandoffAvailabilityKey {
    return agent === 'openhands_local' || agent === 'openhands_deepinfra' ? 'openhands' : agent;
}

/**
 * Which other models this session can hand off to right now: online per
 * `avail`, minus whichever one this session is already running. `current`
 * must be the session's own flavor value (e.g. `openhands_local`), not the
 * shared availability key, or every OpenHands preset would wrongly offer
 * itself as a target since both share one `openhands` availability flag.
 */
export function resolveHandoffTargets(
    current: string | null | undefined,
    avail: Partial<Record<HandoffAvailabilityKey, boolean>> | null | undefined,
): HandoffAgent[] {
    if (!avail) return [];
    return HANDOFF_AGENTS.filter((x) => x.agent !== current && avail[getHandoffAvailabilityKey(x.agent)]).map((x) => x.agent);
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isRigMetadata(session.metadata) || session.metadata?.capabilities?.resume === false) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    // Older daemons do not publish resumeSupport and do not implement the
    // resume RPC. Capability presence is the compatibility check; the UI is
    // hidden instead of offering an action that the machine cannot execute.
    if (machine.metadata?.resumeSupport?.rpcAvailable !== true) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const continuationExperimentsEnabled = useSetting('expResumeSession');
    const resumeAvailability = React.useMemo(
        () => getResumeAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. Fork/duplicate still use the
    // legacy rollout flag because resumeSupport does not prove that the daemon
    // implements the newer fork RPC.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(
        continuationExperimentsEnabled
        && !isRigMetadata(session.metadata)
        && forkSource
        && machine
        && isMachineOnline(machine)
    );

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const [resumingSession, performResume] = useHappyAction(async () => {
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        let modeMeta: ReturnType<typeof resolveMessageModeMeta>;
        try {
            modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
        } catch (error) {
            if (error instanceof UnsupportedPermissionModeError) {
                // Refuse loudly instead of substituting a mode: swapping in a
                // default would silently change what the agent may do.
                throw new HappyError(error.message, false);
            }
            throw error;
        }
        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive resume on their own — they live
                // in the session's synced metadata (#1492).

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        if (session.metadata?.bot) {
            const result = await sessionKill(session.id);
            if (!result.success) {
                throw new HappyError(result.message || 'Connect to the bot’s machine to archive it.', false);
            }
            onAfterArchive?.();
            return;
        }
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Try to kill the CLI process; if it's already dead, force-archive via server
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            await sessionArchive(session.id);
        }
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Fork the session (no truncation) — copies the on-disk Claude JSONL
    // and spawns a fresh Happy session on the same machine. Works for
    // both active and inactive sessions; the source row stays untouched.
    const [forking, performFork] = useHappyAction(async () => {
        if (!canFork) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        if (!forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource);
        if (result.type !== 'success') {
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    // Second-opinion handoff: which OTHER models are installed on this machine and
    // online right now. Gated behind the same experiment as fork/resume/duplicate
    // so it ships with a kill switch; never offers the session's own current flavor.
    const handoffTargets = React.useMemo<HandoffAgent[]>(() => {
        if (!continuationExperimentsEnabled) return [];
        if (!machine || !isMachineOnline(machine)) return [];
        return resolveHandoffTargets(session.metadata?.flavor, machine?.metadata?.cliAvailability);
    }, [continuationExperimentsEnabled, machine, session.metadata?.flavor]);

    // Serialize the conversation and open a fresh session on the target model with
    // it as the kickoff. useHappyAction gives the shared error handling AND a
    // re-entrancy lock, so a double-tap can't spawn two duplicate handoffs.
    const handoffTargetRef = React.useRef<HandoffAgent | null>(null);
    const [handingOff, performHandoff] = useHappyAction(async () => {
        const targetAgent = handoffTargetRef.current;
        if (!targetAgent) return;
        const directory = session.metadata?.path;
        const spawnMachineId = session.metadata?.machineId;
        if (!directory || !spawnMachineId) {
            throw new HappyError('This session has no folder or machine, so it cannot be handed off.', false);
        }
        const message = buildSecondOpinionMessage(session.id);
        if (!message) {
            throw new HappyError('There is no conversation yet to hand off.', false);
        }
        const result = await machineSpawnNewSession({ machineId: spawnMachineId, directory, agent: targetAgent, parentSessionId: session.id });
        switch (result.type) {
            case 'success':
                // Wait for the new session to sync (encryption keys) before messaging
                // it — otherwise sendMessage silently no-ops on the fresh id.
                await sync.refreshSessions();
                await sync.sendMessage(result.sessionId, message);
                navigateToSession(result.sessionId);
                return;
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
            case 'pending':
                throw new HappyError('The handoff is still being created. Please try again shortly.', false);
        }
    });

    const handoffToFlavor = React.useCallback((agent: HandoffAgent) => {
        handoffTargetRef.current = agent;
        performHandoff();
    }, [performHandoff]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (resumeAvailability.canShowResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        handoffTargets.forEach((agent) => {
            const label = HANDOFF_AGENTS.find((candidate) => candidate.agent === agent)?.label ?? `Ask ${agent}`;
            items.push({ id: `handoff-${agent}`, icon: 'sparkles-outline', label, onPress: () => handoffToFlavor(agent) });
        });

        items.push({ id: 'archive', icon: 'archive-outline', label: 'Archive', onPress: archiveSession, destructive: true });

        return items;
    }, [
        archiveSession,
        canCopySessionMetadata,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSource,
        forkSession,
        handoffTargets,
        handoffToFlavor,
        openDetails,
        openDuplicateSheet,
        resumeAvailability.canShowResume,
        resumeSession,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: true,
        canCopySessionMetadata,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        handoffTargets,
        handingOff,
        handoffToFlavor,
        openDetails,
        openDuplicateSheet,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session!, {});
    return session ? showActionAlert : undefined;
}
