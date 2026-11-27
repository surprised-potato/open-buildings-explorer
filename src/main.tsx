import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/tokens.css';
import './styles/app.css';
import App from './App';

async function bootstrap() {
  if (!('switch' in HTMLInputElement.prototype)) {
    // @ts-expect-error input-switch-polyfill ships without TypeScript declarations
    await import('input-switch-polyfill');
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void bootstrap();
