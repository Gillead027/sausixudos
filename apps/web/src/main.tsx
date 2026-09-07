import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootPerfMode } from './perfMode';
import { bootTheme } from './theme';
import { bootDensity } from './density';
import { bootAppearancePrefs } from './appearancePrefs';
import './styles.css';

bootPerfMode();
bootTheme();
bootDensity();
bootAppearancePrefs();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
