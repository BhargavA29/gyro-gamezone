import type { AvatarId } from "@gyro/shared";

export function avatarSvg(id: AvatarId, color: string, size = 28): string {
  switch (id) {
    case "crosshair":
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/><circle cx="12" cy="12" r="1.5" fill="${color}"/></svg>`;
    case "prism":
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 3 21 19 3 19"/><polygon points="12 9 16 17 8 17" fill="${color}" fill-opacity="0.25"/></svg>`;
    case "chevron":
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 15 12 8 19 15"/><polyline points="5 20 12 13 19 20"/></svg>`;
    case "orbit":
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" aria-hidden="true"><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-30 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(30 12 12)"/><circle cx="12" cy="12" r="2.2" fill="${color}"/></svg>`;
  }
}

export const ICON_RECENTER = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`;

export const ICON_VOLUME_ON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;

export const ICON_VOLUME_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
