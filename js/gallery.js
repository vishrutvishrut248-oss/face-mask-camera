/* gallery.js — built-in masks + localStorage gallery for saved user masks. */

export const BUILTIN_MASKS = [
  { id: 'builtin-kitsune', name: 'Kitsune', src: 'assets/masks/kitsune.png', builtin: true },
  { id: 'builtin-robot', name: 'Robot', src: 'assets/masks/robot.png', builtin: true },
  { id: 'builtin-cat', name: 'Cat', src: 'assets/masks/cat.png', builtin: true },
  { id: 'builtin-anime', name: 'Anime', src: 'assets/masks/anime.png', builtin: true },
];

const KEY = 'maskcam.masks.v1';
const QUOTA_BYTES = 3_500_000;

export function loadUserMasks() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveUserMask(mask) {
  const prev = loadUserMasks();
  const masks = prev.slice();
  masks.unshift(mask);
  try {
    localStorage.setItem(KEY, JSON.stringify(masks));
    return { ok: true, masks };
  } catch (e) {
    // quota: drop oldest until it fits
    while (masks.length > 1) {
      masks.pop();
      try { localStorage.setItem(KEY, JSON.stringify(masks)); return { ok: true, masks, dropped: true }; }
      catch { /* keep trimming */ }
    }
    // a failed setItem leaves the old list untouched (never wipe previous saves)
    return { ok: false, masks: prev, error: 'Storage full — mask too large to save.' };
  }
}

export function deleteUserMask(id) {
  const masks = loadUserMasks().filter(m => m.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(masks)); } catch {}
  return masks;
}

export function storageUsed() {
  try { return (localStorage.getItem(KEY) || '').length; } catch { return 0; }
}
export { QUOTA_BYTES };
