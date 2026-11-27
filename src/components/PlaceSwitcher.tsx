import { ChevronDown, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PLACE_SLUG, getPlaceMeta, loadPlaceIndex, type PlaceIndexEntry } from '../utils/place';

/** Dropdown of the places that have been built (data/places.json). Switching reloads the app on that place. */
export function PlaceSwitcher() {
  const [places, setPlaces] = useState<PlaceIndexEntry[]>([]);

  useEffect(() => {
    let live = true;
    void loadPlaceIndex(import.meta.env.BASE_URL).then((list) => {
      if (live) setPlaces(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const meta = getPlaceMeta();
  if (places.length < 2) {
    return <h1 className="hud-topbar-title">{meta.displayName}</h1>;
  }
  const sorted = [...places].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <label className="place-switcher" title="Switch city or municipality">
      <span className="sr-only">City or municipality</span>
      <MapPin size={13} aria-hidden="true" />
      <select
        value={PLACE_SLUG}
        aria-label="City or municipality"
        onChange={(e) => {
          const slug = e.target.value;
          // Drop the camera and layer state of the old place; the new one opens at its home view.
          window.location.hash = slug === 'bacolod' ? '' : `place=${slug}`;
          window.location.reload();
        }}
      >
        {sorted.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.displayName}
          </option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden="true" className="place-switcher-chevron" />
    </label>
  );
}
