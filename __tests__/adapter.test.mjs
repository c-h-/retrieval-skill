import { describe, expect, it } from 'vitest';
import {
  clearRegistry,
  getAdapter,
  getAdaptersByType,
  registerAdapter,
  validateAdapter,
} from '../src/adapters/adapter.mjs';

describe('validateAdapter', () => {
  it('validates a complete text adapter', () => {
    const adapter = {
      name: 'test-text',
      type: 'text',
      init: async () => {},
      embedQuery: async () => new Float32Array(4),
      embedDocuments: async () => [new Float32Array(4)],
      embeddingDim: () => 4,
      modelId: () => 'test-model',
      dispose: async () => {},
    };
    expect(validateAdapter(adapter)).toBe(true);
  });

  it('validates a complete vision adapter', () => {
    const adapter = {
      name: 'test-vision',
      type: 'vision',
      init: async () => {},
      embedQuery: async () => [new Float32Array(4)],
      embedImages: async () => [[new Float32Array(4)]],
      embeddingDim: () => 128,
      modelId: () => 'test-vision-model',
      dispose: async () => {},
    };
    expect(validateAdapter(adapter)).toBe(true);
  });

  it('throws on missing required property', () => {
    const adapter = { name: 'broken', type: 'text' };
    expect(() => validateAdapter(adapter)).toThrow('missing required property');
  });

  it('throws if text adapter missing embedDocuments', () => {
    const adapter = {
      name: 'bad-text',
      type: 'text',
      init: async () => {},
      embedQuery: async () => {},
      embeddingDim: () => 4,
      modelId: () => 'x',
      dispose: async () => {},
    };
    expect(() => validateAdapter(adapter)).toThrow('embedDocuments');
  });

  it('throws if vision adapter missing embedImages', () => {
    const adapter = {
      name: 'bad-vision',
      type: 'vision',
      init: async () => {},
      embedQuery: async () => {},
      embeddingDim: () => 4,
      modelId: () => 'x',
      dispose: async () => {},
    };
    expect(() => validateAdapter(adapter)).toThrow('embedImages');
  });
});

describe('adapter registry', () => {
  const textAdapter = {
    name: 'reg-text',
    type: 'text',
    init: async () => {},
    embedQuery: async () => new Float32Array(4),
    embedDocuments: async () => [new Float32Array(4)],
    embeddingDim: () => 4,
    modelId: () => 'model-a',
    dispose: async () => {},
  };

  const visionAdapter = {
    name: 'reg-vision',
    type: 'vision',
    init: async () => {},
    embedQuery: async () => [new Float32Array(4)],
    embedImages: async () => [[new Float32Array(4)]],
    embeddingDim: () => 128,
    modelId: () => 'model-b',
    dispose: async () => {},
  };

  it('registers and retrieves adapters', () => {
    clearRegistry();
    registerAdapter(textAdapter);
    registerAdapter(visionAdapter);

    expect(getAdapter('reg-text').name).toBe('reg-text');
    expect(getAdapter('reg-vision').name).toBe('reg-vision');
  });

  it('throws for unknown adapter', () => {
    clearRegistry();
    expect(() => getAdapter('nonexistent')).toThrow('No adapter registered');
  });

  it('filters adapters by type', () => {
    clearRegistry();
    registerAdapter(textAdapter);
    registerAdapter(visionAdapter);

    const textAdapters = getAdaptersByType('text');
    expect(textAdapters.length).toBe(1);
    expect(textAdapters[0].name).toBe('reg-text');

    const visionAdapters = getAdaptersByType('vision');
    expect(visionAdapters.length).toBe(1);
    expect(visionAdapters[0].name).toBe('reg-vision');
  });
});
