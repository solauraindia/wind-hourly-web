import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconTurbine = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 12v10M9 22h6" />
    <circle cx="12" cy="10" r="1.6" />
    <path d="M12 8.4 11 2.5c1.6-.3 2.6.6 2.4 2.2L12 8.4ZM13.4 10.8l5.6 2.2c-.5 1.6-1.8 2-3.1 1.1l-2.5-3.3ZM10.6 10.8 6 14.6c-1.1-1.2-.8-2.6.6-3.2l4-.6Z" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
export const IconTable = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 10v10M15 10v10" />
  </svg>
);
export const IconDevices = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);
export const IconDownload = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
  </svg>
);
export const IconFolder = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </svg>
);
export const IconFile = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base} {...p}>
    <path d="m5 12 5 5 9-10" />
  </svg>
);
export const IconAlert = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
);
export const IconDatabase = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);
export const IconX = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
