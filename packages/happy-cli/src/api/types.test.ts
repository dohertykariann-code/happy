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

  it('accepts metadata from CLI versions that do not report Codex models', () => {
    expect(MachineMetadataSchema.parse(oldMachineMetadata).codexModels).toBeUndefined();
  });

  it('accepts a CLI-verified Codex model list', () => {
    const metadata = MachineMetadataSchema.parse({
      ...oldMachineMetadata,
      codexModels: [{
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        description: 'Most capable',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      }],
    });

    expect(metadata.codexModels?.[0]?.model).toBe('gpt-6-astra');
  });

  it('accepts metadata from CLI versions that do not report DeepInfra models', () => {
    expect(MachineMetadataSchema.parse(oldMachineMetadata).deepInfraModels).toBeUndefined();
  });

  it('accepts a CLI-verified DeepInfra model list', () => {
    const metadata = MachineMetadataSchema.parse({
      ...oldMachineMetadata,
      deepInfraModels: [{ id: 'openai/zai-org/GLM-5.2', displayName: 'GLM-5.2' }],
    });

    expect(metadata.deepInfraModels?.[0]?.id).toBe('openai/zai-org/GLM-5.2');
  });
});
