import { describe, expect, it } from 'vitest';
import { MachineMetadataSchema } from './types';

const oldMachineMetadata = {
  host: 'workstation',
  platform: 'darwin',
  happyCliVersion: '1.2.3',
  homeDir: '/Users/person',
  happyHomeDir: '/Users/person/.happy',
  happyLibDir: '/Users/person/.happy/lib',
};

describe('MachineMetadataSchema', () => {
  it('accepts metadata from CLI versions that do not report Claude models', () => {
    expect(MachineMetadataSchema.parse(oldMachineMetadata).claudeModels).toBeUndefined();
  });

  it('accepts a CLI-verified Claude model list', () => {
    const metadata = MachineMetadataSchema.parse({
      ...oldMachineMetadata,
      claudeModels: [{
        value: 'claude-opus-5',
        resolvedModel: 'claude-opus-5',
        displayName: 'Opus 5',
        description: 'Most capable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
      }],
    });

    expect(metadata.claudeModels?.[0]?.value).toBe('claude-opus-5');
  });
});
