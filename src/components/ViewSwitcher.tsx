import { BarChart3, Compass, FileText, Play } from 'lucide-react';
import { useEffect } from 'react';
import { useTwinStore } from '../layers/registry';
import { APP_VIEWS, type AppView } from '../layers/types';

const VIEW_META: Record<AppView, { label: string; hint: string; icon: typeof Compass }> = {
  explore: { label: 'Explore', hint: 'Layers, search and building details', icon: Compass },
  analyze: { label: 'Analyze', hint: 'Compare barangays and pick sites', icon: BarChart3 },
  simulate: { label: 'Simulate', hint: 'Run the traffic and mobility simulation', icon: Play },
  reports: { label: 'Reports', hint: 'Preview and export city and barangay reports', icon: FileText },
};

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function ViewSwitcher() {
  const { activeView, setActiveView } = useTwinStore();

  // Keys 1-4 switch views (ignored while typing or with modifiers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < APP_VIEWS.length) setActiveView(APP_VIEWS[i]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveView]);

  return (
    <div className="segmented-control view-switcher" role="tablist" aria-label="Workspace view">
      {APP_VIEWS.map((v, i) => {
        const { label, hint, icon: Icon } = VIEW_META[v];
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={activeView === v}
            className={`segmented-btn ${activeView === v ? 'active' : ''}`}
            onClick={() => setActiveView(v)}
            title={`${hint} (${i + 1})`}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
