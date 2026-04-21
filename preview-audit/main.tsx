/**
 * Capsule preview audit page — local dev tool.
 *
 * Wiki-style workbench for reviewing the capsule figure renderer.
 * Loads a capsule file (from disk or a built-in fixture), runs it
 * through the real production pipeline modules, and lays out:
 *
 *   § 4  Current baselines     — poster + thumb as users see them today
 *   § 5  Experimental variants — large/poster/thumb from the proposed
 *                                 unified sketch renderer
 *
 * Every SVG below the controls comes from the actual shared modules
 * the production bundle uses — no re-implementations.
 *
 * Production-exclusion guard: throws if accidentally bundled for
 * production. Additional gating in `vite.config.ts` via `command +
 * PREVIEW_AUDIT_BUILD`; see `tests/unit/preview-audit-production-
 * exclusion.test.ts`.
 */

// Defence-in-depth: this module never runs in production. The primary
// exclusion is the conditional Vite input in `vite.config.ts`; this
// guard is a second fence for anyone who bypasses it.
if (import.meta.env.PROD) {
  throw new Error('preview-audit is dev-only and must not be shipped');
}

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildPreviewSceneFromCapsule,
  type CapsulePreviewScene3D,
} from '../src/share/capsule-preview-frame';
import {
  projectPreviewScene,
  deriveBondPairs,
  deriveBondPairsForProjectedScene,
  type CapsulePreviewRenderScene,
} from '../src/share/capsule-preview-project';
import {
  selectPreviewSubjectCluster,
  type PreviewClusterSelectionDiagnostics,
} from '../src/share/capsule-preview-cluster-select';
import {
  renderPreviewSketchSvgNode,
} from '../src/share/capsule-preview-sketch';
import {
  PERSPECTIVE_LARGE_PRESET,
  PERSPECTIVE_POSTER_PRESET,
  PERSPECTIVE_THUMB_PRESET,
  renderPerspectiveSketch,
  type PerspectivePreset,
} from '../src/share/capsule-preview-sketch-perspective';
import { projectCapsuleToSceneJson } from '../src/share/publish-core';
import {
  parsePreviewSceneV1,
  derivePreviewThumbV1,
  CURRENT_THUMB_REV,
  type PreviewSceneV1,
  type PreviewThumbV1,
} from '../src/share/capsule-preview-scene-store';
import { deriveAccountThumb } from '../src/share/capsule-preview-account-derive';
import { CurrentPosterSceneSvg } from '../src/share/capsule-preview-current-poster';
import {
  CurrentThumbSvg,
  CURRENT_THUMB_DEFAULT_INK,
  THUMB_STYLE_HALOED,
} from '../src/share/capsule-preview-current-thumb';
import { ACCOUNT_THUMB_SIZE } from '../src/share/capsule-preview-thumb-size';

/** Enlarged-for-review display size of the account-row thumb figures
 *  in § 4. Deliberately derived from {@link ACCOUNT_THUMB_SIZE} — when
 *  the ship size changes, the inspection size follows at a fixed
 *  visual ratio. The `*2` gives reviewers room to examine glyph
 *  legibility without manual zoom, while staying inside a cols-2
 *  grid cell on a typical desktop viewport.
 *
 *  Kept as a plain local constant rather than a shared export: only
 *  the audit page renders thumbs at this "inspection" size. */
const AUDIT_THUMB_INSPECTION_SIZE = ACCOUNT_THUMB_SIZE * 2;
const AUDIT_THUMB_INSPECTION_RATIO = Math.round(
  AUDIT_THUMB_INSPECTION_SIZE / ACCOUNT_THUMB_SIZE,
);
import { validateCapsuleFile } from '../src/history/history-file-v1';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../src/history/history-file-v1';
import {
  makeC60Capsule,
  makeGrapheneCapsule,
  makeCntCapsule,
  makeSparseSmallCapsule,
  makeDenseNoisyCapsule,
  makeWaterClusterCapsule,
  makeOxidePatchCapsule,
  makeSimpleOrganicCapsule,
  makeFragmentedCapsule,
  makeTwoEqualFragmentsCapsule,
  makeCloseApproachCapsule,
} from '../src/share/__fixtures__/capsule-preview-structures';

// ── Fixture registry ──────────────────────────────────────────────────

interface FixtureEntry {
  id: string;
  label: string;
  bucket: 'structural' | 'color';
  build: () => AtomDojoPlaybackCapsuleFileV1;
}

const FIXTURES: FixtureEntry[] = [
  { id: 'c60', label: 'C60 fullerene', bucket: 'structural', build: makeC60Capsule },
  { id: 'graphene', label: 'Graphene sheet', bucket: 'structural', build: makeGrapheneCapsule },
  { id: 'cnt', label: 'Carbon nanotube', bucket: 'structural', build: makeCntCapsule },
  { id: 'sparse', label: 'Sparse small (4 atoms)', bucket: 'structural', build: makeSparseSmallCapsule },
  { id: 'dense', label: 'Dense noisy (24 atoms)', bucket: 'structural', build: makeDenseNoisyCapsule },
  { id: 'water', label: 'Water cluster (8·H2O)', bucket: 'color', build: makeWaterClusterCapsule },
  { id: 'oxide', label: 'SiO2 fragment', bucket: 'color', build: makeOxidePatchCapsule },
  { id: 'organic', label: 'Simple organic (glycine)', bucket: 'color', build: makeSimpleOrganicCapsule },
  // Cluster-selection fixtures (ADR D138) — exercise both guard-pass
  // and guard-reject paths on the audit page.
  { id: 'fragmented', label: 'Fragmented (dominant + noise)', bucket: 'structural', build: makeFragmentedCapsule },
  { id: 'balanced', label: 'Two equal fragments', bucket: 'structural', build: makeTwoEqualFragmentsCapsule },
  { id: 'close-approach', label: 'Close approach (proximity fusion)', bucket: 'structural', build: makeCloseApproachCapsule },
];

// ── Derived views — staged so errors name the failing pipeline step ──

interface DerivedViews {
  capsule: AtomDojoPlaybackCapsuleFileV1;
  /** Pre-selection scene — the raw first dense frame. */
  fullScene3D: CapsulePreviewScene3D;
  /** Post-selection scene — cluster-filtered when the dominance guard
   *  passes, otherwise identical to `fullScene3D`. The experimental
   *  renderers draw from this. */
  scene3D: CapsulePreviewScene3D;
  clusterDiagnostics: PreviewClusterSelectionDiagnostics;
  projected: CapsulePreviewRenderScene;
  projectedBonds: Array<{ a: number; b: number; depth: number }>;
  storedPoster: PreviewSceneV1 | null;
  storedThumb: PreviewThumbV1 | null;
  /** Thumb derived through the **exact** account-API call
   *  (`deriveAccountThumb`) against the live-published scene JSON.
   *  For a fresh rev-3 row this matches `storedThumb` via the
   *  stored-thumb fast path. */
  accountThumb: PreviewThumbV1 | null;
  /** Thumb derived through the account-API call against a **forced-
   *  stale** copy of the stored scene (`thumb` payload dropped). Shows
   *  what legacy rev<CURRENT_THUMB_REV rows render as on the account
   *  page before a backfill runs. Lives alongside `accountThumb` so
   *  reviewers can see the same divergence a stale production row
   *  would show, without having to dig into D1. */
  accountThumbStaleFallback: PreviewThumbV1 | null;
}

/** Named-stage wrapper so a failure tells the reviewer WHERE the
 *  pipeline broke instead of just bubbling up "Cannot read properties
 *  of undefined". Also logs the full Error to the console so the dev
 *  gets a stack they can paste into a bug report. */
function runStage<T>(stage: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[preview-audit] stage "${stage}" threw:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${stage}: ${msg}`);
  }
}

function deriveViews(capsule: AtomDojoPlaybackCapsuleFileV1): DerivedViews | { error: string } {
  try {
    const fullScene3D = runStage('buildPreviewSceneFromCapsule', () =>
      buildPreviewSceneFromCapsule(capsule),
    );
    const cutoff = capsule.bondPolicy?.cutoff ?? 1.85;
    const minDist = capsule.bondPolicy?.minDist ?? 0.5;
    // Subject-cluster selection (ADR D138) — both the production
    // pipeline and this audit page route through the same helper, so
    // CURRENT baselines and EXPERIMENTAL figures always represent the
    // same physical subject.
    const fullBondPairs = runStage('deriveBondPairs', () =>
      deriveBondPairs(fullScene3D, cutoff, minDist),
    );
    const selection = runStage('selectPreviewSubjectCluster', () =>
      selectPreviewSubjectCluster(fullScene3D, fullBondPairs, {
        mode: 'largest-bonded-cluster',
      }),
    );
    const scene3D = selection.scene;
    const clusterDiagnostics = selection.diagnostics;
    // Canonical projection — runs on the selected subject so the
    // "Pipeline metadata" counts (projected atoms/bonds) are consistent
    // with what the experimental renderers draw from.
    const projected = runStage('projectPreviewScene', () =>
      projectPreviewScene(scene3D, {
        targetWidth: 800,
        targetHeight: 800,
        padding: 0,
      }),
    );
    const projectedBonds = runStage('deriveBondPairsForProjectedScene', () =>
      deriveBondPairsForProjectedScene(scene3D, projected, cutoff, minDist),
    );
    const sceneJson = runStage('projectCapsuleToSceneJson', () =>
      projectCapsuleToSceneJson(capsule),
    );
    const storedPoster = sceneJson ? parsePreviewSceneV1(sceneJson) : null;
    const storedThumb = sceneJson ? derivePreviewThumbV1(sceneJson) : null;
    // Production parity: derive through the exact account-API path.
    // Same helper the account route uses, so audit and production
    // cannot drift.
    const accountThumb = sceneJson ? deriveAccountThumb(sceneJson) : null;
    // Stale-row fallback: force-drop the embedded `thumb` payload so
    // `derivePreviewThumbV1` takes the live-sampling branch (the same
    // branch a legacy rev<CURRENT row hits after the rev bump).
    const accountThumbStaleFallback = (() => {
      if (!sceneJson) return null;
      try {
        const parsed = JSON.parse(sceneJson) as Record<string, unknown>;
        delete parsed.thumb;
        return deriveAccountThumb(JSON.stringify(parsed));
      } catch {
        return null;
      }
    })();
    return {
      capsule, fullScene3D, scene3D, clusterDiagnostics,
      projected, projectedBonds, storedPoster, storedThumb,
      accountThumb, accountThumbStaleFallback,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Source tracking ───────────────────────────────────────────────────

type Source =
  | { kind: 'fixture'; id: string; label: string }
  | { kind: 'file'; name: string; sizeBytes: number }
  | { kind: 'none' };

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Error boundary ────────────────────────────────────────────────────

/**
 * Catches render-time throws in the figure subtree so a buggy
 * renderer doesn't blank the page. Reports into the same `.pa-error`
 * surface the pipeline/file errors use, so the reviewer sees exactly
 * where the crash happened without digging into devtools.
 */
class FigureErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[preview-audit] figure render threw:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="pa-error" role="alert">
          <strong>Figure render failed:</strong> {this.state.error.message}
          {' '}<button type="button" className="pa-reset" onClick={this.reset}>retry</button>
          <span style={{ display: 'block', marginTop: 4, fontFamily: 'var(--ff-mono)', fontSize: 11.5 }}>
            Full stack in the browser console.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Sketch-panel figure ───────────────────────────────────────────────

interface SketchFigureProps {
  title: string;
  preset: PerspectivePreset;
  views: DerivedViews;
  /** True → figure spans the full row (`grid-column: 1 / -1`). The
   *  parent grid handles sizing for non-full figures via its `cols-2`
   *  / `cols-3` template, so no per-figure fractional classes are
   *  needed. */
  fullWidth?: boolean;
  caption: React.ReactNode;
}

function SketchFigure(props: SketchFigureProps): React.ReactElement {
  const { title, preset, views, fullWidth, caption } = props;
  const cutoff = views.capsule.bondPolicy?.cutoff ?? 1.85;
  const minDist = views.capsule.bondPolicy?.minDist ?? 0.5;
  const { svg, stats } = renderPerspectiveSketch(views.scene3D, preset, {
    cutoff,
    minDist,
  });
  // Explicit empty state so a 0-atom scene does not silently render as
  // a blank white panel indistinguishable from a successful render.
  const isEmpty = stats.atoms === 0;
  return (
    <figure className={`pa-figure${fullWidth ? ' span-row' : ''}`}>
      <div className="pa-figure-head">
        <h3 className="pa-figure-title">{title}</h3>
        <span className="pa-tag pa-tag--experimental">experimental</span>
      </div>
      {/*
        Two distinct surfaces — the normal path uses
        dangerouslySetInnerHTML to splat the renderer's SVG string,
        and the empty-state path uses a plain child. Keeping them as
        separate elements avoids React's runtime refusal to accept
        both `children` and `dangerouslySetInnerHTML` on one node
        (including the `false` that a `{isEmpty && …}` expression
        produces in the non-empty case).
      */}
      {isEmpty ? (
        <div className="pa-surface">
          <div className="pa-empty">Scene has no atoms — nothing to project.</div>
        </div>
      ) : (
        <div
          className="pa-surface"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <figcaption className="pa-caption">
        {caption}
        <span className="tech">
          {preset.width}×{preset.height} · atoms={stats.atoms} · bonds={stats.bonds}
          {stats.droppedBonds > 0 ? ` (dropped ${stats.droppedBonds})` : ''}
          {' · '}perspective s∈[{stats.minScale.toFixed(2)}, {stats.maxScale.toFixed(2)}]
          {stats.degenerateDepth ? ' (orthographic — depth span ≈ 0)' : ''}
          {' · '}camera {stats.classification}, K={stats.cameraDistanceFactor}
          {' · '}scale source={stats.scaleSource}
        </span>
      </figcaption>
    </figure>
  );
}

// ── "Loaded …" status line ────────────────────────────────────────────

function LoadedLine({
  parsing,
  source,
  onReset,
}: {
  parsing: boolean;
  source: Source;
  onReset: () => void;
}): React.ReactElement {
  if (parsing) return <span className="pa-loaded-meta">parsing…</span>;
  if (source.kind === 'fixture') {
    return (
      <>
        <span className="pa-loaded-name">fixture / {source.id}</span>
        <span className="pa-loaded-meta">{source.label}</span>
      </>
    );
  }
  if (source.kind === 'file') {
    return (
      <>
        <span className="pa-loaded-name">{source.name}</span>
        <span className="pa-loaded-meta">{formatBytes(source.sizeBytes)}</span>
        <button type="button" className="pa-reset" onClick={onReset}>
          reset to fixture
        </button>
      </>
    );
  }
  return <span className="pa-loaded-meta">nothing loaded yet</span>;
}

// ── Baseline figures — production shared modules ──────────────────────

function CurrentPosterFigure({ views }: { views: DerivedViews }): React.ReactElement {
  return (
    <figure className="pa-figure">
      <div className="pa-figure-head">
        <h3 className="pa-figure-title">Poster pane (OG image)</h3>
        <span className="pa-tag pa-tag--current">current</span>
      </div>
      <div className="pa-surface">
        {views.storedPoster ? (
          // No hardcoded width/height — the SVG carries an intrinsic
          // aspect via its viewBox, and `.pa-surface svg { width:
          // 100%; height: auto }` scales it to the grid cell. The
          // component's internal defaults (CURRENT_POSTER_PANE_*)
          // govern the scene's proportions; this site only controls
          // how much room the cell offers.
          <CurrentPosterSceneSvg
            scene={views.storedPoster}
            gradientId="audit-current-poster-bg"
          />
        ) : (
          <div className="pa-empty">Poster scene projection returned no stored scene.</div>
        )}
      </div>
      <figcaption className="pa-caption">
        Right-hand pane of the 1200×630 share poster, served by
        <code> functions/api/capsules/:code/preview/poster</code>. Rendered
        via the same shared <code>CurrentPosterSceneSvg</code> module the
        production route uses.
        <span className="tech">
          atoms={views.storedPoster?.atoms.length ?? 0} · bonds={views.storedPoster?.bonds?.length ?? 0}
        </span>
      </figcaption>
    </figure>
  );
}

/** Renders a PreviewThumbV1 via the shared CurrentThumbSvg module —
 *  same path the account row uses in production. */
function AccountThumbFigure(props: {
  title: string;
  captionTop: React.ReactNode;
  thumb: PreviewThumbV1 | null;
  tag: 'current' | 'experimental';
  tagLabel: string;
}): React.ReactElement {
  const { title, captionTop, thumb, tag, tagLabel } = props;
  return (
    <figure className="pa-figure">
      <div className="pa-figure-head">
        <h3 className="pa-figure-title">{title}</h3>
        <span className={`pa-tag pa-tag--${tag}`}>{tagLabel}</span>
      </div>
      <div
        className="pa-surface"
        style={{ color: CURRENT_THUMB_DEFAULT_INK }}
      >
        {thumb ? (
          <CurrentThumbSvg thumb={thumb} size={AUDIT_THUMB_INSPECTION_SIZE} />
        ) : (
          <div className="pa-empty">No thumb produced on this path.</div>
        )}
      </div>
      <figcaption className="pa-caption">
        {captionTop}
        <span className="tech">
          {ACCOUNT_THUMB_SIZE}×{ACCOUNT_THUMB_SIZE} · atoms={thumb?.atoms.length ?? 0} · bonds={thumb?.bonds?.length ?? 0}
        </span>
      </figcaption>
    </figure>
  );
}

function CurrentThumbFigure({ views }: { views: DerivedViews }): React.ReactElement {
  const thumb = views.storedThumb;
  return (
    <figure className="pa-figure">
      <div className="pa-figure-head">
        <h3 className="pa-figure-title">Account-row thumb</h3>
        <span className="pa-tag pa-tag--current">current</span>
      </div>
      <div
        className="pa-surface"
        // Match the account row's `--color-text` so the thumb's
        // `fill="currentColor"` background resolves to the same value
        // users see. Enforced by current-thumb-ink-sync.test.ts.
        style={{ color: CURRENT_THUMB_DEFAULT_INK }}
      >
        {thumb ? (
          <CurrentThumbSvg thumb={thumb} size={AUDIT_THUMB_INSPECTION_SIZE} />
        ) : (
          <div className="pa-empty">No stored thumb produced for this capsule.</div>
        )}
      </div>
      <figcaption className="pa-caption">
        {ACCOUNT_THUMB_SIZE}×{ACCOUNT_THUMB_SIZE} thumbnail rendered inside the account
        upload list. Rendered via the shared <code>CurrentThumbSvg</code>
        module the account route uses, upscaled
        {' '}{AUDIT_THUMB_INSPECTION_RATIO}× here for legibility.
        <span className="tech">
          {ACCOUNT_THUMB_SIZE}×{ACCOUNT_THUMB_SIZE} · rev={CURRENT_THUMB_REV} · atoms={thumb?.atoms.length ?? 0} · bonds={thumb?.bonds?.length ?? 0}
        </span>
      </figcaption>
    </figure>
  );
}

// ── Data-driven metadata rows ────────────────────────────────────────

interface MetaRow {
  term: string;
  hint: string;
  value: React.ReactNode;
}

function fmtRatio(value: number | null): string {
  if (value === null) return 'n/a';
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(2);
}

function fmtFraction(value: number | null): string {
  if (value === null) return 'n/a';
  return value.toFixed(3);
}

function buildMetaRows(views: DerivedViews): MetaRow[] {
  const d = views.clusterDiagnostics;
  return [
    {
      term: 'Capsule atom count',
      hint: 'atoms in the full playback payload',
      value: views.capsule.atoms.atoms.length,
    },
    {
      term: 'Dense frame count',
      hint: 'frames available for preview sourcing',
      value: views.capsule.timeline.denseFrames.length,
    },
    {
      term: 'Selected frame id',
      hint: 'chosen by the frame-extraction stage',
      value: views.scene3D.frameId,
    },
    {
      term: 'Time (ps)',
      hint: 'simulation time of the selected frame',
      // 3-dp guard against float noise in the rendered grid.
      value: Number.isFinite(views.scene3D.timePs)
        ? views.scene3D.timePs.toFixed(3)
        : String(views.scene3D.timePs),
    },
    // Cluster-selection diagnostics (ADR D138). Metadata-parity gate:
    // these rows must be visible before any visual review.
    {
      term: 'Full-frame atoms / bonds',
      hint: 'pre-selection subject (denseFrames[0])',
      value: `${d.fullFrameAtomCount} / ${d.fullFrameBondCount}`,
    },
    {
      term: 'Selected atoms / bonds',
      hint: 'post-cluster-select subject (poster + thumb source)',
      value: `${d.selectedAtomCount} / ${d.selectedBondCount}`,
    },
    {
      term: 'Components · meaningful',
      hint: 'proximity-graph components · those with size ≥ MIN_MEANINGFUL_CLUSTER_SIZE',
      value: `${d.componentCount} · ${d.meaningfulComponentCount}`,
    },
    {
      term: 'Dominance ratio',
      hint: 'largest/secondLargest — default threshold DOMINANCE_BY_RATIO=2.0',
      value: fmtRatio(d.dominanceByRatio),
    },
    {
      term: 'Dominance fraction',
      hint: 'largest/total — default threshold DOMINANCE_BY_FRACTION=0.6',
      value: fmtFraction(d.dominanceByFraction),
    },
    {
      term: 'Fallback reason',
      hint: 'none · no-bonds · no-meaningful · dominance-failed · mode-full-frame',
      value: d.fallbackReason,
    },
    {
      term: 'Camera classification',
      hint: 'spherical · planar · linear · general · degenerate',
      value: views.projected.classification,
    },
    {
      term: 'Projected atom count',
      hint: 'after canonical camera + depth sort',
      value: views.projected.atoms.length,
    },
    {
      term: 'Projected bond count',
      hint: 'after index-drift-safe translation',
      value: views.projectedBonds.length,
    },
    {
      term: 'CURRENT_THUMB_REV',
      hint: 'stored-thumb derivation revision',
      value: CURRENT_THUMB_REV,
    },
  ];
}

// ── App shell ─────────────────────────────────────────────────────────

type FileRejectReason = 'wrong-type' | 'parse-failed';

const ACCEPTED_EXTENSIONS = ['.json'];
const ACCEPTED_MIME = ['application/json', 'text/json', ''];

function isLikelyCapsuleFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const hasExt = ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
  // Some OSes don't set a type for .json; fall back to the extension.
  const typeOk = ACCEPTED_MIME.includes(file.type);
  return hasExt || typeOk;
}

function AuditApp(): React.ReactElement {
  const [fixtureId, setFixtureId] = useState<string>('c60');
  const [capsule, setCapsule] = useState<AtomDojoPlaybackCapsuleFileV1 | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'none' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [parsing, setParsing] = useState(false);
  // Ref-counted drag depth — needed because dragover/dragleave bubble
  // through child nodes and a naive boolean latches on child entries.
  const dragDepth = useRef(0);

  // Seed from the fixture registry on first render and whenever the
  // dropdown changes; loaded files take precedence over fixtures.
  useEffect(() => {
    if (capsule != null) return;
    const entry = FIXTURES.find((f) => f.id === fixtureId);
    if (!entry) return;
    try {
      setCapsule(entry.build());
      setSource({ kind: 'fixture', id: entry.id, label: entry.label });
      setLoadError(null);
    } catch (err) {
      // Fixture builders are deterministic and should never throw; if
      // one does, surface it AND clear any stale source so the header
      // doesn't lie about what's loaded.
      setSource({ kind: 'none' });
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [capsule, fixtureId]);

  const onFixtureChange = useCallback((id: string) => {
    setFixtureId(id);
    setCapsule(null);
    setLoadError(null);
  }, []);

  const rejectFile = useCallback((file: File, reason: FileRejectReason, detail?: string) => {
    const msg =
      reason === 'wrong-type'
        ? `"${file.name}" is not a .json capsule — only JSON files are accepted.`
        : `Could not parse "${file.name}": ${detail ?? 'unknown error'}`;
    // Important: clear capsule + source so the stale figures below don't
    // silently keep rendering the previous capsule while the banner
    // says the load failed.
    setCapsule(null);
    setSource({ kind: 'none' });
    setLoadError(msg);
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      if (!isLikelyCapsuleFile(file)) {
        rejectFile(file, 'wrong-type');
        return;
      }
      setParsing(true);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const errors = validateCapsuleFile(parsed);
        if (errors.length > 0) throw new Error(errors[0]);
        setCapsule(parsed as AtomDojoPlaybackCapsuleFileV1);
        setSource({ kind: 'file', name: file.name, sizeBytes: file.size });
        setLoadError(null);
      } catch (err) {
        rejectFile(file, 'parse-failed', err instanceof Error ? err.message : String(err));
      } finally {
        setParsing(false);
      }
    },
    [rejectFile],
  );

  const resetToFixture = useCallback(() => {
    setCapsule(null);
    setLoadError(null);
  }, []);

  const views = useMemo(() => (capsule ? deriveViews(capsule) : null), [capsule]);
  const viewsOk = views && !('error' in views) ? views : null;
  const metaRows = useMemo(() => (viewsOk ? buildMetaRows(viewsOk) : null), [viewsOk]);

  const fileLoaded = source.kind === 'file';

  return (
    <div className="pa-shell">
      <header className="pa-masthead">
        <p className="pa-eyebrow">atomdojo · internal tooling</p>
        <h1 className="pa-title">Capsule Preview Audit</h1>
        <p className="pa-lede">
          Side-by-side reviewer for the capsule figure renderer. Loads a capsule
          JSON, runs it through the real production pipeline, and shows the
          current shipping output alongside the proposed unified-sketch variants.
        </p>
        <span className="pa-notice" role="note">
          <strong>Dev only</strong>
          <span>Never shipped to production — gated in <code>vite.config.ts</code>.</span>
        </span>
      </header>

      <div className="pa-frame">
        <aside className="pa-toc" aria-label="Contents">
          <p className="pa-toc-title">Contents</p>
          <ol>
            <li><a href="#source"><span className="num">§1</span> Source</a></li>
            <li><a href="#display"><span className="num">§2</span> Display options</a></li>
            <li><a href="#metadata"><span className="num">§3</span> Pipeline metadata</a></li>
            <li><a href="#current"><span className="num">§4</span> Current baselines</a></li>
            <li><a href="#experimental"><span className="num">§5</span> Experimental variants</a></li>
          </ol>
        </aside>

        <main className="pa-main">
          {loadError && (
            <div className="pa-error" role="alert">
              <strong>Load failed:</strong> {loadError}
            </div>
          )}
          {views && 'error' in views && (
            <div className="pa-error" role="alert">
              <strong>Pipeline error:</strong> {views.error}
            </div>
          )}

          {/* § 1 — Source ───────────────────────────────────────────── */}
          <section className="pa-section" id="source">
            <header className="pa-section-head">
              <span className="pa-section-num">§ 1</span>
              <h2 className="pa-section-title">Source</h2>
            </header>
            <p className="pa-section-prose">
              Pick a built-in fixture or drop in a local <code>.json</code> capsule.
              Fixtures are the same deterministic builders the renderer test-suite
              uses, so anything you see here is reproducible in CI.
            </p>

            <div className="pa-controls">
              <div className="pa-field">
                <label htmlFor="pa-fixture">Fixture</label>
                <select
                  id="pa-fixture"
                  value={fixtureId}
                  onChange={(e) => onFixtureChange(e.target.value)}
                  disabled={fileLoaded}
                  aria-describedby={fileLoaded ? 'pa-fixture-help' : undefined}
                >
                  <optgroup label="Structural">
                    {FIXTURES.filter((f) => f.bucket === 'structural').map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Color (mixed-element)">
                    {FIXTURES.filter((f) => f.bucket === 'color').map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </optgroup>
                </select>
                {fileLoaded && (
                  <p id="pa-fixture-help" className="pa-field-help">
                    File is loaded — click <em>reset to fixture</em> below to pick a fixture again.
                  </p>
                )}
              </div>

              <div className="pa-field">
                <label htmlFor="pa-file">Local capsule (.json)</label>
                <input
                  id="pa-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
                {/*
                  Drop zone is a <label htmlFor="pa-file"> so keyboard
                  activation (Enter/Space when focused) opens the same
                  picker as the input above. Drag events still work for
                  pointer users. The ref-counted dragDepth handles the
                  child-element flicker that a naive boolean shows.
                */}
                <label
                  htmlFor="pa-file"
                  className={`pa-drop ${dragActive ? 'active' : ''}`}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    dragDepth.current += 1;
                    setDragActive(true);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragLeave={() => {
                    dragDepth.current = Math.max(0, dragDepth.current - 1);
                    if (dragDepth.current === 0) setDragActive(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepth.current = 0;
                    setDragActive(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void onFile(f);
                  }}
                >
                  …or drag a <code>.json</code> capsule onto this area
                </label>
              </div>
            </div>

            <div className="pa-loaded" aria-live="polite">
              <span className="pa-loaded-label">Loaded</span>
              <LoadedLine
                parsing={parsing}
                source={source}
                onReset={resetToFixture}
              />
            </div>
          </section>

          {/* § 2 — Rendering model ──────────────────────────────────── */}
          <section className="pa-section" id="display">
            <header className="pa-section-head">
              <span className="pa-section-num">§ 2</span>
              <h2 className="pa-section-title">Rendering model</h2>
            </header>
            <p className="pa-section-prose">
              Experimental figures use a single rendering contract, documented
              here so the per-figure captions can stay short.
            </p>
            <p className="pa-section-prose">
              <strong>Baseline / experimental parity:</strong> both the
              {' '}<em>current</em> baselines in §4 and the
              {' '}<em>experimental</em> figures in §5 source from the
              {' '}<em>same</em> subject-cluster selection (ADR D138) —
              they differ only in renderer presentation, not in which
              atoms are drawn. If the current and experimental figures
              look identical on a given fixture that is expected, not a
              baseline drift. See §3 for the selection diagnostics.
            </p>
            <dl className="pa-def">
              <dt>Subject</dt>
              <dd>
                The <strong>largest bonded cluster</strong> in the first
                dense frame when that cluster is dominant — size ≥ 2,
                size / secondLargest ≥ 2.0, size / total ≥ 0.6 (ADR
                D138). Otherwise the full frame is used. Zero-bond
                scenes short-circuit. <em>"Bonded cluster" here means a
                connected component of the preview proximity graph (the
                same cutoff + min-dist used for bond rendering), NOT
                authoritative molecular connectivity</em> — close-
                approach frames can fuse two unbonded molecules into one
                cluster; see the <code>close-approach</code> fixture.
              </dd>
              <dt>Camera</dt>
              <dd>
                PCA basis with the smallest eigenvector (e₃) as the depth axis;
                no fixed display tilt. Planar clouds read face-on, tubes read
                side-on, spheres render axis-aligned.
              </dd>
              <dt>Projection</dt>
              <dd>
                Pinhole perspective (Hartley &amp; Zisserman, <em>Multiple View
                Geometry</em> Ch. 6 — the same perspective divide used by
                OpenGL/WebGL). For each atom, screen position and radius scale
                by <code>s(z) = D / (D + z_max − z)</code> with
                <code> D = K·span</code> and <code>K = 1.5</code>, so the
                farthest atom renders at 60% of the closest. Bond widths use
                the midpoint scale.
              </dd>
              <dt>Atoms</dt>
              <dd>
                Dark-gray fill (<code>#333</code>) with a thin dark outline.
                No CPK — flat color lets depth and bond geometry carry the
                reading.
              </dd>
              <dt>Bonds</dt>
              <dd>
                Thick body stroke (≈3× the prior "rail" width) with a thin
                darker border, so a bond reads as a single bar with a crisp
                edge rather than a double-line pair.
              </dd>
            </dl>
          </section>

          {/* § 3 — Pipeline metadata — shell ALWAYS rendered so TOC anchor
              `#metadata` resolves regardless of view state. */}
          <section className="pa-section" id="metadata">
            <header className="pa-section-head">
              <span className="pa-section-num">§ 3</span>
              <h2 className="pa-section-title">Pipeline metadata</h2>
            </header>
            <p className="pa-section-prose">
              Values exposed by each stage of the preview pipeline — useful
              for locating the source of a visual regression (frame choice,
              camera classification, projection fit, bond derivation).
            </p>
            {metaRows ? (
              <dl className="pa-meta">
                {metaRows.map((row) => (
                  <div className="pa-meta-row" key={row.term}>
                    <dt className="pa-meta-term">
                      {row.term}
                      <span className="hint">{row.hint}</span>
                    </dt>
                    <dd className="pa-meta-val">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="pa-empty pa-empty--inline">
                Metadata unavailable — no capsule loaded or the pipeline failed.
              </p>
            )}
          </section>

          {/* § 4 — Current baselines — shell ALWAYS rendered; error
              boundary wraps the renderer subtree so a crash reports
              into .pa-error instead of blanking the app. */}
          <section className="pa-section" id="current">
            <header className="pa-section-head">
              <span className="pa-section-num">§ 4</span>
              <h2 className="pa-section-title">Current baselines</h2>
            </header>
            <p className="pa-section-prose">
              What users see today. Rendered via the exact shared modules the
              production poster route and account row consume, so if production
              drifts, these drift with it.
            </p>
            {viewsOk ? (
              <FigureErrorBoundary>
                <div className="pa-figures cols-2">
                  <CurrentPosterFigure views={viewsOk} />
                  <CurrentThumbFigure views={viewsOk} />
                </div>
                <p
                  className="pa-section-prose"
                  style={{ marginTop: 20 }}
                >
                  <strong>Account-route parity.</strong> These two
                  thumbs exercise the exact code path
                  {' '}<code>deriveAccountThumb</code> that
                  {' '}<code>/api/account/capsules</code> uses. The
                  left panel is the fresh rev-3 write-path result
                  (stored-thumb fast path). The right panel is the
                  <strong> stale-row fallback</strong> — a legacy
                  row at <code>rev &lt; {CURRENT_THUMB_REV}</code>
                  has its embedded thumb bytes ignored, and the
                  account route live-samples atoms from the stored
                  scene. Run <code>npm run capsule-preview:backfill:local</code>
                  {' '}or <code>npm run capsule-preview:backfill:prod</code>
                  {' '}to promote stale rows onto the left path.
                </p>
                <div className="pa-figures cols-2">
                  <AccountThumbFigure
                    title={`Fresh rev-${CURRENT_THUMB_REV} (post-backfill)`}
                    tag="current"
                    tagLabel="production"
                    thumb={viewsOk.accountThumb}
                    captionTop={
                      <>
                        What the account list shows for a row published
                        (or backfilled) under the D138 pipeline.
                        Matches the account row exactly.
                      </>
                    }
                  />
                  <AccountThumbFigure
                    title="Stale fallback (pre-backfill)"
                    tag="experimental"
                    tagLabel="fallback"
                    thumb={viewsOk.accountThumbStaleFallback}
                    captionTop={
                      <>
                        Embedded thumb dropped — same code path a
                        legacy row hits before rebaking. If this
                        doesn't match the left panel, the row needs
                        a backfill.
                      </>
                    }
                  />
                </div>
                <p
                  className="pa-section-prose"
                  style={{ marginTop: 20 }}
                >
                  <strong>True-size ({ACCOUNT_THUMB_SIZE} px) review.</strong> The
                  panels above are enlarged {AUDIT_THUMB_INSPECTION_RATIO}× for inspection. The
                  account row renders at <code>size={ACCOUNT_THUMB_SIZE}</code>. Load-
                  bearing sign-off happens against THIS row — a
                  thumb that reads at {AUDIT_THUMB_INSPECTION_SIZE} px can still collapse into
                  an unrecognizable cluster at {ACCOUNT_THUMB_SIZE} px.
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 24,
                    padding: '12px 16px',
                    border: '1px solid var(--pa-border, #d0d0d0)',
                    borderRadius: 8,
                    background: '#fafafa',
                    color: CURRENT_THUMB_DEFAULT_INK,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    {viewsOk.accountThumb ? (
                      <CurrentThumbSvg thumb={viewsOk.accountThumb} size={ACCOUNT_THUMB_SIZE} />
                    ) : (
                      <div style={{ width: ACCOUNT_THUMB_SIZE, height: ACCOUNT_THUMB_SIZE, background: '#eee', borderRadius: 4 }} />
                    )}
                    <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: '#666' }}>
                      ship · {ACCOUNT_THUMB_SIZE} px
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    {viewsOk.accountThumb ? (
                      <CurrentThumbSvg
                        thumb={viewsOk.accountThumb}
                        size={ACCOUNT_THUMB_SIZE}
                        style={THUMB_STYLE_HALOED}
                      />
                    ) : (
                      <div style={{ width: ACCOUNT_THUMB_SIZE, height: ACCOUNT_THUMB_SIZE, background: '#eee', borderRadius: 4 }} />
                    )}
                    <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: '#666' }}>
                      haloed A/B · {ACCOUNT_THUMB_SIZE} px
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    {viewsOk.accountThumbStaleFallback ? (
                      <CurrentThumbSvg thumb={viewsOk.accountThumbStaleFallback} size={ACCOUNT_THUMB_SIZE} />
                    ) : (
                      <div style={{ width: ACCOUNT_THUMB_SIZE, height: ACCOUNT_THUMB_SIZE, background: '#eee', borderRadius: 4 }} />
                    )}
                    <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: '#666' }}>
                      stale · {ACCOUNT_THUMB_SIZE} px
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#444', maxWidth: 320 }}>
                    These are the exact pixels users see.
                    <strong> ship</strong> is the shipped
                    <code> THUMB_STYLE_MINIMAL</code> (no atom
                    halo). <strong>haloed A/B</strong> is
                    <code> THUMB_STYLE_HALOED</code> — audit-only,
                    NOT on the account list. The haloed variant is
                    kept so reviewers can compare without having to
                    ship it.
                  </p>
                </div>
              </FigureErrorBoundary>
            ) : (
              <p className="pa-empty pa-empty--inline">
                Baselines unavailable — no capsule loaded or the pipeline failed.
              </p>
            )}
          </section>

          {/* § 5 — Experimental variants — same pattern as §4. */}
          <section className="pa-section" id="experimental">
            <header className="pa-section-head">
              <span className="pa-section-num">§ 5</span>
              <h2 className="pa-section-title">Experimental variants</h2>
            </header>
            <p className="pa-section-prose">
              The perspective renderer at three presets. The <em>large</em>{' '}
              figure is the design authority for tuning; the <em>poster</em>{' '}
              and <em>thumb</em> scale down from that authority. Compare
              each against the matching current baseline above.
            </p>
            {viewsOk ? (
              <FigureErrorBoundary>
                <div className="pa-figures cols-3">
                  <SketchFigure
                    title="Large (design authority)"
                    preset={PERSPECTIVE_LARGE_PRESET}
                    views={viewsOk}
                    fullWidth
                    caption={<>800×800 working surface. Minor-axis camera + pinhole perspective: nearest atoms render larger, and bonds thin down with distance.</>}
                  />
                  <SketchFigure
                    title="Poster"
                    preset={PERSPECTIVE_POSTER_PRESET}
                    views={viewsOk}
                    caption={<>Proposed replacement for the OG-poster pane. Compare against <em>Poster pane</em> above.</>}
                  />
                  <SketchFigure
                    title="Thumb"
                    preset={PERSPECTIVE_THUMB_PRESET}
                    views={viewsOk}
                    caption={<>Proposed replacement for the {ACCOUNT_THUMB_SIZE}×{ACCOUNT_THUMB_SIZE} account-row thumb. Compare against <em>Account-row thumb</em> above.</>}
                  />
                </div>
              </FigureErrorBoundary>
            ) : (
              <p className="pa-empty pa-empty--inline">
                Variants unavailable — no capsule loaded or the pipeline failed.
              </p>
            )}
          </section>

          <footer className="pa-colophon">
            Dev-only surface. Source: <code>preview-audit/main.tsx</code>.
            Gated by <code>vite.config.ts</code> and
            {' '}<code>tests/unit/preview-audit-production-exclusion.test.ts</code>.
          </footer>
        </main>
      </div>
    </div>
  );
}

const rootEl = document.getElementById('audit-root');
if (rootEl) {
  createRoot(rootEl).render(<AuditApp />);
}

// Keep `renderPreviewSketchSvgNode` referenced so a future panel swap
// doesn't need to re-import it — also ensures Vite dev-server picks it
// up in the module graph for the audit tests that reach in.
export { renderPreviewSketchSvgNode };
