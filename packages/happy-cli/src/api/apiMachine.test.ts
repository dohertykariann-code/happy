import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect,
    mockDetectClaudeModels,
    mockStopClaudeModelProbe,
    mockDetectCodexModels,
    mockStopCodexModelProbe,
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true),
    mockDetectClaudeModels: vi.fn(),
    mockStopClaudeModelProbe: vi.fn(),
    mockDetectCodexModels: vi.fn(),
    mockStopCodexModelProbe: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/utils/detectClaudeModels', () => ({
    detectClaudeModels: mockDetectClaudeModels,
    stopClaudeModelProbe: mockStopClaudeModelProbe,
}));

vi.mock('@/utils/detectCodexModels', () => ({
    detectCodexModels: mockDetectCodexModels,
    stopCodexModelProbe: mockStopCodexModelProbe,
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockDetectClaudeModels.mockResolvedValue(undefined);
        mockDetectCodexModels.mockResolvedValue(undefined);
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('emits machine-alive immediately when the socket connects', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive')).toHaveLength(0);

        emitSocketEvent('connect');

        let aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);
        expect(aliveCalls[0][1]).toEqual(expect.objectContaining({
            machineId: 'test-machine-id',
            time: expect.any(Number)
        }));

        await vi.advanceTimersByTimeAsync(19999);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(2);

        client.shutdown();
    });

    it('republishes the running CLI version without dropping stored machine fields', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const machine = makeMachine();
        machine.metadata.happyCliVersion = '1.0.0';
        const storedMetadata = machine.metadata as Machine['metadata'] & { displayName?: string };
        storedMetadata.displayName = 'My Mac';
        const client = new ApiMachineClient('fake-token', machine);
        let publishedMetadata: (Machine['metadata'] & { displayName?: string }) | null = null;
        vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async (handler) => {
            publishedMetadata = handler(storedMetadata);
        });
        client.connect();

        emitSocketEvent('connect');

        expect(publishedMetadata).toEqual(expect.objectContaining({
            displayName: 'My Mac',
            happyCliVersion: 'test',
            cliAvailability: expect.objectContaining({
                claude: false,
                codex: false,
            }),
        }));

        client.shutdown();
    });

    it('starts the Claude model probe without awaiting socket startup, then publishes its result', async () => {
        let resolveModels: ((models: Array<any>) => void) | undefined;
        mockDetectClaudeModels.mockReturnValue(new Promise((resolve) => {
            resolveModels = resolve;
        }));
        const client = new ApiMachineClient('fake-token', makeMachine());
        const update = vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async (handler) => {
            handler(makeMachine().metadata);
        });
        client.connect();

        emitSocketEvent('connect');

        expect(mockDetectClaudeModels).toHaveBeenCalledTimes(1);
        const updatesBeforeProbeResolves = update.mock.calls.length;

        resolveModels?.([{
            value: 'claude-opus-5',
            displayName: 'Opus 5',
            description: 'Most capable',
        }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(update.mock.calls).toHaveLength(updatesBeforeProbeResolves + 1);
        const modelUpdate = update.mock.calls.at(-1)?.[0];
        expect(modelUpdate?.(makeMachine().metadata)).toMatchObject({
            claudeModels: [{ value: 'claude-opus-5' }],
        });
        client.shutdown();
        expect(mockStopClaudeModelProbe).toHaveBeenCalledTimes(1);
    });

    it('starts the Codex model probe without awaiting socket startup, then publishes its result', async () => {
        let resolveModels: ((models: Array<any>) => void) | undefined;
        mockDetectCodexModels.mockReturnValue(new Promise((resolve) => {
            resolveModels = resolve;
        }));
        const client = new ApiMachineClient('fake-token', makeMachine());
        const update = vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async (handler) => {
            handler(makeMachine().metadata);
        });
        client.connect();

        emitSocketEvent('connect');

        expect(mockDetectCodexModels).toHaveBeenCalledTimes(1);
        const updatesBeforeProbeResolves = update.mock.calls.length;

        resolveModels?.([{
            id: 'gpt-6-astra',
            model: 'gpt-6-astra',
            displayName: 'GPT-6 Astra',
            description: 'Most capable',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
        }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(update.mock.calls).toHaveLength(updatesBeforeProbeResolves + 1);
        const modelUpdate = update.mock.calls.at(-1)?.[0];
        expect(modelUpdate?.(makeMachine().metadata)).toMatchObject({
            codexModels: [{ model: 'gpt-6-astra' }],
        });
        client.shutdown();
        expect(mockStopCodexModelProbe).toHaveBeenCalledTimes(1);
    });
});
