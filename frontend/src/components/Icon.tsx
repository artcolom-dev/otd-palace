// The icon set, drawn in one 24-unit grid, one stroke weight (1.8), round caps. Inline SVG: no image requests.

const PATHS = {
  palace: <path d="M4 9.5L12 4l8 5.5M6.5 10.5v7M10.5 10.5v7M13.5 10.5v7M17.5 10.5v7M4 20h16" />,
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <circle cx="12" cy="15.2" r="1.5" />
    </>
  ),
  deals: (
    <>
      <path d="M3.5 12.6V5A1.5 1.5 0 0 1 5 3.5h7.6l8 8a1.5 1.5 0 0 1 0 2.1l-7 7a1.5 1.5 0 0 1-2.1 0z" />
      <circle cx="8.5" cy="8.5" r="1.5" />
    </>
  ),
  prices: <path d="M3 17l5.5-5.5 4 4L21 7M15 7h6v6" />,
  passes: (
    <>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z" />
      <path d="M14.5 6.5v11" strokeDasharray="2 2.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  ext: <path d="M7 17L17 7M9 7h8v8" />,
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13.5" r="7" />
      <path d="M12 10v3.5l2.3 1.5M9.5 3h5" />
    </>
  ),
  pause: <path d="M9 6.5v11M15 6.5v11" />,
  sortdn: <path d="M12 5v14M7 14l5 5 5-5" />,
  sortup: <path d="M12 19V5M7 10l5-5 5 5" />,
  chev: <path d="M7 10l5 5 5-5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowup: <path d="M12 19V5M6 11l6-6 6 6" />,
  fall: <path d="M3 7l6 6 4-4 8 8M21 11v6h-6" />,
  star: <path d="M12 3.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.62l-5.1 2.68.97-5.68L3.75 9.6l5.7-.83z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2M12 7.9v.1" />
    </>
  ),
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  lock: <path d="M7.5 11V8.2a4.5 4.5 0 0 1 9 0V11M5.5 11h13v9.5h-13zM12 14.5v2.5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  share: <path d="M12 3.5v11M8 7.5l4-4 4 4M8.5 10.5H6.5v9.5h11v-9.5h-2" />,
  home: <path d="M4 11l8-6.5 8 6.5M6.5 9.5V20h11V9.5M10 20v-5h4v5" />,
  chat: <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16a2 2 0 0 1-2-2z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  coins: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
      <path d="M5 6.5v5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-5M5 11.5v5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-5" />
    </>
  ),
  flag: <path d="M5.5 21V4M5.5 4.5h11l-2.2 4 2.2 4h-11" />,
  layers: (
    <>
      <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="M3.5 12.5l8.5 4.5 8.5-4.5M3.5 16.5L12 21l8.5-4.5" />
    </>
  ),
  cards: (
    <>
      <rect x="3.5" y="7" width="11" height="14" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4.2l8.7 15.3H3.3z" />
      <path d="M12 10v4.2M12 16.9v.1" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M3.5 19.5c.6-3.1 2.8-5 5.5-5s4.9 1.9 5.5 5M15.2 14.4c2.6-.4 4.7 1.3 5.3 4.4" />
    </>
  ),
  bolt: <path d="M13 3L5.5 13.2H11L10 21l7.5-10.2H12z" />,
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2.1H4.4z" />
      <path d="M10 21a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  cal: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M12 14h2M16 14h.5M8 17h2M12 17h2" />
    </>
  ),
  user: <path d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2zM4.6 20.4a7.4 7.4 0 0 1 14.8 0" />,
  wallet: (
    <>
      <path d="M4 8V6.5A1.5 1.5 0 0 1 5.5 5H17M4 8h14.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM16 13.5h.01" />
    </>
  ),
  tune: <path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9M15 5.5v4M9 14.5v4" />,
  book: (
    <>
      <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v14H7.5A2.5 2.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A2.5 2.5 0 0 0 7.5 22H19v-5" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `i ${className}` : "i"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
