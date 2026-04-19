/**
 * Tests for src/share/capsule-preview.ts (descriptor builder).
 * Covers spec §1 identity contract: figure geometry is a pure function of
 * shareCode + kind; title/theme/dates never affect identity fields.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCapsulePreviewDescriptor,
  type CapsulePreviewInput,
} from '../../src/share/capsule-preview';
import fixtures from '../../src/share/__fixtures__/capsule-preview-inputs.json';

const baseInput = (over: Partial<CapsulePreviewInput> = {}): CapsulePreviewInput => ({
  shareCode: '7M4K2D8Q9T1V',
  title: 'Diamond cluster',
  kind: 'capsule',
  atomCount: 64,
  frameCount: 240,
  sizeBytes: 12345,
  createdAt: '2026-04-13T00:00:00Z',
  ...over,
});

describe('buildCapsulePreviewDescriptor', () => {
  it('is deterministic — identical input produces deep-equal descriptors', () => {
    expect(buildCapsulePreviewDescriptor(baseInput())).toEqual(
      buildCapsulePreviewDescriptor(baseInput()),
    );
  });

  it('snapshot for fixed shareCode (golden)', () => {
    const d = buildCapsulePreviewDescriptor(baseInput());
    expect({
      mode: d.mode,
      figureVariant: d.figureVariant,
      density: d.density,
      themeVariant: d.themeVariant,
      shareCode: d.shareCode,
    }).toMatchInlineSnapshot(`
      {
        "density": "medium",
        "figureVariant": "ring-fused",
        "mode": "static-figure",
        "shareCode": "7M4K2D8Q9T1V",
        "themeVariant": "light",
      }
    `);
  });

  it('title independence — changing title does not change identity fields', () => {
    const a = buildCapsulePreviewDescriptor(baseInput({ title: 'AAA' }));
    const b = buildCapsulePreviewDescriptor(baseInput({ title: 'something completely different' }));
    expect(b.figureVariant).toBe(a.figureVariant);
    expect(b.accentColor).toBe(a.accentColor);
    expect(b.density).toBe(a.density);
  });

  it('createdAt / sizeBytes do not change identity fields', () => {
    const a = buildCapsulePreviewDescriptor(baseInput());
    const b = buildCapsulePreviewDescriptor(baseInput({
      createdAt: '2030-01-01T00:00:00Z',
      sizeBytes: 999_999_999,
    }));
    expect(b.figureVariant).toBe(a.figureVariant);
    expect(b.accentColor).toBe(a.accentColor);
    expect(b.density).toBe(a.density);
  });

  it('themeVariant is presentation-only — does not change identity fields', () => {
    const light = buildCapsulePreviewDescriptor(baseInput(), { themeVariant: 'light' });
    const dark = buildCapsulePreviewDescriptor(baseInput(), { themeVariant: 'dark' });
    expect(dark.figureVariant).toBe(light.figureVariant);
    expect(dark.accentColor).toBe(light.accentColor);
    expect(dark.density).toBe(light.density);
    expect(dark.themeVariant).toBe('dark');
  });

  it('wrong-audience fallback — unknown kind → neutral-brand', () => {
    const d = buildCapsulePreviewDescriptor(baseInput({ kind: 'mystery-blob' }));
    expect(d.figureVariant).toBe('neutral-brand');
  });

  it.each(['md', 'md-capsule', 'structure', 'full', 'capsule'])(
    'known molecular kind %s yields a non-neutral variant',
    (kind) => {
      const d = buildCapsulePreviewDescriptor(baseInput({ kind }));
      expect(d.figureVariant).not.toBe('neutral-brand');
    },
  );

  it('density buckets follow atomCount thresholds', () => {
    expect(buildCapsulePreviewDescriptor(baseInput({ atomCount: 8 })).density).toBe('low');
    expect(buildCapsulePreviewDescriptor(baseInput({ atomCount: 64 })).density).toBe('medium');
    expect(buildCapsulePreviewDescriptor(baseInput({ atomCount: 1024 })).density).toBe('high');
  });

  it('uses sanitized title — never the raw input', () => {
    const d = buildCapsulePreviewDescriptor(baseInput({ title: '   ' }));
    expect(d.title).toBe('Atom Dojo Capsule');
  });

  it('uses fallback subtitle when atomCount/frameCount are zero/missing', () => {
    const d = buildCapsulePreviewDescriptor(baseInput({ atomCount: 0, frameCount: 0 }));
    expect(d.subtitle).toBe('Interactive molecular dynamics scene');
  });

  it('every fixture builds a stable descriptor', () => {
    for (const f of fixtures as CapsulePreviewInput[]) {
      const a = buildCapsulePreviewDescriptor(f);
      const b = buildCapsulePreviewDescriptor(f);
      expect(a).toEqual(b);
      expect(a.title.length).toBeGreaterThan(0);
    }
  });
});
