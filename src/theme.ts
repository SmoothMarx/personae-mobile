/** One palette, used by every screen. Plain objects so there is nothing to resolve at runtime. */

export const colors = {
  bg: '#0b0f14',
  panel: '#121a23',
  panelAlt: '#17212c',
  border: '#22303d',
  text: '#e6edf3',
  muted: '#8b98a5',
  faint: '#5c6b7a',
  accent: '#4c8dff',
  accentText: '#ffffff',
  green: '#3fb950',
  amber: '#d29922',
  red: '#f85149',
  grey: '#5c6b7a',
  bubbleUser: '#1d3a5f',
  bubbleAgent: '#17212c',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const font = {
  small: 12,
  body: 15,
  title: 17,
  large: 22,
} as const;
