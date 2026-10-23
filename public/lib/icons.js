// Small inline SVG icon set (24px grid, 1.75 stroke, currentColor), built with createElementNS.
const SVG_NS = 'http://www.w3.org/2000/svg'; // namespace identifier, not a network request

// Strings are path data; arrays are [tag, attributes].
const ICONS = {
  plus: ['M5 12h14', 'M12 5v14'],
  bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  'book-open': ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
  'message-circle': ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  'square-plus': [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 }], 'M8 12h8', 'M12 8v8'],
  'bar-chart': ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
  home: ['m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', ['circle', { cx: 12, cy: 7, r: 4 }]],
  'square-pen': ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z'],
  paperclip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  square: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  grip: [['circle', { cx: 9, cy: 6, r: 1 }], ['circle', { cx: 9, cy: 12, r: 1 }], ['circle', { cx: 9, cy: 18, r: 1 }], ['circle', { cx: 15, cy: 6, r: 1 }], ['circle', { cx: 15, cy: 12, r: 1 }], ['circle', { cx: 15, cy: 18, r: 1 }]],
  check: ['M20 6 9 17l-5-5'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  sliders: ['M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3', 'M14 2v4', 'M8 10v4', 'M16 18v4'],
  copy: [['rect', { x: 8, y: 8, width: 13, height: 13, rx: 2 }], 'M4 16V5a2 2 0 0 1 2-2h11'],
  'more-horizontal': [
    ['circle', { cx: 5, cy: 12, r: 1 }],
    ['circle', { cx: 12, cy: 12, r: 1 }],
    ['circle', { cx: 19, cy: 12, r: 1 }],
  ],
  send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z', ['circle', { cx: 12, cy: 13, r: 3 }]],
  'chevron-right': ['m9 18 6-6-6-6'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  printer: ['M6 9V2h12v7', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', ['rect', { x: 6, y: 14, width: 12, height: 8 }]],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  pencil: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
  mic: [['rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }], 'M19 10v1a7 7 0 0 1-14 0v-1', 'M12 18v4'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9Z'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
  image: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['circle', { cx: 9, cy: 9, r: 2 }],
    'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  ],
  'panel-left': [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], 'M9 3v18'],
  search: [['circle', { cx: 11, cy: 11, r: 8 }], 'm21 21-4.3-4.3'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'eye-off': ['M9.88 9.88a3 3 0 1 0 4.24 4.24', 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68', 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61', 'M2 2l20 20'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z', ['circle', { cx: 12, cy: 12, r: 3 }]],
  'alert-circle': [['circle', { cx: 12, cy: 12, r: 10 }], 'M12 8v4', 'M12 16h.01'],
};

export function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

export function icon(name, size = 16) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const part of ICONS[name] ?? []) {
    svg.append(typeof part === 'string' ? svgEl('path', { d: part }) : svgEl(part[0], part[1]));
  }
  return svg;
}

// Fills every [data-ico="name"] element in the static HTML with its icon.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-ico]')) {
    el.prepend(icon(el.dataset.ico));
    delete el.dataset.ico;
  }
}
