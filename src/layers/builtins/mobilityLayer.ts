import type { TwinLayerDefinition } from '../types';

export const mobilityLayer: TwinLayerDefinition = {
  id: 'mobility',
  name: 'Mobility Swarm',
  description:
    'Agent-based Bacolod traveller micro-swarm derived from trafficsim gravity demand and 5-mode routing.',
  category: 'mobility',
  engine: 'deck',
  defaultVisible: true,
  defaultOpacity: 0.95,
  legend: [
    { label: 'Jeepney / bus', color: '#f59e0b', shape: 'circle' },
    { label: 'Motorcycle', color: '#ec4899', shape: 'circle' },
    { label: 'Car', color: '#38bdf8', shape: 'circle' },
    { label: 'Tricycle', color: '#10b981', shape: 'circle' },
    { label: 'Walk', color: '#f8fafc', shape: 'circle' },
  ],
  // Driven directly at 60 FPS via Deck.gl overlayRef in TwinViewport
  buildDeckLayer() {
    return null;
  },
};
