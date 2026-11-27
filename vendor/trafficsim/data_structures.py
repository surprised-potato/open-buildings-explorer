# File: data_structures.py

from dataclasses import dataclass, field
from typing import Dict, Optional, Any
import uuid

@dataclass
class Mode:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = "Default Mode"
    beta_cost: float = -0.1
    beta_duration: float = -0.1
    asc: float = 0.0 # Mode-specific constant
    veh_factor: float = 1.0   # road load per person trip (pcu / occupancy); 0 = does not load the road network
    congests: bool = True     # False: travel time is not affected by congestion (e.g. walking)

@dataclass
class Node:
    # --- CHANGED Coordinates ---
    lat: float = 0.0  # Latitude
    lon: float = 0.0  # Longitude
    # --- Core Attributes ---
    name: str = "Node"
    is_zone: bool = False
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    # --- GUI/Map Related State (NEW - use field to exclude from default __init__) ---
    # Using 'Any' to avoid strict dependency on tkintermapview types here
    map_marker: Optional[Any] = field(default=None, compare=False, repr=False)


@dataclass
class Edge:
    # --- Attributes (order matters less now, but keep logical) ---
    start_node_id: str = ""
    end_node_id: str = ""
    distance: float = 1.0 # May be auto-calculated or user-set
    capacity: float = 1000.0
    free_flow_time: Optional[float] = None
    modal_values: Dict[str, Dict[str, float]] = field(default_factory=dict)
    flow: Dict[str, float] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    # Optional road shape [(lat, lon), ...] including both endpoints (set by OSM import)
    geometry: Optional[list] = None
    # --- GUI/Map Related State (NEW - use field to exclude from default __init__) ---
    map_path: Optional[Any] = field(default=None, compare=False, repr=False)
    map_label_marker: Optional[Any] = field(default=None, compare=False, repr=False)
    # Remove canvas_item, canvas_text_item if they exist from previous versions
    # canvas_item: Optional[int] = field(default=None, compare=False, repr=False)
    # canvas_text_item: Optional[int] = field(default=None, compare=False, repr=False)

    @property
    def total_flow(self) -> float:
        """Returns the sum of flows for all modes on this edge."""
        return sum(self.flow.values())

    def get_mode_flow(self, mode_id: str) -> float:
        """Gets the flow for a specific mode, returns 0.0 if mode not present."""
        return self.flow.get(mode_id, 0.0)

    def get_mode_duration(self, mode_id: str) -> Optional[float]:
        """Gets the BASE duration for a specific mode from modal_values."""
        return self.modal_values.get(mode_id, {}).get('duration')

    def get_mode_cost(self, mode_id: str) -> Optional[float]:
         """Gets the cost for a specific mode from modal_values."""
         return self.modal_values.get(mode_id, {}).get('cost')

    def get_base_duration(self, mode_id: Optional[str] = None) -> Optional[float]:
        """Gets the best available base duration (Free Flow Time preferred)."""
        if self.free_flow_time is not None:
            return self.free_flow_time
        # Fallback: Use modal duration if free_flow_time isn't set
        if mode_id and mode_id in self.modal_values:
            modal_dur = self.modal_values[mode_id].get('duration')
            if modal_dur is not None:
                return modal_dur
        # Fallback further: distance? Less ideal, depends on units.
        # return self.distance # Uncomment if this is desired fallback logic
        return None # Indicate base duration is unknown