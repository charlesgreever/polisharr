import type { SVGProps } from "react";

function Svg(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18" {...props} />;
}

export const Icons = {
  home: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" /></Svg>
  ),
  movies: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.5v5l4-2.5z" /></Svg>
  ),
  series: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>
  ),
  suggestions: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></Svg>
  ),
  queue: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M4 6h16M4 12h10M4 18h7" /><path d="M16 14l4 3-4 3z" /></Svg>
  ),
  review: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M5 12l4 4 10-10" /></Svg>
  ),
  playback: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M10 9.5v5l4-2.5z" /></Svg>
  ),
  errors: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></Svg>
  ),
  history: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></Svg>
  ),
  settings: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></Svg>
  ),
  search: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-3.5-3.5" /></Svg>
  ),
  menu: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
  ),
  sun: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3 5.6 18.4" />
    </Svg>
  ),
  moon: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M17 14.5A7 7 0 0 1 9.5 7 7.2 7.2 0 1 0 17 14.5z" /></Svg>
  ),
  help: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.3 2.4c-.8.4-1.3 1-1.3 1.8V14M12 17h.01" /></Svg>
  ),
  stereo: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><rect x="3" y="8" width="6" height="8" rx="1" /><rect x="15" y="8" width="6" height="8" rx="1" /></Svg>
  ),
  exempt: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z" /></Svg>
  ),
  open: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><path d="M14 5h5v5M19 5l-9 9" /><path d="M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></Svg>
  ),
  bug: (p?: SVGProps<SVGSVGElement>) => (
    <Svg {...p}><circle cx="12" cy="14" r="6" /><path d="M8 8l-2-3M16 8l2-3M6 14H3M21 14h-3M8 20l-2 2M16 20l2 2" /></Svg>
  ),
};
