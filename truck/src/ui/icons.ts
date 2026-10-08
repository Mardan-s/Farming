// Inline SVG icons (stroke-based, inherit currentColor).

const s = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  camera: s('<path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="4"/>'),
  menu: s('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  light: s('<path d="M10 6c-4 0-6 3-6 6s2 6 6 6h2V6z"/><path d="M15 8l5-1M15 12h6M15 16l5 1"/>'),
  horn: s('<path d="M3 10v4h4l7 5V5L7 10z"/><path d="M18 8c1.5 1.2 1.5 6.8 0 8"/>'),
  cruise: s('<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.5"/>'),
  left: s('<path d="M15 5l-7 7 7 7"/>'),
  right: s('<path d="M9 5l7 7-7 7"/>'),
  hazard: s('<path d="M12 4l9 16H3z"/><path d="M12 9.5l4 7H8z"/>'),
  roof: s('<rect x="4" y="9" width="16" height="6" rx="2"/><path d="M7 5v2M12 4v3M17 5v2"/>'),
  fuel: s('<path d="M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 8h5"/>'),
  wrench: s('<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5L17 4l3 3-2.5 2.5"/>'),
  box: s('<path d="M3 8l9-4 9 4v8l-9 4-9-4z"/><path d="M3 8l9 4 9-4M12 12v8"/>'),
  flag: s('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  snow: s('<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9"/>'),
  drop: s('<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>'),
  tank: s('<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 7v10M16 7v10"/>'),
  phone: s('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'),
  radio: s('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l9-5"/><circle cx="15" cy="14" r="2.5"/><path d="M6 12h4M6 15h4"/>'),
  expand: s('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
};

export const WHEEL_SVG = `<svg viewBox="0 0 200 200">
  <defs>
    <radialGradient id="wg" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#3a3f47"/><stop offset="1" stop-color="#14171c"/></radialGradient>
    <linearGradient id="wr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a505a"/><stop offset="1" stop-color="#16191e"/></linearGradient>
  </defs>
  <circle cx="100" cy="100" r="92" fill="none" stroke="url(#wr)" stroke-width="18"/>
  <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
  <path d="M100 100 L18 112 A84 84 0 0 1 22 82 Z M100 100 L182 112 A84 84 0 0 0 178 82 Z M100 100 L88 186 A84 84 0 0 0 112 186 Z" fill="url(#wg)" stroke="rgba(255,255,255,0.08)"/>
  <circle cx="100" cy="100" r="30" fill="url(#wg)" stroke="rgba(255,255,255,0.15)"/>
  <circle cx="100" cy="100" r="11" fill="none" stroke="#ffad1f" stroke-width="3"/>
  <rect x="96" y="6" width="8" height="16" rx="3" fill="#ffad1f"/>
</svg>`;
