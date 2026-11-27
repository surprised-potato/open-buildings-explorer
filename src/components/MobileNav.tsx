import { BarChart3, Compass, FileText, Layers, Play } from 'lucide-react';
import { useTwinStore } from '../layers/registry';
import type { AppView } from '../layers/types';

const TABS: { view: AppView; label: string; icon: typeof Compass }[] = [
  { view: 'explore', label: 'Explore', icon: Compass },
  { view: 'analyze', label: 'Analyze', icon: BarChart3 },
  { view: 'simulate', label: 'Simulate', icon: Play },
  { view: 'reports', label: 'Reports', icon: FileText },
];

interface MobileNavProps {
  layersOpen: boolean;
  onToggleLayers: () => void;
  onSelectView: () => void;
}

/** Bottom tab bar shown on phones (CSS hides it on wider screens). */
export function MobileNav({ layersOpen, onToggleLayers, onSelectView }: MobileNavProps) {
  const { activeView, setActiveView } = useTwinStore();
  return (
    <nav className="mobile-nav glass-panel" aria-label="Views">
      {TABS.map(({ view, label, icon: Icon }) => (
        <button
          key={view}
          type="button"
          className={`mobile-tab ${activeView === view && !layersOpen ? 'active' : ''}`}
          aria-current={activeView === view ? 'page' : undefined}
          onClick={() => {
            setActiveView(view);
            onSelectView();
          }}
        >
          <Icon size={19} />
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        className={`mobile-tab ${layersOpen ? 'active' : ''}`}
        aria-pressed={layersOpen}
        disabled={activeView === 'reports'}
        onClick={onToggleLayers}
      >
        <Layers size={19} />
        <span>Layers</span>
      </button>
    </nav>
  );
}
