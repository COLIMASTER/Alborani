import math
import random
import json
import base64
import secrets
import threading
import unicodedata
from copy import deepcopy
from datetime import datetime, timedelta
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from typing import Dict, List, Optional, Tuple
import os
from pathlib import Path
import qrcode
from qrcode.image.pure import PyPNGImage
from flask import Flask, jsonify, render_template, request, redirect, session, url_for

try:
    import psycopg2
except Exception:
    psycopg2 = None

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "change-this-secret-in-production")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("SESSION_COOKIE_SECURE", "0") == "1"

SAVIAN_API_BASE = os.environ.get(
    "SAVIAN_API_BASE", "https://func-savian-sensor-api-dev.azurewebsites.net/api"
).rstrip("/")
SAVIAN_API_TIMEOUT = int(os.environ.get("SAVIAN_API_TIMEOUT", "20"))
SAVIAN_STATE_CACHE_SECONDS = int(os.environ.get("SAVIAN_STATE_CACHE_SECONDS", "30"))

ALLOWED_CENTER_NAMES = {
    "hornillos",
    "los hornillos",
    "cortezones",
    "los cortezones",
    "eurogold",
    "los matias",
    "matias",
}

AUTH_SESSION_COOKIE_KEY = "sid"
auth_session_store: Dict[str, Dict] = {}
auth_session_lock = threading.Lock()
external_state_cache = {"state": None, "ts": None}
external_state_lock = threading.Lock()


WAREHOUSE = {"lat": 36.834, "lon": -2.4637, "name": "Almacen Almeria"}

TEST_TRUCKS = [
    {
        "id": "TR-01",
        "driver": "Alba",
        "capacity_l": 12000,
    },
    {
        "id": "TR-02",
        "driver": "Raul",
        "capacity_l": 10000,
    },
    {
        "id": "TR-03",
        "driver": "Sofia",
        "capacity_l": 14000,
    },
]

WORKERS = {
    "prueba1": {"password": "123", "name": "Operador 1"},
    "prueba2": {"password": "123", "name": "Operador 2"},
    "prueba3": {"password": "123", "name": "Operador 3"},
}

ADMIN = {"username": "admin", "password": "123"}

DB_URL = os.environ.get("DATABASE_URL")


def _strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def _normalize_center_name(value: str) -> str:
    text = _strip_accents(value).lower()
    return " ".join(text.split())


def _is_allowed_center(value: str) -> bool:
    key = _normalize_center_name(value)
    variants = {key}
    if key.startswith("los "):
        variants.add(key[4:])
    else:
        variants.add(f"los {key}")
    return any(item in ALLOWED_CENTER_NAMES for item in variants)


def _to_float(value, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None:
            return default
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned == "" or cleaned.lower() == "nat":
                return default
            value = cleaned.replace(",", ".")
        return float(value)
    except Exception:
        return default


def _to_int(value, default: Optional[int] = None) -> Optional[int]:
    try:
        if value is None:
            return default
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned == "" or cleaned.lower() == "nat":
                return default
            value = cleaned
        return int(float(value))
    except Exception:
        return default


def _safe_iso_ts(value) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "nat":
        return None
    return text


def _json_loads(raw: bytes):
    try:
        text = raw.decode("utf-8")
    except Exception:
        text = raw.decode("latin-1", errors="ignore")
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}


def _http_json(
    method: str,
    url: str,
    body: Optional[Dict] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = SAVIAN_API_TIMEOUT,
) -> Tuple[int, Dict]:
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    req = urllib_request.Request(url=url, data=payload, headers=request_headers, method=method.upper())
    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            status = response.getcode()
            raw = response.read()
            return status, _json_loads(raw)
    except urllib_error.HTTPError as exc:
        raw = exc.read()
        return exc.code, _json_loads(raw)
    except Exception as exc:  # noqa: BLE001
        return 503, {"message": f"Error de conexion: {exc}"}


def _response_payload(data: Dict):
    if isinstance(data, dict) and "payload" in data:
        return data.get("payload")
    return data


def _response_message(data: Dict, fallback: str) -> str:
    if isinstance(data, dict):
        msg = data.get("message") or data.get("error")
        if isinstance(msg, str) and msg.strip():
            return msg
    return fallback


def _session_id(create: bool = False) -> Optional[str]:
    sid = session.get(AUTH_SESSION_COOKIE_KEY)
    if sid:
        return sid
    if not create:
        return None
    sid = secrets.token_urlsafe(32)
    session[AUTH_SESSION_COOKIE_KEY] = sid
    return sid


def _decode_jwt_payload(token: Optional[str]) -> Dict:
    if not token or "." not in token:
        return {}
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload_part = parts[1]
    padding = "=" * (-len(payload_part) % 4)
    try:
        decoded = base64.urlsafe_b64decode((payload_part + padding).encode("utf-8"))
        parsed = json.loads(decoded.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _get_auth_session() -> Optional[Dict]:
    sid = _session_id(create=False)
    if not sid:
        return None
    with auth_session_lock:
        data = auth_session_store.get(sid)
        if not data:
            return None
        return deepcopy(data)


def _set_auth_session(username: str, token_payload: Dict):
    sid = _session_id(create=True)
    expires_in = _to_int(token_payload.get("expiresIn"), 900) or 900
    expires_at = datetime.utcnow() + timedelta(seconds=max(expires_in - 30, 30))
    claims = _decode_jwt_payload(token_payload.get("accessToken"))
    auth_data = {
        "username": username,
        "access_token": token_payload.get("accessToken"),
        "refresh_token": token_payload.get("refreshToken"),
        "token_type": token_payload.get("tokenType", "Bearer"),
        "expires_in": expires_in,
        "expires_at": expires_at,
        "tipo_usuario": token_payload.get("tipo_usuario") or claims.get("tipo_usuario"),
        "claims": claims,
    }
    with auth_session_lock:
        auth_session_store[sid] = auth_data


def _clear_auth_session():
    sid = _session_id(create=False)
    if sid:
        with auth_session_lock:
            auth_session_store.pop(sid, None)
    session.pop(AUTH_SESSION_COOKIE_KEY, None)


def _token_expiring(auth_data: Dict) -> bool:
    expires_at = auth_data.get("expires_at")
    if not isinstance(expires_at, datetime):
        return True
    return expires_at <= (datetime.utcnow() + timedelta(seconds=20))


def _login_remote(username: str, password: str) -> Tuple[bool, Dict, str]:
    url = f"{SAVIAN_API_BASE}/IniciarSesion"
    status, data = _http_json("POST", url, body={"username": username, "password": password})
    payload = _response_payload(data)
    if (
        status == 200
        and isinstance(payload, dict)
        and payload.get("accessToken")
        and payload.get("refreshToken")
    ):
        return True, payload, _response_message(data, "Autenticacion correcta")
    return False, {}, _response_message(data, f"No se pudo iniciar sesion ({status})")


def _refresh_remote_token(refresh_token: str) -> Tuple[bool, Dict, str]:
    refresh_paths = ["/RefreshToke", "/RefreshToken"]
    last_msg = "No se pudo renovar el token"
    for path in refresh_paths:
        url = f"{SAVIAN_API_BASE}{path}"
        status, data = _http_json("POST", url, body={"refreshToken": refresh_token})
        payload = _response_payload(data)
        if (
            status == 200
            and isinstance(payload, dict)
            and payload.get("accessToken")
            and payload.get("refreshToken")
        ):
            return True, payload, _response_message(data, "Token renovado")
        if status != 404:
            last_msg = _response_message(data, f"No se pudo renovar el token ({status})")
    return False, {}, last_msg


def _ensure_auth_session(refresh_if_needed: bool = True) -> Optional[Dict]:
    auth_data = _get_auth_session()
    if not auth_data:
        return None
    if not _token_expiring(auth_data):
        return auth_data
    if not refresh_if_needed:
        return None
    refresh_token = auth_data.get("refresh_token")
    username = auth_data.get("username", "")
    if not refresh_token:
        _clear_auth_session()
        return None
    ok, payload, _msg = _refresh_remote_token(refresh_token)
    if not ok:
        _clear_auth_session()
        return None
    _set_auth_session(username, payload)
    return _get_auth_session()


def _call_savian_api(
    method: str,
    endpoint: str,
    params: Optional[Dict] = None,
    body: Optional[Dict] = None,
    retry_on_401: bool = True,
) -> Tuple[int, Dict]:
    auth_data = _ensure_auth_session(refresh_if_needed=True)
    if not auth_data:
        return 401, {"message": "Sesion no autenticada"}

    base_url = f"{SAVIAN_API_BASE}/{endpoint.lstrip('/')}"
    if params:
        query = urllib_parse.urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{base_url}?{query}" if query else base_url
    else:
        url = base_url

    token = auth_data.get("access_token")
    token_type = auth_data.get("token_type") or "Bearer"
    headers = {"Authorization": f"{token_type} {token}"}
    status, data = _http_json(method, url, body=body, headers=headers)

    if status == 401 and retry_on_401:
        refresh_token = auth_data.get("refresh_token")
        username = auth_data.get("username", "")
        if not refresh_token:
            _clear_auth_session()
            return status, data
        ok, payload, _msg = _refresh_remote_token(refresh_token)
        if not ok:
            _clear_auth_session()
            return 401, {"message": "Sesion expirada. Inicia sesion de nuevo."}
        _set_auth_session(username, payload)
        renewed = _get_auth_session() or {}
        token = renewed.get("access_token")
        token_type = renewed.get("token_type") or "Bearer"
        headers = {"Authorization": f"{token_type} {token}"}
        status, data = _http_json(method, url, body=body, headers=headers)

    if status == 401:
        _clear_auth_session()
    return status, data


def _is_request_authenticated() -> bool:
    return _ensure_auth_session(refresh_if_needed=True) is not None


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


def _get_base_url() -> str:
    return (
        os.environ.get("APP_BASE_URL")
        or os.environ.get("RENDER_EXTERNAL_URL")
        or "http://localhost:5009"
    ).rstrip("/")


def _db_enabled():
    return DB_URL and psycopg2 is not None


def _json_default(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


def _ensure_state_table(conn):
    with conn.cursor() as cur:
        cur.execute("create table if not exists app_state (key text primary key, data jsonb)")
    conn.commit()


def _serialize_for_store():
    return {
        "warehouse": WAREHOUSE,
        "centers": centers,
        "trucks": trucks,
        "active_routes": active_routes,
        "route_history": route_history,
        "delivery_log": delivery_log,
    }


def _convert_dates(obj):
    if isinstance(obj, str):
        try:
            return datetime.fromisoformat(obj)
        except Exception:
            return obj
    if isinstance(obj, list):
        return [_convert_dates(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _convert_dates(v) for k, v in obj.items()}
    return obj


def _load_state_from_db():
    if not _db_enabled():
        return
    try:
        conn = psycopg2.connect(DB_URL, sslmode="require")
        _ensure_state_table(conn)
        with conn.cursor() as cur:
            cur.execute("select data from app_state where key=%s", ("state",))
            row = cur.fetchone()
            if not row:
                return
            data = row[0]
    except Exception as exc:  # noqa: BLE001
        print("No se pudo cargar estado desde DB:", exc)
        return
    finally:
        try:
            conn.close()
        except Exception:
            pass
    restored = _convert_dates(data)
    if restored.get("trucks"):
        trucks.clear()
        trucks.extend(restored["trucks"])
    if restored.get("centers"):
        centers.clear()
        centers.extend(restored["centers"])
    if restored.get("warehouse"):
        WAREHOUSE.update(restored["warehouse"])
    if restored.get("active_routes") is not None:
        active_routes.clear()
        active_routes.extend(restored.get("active_routes", []))
    if restored.get("route_history") is not None:
        route_history.clear()
        route_history.extend(restored.get("route_history", []))
    if restored.get("delivery_log") is not None:
        delivery_log.clear()
        delivery_log.extend(restored.get("delivery_log", []))


def _save_state():
    with external_state_lock:
        external_state_cache["state"] = None
        external_state_cache["ts"] = None
    if not _db_enabled():
        return
    try:
        conn = psycopg2.connect(DB_URL, sslmode="require")
        _ensure_state_table(conn)
        payload = json.dumps(_serialize_for_store(), default=_json_default)
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into app_state(key, data)
                values (%s, %s::jsonb)
                on conflict (key) do update set data = EXCLUDED.data
                """,
                ("state", payload),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        print("No se pudo guardar estado en DB:", exc)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _qr_targets(base_url: str):
    targets = []
    for tr in trucks:
        targets.append(
            {
                "filename": f"truck_{tr['id']}.png",
                "url": f"{base_url}/scan?type=truck&id={tr['id']}",
            }
        )
    for center in centers:
        for tank in center["tanks"]:
            targets.append(
                {
                    "filename": f"center_{center['id']}_{tank['id']}.png",
                    "url": f"{base_url}/scan?type=center&center_id={center['id']}&tank_id={tank['id']}",
                }
            )
    targets.append({"filename": "warehouse_main.png", "url": f"{base_url}/scan?type=warehouse&id=main"})
    return targets


def _ensure_qr_codes(base_url: str):
    out_dir = Path(app.root_path) / "static" / "qr"
    out_dir.mkdir(parents=True, exist_ok=True)
    for target in _qr_targets(base_url):
        img_path = out_dir / target["filename"]
        img = qrcode.make(target["url"], image_factory=PyPNGImage)
        with open(img_path, "wb") as f:
            img.save(f)


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


_load_state_from_db()
if not route_history:
    _seed_history()
_save_state()
_ensure_qr_codes(_get_base_url())


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
    capacity_l = _to_float(tank.get("capacity_l"), 0.0) or 0.0
    current_l = _to_float(tank.get("current_l"), 0.0) or 0.0
    warn_at = _to_float(tank.get("warn_at"), 0.30) or 0.30
    crit_at = _to_float(tank.get("crit_at"), 0.15) or 0.15
    pct = current_l / capacity_l if capacity_l else 0
    urgent_threshold = min(max(crit_at, 0.0), 1.0)
    status = "ok"
    hours_left = None
    runout_eta = None

    if pct <= urgent_threshold:
        status = "critical"
        hours_left = 48
        runout_eta = _now() + timedelta(hours=hours_left)
    elif pct <= warn_at:
        status = "warn"

    if hours_left is None:
        hourly_use = capacity_l * 0.018
        hours_left = (current_l / hourly_use) if hourly_use else None
        runout_eta = (_now() + timedelta(hours=hours_left)) if hours_left else None

    return pct, status, runout_eta, hours_left


def _tank_deficit(tank: Dict) -> int:
    capacity_l = _to_float(tank.get("capacity_l"), 0.0) or 0.0
    current_l = _to_float(tank.get("current_l"), 0.0) or 0.0
    return int(max(capacity_l - current_l, 0))


def _reserved_tank_pairs():
    pairs = set()
    for r in active_routes:
        if r.get("status") == "finalizada":
            continue
        for stop in r.get("stops", []):
            pairs.add((stop.get("center_id"), stop.get("tank_id")))
    return pairs


def _collect_urgent_centers(reserved: Optional[set] = None):
    reserved = reserved or set()
    urgent = []
    for center in centers:
        urgent_tanks = []
        for tank in center["tanks"]:
            pct, status, runout_eta, hours_left = _compute_tank_status(tank)
            if pct <= 0.2:
                if (center["id"], tank["id"]) in reserved:
                    continue
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
    reserved = _reserved_tank_pairs()
    urgent = sorted(
        _collect_urgent_centers(reserved),
        key=lambda c: (c.get("urgent_count", 0), c["total_deficit"]),
        reverse=True,
    )
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
        for stop in route.get("stops", []):
            reserved.add((stop.get("center_id"), stop.get("tank_id")))
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
        "workers": list(WORKERS.keys()),
        "alerts": alerts,
        "routes": _serialize_routes(active_routes),
        "route_history": _serialize_routes(route_history[:8]),
        "delivery_log": log,
        "server_time": _now().isoformat(),
        "urgent_centers": _collect_urgent_centers(),
    }


def _extract_centers_rows(data: Dict) -> List[Dict]:
    payload = _response_payload(data)
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("centrosTrabajo", "CentrosTrabajo", "centros", "Centros", "items", "data"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return rows
    return []


def _center_location(center_row: Dict) -> Dict:
    lat = _to_float(
        center_row.get("Lat")
        or center_row.get("lat")
        or center_row.get("Latitude")
        or center_row.get("latitude"),
        WAREHOUSE["lat"],
    )
    lon = _to_float(
        center_row.get("Long")
        or center_row.get("long")
        or center_row.get("Lon")
        or center_row.get("lon")
        or center_row.get("Longitude")
        or center_row.get("longitude"),
        WAREHOUSE["lon"],
    )
    return {"lat": lat, "lon": lon}


def _compute_external_tank_status(
    liters: Optional[float],
    capacity_l: float,
    orange_level: Optional[float],
    red_level: Optional[float],
) -> str:
    if liters is None:
        return "warn"
    if red_level is not None and liters <= red_level:
        return "critical"
    if orange_level is not None and liters <= orange_level:
        return "alert"
    if not capacity_l:
        return "warn"
    pct = liters / capacity_l
    if pct <= 0.15:
        return "critical"
    if pct <= 0.30:
        return "warn"
    return "ok"


def _fetch_center_deposit_screens(center_row: Dict) -> List[Dict]:
    center_id = _to_int(center_row.get("IdCentroTrabajo") or center_row.get("idCentroTrabajo"))
    if center_id is None:
        return []

    screens: List[Dict] = []
    deposits_meta = center_row.get("Depositos") or center_row.get("depositos") or []
    if isinstance(deposits_meta, list) and deposits_meta:
        for item in deposits_meta:
            screen_id = _to_int(
                item.get("IdDepositosPantalla")
                or item.get("idDepositosPantalla")
                or item.get("id")
            )
            params = {"idCentroTrabajo": center_id, "idDepositosPantalla": screen_id}
            status, data = _call_savian_api("GET", "ObtenerPantallaDepositos", params=params)
            payload = _response_payload(data)
            if status == 200 and isinstance(payload, dict):
                screens.append(payload)
    else:
        status, data = _call_savian_api(
            "GET",
            "ObtenerPantallaDepositos",
            params={"idCentroTrabajo": center_id},
        )
        payload = _response_payload(data)
        if status == 200 and isinstance(payload, dict):
            screens.append(payload)
    return screens


def _default_tank_sensors():
    return {
        "ph": 0,
        "ec": 0,
        "drain_ph": 0,
        "drain_ec": 0,
        "climate": {"temp_c": 0, "humidity_pct": 0, "vpd": 0},
        "fertilizer": {"mix_l": 0, "pressure_bar": 0},
        "drain_pct": 0,
    }


def _sync_internal_runtime_from_external(serialized_centers: List[Dict]):
    synced_centers: List[Dict] = []
    for center in serialized_centers:
        center_entry = {
            "id": str(center.get("id")),
            "name": center.get("name") or str(center.get("id")),
            "location": {
                "lat": _to_float(center.get("location", {}).get("lat"), WAREHOUSE["lat"]),
                "lon": _to_float(center.get("location", {}).get("lon"), WAREHOUSE["lon"]),
            },
            "tanks": [],
        }
        for tank in center.get("tanks", []):
            capacity_l = _to_float(tank.get("capacity_l"), 0.0) or 0.0
            current_l = _to_float(tank.get("current_l"), 0.0)
            current_l = 0.0 if current_l is None else current_l
            if capacity_l > 0:
                current_l = max(0.0, min(current_l, capacity_l))
            center_entry["tanks"].append(
                {
                    "id": str(tank.get("id")),
                    "label": tank.get("label") or str(tank.get("id")),
                    "product": tank.get("product") or "-",
                    "capacity_l": capacity_l,
                    "current_l": current_l,
                    "warn_at": _to_float(tank.get("warn_at"), 0.30) or 0.30,
                    "crit_at": _to_float(tank.get("crit_at"), 0.15) or 0.15,
                    "location": {
                        "lat": _to_float(tank.get("location", {}).get("lat"), center_entry["location"]["lat"]),
                        "lon": _to_float(tank.get("location", {}).get("lon"), center_entry["location"]["lon"]),
                        "name": center_entry["name"],
                    },
                    "sensors": _default_tank_sensors(),
                }
            )
        synced_centers.append(center_entry)

    if synced_centers:
        centers.clear()
        centers.extend(synced_centers)


def _ensure_test_trucks():
    current = {str(tr.get("id")): tr for tr in trucks}
    synced = []
    for base in TEST_TRUCKS:
        existing = current.get(base["id"], {})
        synced.append(
            {
                "id": base["id"],
                "driver": existing.get("driver") or base["driver"],
                "status": existing.get("status") or "parked",
                "current_load_l": _to_int(existing.get("current_load_l"), 0) or 0,
                "capacity_l": _to_int(existing.get("capacity_l"), base["capacity_l"]) or base["capacity_l"],
                "position": existing.get("position") or deepcopy(WAREHOUSE),
                "destination": existing.get("destination"),
                "started_at": existing.get("started_at"),
                "eta_minutes": existing.get("eta_minutes"),
                "route_id": existing.get("route_id"),
                "notes": existing.get("notes") or "Disponible en almacen",
            }
        )
    trucks.clear()
    trucks.extend(synced)


def _serialize_runtime_trucks() -> List[Dict]:
    serialized = []
    for tr in trucks:
        serialized.append(
            {
                "id": tr.get("id"),
                "driver": tr.get("driver"),
                "status": tr.get("status") or "parked",
                "current_load_l": _to_int(tr.get("current_load_l"), 0) or 0,
                "capacity_l": _to_int(tr.get("capacity_l"), 0) or 0,
                "position": tr.get("position") or deepcopy(WAREHOUSE),
                "destination": tr.get("destination"),
                "eta_minutes": tr.get("eta_minutes"),
                "notes": tr.get("notes") or "",
                "route_id": tr.get("route_id"),
            }
        )
    return serialized


def _serialize_runtime_log(limit: int = 40) -> List[Dict]:
    rows = []
    for item in sorted(delivery_log, key=lambda x: x.get("ts") or _now(), reverse=True)[:limit]:
        ts = item.get("ts")
        ts_iso = ts.isoformat() if isinstance(ts, datetime) else str(ts or "")
        rows.append(
            {
                "ts": ts_iso,
                "truck_id": item.get("truck_id"),
                "tank_id": item.get("tank_id"),
                "center": item.get("center"),
                "delivered_l": item.get("delivered_l"),
                "by": item.get("by"),
                "note": item.get("note"),
            }
        )
    return rows


def _ensure_external_runtime_ready():
    try:
        _get_external_state_cached(force=False)
    except Exception:
        return


def _build_external_state() -> Dict:
    status, centers_response = _call_savian_api("GET", "ObtenerInformacionCentrosTrabajo")
    if status == 401:
        message = _response_message(centers_response, "Sesion expirada. Inicia sesion de nuevo.")
        raise PermissionError(message)
    if status != 200:
        message = _response_message(
            centers_response,
            f"No se pudo obtener la informacion de centros ({status})",
        )
        raise RuntimeError(message)

    center_rows = _extract_centers_rows(centers_response)
    selected_rows = [row for row in center_rows if _is_allowed_center(row.get("Nombre", ""))]
    selected_rows.sort(key=lambda item: str(item.get("Nombre", "")))

    serialized_centers: List[Dict] = []
    flat_tanks: List[Dict] = []
    alerts: List[Dict] = []
    urgent_centers: List[Dict] = []

    for center_row in selected_rows:
        center_id = _to_int(center_row.get("IdCentroTrabajo") or center_row.get("idCentroTrabajo"))
        center_id_str = str(center_id) if center_id is not None else str(center_row.get("Nombre", ""))
        center_name = center_row.get("Nombre") or center_row.get("nombre") or center_id_str
        location = _center_location(center_row)
        center_tanks: List[Dict] = []
        urgent_tanks: List[Dict] = []
        screen_meta: List[Dict] = []
        seen_elements = set()
        tank_index = 0

        for screen in _fetch_center_deposit_screens(center_row):
            screen_id = _to_int(
                screen.get("IdDepositosPantalla")
                or screen.get("idDepositosPantalla")
                or screen.get("id")
            )
            screen_name = screen.get("NombrePantalla") or screen.get("nombrePantalla") or ""
            screen_meta.append(
                {
                    "id_depositos_pantalla": screen_id,
                    "nombre_pantalla": screen_name,
                    "balsa": screen.get("balsa"),
                }
            )
            deposits = screen.get("depositos") or screen.get("Depositos") or []
            if not isinstance(deposits, list):
                continue
            for dep in deposits:
                element_id = _to_int(
                    dep.get("IdDepositosPantallaElemento")
                    or dep.get("idDepositosPantallaElemento")
                    or dep.get("id")
                )
                dedupe_key = (screen_id, element_id)
                if dedupe_key in seen_elements:
                    continue
                seen_elements.add(dedupe_key)

                name = dep.get("NombreDeposito") or dep.get("nombreDeposito") or f"Deposito {tank_index + 1}"
                description = dep.get("DescripcionDeposito") or dep.get("descripcionDeposito") or ""
                last_reading = _safe_iso_ts(
                    dep.get("FechaHoraUltimaLectura") or dep.get("fechaHoraUltimaLectura")
                )
                capacity_l = _to_float(dep.get("CapacidadLitros") or dep.get("capacidadLitros"), 0.0) or 0.0
                liters = _to_float(dep.get("Litros") or dep.get("litros"))
                orange_level = _to_float(
                    dep.get("NivelAlertaNaranja") or dep.get("nivelAlertaNaranja")
                )
                red_level = _to_float(dep.get("NivelAlertaRoja") or dep.get("nivelAlertaRoja"))
                status_name = _compute_external_tank_status(liters, capacity_l, orange_level, red_level)

                percentage = 0.0
                if liters is not None and capacity_l > 0:
                    percentage = round((liters / capacity_l) * 100, 1)

                deficit_l = 0.0
                if liters is not None and capacity_l > 0:
                    deficit_l = round(max(capacity_l - liters, 0.0), 1)
                elif liters is None and capacity_l > 0:
                    deficit_l = round(capacity_l, 1)

                tank_id = str(element_id) if element_id is not None else f"{center_id_str}-dep-{tank_index + 1}"
                point_offset = ((tank_index % 4) - 1.5) * 0.00018
                tank_location = {
                    "lat": location["lat"] + point_offset,
                    "lon": location["lon"] + point_offset,
                    "name": center_name,
                }
                tank_index += 1

                warn_at = (orange_level / capacity_l) if orange_level is not None and capacity_l > 0 else 0.30
                crit_at = (red_level / capacity_l) if red_level is not None and capacity_l > 0 else 0.15
                tank_entry = {
                    "id": tank_id,
                    "label": name,
                    "product": description or "-",
                    "capacity_l": capacity_l,
                    "current_l": liters,
                    "warn_at": warn_at,
                    "crit_at": crit_at,
                    "percentage": percentage,
                    "status": status_name,
                    "runout_eta": None,
                    "runout_hours": None,
                    "deficit_l": deficit_l,
                    "needs_refill": status_name in ("warn", "alert", "critical"),
                    "sensors": {},
                    "location": tank_location,
                    "center_id": center_id_str,
                    "center_name": center_name,
                    "description": description,
                    "last_reading": last_reading,
                    "alerts_enabled": bool(dep.get("AlertasNivelActivas") or dep.get("alertasNivelActivas")),
                    "alert_level_orange": orange_level,
                    "alert_level_red": red_level,
                    "id_depositos_pantalla": screen_id,
                    "nombre_pantalla": screen_name,
                    "id_depositos_pantalla_elemento": element_id,
                }
                center_tanks.append(tank_entry)
                flat_tanks.append(tank_entry)

                if status_name in ("warn", "alert", "critical"):
                    severity = "alta" if status_name in ("alert", "critical") else "media"
                    liters_text = "n/d" if liters is None else f"{round(liters, 1)} L"
                    message = (
                        f"{center_name} / {name}: {percentage}% ({liters_text} de {round(capacity_l, 1)} L)"
                    )
                    if orange_level is not None or red_level is not None:
                        message += (
                            f" · Umbral naranja: {orange_level if orange_level is not None else 'n/d'}"
                            f" · Umbral rojo: {red_level if red_level is not None else 'n/d'}"
                        )
                    alerts.append(
                        {
                            "tank_id": tank_id,
                            "center": center_name,
                            "severity": severity,
                            "message": message,
                            "runout_eta": None,
                            "status": status_name,
                        }
                    )

                if percentage <= 20 or status_name in ("alert", "critical"):
                    urgent_tanks.append(
                        {
                            "id": tank_id,
                            "label": name,
                            "product": description or "-",
                            "percentage": percentage,
                            "deficit_l": deficit_l,
                            "runout_eta": None,
                            "hours_left": None,
                        }
                    )

        serialized_centers.append(
            {
                "id": center_id_str,
                "name": center_name,
                "location": location,
                "tanks": center_tanks,
                "avg_ph": "-",
                "avg_ec": "-",
                "id_centro_trabajo": center_id,
                "deposit_screens": screen_meta,
            }
        )
        if urgent_tanks:
            urgent_centers.append(
                {
                    "center_id": center_id_str,
                    "center_name": center_name,
                    "location": location,
                    "tanks": urgent_tanks,
                    "total_deficit": round(sum(t["deficit_l"] for t in urgent_tanks), 1),
                    "urgent_count": len(urgent_tanks),
                }
            )

    _sync_internal_runtime_from_external(serialized_centers)
    _ensure_test_trucks()

    return {
        "warehouse": WAREHOUSE,
        "centers": serialized_centers,
        "tanks": flat_tanks,
        "trucks": _serialize_runtime_trucks(),
        "workers": list(WORKERS.keys()),
        "alerts": alerts,
        "routes": _serialize_routes(active_routes),
        "route_history": _serialize_routes(route_history[:20]),
        "delivery_log": _serialize_runtime_log(),
        "server_time": _now().isoformat(),
        "urgent_centers": urgent_centers,
        "source": "savian-api",
    }


def _get_external_state_cached(force: bool = False) -> Dict:
    now = datetime.utcnow()
    with external_state_lock:
        cached_state = external_state_cache.get("state")
        cached_ts = external_state_cache.get("ts")
        if (
            not force
            and cached_state is not None
            and isinstance(cached_ts, datetime)
            and (now - cached_ts).total_seconds() < SAVIAN_STATE_CACHE_SECONDS
        ):
            return deepcopy(cached_state)
    try:
        state = _build_external_state()
    except PermissionError:
        raise
    except Exception as exc:  # noqa: BLE001
        with external_state_lock:
            cached_state = external_state_cache.get("state")
            if cached_state is not None:
                fallback = deepcopy(cached_state)
                fallback["warning"] = str(exc)
                return fallback
        raise
    with external_state_lock:
        external_state_cache["state"] = deepcopy(state)
        external_state_cache["ts"] = now
    return state


PUBLIC_PATHS = {
    "/login",
    "/trabajador",
    "/scan",
    "/api/login",
    "/api/logout",
    "/api/auth/status",
}


@app.before_request
def _guard_routes():
    path = request.path or "/"
    if request.method == "OPTIONS":
        return None
    if path.startswith("/static/"):
        return None
    if path in PUBLIC_PATHS:
        return None
    if path == "/favicon.ico":
        return None
    if _is_request_authenticated():
        return None
    if path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Sesion no iniciada"}), 401
    return redirect(url_for("view_login"))


@app.route("/login")
def view_login():
    if _is_request_authenticated():
        return redirect(url_for("index"))
    return render_template("login.html")


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


@app.route("/scan")
def view_scan():
    return render_template("scan.html")


@app.route("/informes")
def view_reports():
    return render_template("reports.html")


@app.route("/alertas")
def view_alerts():
    return render_template("alerts.html")


@app.route("/mapa")
def view_map():
    return render_template("map.html")


@app.route("/hub")
def view_hub():
    return render_template("hub.html")


@app.route("/centro/<center_id>")
def view_center(center_id):
    return render_template("center.html", center_id=center_id)


@app.route("/api/state")
def api_state():
    try:
        return jsonify(_get_external_state_cached())
    except PermissionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 401
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(force=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", "")).strip()
    role = payload.get("role", "admin")
    if not username or not password:
        return jsonify({"ok": False, "error": "Debes indicar usuario y contrasena"}), 400
    ok, tokens, message = _login_remote(username, password)
    if not ok:
        return jsonify({"ok": False, "error": message}), 401
    _set_auth_session(username, tokens)
    return jsonify(
        {
            "ok": True,
            "user": username,
            "role": role,
            "tipo_usuario": tokens.get("tipo_usuario"),
            "message": message,
        }
    )


@app.route("/api/logout", methods=["POST"])
def api_logout():
    _clear_auth_session()
    return jsonify({"ok": True})


@app.route("/api/auth/status")
def api_auth_status():
    auth_data = _ensure_auth_session(refresh_if_needed=True)
    if not auth_data:
        return jsonify({"ok": True, "authenticated": False})
    claims = auth_data.get("claims") or {}
    return jsonify(
        {
            "ok": True,
            "authenticated": True,
            "user": auth_data.get("username") or claims.get("email"),
            "tipo_usuario": auth_data.get("tipo_usuario") or claims.get("tipo_usuario"),
        }
    )


@app.route("/api/simulate-drain", methods=["POST"])
def api_simulate_drain():
    _simulate_drain()
    _save_state()
    return jsonify({"ok": True, "message": "Consumo simulado"}), 200


@app.route("/api/admin/auto-plan", methods=["POST"])
def api_admin_auto_plan():
    _ensure_external_runtime_ready()
    planned = _auto_plan_urgent_routes()
    if not planned:
        return jsonify({"ok": False, "error": "Sin centros urgentes o camiones libres"}), 400
    _save_state()
    return jsonify({"ok": True, "created": len(planned), "routes": _serialize_routes(planned)})


@app.route("/api/admin/reassign-route", methods=["POST"])
def api_admin_reassign_route():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    truck_id = payload.get("truck_id")
    worker = payload.get("worker")
    if not route_id or not truck_id:
        return jsonify({"ok": False, "error": "Faltan datos"}), 400

    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 404
    if route.get("status") not in ["planificada"]:
        return jsonify({"ok": False, "error": "Solo puedes editar rutas planificadas"}), 400

    new_truck = next((t for t in trucks if t["id"] == truck_id), None)
    if not new_truck:
        return jsonify({"ok": False, "error": "Camion no valido"}), 400

    busy_other = new_truck.get("route_id") and new_truck.get("route_id") != route_id
    if busy_other or new_truck.get("status") not in ["parked", "maintenance", None]:
        return jsonify({"ok": False, "error": "Camion no disponible"}), 400

    old_truck = next((t for t in trucks if t.get("route_id") == route_id), None)
    if old_truck and old_truck["id"] != new_truck["id"]:
        old_truck["route_id"] = None
        old_truck["notes"] = "Libre"
        if old_truck.get("status") != "outbound":
            old_truck["status"] = "parked"
        old_truck["current_load_l"] = 0
        old_truck["destination"] = None

    route["truck_id"] = new_truck["id"]
    new_truck["route_id"] = route["id"]
    new_truck["status"] = "parked"
    new_truck["notes"] = payload.get("notes") or f"Ruta {route_id} asignada manual"
    new_truck["current_load_l"] = route.get("planned_load_l", new_truck.get("current_load_l", 0))

    if worker:
        if worker not in WORKERS:
            return jsonify({"ok": False, "error": "Operario no valido"}), 400
        route["worker"] = worker
        route["pending_worker"] = False

    route.setdefault("history", []).append(
        {"event": "reasignada", "note": f"Asignada al camion {truck_id}", "ts": _now()}
    )

    _save_state()
    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/admin/delete-route", methods=["POST"])
def api_admin_delete_route():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    if not route_id:
        return jsonify({"ok": False, "error": "Falta route_id"}), 400
    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 404
    if not route.get("auto_generated"):
        return jsonify({"ok": False, "error": "Solo puedes eliminar rutas auto generadas"}), 400
    if route.get("status") != "planificada":
        return jsonify({"ok": False, "error": "Solo rutas planificadas pueden eliminarse"}), 400

    active_routes[:] = [r for r in active_routes if r["id"] != route_id]
    truck = next((t for t in trucks if t.get("route_id") == route_id), None)
    if truck:
        truck["route_id"] = None
        truck["status"] = "parked"
        truck["notes"] = "Libre"
        truck["current_load_l"] = 0
        truck["destination"] = None
    _save_state()
    return jsonify({"ok": True, "deleted": route_id})


@app.route("/api/routes/claim", methods=["POST"])
def api_claim_route():
    _ensure_external_runtime_ready()
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
    _save_state()
    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/plan", methods=["POST"])
def api_plan_route():
    _ensure_external_runtime_ready()
    payload = request.get_json(force=True)
    worker = payload.get("worker")
    truck_id = payload.get("truck_id")
    origin = payload.get("origin") or WAREHOUSE["name"]
    load_l = payload.get("load_l")
    product_type = payload.get("product_type")
    stops = payload.get("stops", [])
    auto_generated = bool(payload.get("auto_generated"))

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
        "status": "planificada",
        "current_stop_idx": 0,
        "started_at": None,
        "finished_at": None,
        "history": [
            {"event": "planificada", "note": f"{len(validated_stops)} destinos", "ts": _now()}
        ],
        "current_leg": None,
        "total_delivered": 0,
        "success": None,
        "auto_generated": auto_generated,
        "pending_worker": False,
        "planned_load_l": load_l,
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
    truck["status"] = "parked"
    truck["route_id"] = route_id
    truck["current_load_l"] = load_l
    truck["notes"] = "Ruta planificada manual"
    truck["destination"] = None

    _save_state()
    return jsonify({"ok": True, "route": _serialize_routes([route])[0]})


@app.route("/api/routes/arrive", methods=["POST"])
def api_arrive_stop():
    payload = request.get_json(force=True)
    route_id = payload.get("route_id")
    route = next((r for r in active_routes if r["id"] == route_id), None)
    if not route:
        return jsonify({"ok": False, "error": "Ruta no encontrada"}), 400

    if route.get("status") == "planificada":
        return jsonify(
            {
                "ok": False,
                "error": "Debes escanear primero el QR del camion para activar la ruta",
            }
        ), 400
    if route.get("status") in {"regresando", "finalizada"}:
        return jsonify({"ok": False, "error": "La ruta ya no admite llegadas a centro"}), 400

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
    _save_state()
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

    _save_state()
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
    _save_state()
    return jsonify({"ok": True, "message": "Ruta cerrada", "route": _serialize_routes([route])[0]})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5009)

