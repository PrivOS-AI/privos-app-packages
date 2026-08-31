import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LazyBoundary } from './lazy-boundary';

declare global {
  interface Window {
    /** Set once this bootstrap has rendered — clears the inline boot watchdog. */
    __privosUiBooted?: boolean;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LazyBoundary>
      <App />
    </LazyBoundary>
  </React.StrictMode>,
);

window.__privosUiBooted = true;
