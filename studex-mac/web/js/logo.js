/**
 * The Studex mark: a mortarboard whose tassel is an exclamation mark.
 *
 * The cap is drawn in the surrounding text colour so the mark reads on the
 * sidebar, the sign-in card and a light tile alike; only the tassel's dot is
 * accent, which is what still identifies it at 16px.
 */
import { svg } from './dom.js';

const CAP = 'M15 3 L27 8.5 L15 14 L3 8.5 Z';
const BODY = 'M7.5 10.6 V17 C7.5 19.1 10.9 20.5 15 20.5 C19.1 20.5 22.5 19.1 22.5 17 V10.6';
const TASSEL = 'M32.5 4.5 V15';

export function logoMark({ className = 'mark', title = 'Studex' } = {}) {
  return svg('svg', {
    class: className,
    viewBox: '0 0 38 24',
    fill: 'none',
    role: 'img',
    'aria-label': title,
  },
    svg('g', {
      stroke: 'currentColor',
      'stroke-width': '2.4',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    },
      svg('path', { d: CAP }),
      svg('path', { d: BODY }),
      svg('path', { d: TASSEL }),
    ),
    svg('circle', { cx: '32.5', cy: '19.6', r: '2.3', fill: 'var(--color-accent)' }),
  );
}
