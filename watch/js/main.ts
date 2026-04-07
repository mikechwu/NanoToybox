/**
 * Watch app entrypoint — imports .atomdojo history files and plays them back.
 *
 * v1: exact recorded-frame playback of 'full' history files.
 * Architecture: plain TS + DOM (no React required for v1).
 */

import { applyThemeTokens } from '../../lab/js/themes';
import { DEFAULT_THEME } from '../../lab/js/config';
import { formatTime } from '../../lab/js/components/timeline-format';
import { loadHistoryFile } from './history-file-loader';
import { importFullHistory } from './full-history-import';
import { createWatchPlaybackModel } from './watch-playback-model';
import { createWatchRenderer, type WatchRenderer } from './watch-renderer';
import { createWatchBondedGroups } from './watch-bonded-groups';

// ── Global error handler ──
window.addEventListener('unhandledrejection', (e) => {
  console.error('[watch] unhandled rejection:', e.reason);
  const errorPanel = document.getElementById('watch-error');
  const errorText = document.getElementById('watch-error-text');
  if (errorPanel && errorText) {
    errorText.textContent = `Unexpected error: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`;
    errorPanel.hidden = false;
  }
});

// ── State ──

const playback = createWatchPlaybackModel();
const bondedGroups = createWatchBondedGroups();
let renderer: WatchRenderer | null = null;
let rafId = 0;

// ── DOM references ──

const landing = document.getElementById('watch-landing')!;
const workspace = document.getElementById('watch-workspace')!;
const canvasContainer = document.getElementById('watch-canvas')!;
const fileBadge = document.getElementById('watch-badge')!;
const errorPanel = document.getElementById('watch-error')!;
const errorText = document.getElementById('watch-error-text')!;
const playBtn = document.getElementById('watch-play')! as HTMLButtonElement;
const scrubber = document.getElementById('watch-scrubber')! as HTMLInputElement;
const timeLabel = document.getElementById('watch-time')!;
const durationLabel = document.getElementById('watch-duration')!;
const openBtn = document.getElementById('watch-open-btn')! as HTMLButtonElement;
const openAnotherBtn = document.getElementById('watch-open-another')! as HTMLButtonElement;
const dropZone = document.getElementById('watch-drop-zone')!;
const analysisAtoms = document.getElementById('watch-atoms')!;
const analysisFrames = document.getElementById('watch-frames')!;
const analysisGroups = document.getElementById('watch-groups')!;
const groupList = document.getElementById('watch-group-list')!;

// ── Theme ──

applyThemeTokens(DEFAULT_THEME);

// ── File open ──

function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.atomdojo,.json,application/json';
  input.onchange = () => {
    if (input.files?.[0]) {
      handleFile(input.files[0]).catch(e => {
        console.error('[watch] handleFile unhandled error:', e);
        showError(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };
  input.click();
}

openBtn.addEventListener('click', openFilePicker);
openAnotherBtn.addEventListener('click', openFilePicker);

// Drag and drop
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('watch-drop-active'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('watch-drop-active'); });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('watch-drop-active');
  if (e.dataTransfer?.files[0]) {
    handleFile(e.dataTransfer.files[0]).catch(err => {
      console.error('[watch] handleFile unhandled error:', err);
      showError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
});

async function handleFile(file: File) {
  hideError();

  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    showError(`Could not read file "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  let decision: ReturnType<typeof loadHistoryFile>;
  try {
    decision = loadHistoryFile(text);
  } catch (e) {
    showError(`This file could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (decision.status === 'invalid') {
    showError(`This file could not be opened: ${decision.errors[0]}`);
    return;
  }
  if (decision.status === 'unsupported') {
    showError(`${decision.reason} (detected kind: ${decision.kind})`);
    return;
  }

  // Supported — import and start playback
  let history;
  try {
    history = importFullHistory(decision.file);
  } catch (e) {
    console.error('[watch] import error:', e);
    showError(`Failed to import history data: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (history.denseFrames.length === 0) {
    showError('This file has no recorded frames to play back.');
    return;
  }

  try {
    playback.load(history);
    bondedGroups.reset();
    enterWorkspace(history.simulation.frameCount, history.atoms.length);
  } catch (e) {
    console.error('[watch] workspace init error:', e);
    showError(`Failed to initialize playback: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Error display ──

function showError(msg: string) {
  errorText.textContent = msg;
  errorPanel.hidden = false;
}

function hideError() {
  errorPanel.hidden = true;
}

// ── Workspace ──

function enterWorkspace(frameCount: number, atomCount: number) {
  landing.hidden = true;
  workspace.hidden = false;
  fileBadge.textContent = 'Full History';

  // Init renderer
  if (!renderer) {
    renderer = createWatchRenderer(canvasContainer);
  }

  // Sync Three.js scene with the active theme (background color, materials, lights)
  renderer.applyTheme(DEFAULT_THEME);

  // Initialize mesh capacity for the loaded history's atom count
  const history = playback.getLoadedHistory();
  if (history && renderer) {
    renderer.initForPlayback(history.simulation.maxAtomCount);
  }

  // Reset all UI controls to clean initial state
  const startTime = playback.getStartTimePs();
  const endTime = playback.getEndTimePs();
  const duration = endTime - startTime;
  scrubber.min = String(startTime);
  scrubber.max = String(endTime);
  scrubber.step = duration > 0 ? String(duration / Math.max(1, frameCount - 1)) : '1';
  scrubber.value = String(startTime);
  playBtn.textContent = '▶';
  playBtn.disabled = duration <= 0;
  timeLabel.textContent = formatTime(startTime);
  playback.setCurrentTimePs(startTime);

  durationLabel.textContent = formatTime(endTime);
  analysisAtoms.textContent = String(atomCount);
  analysisFrames.textContent = String(frameCount);

  // Initial frame
  updateFrame(startTime);
  renderer.fitCamera();

  // Start RAF loop
  startPlaybackLoop();
}

// ── Playback loop ──

let lastTimestamp = 0;

function startPlaybackLoop() {
  lastTimestamp = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function tick(timestamp: number) {
  rafId = requestAnimationFrame(tick);

  if (playback.isPlaying() && lastTimestamp > 0) {
    const dtMs = timestamp - lastTimestamp;
    // Playback speed: 1x = real-time (1 ps ≈ 1 sec for visibility)
    const dtPs = dtMs * 0.001;
    let newTime = playback.getCurrentTimePs() + dtPs;
    const endTime = playback.getEndTimePs();
    if (newTime >= endTime) {
      newTime = endTime;
      playback.setPlaying(false);
      playBtn.textContent = '▶';
    }
    playback.setCurrentTimePs(newTime);
    scrubber.value = String(newTime);
  }
  lastTimestamp = timestamp;

  const timePs = playback.getCurrentTimePs();
  updateFrame(timePs);
}

function updateFrame(timePs: number) {
  // Position sampling
  const posData = playback.getDisplayPositionsAtTime(timePs);
  const topology = playback.getTopologyAtTime(timePs);

  if (posData && renderer) {
    renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
    renderer.render();
  }

  // Time label
  timeLabel.textContent = formatTime(timePs);

  // Bonded groups
  const summaries = bondedGroups.updateForTime(timePs, topology);
  analysisGroups.textContent = String(summaries.length);

  // Group list
  if (summaries.length > 0) {
    groupList.innerHTML = summaries
      .slice(0, 20)
      .map(g => `<li>#${g.displayIndex}: ${g.atomCount} atoms</li>`)
      .join('');
  } else {
    groupList.innerHTML = '<li>No groups</li>';
  }
}

// ── Controls ──

playBtn.addEventListener('click', () => {
  if (!playback.isLoaded()) return;
  const wasPlaying = playback.isPlaying();
  playback.setPlaying(!wasPlaying);
  playBtn.textContent = wasPlaying ? '▶' : '⏸';
  if (!wasPlaying) {
    // If at end, restart from beginning
    if (playback.getCurrentTimePs() >= playback.getEndTimePs()) {
      const start = playback.getStartTimePs();
      playback.setCurrentTimePs(start);
      scrubber.value = String(start);
    }
  }
});

scrubber.addEventListener('input', () => {
  const timePs = parseFloat(scrubber.value);
  playback.setCurrentTimePs(timePs);
  playback.setPlaying(false);
  playBtn.textContent = '▶';
  updateFrame(timePs);
});

// Note: window resize is handled automatically by the Renderer's internal listener.
