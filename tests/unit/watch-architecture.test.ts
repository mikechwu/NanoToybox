/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the Watch Round 1 architecture upgrade:
 *   - src/config/viewer-defaults.ts (shared config extraction)
 *   - watch-document-service.ts (transactional prepare)
 *   - watch-playback-model.ts (consolidated playback policy: advance, startPlayback, pausePlayback, seekTo)
 *   - watch-controller.ts (thin facade delegation)
 */

import { describe, it, expect } from 'vitest';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import { CONFIG } from '../../lab/js/config';
import { createWatchDocumentService } from '../../watch/js/watch-document-service';
import { createWatchPlaybackModel } from '../../watch/js/watch-playback-model';
import { createWatchController } from '../../watch/js/watch-controller';
import { importFullHistory } from '../../watch/js/full-history-import';

// ── Shared fixture ──

function makeValidFileText(): string {
  return JSON.stringify({
    format: 'atomdojo-history', version: 1, kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-06T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.1, 0, 0], interaction: null, boundary: {} },
      ],
      restartFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], velocities: [0, 0, 0, 0, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.1, 0, 0], velocities: [0.01, 0, 0, 0.01, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
      ],
      checkpoints: [],
    },
  });
}

// ── Shared viewer defaults ──

describe('VIEWER_DEFAULTS', () => {
  it('has baseSimRatePsPerSecond', () => {
    expect(VIEWER_DEFAULTS.baseSimRatePsPerSecond).toBe(0.12);
  });

  it('has defaultTheme', () => {
    expect(VIEWER_DEFAULTS.defaultTheme).toBe('light');
  });

  it('lab CONFIG references the same values', () => {
    expect(CONFIG.playback.baseSimRatePsPerSecond).toBe(VIEWER_DEFAULTS.baseSimRatePsPerSecond);
  });
});

// ── Document service ──

describe('WatchDocumentService', () => {
  it('prepares a valid file successfully', async () => {
    const service = createWatchDocumentService();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    const result = await service.prepare(file);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.history.denseFrames).toHaveLength(2);
      expect(result.fileName).toBe('test.atomdojo');
    }
  });

  it('returns error for invalid JSON', async () => {
    const service = createWatchDocumentService();
    const file = new File(['not json'], 'bad.txt');
    const result = await service.prepare(file);
    expect(result.status).toBe('error');
  });

  it('returns error for unsupported kind', async () => {
    const service = createWatchDocumentService();
    const json = makeValidFileText();
    const modified = json.replace('"full"', '"replay"');
    const file = new File([modified], 'replay.atomdojo');
    const result = await service.prepare(file);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('Replay');
    }
  });

  it('does not modify any external state (non-destructive)', async () => {
    const service = createWatchDocumentService();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    // Just verify it doesn't throw — it has no side effects
    const result = await service.prepare(file);
    expect(result.status).toBe('ready');
  });
});

// ── Playback model policy commands ──

describe('WatchPlaybackModel policy commands', () => {
  function loadModel() {
    const model = createWatchPlaybackModel();
    const history = importFullHistory(JSON.parse(makeValidFileText()));
    model.load(history);
    return model;
  }

  it('advance() moves time forward at canonical x1 rate', () => {
    const model = loadModel();
    model.startPlayback();
    expect(model.isPlaying()).toBe(true);

    const before = model.getCurrentTimePs();
    model.advance(16.7); // one RAF tick
    const after = model.getCurrentTimePs();

    // Should advance by dtMs * PS_PER_MS_AT_1X = 16.7 * 0.00012 ≈ 0.002
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeCloseTo(16.7 * VIEWER_DEFAULTS.baseSimRatePsPerSecond / 1000, 6);
  });

  it('advance() does nothing when paused', () => {
    const model = loadModel();
    model.pausePlayback();
    const before = model.getCurrentTimePs();
    model.advance(100);
    expect(model.getCurrentTimePs()).toBe(before);
  });

  it('advance() auto-pauses at end (repeat off)', () => {
    const model = loadModel();
    model.setRepeat(false);
    model.startPlayback();
    model.setSpeed(20); // high speed to reach end fast
    // Advance in capped steps (gap clamp = 250ms) until end
    for (let i = 0; i < 100000; i++) {
      model.advance(250);
      if (!model.isPlaying()) break;
    }
    expect(model.isPlaying()).toBe(false);
    expect(model.getCurrentTimePs()).toBe(model.getEndTimePs());
  });

  it('startPlayback() resets to start if at end', () => {
    const model = loadModel();
    model.seekTo(model.getEndTimePs());
    expect(model.getCurrentTimePs()).toBe(model.getEndTimePs());

    model.startPlayback();
    expect(model.isPlaying()).toBe(true);
    expect(model.getCurrentTimePs()).toBe(model.getStartTimePs());
  });

  it('pausePlayback() stops playing', () => {
    const model = loadModel();
    model.startPlayback();
    expect(model.isPlaying()).toBe(true);
    model.pausePlayback();
    expect(model.isPlaying()).toBe(false);
  });

  it('seekTo() moves time and pauses', () => {
    const model = loadModel();
    model.startPlayback();
    model.seekTo(50);
    expect(model.getCurrentTimePs()).toBe(50);
    expect(model.isPlaying()).toBe(false);
  });

  it('seekTo() clamps to range', () => {
    const model = loadModel();
    model.seekTo(-100);
    expect(model.getCurrentTimePs()).toBe(model.getStartTimePs());
    model.seekTo(1e6);
    expect(model.getCurrentTimePs()).toBe(model.getEndTimePs());
  });
});

// ── Facade delegation ──

describe('WatchController facade delegation', () => {
  it('openFile delegates to document service', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);
    expect(controller.getSnapshot().loaded).toBe(true);
    expect(controller.getSnapshot().fileName).toBe('test.atomdojo');
    controller.dispose();
  });

  it('togglePlay delegates to playback model startPlayback/pausePlayback', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    // Auto-play starts on file open; first toggle pauses.
    expect(controller.getSnapshot().playing).toBe(true);
    controller.togglePlay();
    expect(controller.getSnapshot().playing).toBe(false);
    controller.togglePlay();
    expect(controller.getSnapshot().playing).toBe(true);
    controller.dispose();
  });

  it('scrub delegates to playback model seekTo', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    controller.scrub(50);
    expect(controller.getSnapshot().currentTimePs).toBe(50);
    expect(controller.getSnapshot().playing).toBe(false);
    controller.dispose();
  });

  it('bad file preserves current document (transactional)', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'good.atomdojo');
    await controller.openFile(file);
    expect(controller.getSnapshot().loaded).toBe(true);

    const bad = new File(['bad'], 'bad.atomdojo');
    await controller.openFile(bad);
    expect(controller.getSnapshot().loaded).toBe(true);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(controller.getSnapshot().fileName).toBe('good.atomdojo');
    controller.dispose();
  });

  it('facade composes one snapshot from all domains', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    // Document domain fields
    expect(snap.fileName).toBe('test.atomdojo');
    expect(snap.fileKind).toBe('full');
    expect(snap.atomCount).toBe(2);
    // Playback domain fields
    expect(snap.currentTimePs).toBeGreaterThan(0);
    expect(snap.startTimePs).toBeGreaterThan(0);
    expect(snap.endTimePs).toBe(100);
    // Analysis domain fields
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].atomCount).toBe(2);
    controller.dispose();
  });
});

// ── Ownership boundary assertions ──

describe('Architecture ownership boundaries', () => {
  it('controller does not own file parsing/import policy', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(dir, '../../watch/js/watch-controller.ts'), 'utf8');
    // Controller must not call file parsing functions at runtime.
    // Runtime imports from history-file-loader are forbidden entirely.
    expect(src).not.toContain("from './history-file-loader'");
    // Round 6: controller may reference types from full-history-import (to
    // describe capability-layer fields and import diagnostics in its snapshot
    // interface) but must NOT invoke runtime functions from it. Enforce via
    // type-only import: `import type { ... } from './full-history-import';`
    // Runtime imports (without `type`) remain forbidden.
    const runtimeImport = /^\s*import\s+\{[^}]*\}\s*from\s*['"]\.\/full-history-import['"]/m;
    expect(runtimeImport.test(src)).toBe(false);
    // Controller never calls importFullHistory / loadHistoryFile.
    expect(src).not.toMatch(/\bimportFullHistory\s*\(/);
    expect(src).not.toMatch(/\bloadHistoryFile\s*\(/);
  });

  it('controller does not own playback rate constant', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(dir, '../../watch/js/watch-controller.ts'), 'utf8');
    expect(src).not.toContain('PS_PER_MS_AT_1X');
    expect(src).not.toContain('baseSimRatePsPerSecond');
  });

  it('playback model owns the rate constant from shared config', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(dir, '../../watch/js/watch-playback-model.ts'), 'utf8');
    expect(src).toContain('PS_PER_MS_AT_1X');
    expect(src).toContain('VIEWER_DEFAULTS');
  });
});

// ── Behavioral ownership tests ──

describe('Document metadata ownership', () => {
  it('document metadata comes from document service, not controller locals', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'meta-test.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    expect(snap.fileName).toBe('meta-test.atomdojo');
    expect(snap.fileKind).toBe('full');
    expect(snap.atomCount).toBe(2);
    expect(snap.frameCount).toBe(2);
    expect(snap.maxAtomCount).toBe(2);
    controller.dispose();
  });

  it('document metadata is preserved after failed file replacement', async () => {
    const controller = createWatchController();
    await controller.openFile(new File([makeValidFileText()], 'original.atomdojo'));
    expect(controller.getSnapshot().fileName).toBe('original.atomdojo');

    await controller.openFile(new File(['bad'], 'bad.atomdojo'));
    // Document metadata should still be from original file
    expect(controller.getSnapshot().fileName).toBe('original.atomdojo');
    expect(controller.getSnapshot().fileKind).toBe('full');
    controller.dispose();
  });
});

describe('Analysis rollback via explicit recomputation', () => {
  it('groups after failed file replacement are explicitly recomputed from prior state', async () => {
    const controller = createWatchController();
    await controller.openFile(new File([makeValidFileText()], 'good.atomdojo'));

    const snapBefore = controller.getSnapshot();
    expect(snapBefore.groups.length).toBeGreaterThan(0);
    const groupsBefore = snapBefore.groups;

    await controller.openFile(new File(['bad'], 'bad.atomdojo'));

    const snapAfter = controller.getSnapshot();
    expect(snapAfter.loaded).toBe(true);
    expect(snapAfter.error).toBeTruthy();
    expect(snapAfter.groups).toHaveLength(groupsBefore.length);
    expect(snapAfter.groups[0]?.atomCount).toBe(groupsBefore[0]?.atomCount);
    controller.dispose();
  });
});

describe('Snapshot building is pure (no side effects)', () => {
  it('calling getSnapshot multiple times does not mutate analysis state', async () => {
    const controller = createWatchController();
    await controller.openFile(new File([makeValidFileText()], 'test.atomdojo'));

    const groups1 = controller.getBondedGroups().getSummaries();
    controller.getSnapshot();
    controller.getSnapshot();
    controller.getSnapshot();
    const groups2 = controller.getBondedGroups().getSummaries();

    // Summaries should be referentially identical — no mutation from getSnapshot
    expect(groups1).toBe(groups2);
    controller.dispose();
  });
});

// ── Watch no longer imports lab CONFIG ──

describe('Watch decoupled from lab CONFIG', () => {
  it('watch-controller does not import from lab/js/config', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(dir, '../../watch/js/watch-controller.ts'), 'utf8');
    expect(src).not.toContain("from '../../lab/js/config'");
    expect(src).not.toContain('from "../../lab/js/config"');
  });

  it('watch-playback-model imports from shared viewer-defaults', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(dir, '../../watch/js/watch-playback-model.ts'), 'utf8');
    expect(src).toContain("from '../../src/config/viewer-defaults'");
  });
});
