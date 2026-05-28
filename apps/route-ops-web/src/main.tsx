import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const root = document.getElementById('clever-route-ops-root');
if (root === null) {
  throw new Error('CLEVER Route Ops root element is missing');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
