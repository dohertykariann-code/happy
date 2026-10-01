/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface SessionEncryptionData {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

/**
 * Durable identity of the process holding a session claim. The PID alone is not
 * enough: the OS can reassign it, so it is paired with the process start time.
 * See daemon/sessionOwnership.ts.
 */
export type ProcessOwner = {
  pid: number;
  startedAt: string;
};

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  encryption?: SessionEncryptionData;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /**
   * Proof of WHICH process owns this claim, carried for the life of the
   * claim. Kept so later decisions re-verify ownership instead of falling
   * back to a bare liveness probe, which a reused PID passes.
   */
  owner?: ProcessOwner;
}