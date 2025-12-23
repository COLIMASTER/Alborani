import math
import random
from copy import deepcopy
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)


WAREHOUSE = {"lat": 36.834, "lon": -2.4637, "name": "Almacen Almeria"}

WORKERS = {
    "prueba1": {"password": "123", "name": "Operador 1"},
    "prueba2": {"password": "123", "name": "Operador 2"},
    "prueba3": {"password": "123", "name": "Operador 3"},
}

ADMIN = {"username": "admin", "password": "123"}


def _make_tank(prefix: str, idx: int, base_lat: float, base_lon: float, product: str):
    capacity = random.choice([14000, 16000, 18000, 20000])
    current = random.randint(int(capacity * 0.38), int(capacity * 0.86))
    offset = (idx - 2) * 0.0012
    sensors = {
        "ph": round(random.uniform(5.7, 6.4), 2),
        "ec": round(random.uniform(1.8, 2.9), 2),
        "drain_ph": round(random.uniform(5.8, 6.5), 2),
        "drain_ec": round(random.uniform(1.7, 2.6), 2),
        "climate": {
            "temp_c": round(random.uniform(22, 30), 1),
            "humidity_pct": random.randint(58, 78),
            "vpd": round(random.uniform(0.7, 1.4), 2),
        },
        "fertilizer": {
            "mix_l": random.randint(800, 1600),
            "pressure_bar": round(random.uniform(1.7, 2.8), 2),
        },
        "drain_pct": random.randint(14, 30),
    }
    return {
        "id": f"{prefix}-{idx}",
        "label": f"Deposito {idx}",
        "product": product,
        "capacity_l": capacity,
        "current_l": current,
        "warn_at": 0.32,
        "crit_at": 0.18,
        "location": {"lat": base_lat + offset, "lon": base_lon + offset, "name": prefix},
        "sensors": sensors,
    }


def _build_centers():
    return [
        {
            "id": "eurogold",
            "name": "Eurogold",
            "location": {"lat": 36.8273, "lon": -2.1506},
            "tanks": [
                _make_tank("EG", 1, 36.8273, -2.1506, "Calcio + nitrato"),
                _make_tank("EG", 2, 36.8273, -2.1506, "NPK 15-5-30"),
                _make_tank("EG", 3, 36.8273, -2.1506, "Amonio + micro"),
            ],
        },
        {
            "id": "matias",
            "name": "Los Matias",
            "location": {"lat": 36.829171, "lon": -2.160965},
            "tanks": [
                _make_tank("MT", 1, 36.829171, -2.160965, "Urea foliar"),
                _make_tank("MT", 2, 36.829171, -2.160965, "NPK 12-12-24"),
                _make_tank("MT", 3, 36.829171, -2.160965, "Fosforo acido"),
            ],
        },
        {
            "id": "cortezones",
            "name": "Los Cortezones",
            "location": {"lat": 36.904461, "lon": -2.205572},
            "tanks": [
                _make_tank("CZ", 1, 36.904461, -2.205572, "Potasio liquido"),
                _make_tank("CZ", 2, 36.904461, -2.205572, "Calcio + boro"),
                _make_tank("CZ", 3, 36.904461, -2.205572, "PK 0-20-30"),
            ],
        },
        {
            "id": "hornillos",
            "name": "Los Hornillos",
            "location": {"lat": 36.830851, "lon": -2.139645},
            "tanks": [
                _make_tank("HN", 1, 36.830851, -2.139645, "NPK 9-12-30"),
                _make_tank("HN", 2, 36.830851, -2.139645, "Potasio + Ca"),
                _make_tank("HN", 3, 36.830851, -2.139645, "Aqua micronizado"),
            ],
        },
        {
            "id": "vicar",
            "name": "Vicar",
            "location": {"lat": 36.791086, "lon": -2.65487},
            "tanks": [
                _make_tank("VC", 1, 36.791086, -2.65487, "NPK 16-8-24"),
                _make_tank("VC", 2, 36.791086, -2.65487, "Riego bicarbonato"),
                _make_tank("VC", 3, 36.791086, -2.65487, "Corrector de Zn"),
            ],
        },
        # Centros de prueba adicionales
        {
            "id": "prueba1",
            "name": "Prueba 1",
            "location": {"lat": 36.8325, "lon": -2.1450},
            "tanks": [
                _make_tank("P1", 1, 36.8325, -2.1450, "NPK 15-5-30"),
                _make_tank("P1", 2, 36.8325, -2.1450, "Calcio + nitrato"),
                _make_tank("P1", 3, 36.8325, -2.1450, "Micros mixtos"),
            ],
        },
        {
            "id": "prueba2",
            "name": "Prueba 2",
            "location": {"lat": 36.8235, "lon": -2.1675},
            "tanks": [
                _make_tank("P2", 1, 36.8235, -2.1675, "NPK 12-12-24"),
                _make_tank("P2", 2, 36.8235, -2.1675, "Amonio + micro"),
                _make_tank("P2", 3, 36.8235, -2.1675, "Fosforo acido"),
            ],
        },
        {
            "id": "prueba3",
            "name": "Prueba 3",
            "location": {"lat": 36.8365, "lon": -2.1320},
            "tanks": [
                _make_tank("P3", 1, 36.8365, -2.1320, "Potasio liquido"),
                _make_tank("P3", 2, 36.8365, -2.1320, "NPK 9-12-30"),
                _make_tank("P3", 3, 36.8365, -2.1320, "Corrector de Zn"),
            ],
        },
        {
            "id": "prueba4",
            "name": "Prueba 4",
            "location": {"lat": 36.9090, "lon": -2.2135},
            "tanks": [
                _make_tank("P4", 1, 36.9090, -2.2135, "Calcio + boro"),
                _make_tank("P4", 2, 36.9090, -2.2135, "NPK 16-8-24"),
                _make_tank("P4", 3, 36.9090, -2.2135, "Urea foliar"),
            ],
        },
        {
            "id": "prueba5",
            "name": "Prueba 5",
            "location": {"lat": 36.7845, "lon": -2.6485},
            "tanks": [
                _make_tank("P5", 1, 36.7845, -2.6485, "PK 0-20-30"),
                _make_tank("P5", 2, 36.7845, -2.6485, "Riego bicarbonato"),
                _make_tank("P5", 3, 36.7845, -2.6485, "Micros mixtos"),
            ],
        },
        {
            "id": "prueba6",
            "name": "Prueba 6",
            "location": {"lat": 36.8208, "lon": -2.1550},
            "tanks": [
                _make_tank("P6", 1, 36.8208, -2.1550, "NPK 15-5-30"),
                _make_tank("P6", 2, 36.8208, -2.1550, "Corrector de Zn"),
                _make_tank("P6", 3, 36.8208, -2.1550, "Potasio + Ca"),
            ],
        },
        {
            "id": "prueba7",
            "name": "Prueba 7",
            "location": {"lat": 36.8350, "lon": -2.1520},
            "tanks": [
                _make_tank("P7", 1, 36.8350, -2.1520, "NPK 12-12-24"),
                _make_tank("P7", 2, 36.8350, -2.1520, "Calcio + nitrato"),
                _make_tank("P7", 3, 36.8350, -2.1520, "Aqua micronizado"),
            ],
        },
        {
            "id": "prueba8",
            "name": "Prueba 8",
            "location": {"lat": 36.8980, "lon": -2.1940},
            "tanks": [
                _make_tank("P8", 1, 36.8980, -2.1940, "Fosforo acido"),
                _make_tank("P8", 2, 36.8980, -2.1940, "NPK 9-12-30"),
                _make_tank("P8", 3, 36.8980, -2.1940, "Calcio + boro"),
            ],
        },
        {
            "id": "prueba9",
            "name": "Prueba 9",
            "location": {"lat": 36.8260, "lon": -2.1455},
            "tanks": [
                _make_tank("P9", 1, 36.8260, -2.1455, "NPK 16-8-24"),
                _make_tank("P9", 2, 36.8260, -2.1455, "Potasio liquido"),
                _make_tank("P9", 3, 36.8260, -2.1455, "Micros mixtos"),
            ],
        },
        {
            "id": "prueba10",
            "name": "Prueba 10",
            "location": {"lat": 36.7950, "lon": -2.6625},
            "tanks": [
                _make_tank("P10", 1, 36.7950, -2.6625, "Riego bicarbonato"),
                _make_tank("P10", 2, 36.7950, -2.6625, "NPK 12-12-24"),
                _make_tank("P10", 3, 36.7950, -2.6625, "Potasio + Ca"),
            ],
        },
    ]


centers = _build_centers()

trucks = [
    {
        "id": "TR-01",
        "driver": "Alba",
        "status": "parked",  # parked | outbound | delivering | returning
        "current_load_l": 0,
        "capacity_l": 12000,
        "position": deepcopy(WAREHOUSE),
        "destination": None,
        "started_at": None,
        "eta_minutes": None,
        "route_id": None,
        "notes": "Disponible en almacen",
    },
    {
        "id": "TR-02",
        "driver": "Raul",
        "status": "parked",
        "current_load_l": 0,
        "capacity_l": 10000,
        "position": deepcopy(WAREHOUSE),
        "destination": None,
        "started_at": None,
        "eta_minutes": None,
        "route_id": None,
        "notes": "Revisado y libre",
    },
    {
        "id": "TR-03",
        "driver": "Sofia",
        "status": "parked",
        "current_load_l": 0,
        "capacity_l": 14000,
        "position": deepcopy(WAREHOUSE),
        "destination": None,
        "started_at": None,
        "eta_minutes": None,
        "route_id": None,
        "notes": "Listo para cargar",
    },
]

active_routes: List[Dict] = []
route_history: List[Dict] = []
delivery_log: List[Dict] = []


def _now():
    return datetime.utcnow()


def _seed_history():
    started = _now() - timedelta(hours=6, minutes=10)
    stop1_arrival = started + timedelta(minutes=32)
    stop1_depart = stop1_arrival + timedelta(minutes=18)
    stop2_arrival = stop1_depart + timedelta(minutes=30)
    stop2_depart = stop2_arrival + timedelta(minutes=22)
    finished = stop2_depart + timedelta(minutes=36)
    route = {
        "id": "R-000",
        "worker": "prueba2",
        "truck_id": "TR-02",
        "origin": WAREHOUSE["name"],
        "product_type": "NPK 12-12-24",
        "stops": [
            {
                "center_id": "matias",
                "tank_id": "MT-1",
                "liters": 3200,
                "product": "NPK 12-12-24",
                "status": "completado",
                "arrival_at": stop1_arrival,
                "depart_at": stop1_depart,
                "delivered_l": 3200,
            },
            {
                "center_id": "eurogold",
                "tank_id": "EG-2",
                "liters": 2500,
                "product": "NPK 15-5-30",
                "status": "completado",
                "arrival_at": stop2_arrival,
                "depart_at": stop2_depart,
                "delivered_l": 2500,
            },
        ],
        "status": "finalizada",
        "current_stop_idx": 2,
        "started_at": started,
        "finished_at": finished,
        "history": [
            {"event": "planificada", "note": "2 destinos", "ts": started},
            {"event": "llegada", "note": "matias / MT-1", "ts": stop1_arrival},
            {"event": "llegada", "note": "eurogold / EG-2", "ts": stop2_arrival},
            {"event": "almacen", "note": "Ruta cerrada", "ts": finished},
        ],
        "current_leg": None,
        "total_delivered": 5700,
        "success": True,
    }
    route_history.append(route)
    delivery_log.extend(
        [
            {
                "ts": stop1_depart,
                "truck_id": "TR-02",
                "tank_id": "MT-1",
                "center": "Los Matias",
                "delivered_l": 3200,
                "by": "prueba2",
                "note": "Descarga turno manana",
            },
            {
                "ts": stop2_depart,
                "truck_id": "TR-02",
                "tank_id": "EG-2",
                "center": "Eurogold",
                "delivered_l": 2500,
                "by": "prueba2",
                "note": "Entrega completa",
            },
        ]
    )


_seed_history()


def _haversine_km(a, b):
    r = 6371
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def _lerp(a, b, t):
    return a + (b - a) * t


def _find_center(center_id: str) -> Optional[Dict]:
    return next((c for c in centers if c["id"] == center_id), None)


def _find_tank(center_id: str, tank_id: str) -> Optional[Dict]:
    center = _find_center(center_id)
    if not center:
        return None
    return next((t for t in center["tanks"] if t["id"] == tank_id), None)


def _iter_tanks():
    for center in centers:
        for tank in center["tanks"]:
            yield tank, center


def _flatten_tanks():
    flat = []
    for tank, center in _iter_tanks():
        flat.append({**tank, "center_id": center["id"], "center_name": center["name"]})
    return flat


def _compute_tank_status(tank):
    pct = tank["current_l"] / tank["capacity_l"] if tank["capacity_l"] else 0
    urgent_threshold = 0.2
    status = "ok"
    hours_left = None
    runout_eta = None

    if pct <= urgent_threshold:
        status = "alert"
        hours_left = 48
        runout_eta = _now() + timedelta(hours=hours_left)
    elif pct <= tank["warn_at"]:
        status = "warn"

    if hours_left is None:
        hourly_use = tank["capacity_l"] * 0.018
        hours_left = (tank["current_l"] / hourly_use) if hourly_use else None
        runout_eta = (_now() + timedelta(hours=hours_left)) if hours_left else None

    return pct, status, runout_eta, hours_left


def _tank_deficit(tank: Dict) -> int:
    return max(tank.get("capacity_l", 0) - tank.get("current_l", 0), 0)


def _collect_urgent_centers():
    urgent = []
    for center in centers:
        urgent_tanks = []
        for tank in center["tanks"]:
            pct, status, runout_eta, hours_left = _compute_tank_status(tank)
            if pct <= 0.2:
                urgent_tanks.append(
                    {
                        "id": tank["id"],
                        "label": tank["label"],
                        "product": tank["product"],
                        "percentage": round(pct * 100, 1),
                        "deficit_l": _tank_deficit(tank),
                        "runout_eta": runout_eta.isoformat() if runout_eta else None,
                        "hours_left": hours_left,
                    }
                )
        if urgent_tanks:
            total_deficit = sum(t["deficit_l"] for t in urgent_tanks)
            urgent.append(
                {
                    "center_id": center["id"],
                    "center_name": center["name"],
                    "location": center["location"],
                    "tanks": urgent_tanks,
                    "total_deficit": total_deficit,
                    "urgent_count": len(urgent_tanks),
                }
            )
    return urgent


def _jitter(value: float, delta: float, min_v: float, max_v: float):
    jittered = value + random.uniform(-delta, delta)
    return max(min_v, min(max_v, round(jittered, 2)))


def _simulate_sensors():
    for tank, _center in _iter_tanks():
        sensors = tank["sensors"]
        sensors["ph"] = _jitter(sensors["ph"], 0.08, 5.5, 6.6)
        sensors["ec"] = _jitter(sensors["ec"], 0.12, 1.8, 3.0)
        sensors["drain_ph"] = _jitter(sensors["drain_ph"], 0.06, 5.4, 6.7)
        sensors["drain_ec"] = _jitter(sensors["drain_ec"], 0.1, 1.4, 2.8)
        sensors["climate"]["temp_c"] = _jitter(sensors["climate"]["temp_c"], 0.6, 19, 35)
        sensors["climate"]["humidity_pct"] = int(
            max(48, min(85, sensors["climate"]["humidity_pct"] + random.randint(-2, 2)))
        )
        sensors["climate"]["vpd"] = _jitter(sensors["climate"]["vpd"], 0.08, 0.5, 1.8)
        sensors["fertilizer"]["mix_l"] = int(
            max(200, min(1800, sensors["fertilizer"]["mix_l"] + random.randint(-40, 60)))
        )
        sensors["fertilizer"]["pressure_bar"] = _jitter(
            sensors["fertilizer"]["pressure_bar"], 0.05, 1.5, 3.2
        )
        sensors["drain_pct"] = int(max(8, min(40, sensors["drain_pct"] + random.randint(-2, 2))))


def _simulate_drain():
    for tank, _center in _iter_tanks():
        drain = random.randint(160, 420)
        tank["current_l"] = max(tank["current_l"] - drain, 0)
    _simulate_sensors()


def _new_route_id():
    return f"R-{len(active_routes) + len(route_history) + 1:03d}"


def _build_leg(origin: Dict, destination: Dict, label: str):
    km = _haversine_km(origin, destination)
    eta_minutes = max(8, math.ceil(km / 60 * 60))
    return {
        "origin": origin,
        "destination": destination,
        "started_at": _now(),
        "eta_minutes": eta_minutes,
        "label": label,
    }


def _set_leg(route: Dict, truck: Dict, origin: Dict, destination: Dict, label: str):
    leg = _build_leg(origin, destination, label)
    route["current_leg"] = leg
    truck["started_at"] = leg["started_at"]
    truck["eta_minutes"] = leg["eta_minutes"]
    truck["position"] = {
        "lat": origin["lat"],
        "lon": origin["lon"],
        "name": origin.get("name", "Salida"),
    }
    truck["destination"] = {
        "name": destination.get("name", label),
        "center_id": destination.get("center_id"),
        "tank_id": destination.get("tank_id"),
    }
    return leg


def _update_truck_positions():
    for tr in trucks:
        route = next((r for r in active_routes if r["id"] == tr.get("route_id")), None)
        if not route or not route.get("current_leg"):
            continue
        leg = route["current_leg"]
        elapsed = (_now() - leg["started_at"]).total_seconds() / 60
        progress = min(max(elapsed / leg["eta_minutes"], 0), 1)
        tr["position"] = {
            "lat": _lerp(leg["origin"]["lat"], leg["destination"]["lat"], progress),
            "lon": _lerp(leg["origin"]["lon"], leg["destination"]["lon"], progress),
            "name": leg["label"],
        }
        if progress >= 1 and tr["status"] in ("outbound", "returning"):
            if route["status"] == "en_ruta":
                tr["notes"] = "En destino, marca llegada"
            elif route["status"] == "regresando":
                tr["notes"] = "Marca llegada a almacen"


def _order_centers_by_distance(center_batch: List[Dict], origin: Dict):
    ordered = []
    remaining = list(center_batch)
    current = origin
    while remaining:
        nearest = min(remaining, key=lambda c: _haversine_km(current, c["location"]))
        ordered.append(nearest)
        remaining.remove(nearest)
        current = nearest["location"]
    return ordered


def _build_auto_route_for_truck(truck: Dict, center_batch: List[Dict], worker: Optional[str] = None):
    if not center_batch:
        return None
    ordered_centers = _order_centers_by_distance(center_batch, WAREHOUSE)
    stops = []
    remaining_capacity = truck.get("capacity_l", 0)
    first_center_id = None

    for center in ordered_centers:
        if remaining_capacity <= 0:
            break
        center_id = center["center_id"]
        center_total_deficit = sum(t.get("deficit_l", 0) for t in center.get("tanks", []))
        if first_center_id is None:
            first_center_id = center_id
        # No abrir un centro nuevo si solo quedan migajas (<1000 L)
        if center_id != first_center_id and min(remaining_capacity, center_total_deficit) < 1000:
            continue

        for tank in sorted(center["tanks"], key=lambda t: t.get("deficit_l", 0), reverse=True):
            if remaining_capacity <= 0:
                break
            liters = min(tank["deficit_l"], remaining_capacity)
            if center_id != first_center_id and liters < 1000:
                continue
            if liters <= 0:
                continue
            stops.append(
                {
                    "center_id": center_id,
                    "tank_id": tank["id"],
                    "liters": liters,
                    "product": tank["product"],
                    "status": "pendiente",
                    "arrival_at": None,
                    "depart_at": None,
                    "delivered_l": None,
                }
            )
            remaining_capacity -= liters

    if not stops:
        return None

    planned_load = sum(s["liters"] for s in stops)
    route = {
        "id": _new_route_id(),
        "worker": worker,
        "truck_id": truck["id"],
        "origin": WAREHOUSE["name"],
        "product_type": "Multiproducto",
        "stops": stops,
        "status": "planificada",
        "current_stop_idx": 0,
        "started_at": None,
        "finished_at": None,
        "history": [
            {
                "event": "planificada",
                "note": f"{len(stops)} destinos urgentes"
                + (f" asignada a {worker}" if worker else ""),
                "ts": _now(),
            }
        ],
        "current_leg": None,
        "total_delivered": 0,
        "success": None,
        "auto_generated": True,
        "pending_worker": not bool(worker),
        "planned_load_l": planned_load,
    }
    return route


def _auto_plan_urgent_routes():
    urgent = sorted(_collect_urgent_centers(), key=lambda c: (c.get("urgent_count", 0), c["total_deficit"]), reverse=True)
    available_trucks = [
        t for t in trucks if t["status"] == "parked" and not t.get("route_id") and t.get("capacity_l")
    ]
    if not urgent or not available_trucks:
        return []

    worker_pool = list(WORKERS.keys())
    random.shuffle(worker_pool)

    assignments = {t["id"]: [] for t in available_trucks}

    # Asignar un centro prioritario a cada camion (prioriza centros con mas tanques en alerta)
    for tr in available_trucks:
        if urgent:
            assignments[tr["id"]].append(urgent.pop(0))

    # Repartir el resto intentando agrupar centros cercanos en la misma ruta
    idx = 0
    while urgent:
        tr = available_trucks[idx % len(available_trucks)]
        idx += 1
        batch = assignments.get(tr["id"], [])
        last_loc = batch[-1]["location"] if batch else WAREHOUSE
        nearest_idx = min(range(len(urgent)), key=lambda i: _haversine_km(last_loc, urgent[i]["location"]))
        batch.append(urgent.pop(nearest_idx))
        assignments[tr["id"]] = batch

    planned_routes = []
    for idx, tr in enumerate(available_trucks):
        center_batch = assignments.get(tr["id"], [])
        worker = worker_pool[idx % len(worker_pool)] if worker_pool else None
        route = _build_auto_route_for_truck(tr, center_batch, worker)
        if not route:
            continue
        tr["route_id"] = route["id"]
        tr["notes"] = f"Ruta urgente asignada a {worker}" if worker else "Ruta urgente planificada"
        tr["current_load_l"] = route.get("planned_load_l", 0)
        tr["destination"] = None
        tr["started_at"] = None
        tr["eta_minutes"] = None
        planned_routes.append(route)
        active_routes.append(route)
    return planned_routes


def _serialize_routes(routes: List[Dict]):
    serialized = []
    for r in routes:
        serialized.append(
            {
                **{k: r.get(k) for k in ["id", "worker", "truck_id", "origin", "status", "success"]},
                "started_at": r.get("started_at").isoformat() if r.get("started_at") else None,
                "finished_at": r.get("finished_at").isoformat() if r.get("finished_at") else None,
                "total_delivered": r.get("total_delivered", 0),
                "product_type": r.get("product_type"),
                "current_stop_idx": r.get("current_stop_idx", 0),
                "pending_worker": r.get("pending_worker", False),
                "auto_generated": r.get("auto_generated", False),
                "planned_load_l": r.get("planned_load_l"),
                "stops": [
                    {
                        **{k: stop.get(k) for k in ["center_id", "tank_id", "liters", "product", "status"]},
                        "arrival_at": stop.get("arrival_at").isoformat() if stop.get("arrival_at") else None,
                        "depart_at": stop.get("depart_at").isoformat() if stop.get("depart_at") else None,
                        "delivered_l": stop.get("delivered_l"),
                    }
                    for stop in r.get("stops", [])
                ],
                "history": [
                    {
                        "event": h.get("event"),
                        "note": h.get("note"),
                        "ts": h["ts"].isoformat(),
                    }
                    for h in r.get("history", [])
                ],
                "current_leg": {
                    **{k: r["current_leg"].get(k) for k in ["eta_minutes", "label"]},
                    "started_at": r["current_leg"]["started_at"].isoformat()
                    if r.get("current_leg")
                    else None,
                    "destination": r["current_leg"]["destination"],
                }
                if r.get("current_leg")
                else None,
            }
        )
    return serialized


def _serialize_state():
    _update_truck_positions()
    _simulate_sensors()

    serialized_centers = []
    flat_tanks = []
    alerts = []
    for c in centers:
        serialized_tanks = []
        for t in c["tanks"]:
            pct, status, runout, hours_left = _compute_tank_status(t)
            deficit_l = _tank_deficit(t)
            tank_entry = {
                "id": t["id"],
                "label": t["label"],
                "product": t["product"],
                "capacity_l": t["capacity_l"],
                "current_l": t["current_l"],
                "percentage": round(pct * 100, 1),
                "status": status,
                "runout_eta": runout.isoformat() if runout else None,
                "runout_hours": hours_left,
                "deficit_l": deficit_l,
                "needs_refill": status in ("warn", "critical", "alert"),
                "sensors": t["sensors"],
                "location": t["location"],
                "center_id": c["id"],
                "center_name": c["name"],
            }
            serialized_tanks.append(tank_entry)
            flat_tanks.append(tank_entry)
            if status in ("warn", "critical", "alert"):
                eta_text = ""
                if runout:
                    eta_text = f" Reponer antes de {runout.strftime('%d/%m %H:%M')}."
                alerts.append(
                    {
                        "tank_id": t["id"],
                        "center": c["name"],
                        "severity": "alta" if status in ("critical", "alert") else "media",
                        "message": f"{c['name']} / {t['label']} bajo en nivel ({round(pct*100,1)}%).{eta_text}",
                        "runout_eta": runout.isoformat() if runout else None,
                    }
                )
        avg_ph = round(sum(t["sensors"]["ph"] for t in c["tanks"]) / len(c["tanks"]), 2)
        avg_ec = round(sum(t["sensors"]["ec"] for t in c["tanks"]) / len(c["tanks"]), 2)
        serialized_centers.append(
            {
                "id": c["id"],
                "name": c["name"],
                "location": c["location"],
                "tanks": serialized_tanks,
                "avg_ph": avg_ph,
                "avg_ec": avg_ec,
            }
        )

    serialized_trucks = []
    for tr in trucks:
        serialized_trucks.append(
            {
                "id": tr["id"],
                "driver": tr["driver"],
                "status": tr["status"],
                "current_load_l": tr["current_load_l"],
                "capacity_l": tr["capacity_l"],
                "position": tr["position"],
                "destination": tr["destination"],
                "eta_minutes": tr["eta_minutes"],
                "notes": tr["notes"],
                "route_id": tr.get("route_id"),
            }
        )

    log = [
        {
            "ts": item["ts"].isoformat(),
            "truck_id": item["truck_id"],
            "tank_id": item["tank_id"],
            "center": item["center"],
            "delivered_l": item["delivered_l"],
            "by": item["by"],
            "note": item["note"],
        }
        for item in sorted(delivery_log, key=lambda x: x["ts"], reverse=True)[:12]
    ]

    return {
        "warehouse": WAREHOUSE,
        "centers": serialized_centers,
        "tanks": flat_tanks,
        "trucks": serialized_trucks,
        "alerts": alerts,
        "routes": _serialize_routes(active_routes),
        "route_history": _serialize_routes(route_history[:8]),
        "delivery_log": log,
        "server_time": _now().isoformat(),
        "urgent_centers": _collect_urgent_centers(),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/trabajador")
def view_worker_login():
    return render_template("worker_login.html")


@app.route("/salida")
def view_salida():
    return render_template("salida.html")


@app.route("/destino")
def view_destino():
    return render_template("destino.html")


@app.route("/llegada")
def view_llegada():
    return render_template("llegada.html")


@app.route("/admin")
def view_admin():
    return render_template("admin.html")


@app.route("/informes")
def view_reports():
    return render_template("reports.html")


@app.route("/centro/<center_id>")
def view_center(center_id):
    return render_template("center.html", center_id=center_id)


@app.route("/api/state")
def api_state():
    return jsonify(_serialize_state())


@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(force=True)
    username = payload.get("username")
    password = payload.get("password")
    role = payload.get("role", "worker")
    if role == "admin":
        if username == ADMIN["username"] and password == ADMIN["password"]:
            return jsonify({"ok": True, "user": username, "role": "admin"})
        return jsonify({"ok": False, "error": "Credenciales de admin incorrectas"}), 401
    user = WORKERS.get(username)
    if user and user["password"] == password:
        return jsonify({"ok": True, "user": username, "role": "worker"})
    return jsonify({"ok": False, "error": "Usuario o clave incorrectos"}), 401


@app.route("/api/simulate-drain", methods=["POST"])
def api_simulate_drain():
    _simulate_drain()
    return jsonify({"ok": True, "message": "Consumo simulado"}), 200


@app.route("/api/admin/auto-plan", methods=["POST"])
def api_admin_auto_plan():
    planned = _auto_plan_urgent_routes()
    if not planned:
        return jsonify({"ok": False, "error": "Sin centros urgentes o camiones libres"}), 400
    return jsonify({"ok": True, "created": len(planned), "routes": _serialize_routes(planned)})


@app.route("/api/routes/claim", methods=["POST"])
def api_claim_route():
    payload = request.get_json(force=True)
    worker = payload.get("worker")
    truck_id = payload.get("truck_id")
    if worker not in WORKERS:
        return jsonify({"ok": False, "error": "Trabajador no valido"}), 400

    truck = next((t for t in trucks if t["id"] == truck_id), None)
    if not truck:
        return jsonify({"ok": False, "error": "Camion no encontrado"}), 400

    route = next(
        (r for r in active_routes if r["truck_id"] == truck_id and r.get("status") == "planificada"),
        None,
    )
    if not route:
        return jsonify({"ok": False, "error": "No hay ruta planificada para este camion"}), 400
    if route.get("worker") and route.get("worker") != worker:
        return jsonify({"ok": False, "error": "Ruta asignada a otro operario"}), 400

    route["worker"] = worker
    route["pending_worker"] = False
    route["status"] = "en_ruta"
    route["started_at"] = _now()
    route["history"].append({"event": "asignada", "note": f"Tomada por {worker}", "ts": _now()})

    planned_load = route.get("planned_load_l") or sum(s["liters"] for s in route["stops"])
    truck["status"] = "outbound"
    truck["route_id"] = route["id"]
    truck["notes"] = f"Asignada a {worker}"
    truck["current_load_l"] = planned_load

    first_stop = route["stops"][0]
    dest_center = _find_center(first_stop["center_id"])
    dest_tank = _find_tank(first_stop["center_id"], first_stop["tank_id"])
    leg_origin = {**WAREHOUSE, "name": route.get("origin") or WAREHOUSE["name"]}
    leg_dest = {
        "lat": dest_tank["location"]["lat"],
        "lon": dest_tank["location"]["lon"],
        "name": f"{dest_center['name']} / {dest_tank['label']}"
        if dest_center and dest_tank
        else first_stop["center_id"],
        "center_id": dest_center["id"] if dest_center else first_stop["center_id"],
        "tank_id": dest_tank["id"] if dest_tank else first_stop["tank_id"],
    }
    _set_leg(route, truck, leg_origin, leg_dest, f"Hacia {dest_center['name']}" if dest_center else "Primer destino")
    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/plan", methods=["POST"])
def api_plan_route():
    payload = request.get_json(force=True)
    worker = payload.get("worker")
    truck_id = payload.get("truck_id")
    origin = payload.get("origin") or WAREHOUSE["name"]
    load_l = payload.get("load_l")
    product_type = payload.get("product_type")
    stops = payload.get("stops", [])

    if worker not in WORKERS:
        return jsonify({"ok": False, "error": "Trabajador no valido"}), 400

    truck = next((t for t in trucks if t["id"] == truck_id), None)
    if not truck:
        return jsonify({"ok": False, "error": "Camion no encontrado"}), 400
    if truck["status"] != "parked":
        return jsonify({"ok": False, "error": "Camion no disponible"}), 400

    if not stops:
        return jsonify({"ok": False, "error": "Debes definir destinos"}), 400

    validated_stops = []
    for stop in stops:
        center_id = stop.get("center_id")
        tank_id = stop.get("tank_id")
        liters = stop.get("liters", 0)
        product = stop.get("product") or product_type
        center = _find_center(center_id)
        tank = _find_tank(center_id, tank_id)
        if not center or not tank:
            return jsonify({"ok": False, "error": "Destino no valido"}), 400
        validated_stops.append(
            {
                "center_id": center_id,
                "tank_id": tank_id,
                "liters": liters,
                "product": product,
                "status": "pendiente",
                "arrival_at": None,
                "depart_at": None,
                "delivered_l": None,
            }
        )

    total_planned = sum(s["liters"] or 0 for s in validated_stops)
    truck_capacity = truck["capacity_l"]
    if load_l is None:
        load_l = total_planned
    if load_l <= 0 or load_l > truck_capacity:
        return jsonify({"ok": False, "error": "Carga fuera de limite"}), 400

    route_id = _new_route_id()
    route = {
        "id": route_id,
        "worker": worker,
        "truck_id": truck_id,
        "origin": origin,
        "product_type": product_type,
        "stops": validated_stops,
        "status": "en_ruta",
        "current_stop_idx": 0,
        "started_at": _now(),
        "finished_at": None,
        "history": [
            {"event": "planificada", "note": f"{len(validated_stops)} destinos", "ts": _now()}
        ],
        "current_leg": None,
        "total_delivered": 0,
        "success": None,
    }
    active_routes.append(route)

    first_stop = validated_stops[0]
    dest_center = _find_center(first_stop["center_id"])
    dest_tank = _find_tank(first_stop["center_id"], first_stop["tank_id"])
    leg_origin = {**WAREHOUSE, "name": origin}
    leg_dest = {
        "lat": dest_tank["location"]["lat"],
        "lon": dest_tank["location"]["lon"],
        "name": f"{dest_center['name']} / {dest_tank['label']}",
        "center_id": dest_center["id"],
        "tank_id": dest_tank["id"],
    }
    _set_leg(route, truck, leg_origin, leg_dest, f"Hacia {dest_center['name']}")
    truck["status"] = "outbound"
    truck["route_id"] = route_id
    truck["current_load_l"] = load_l
    truck["notes"] = f"Salida de {worker} con {load_l} L"

    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/arrive", methods=["POST"])
def api_arrive_stop():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 400
    idx = route.get("current_stop_idx", 0)
    if idx >= len(route["stops"]):
        return jsonify({"ok": False, "error": "No hay destinos pendientes"}), 400
    stop = route["stops"][idx]
    if stop.get("arrival_at"):
        return jsonify({"ok": False, "error": "Ya marcado"}), 400
    stop["arrival_at"] = _now()
    stop["status"] = "en_descarga"
    route["history"].append(
        {"event": "llegada", "note": f"{stop['center_id']} / {stop['tank_id']}", "ts": _now()}
    )
    truck = next((t for t in trucks if t["id"] == route["truck_id"]), None)
    if truck:
        truck["status"] = "delivering"
        truck["notes"] = "En descarga"
        tank = _find_tank(stop["center_id"], stop["tank_id"])
        if tank:
            truck["position"] = deepcopy(tank["location"])
            truck["destination"] = {
                "name": f"{stop['center_id']} / {stop['tank_id']}",
                "center_id": stop["center_id"],
                "tank_id": stop["tank_id"],
            }
    route["status"] = "en_destino"
    route["current_leg"] = None
    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/complete-stop", methods=["POST"])
def api_complete_stop():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    delivered_l = payload.get("delivered_l")
    note = payload.get("note") or ""

    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 400

    idx = route.get("current_stop_idx", 0)
    if idx >= len(route["stops"]):
        return jsonify({"ok": False, "error": "Sin destinos activos"}), 400

    stop = route["stops"][idx]
    if not stop.get("arrival_at"):
        return jsonify({"ok": False, "error": "Marca llegada primero"}), 400
    if delivered_l is None or delivered_l < 0:
        return jsonify({"ok": False, "error": "Cantidad invalida"}), 400

    stop["depart_at"] = _now()
    stop["status"] = "completado"
    stop["delivered_l"] = delivered_l
    route["total_delivered"] += delivered_l
    duration_min = None
    if stop.get("arrival_at"):
        duration_min = max(
            0, math.ceil((stop["depart_at"] - stop["arrival_at"]).total_seconds() / 60)
        )

    center = _find_center(stop["center_id"])
    tank = _find_tank(stop["center_id"], stop["tank_id"])
    if tank:
        tank["current_l"] = min(tank["current_l"] + delivered_l, tank["capacity_l"])

    truck = next((t for t in trucks if t["id"] == route["truck_id"]), None)
    if truck:
        truck["current_load_l"] = max(truck["current_load_l"] - delivered_l, 0)

    note_text = f"{stop['center_id']} / {stop['tank_id']} {delivered_l} L"
    if duration_min is not None:
        note_text += f" en {duration_min} min"
    route["history"].append({"event": "descarga", "note": note_text, "ts": _now()})

    delivery_log.append(
        {
            "ts": _now(),
            "truck_id": route["truck_id"],
            "tank_id": stop["tank_id"],
            "center": center["name"] if center else stop["center_id"],
            "delivered_l": delivered_l,
            "by": route["worker"],
            "note": note or "Descarga confirmada",
        }
    )

    has_more = idx + 1 < len(route["stops"])
    if has_more:
        next_stop = route["stops"][idx + 1]
        route["current_stop_idx"] = idx + 1
        route["status"] = "en_ruta"
        dest_center = _find_center(next_stop["center_id"])
        dest_tank = _find_tank(next_stop["center_id"], next_stop["tank_id"])
        leg_origin = tank["location"] if tank else WAREHOUSE
        leg_dest = {
            "lat": dest_tank["location"]["lat"],
            "lon": dest_tank["location"]["lon"],
            "name": f"{dest_center['name']} / {dest_tank['label']}",
            "center_id": dest_center["id"],
            "tank_id": dest_tank["id"],
        }
        if truck:
            truck["status"] = "outbound"
            truck["notes"] = "Siguiente destino"
            _set_leg(route, truck, leg_origin, leg_dest, f"Hacia {dest_center['name']}")
    else:
        route["status"] = "regresando"
        route["history"].append({"event": "salida_destino", "note": "Ultimo destino", "ts": _now()})
        if truck:
            truck["status"] = "returning"
            truck["notes"] = "Volviendo a almacen"
            _set_leg(route, truck, tank["location"] if tank else WAREHOUSE, WAREHOUSE, "Retorno")

    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/arrive-warehouse", methods=["POST"])
def api_arrive_warehouse():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    success = payload.get("success", True)

    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 400
    if route.get("current_stop_idx", 0) < len(route.get("stops", [])) and route.get("status") != "regresando":
        return jsonify({"ok": False, "error": "Aun quedan destinos por cerrar"}), 400

    truck = next((t for t in trucks if t["id"] == route["truck_id"]), None)
    route["status"] = "finalizada"
    route["finished_at"] = _now()
    route["history"].append({"event": "almacen", "note": "Ruta cerrada", "ts": _now()})
    route["success"] = bool(success)
    route["current_leg"] = None

    if truck:
        truck["status"] = "parked"
        truck["destination"] = None
        truck["current_load_l"] = 0
        truck["started_at"] = None
        truck["eta_minutes"] = None
        truck["notes"] = "Listo en almacen"
        truck["route_id"] = None
        truck["position"] = deepcopy(WAREHOUSE)

    # mover ruta al historial
    active_routes.remove(route)
    route_history.insert(0, route)
    return jsonify({"ok": True, "message": "Ruta cerrada", "route": _serialize_routes([route])[0]})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5009)

