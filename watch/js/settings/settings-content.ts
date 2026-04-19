/**
 * Watch settings content — structured data for help sections.
 *
 * Viewer-specific help content (NOT cloned from lab simulation instructions).
 * Separates content from presentation so updates are cheap and parity review is clear.
 */

export interface HelpSection {
  title: string;
  content: string;
}

export const WATCH_HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Playback',
    content: 'Play/Pause, Step Forward/Backward to navigate frame by frame. Speed slider in the dock adjusts from 0.5x to 20x. Repeat loops continuously.',
  },
  {
    title: 'Timeline',
    content: 'Drag the scrubber to jump to any point in the history.',
  },
  {
    title: 'Bonded Groups',
    content: 'Center: frame camera on a group. Follow: track during playback. Color: click chip to assign.',
  },
  {
    title: 'Camera',
    content: 'Desktop: left/right-drag to orbit, scroll to zoom. Mobile: 1-finger orbit, 2-finger pinch zoom, triad tap to snap.',
  },
  {
    title: 'File',
    content: 'Open File button or drag-and-drop an .atomdojo file.',
  },
];
