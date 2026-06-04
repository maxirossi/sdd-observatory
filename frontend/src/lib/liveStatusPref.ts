// Preferencia on/off de la barra de estado en vivo. Default: true.
const KEY = 'liveStatusEnabled';
const EVT = 'live-status-pref-changed';

export function getLiveStatusEnabled(): boolean {
  const v = localStorage.getItem(KEY);
  return v === null ? true : v === 'true';
}

export function setLiveStatusEnabled(on: boolean): void {
  localStorage.setItem(KEY, String(on));
  window.dispatchEvent(new CustomEvent(EVT));
}

export function subscribeLiveStatusEnabled(cb: (on: boolean) => void): () => void {
  const h = () => cb(getLiveStatusEnabled());
  window.addEventListener(EVT, h);
  window.addEventListener('storage', h);
  return () => {
    window.removeEventListener(EVT, h);
    window.removeEventListener('storage', h);
  };
}
