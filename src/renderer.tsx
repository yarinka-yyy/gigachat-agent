import { createRoot } from 'react-dom/client';
import App from './app';
import './app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Renderer root element is missing');

createRoot(root).render(<App />);
