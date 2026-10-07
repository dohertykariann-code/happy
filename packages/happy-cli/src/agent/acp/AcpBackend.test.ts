import { describe, expect, it } from 'vitest';

import { buildAcpPromptContent } from './AcpBackend';

describe('buildAcpPromptContent', () => {
  const prompt = 'Describe this screenshot';

  it('keeps text-only prompts byte-for-byte compatible', () => {
    expect(buildAcpPromptContent(prompt)).toEqual([{ type: 'text', text: prompt }]);
  });

  it('adds ACP image blocks ahead of the text block', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]);

    expect(buildAcpPromptContent(prompt, [{ data: png, mimeType: 'image/heic', name: 'screen' }])).toEqual([
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: prompt },
    ]);
  });

  it('skips invalid attachments without blocking the text prompt', () => {
    expect(buildAcpPromptContent(prompt, [{ data: new Uint8Array([0x00]), mimeType: 'image/png', name: 'bad' }])).toEqual([
      { type: 'text', text: prompt },
    ]);
  });
});
