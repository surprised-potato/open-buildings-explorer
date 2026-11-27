import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/tokens.css';
import './styles/app.css';
import App from './App';
import { DEFAULT_PLACE_SLUG, PLACE_SLUG, loadPlaceMeta } from './utils/place';

function showFatal(rootEl: HTMLElement, message: string) {
  rootEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'place-error';
  const h = document.createElement('h1');
  h.textContent = 'This place is not available';
  const p = document.createElement('p');
  p.textContent = message;
  const a = document.createElement('a');
  a.href = `${window.location.pathname}#place=${DEFAULT_PLACE_SLUG}`;
  a.textContent = 'Open Bacolod City instead';
  a.addEventListener('click', () => setTimeout(() => window.location.reload(), 0));
  box.append(h, p, a);
  rootEl.append(box);
}

async function bootstrap() {
  if (!('switch' in HTMLInputElement.prototype)) {
    // @ts-expect-error input-switch-polyfill ships without TypeScript declarations
    await import('input-switch-polyfill');
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  try {
    const meta = await loadPlaceMeta(import.meta.env.BASE_URL);
    document.title = `${meta.displayName} — 3D Graphical Digital Twin`;
  } catch (err) {
    showFatal(rootEl, `${(err as Error).message}: "${PLACE_SLUG}" has not been built yet, or the link is mistyped.`);
    return;
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void bootstrap();
