

let mapInstances = {};

let tankMarkerSets = {};

let truckMarkerSets = {};

let lastState = null;

let qrScannerWidget = null;

let selectedCenterId = null;
let selectedMapCenterId = null;

const logFilters = { range: "24h", worker: "all", center: "all" };
const mapCenterWhitelist = new Set([
  "hornillos",
  "los hornillos",
  "cortezones",
  "los cortezones",
  "eurogold",
  "los matias",
  "matias",
]);

function normalizeCenterName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCenterEnabledOnMap(name) {
  const key = normalizeCenterName(name);
  if (mapCenterWhitelist.has(key)) return true;
  if (key.startsWith("los ")) return mapCenterWhitelist.has(key.slice(4));
  return mapCenterWhitelist.has(`los ${key}`);
}

function ensureGlobalQRButton() {
  /* QR por URL, sin boton flotante */
}

function toggleGate(show) {
  const gate = document.getElementById("login-gate");
  const html = document.documentElement;
  const appShell = document.querySelectorAll(".admin-only, .worker-only, .quick-links");
  if (gate) gate.style.display = show ? "grid" : "none";
  if (show) {
    html.classList.add("no-session");
    html.classList.remove("has-session");
    appShell.forEach((el) => (el.style.display = "none"));
  } else {
    html.classList.add("has-session");
    html.classList.remove("no-session");
  }
}


const statusColor = {

  ok: "#66e2c1",

  warn: "#ffc857",

  alert: "#ff9f66",

  critical: "#ff7b7b",

};



const severityRank = {

  critical: 4,

  alert: 3,

  warn: 2,

  ok: 1,

  unknown: 0,

};



const truckColor = {

  parked: "#9bb3cb",

  outbound: "#5fb3ff",

  delivering: "#ffc857",

  returning: "#66e2c1",

};



const truckStatusLabel = {

  parked: "En almacen",

  outbound: "En ruta",

  delivering: "En destino",

  returning: "Volviendo",

};



const routeStatusLabel = {

  en_ruta: "En ruta",

  en_destino: "En destino",

  en_descarga: "En descarga",

  regresando: "Regresando",

  finalizada: "Finalizada",

  planificada: "Planificada",

};



const truckQRProfiles = {

  "TR-01": { truck_id: "TR-01", product_type: "NPK 15-5-30", load_l: 8000 },

  "TR-02": { truck_id: "TR-02", product_type: "Calcio + nitrato", load_l: 9000 },

  "TR-03": { truck_id: "TR-03", product_type: "NPK 12-12-24", load_l: 8500 },

};



function flash(text) {

  const toast = document.getElementById("toast");

  if (!toast) return;

  toast.textContent = text;

  toast.style.opacity = 1;

  setTimeout(() => (toast.style.opacity = 0), 2400);

}



async function parseJSONResponse(res) {
  try {
    return await res.json();
  } catch (_e) {
    return {};
  }
}

async function forceLoginRedirect() {
  clearSession("workerSession");
  clearSession("adminSession");
  clearSession("activeRouteId");
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

async function postJSON(url, body) {

  const res = await fetch(url, {

    method: "POST",

    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",

    body: JSON.stringify(body),

  });

  if (res.status === 401 && url !== "/api/login") {
    await forceLoginRedirect();
    return { ok: false, error: "Sesion expirada" };
  }
  return parseJSONResponse(res);

}



async function fetchState() {

  const res = await fetch("/api/state", { credentials: "same-origin" });

  if (res.status === 401) {
    await forceLoginRedirect();
    throw new Error("Sesion expirada");
  }

  lastState = await parseJSONResponse(res);

  if (!res.ok) {
    const msg = lastState?.error || `Error al cargar estado (${res.status})`;
    throw new Error(msg);
  }

  saveCachedState(lastState);

  return lastState;

}

async function ensureBrowserSessionFromServer() {
  const local = getSession("adminSession") || getSession("workerSession");
  if (local) return local;
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await parseJSONResponse(res);
    if (!data?.authenticated) return null;
    saveSession("adminSession", { user: data.user || "usuario" });
    return data;
  } catch (_e) {
    return null;
  }
}

async function logoutAllSessions(options = {}) {
  const redirectToLogin = options.redirect !== false;
  try {
    await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
  } catch (_e) {
    /* ignore */
  }
  clearSession("workerSession");
  clearSession("adminSession");
  clearSession("activeRouteId");
  if (redirectToLogin) window.location.href = "/login";
}



function formatLiters(n) {

  if (n === null || n === undefined) return "-";

  return `${Math.round(n).toLocaleString()} L`;

}



function formatDatePlus1(ts) {

  if (!ts) return "n/d";

  const d = new Date(ts);

  d.setMinutes(d.getMinutes() + 60);

  return d.toLocaleTimeString();

}

function formatEta(ts) {
  if (!ts) return "n/d";
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatHoursLeft(hours) {
  if (hours === null || hours === undefined) return "";
  if (hours >= 24) {
    const days = hours / 24;
    return `${Number.isInteger(days) ? days : days.toFixed(1)} d`;
  }
  return `${Math.round(hours)} h`;
}

function formatEtaShort(ts) {
  if (!ts) return "n/d";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatEtaDateTime(ts) {
  if (!ts) return "n/d";
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function shortText(text, max = 18) {
  if (!text) return "-";
  const str = String(text);
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}



function minutesBetween(start, end) {

  if (!start || !end) return null;

  return Math.max(0, Math.round((end - start) / 60000));

}



function compactProduct(product = "") {

  const text = (product || "").toString().toLowerCase();

  if (!text) return "-";

  if (text.includes("calcio") || text.includes("nitrato")) return "C+N";

  if (text.includes("npk")) {

    const match = product.match(/npk[^0-9]*([0-9-]+)/i);

    return match ? `NPK ${match[1]}` : "NPK";

  }

  if (text.includes("fos") || text.includes("phos")) return "P";

  if (text.includes("urea")) return "Urea";

  return product.length > 8 ? product.slice(0, 8) : product;

}



function worstStatus(tanks = []) {

  return tanks.reduce((worst, t) => {

    const current = severityRank[worst] ?? -1;

    const incoming = severityRank[t.status] ?? 0;

    return incoming > current ? t.status : worst;

  }, "ok");

}



function centerSeverity(center) {

  const tanks = center.tanks || [];
  const worst = severityRank[worstStatus(tanks)] ?? 0;
  const alertCount = tanks.filter((t) => t.status === "critical" || t.status === "alert").length;
  const warnCount = tanks.filter((t) => t.status === "warn").length;
  const minPct = Math.min(...tanks.map((t) => t.percentage || 100));
  return { worst, alertCount, warnCount, minPct: Number.isFinite(minPct) ? minPct : 100 };

}



function sortCentersByAlert(centers = []) {

  return [...centers].sort((a, b) => {

    const sa = centerSeverity(a);
    const sb = centerSeverity(b);

    if (sb.worst !== sa.worst) return sb.worst - sa.worst;

    if (sb.alertCount !== sa.alertCount) return sb.alertCount - sa.alertCount;

    if (sb.warnCount !== sa.warnCount) return sb.warnCount - sa.warnCount;

    if (sa.minPct !== sb.minPct) return sa.minPct - sb.minPct;

    const countA = (a.alerts || []).length;

    const countB = (b.alerts || []).length;

    if (countB !== countA) return countB - countA;

    return a.name.localeCompare(b.name);

  });

}



function averageSensor(tanks, path, digits = 2) {

  const vals = (tanks || [])

    .map((t) => path.reduce((acc, k) => acc?.[k], t.sensors))

    .filter((v) => v !== undefined);

  if (!vals.length) return "-";

  const n = vals.reduce((a, b) => a + b, 0) / vals.length;

  return n.toFixed(digits);

}



function getSession(key) {

  try {

    const raw = localStorage.getItem(key);

    return raw ? JSON.parse(raw) : null;

  } catch (_e) {

    return null;

  }

}

function consumePendingScan() {
  try {
    const raw = localStorage.getItem("pendingScan");
    if (!raw) return null;
    localStorage.removeItem("pendingScan");
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function savePendingScan(payload) {
  try {
    if (!payload) return;
    localStorage.setItem("pendingScan", JSON.stringify(payload));
  } catch (_e) {
    /* ignore */
  }
}

function saveFlowNotice(text) {
  try {
    if (!text) return;
    localStorage.setItem("qrFlowNotice", String(text));
  } catch (_e) {
    /* ignore */
  }
}

function consumeFlowNotice() {
  try {
    const raw = localStorage.getItem("qrFlowNotice");
    if (!raw) return null;
    localStorage.removeItem("qrFlowNotice");
    return raw;
  } catch (_e) {
    return null;
  }
}

function parseQRContent(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text, window.location.origin);
    const type = url.searchParams.get("type");
    if (type === "truck") return { type, truck_id: url.searchParams.get("id") };
    if (type === "center")
      return { type, center_id: url.searchParams.get("center_id"), tank_id: url.searchParams.get("tank_id") };
    if (type === "warehouse") return { type, id: url.searchParams.get("id") || "main" };
  } catch (_e) {
    /* ignore */
  }
  return null;
}



function renderWorkerAssignments(state) {
  const box = document.getElementById("worker-assignment");
  if (!box) return;
  const session = ensureWorkerSession();
  box.innerHTML = "";
  if (!session) {
    box.innerHTML = `<div class="muted">Inicia sesion de operario.</div>`;
    return;
  }

  const assigned = (state.routes || []).find((r) => r.worker === session.user);
  if (!assigned) {
    box.innerHTML = `<div class="muted">Sin rutas asignadas hoy.</div>`;
    return;
  }

  const liters = (assigned.stops || []).reduce((acc, s) => acc + (s.liters || 0), 0);
  const centerNames = (assigned.stops || []).map((s) => {
    const c = state.centers?.find((cc) => cc.id === s.center_id);
    return c ? c.name : s.center_id;
  });
  const centerSummary =
    centerNames.slice(0, 2).join(", ") + (centerNames.length > 2 ? ` + ${centerNames.length - 2} mas` : "");
  const card = document.createElement("div");
  card.className = "route-card emphasis";
  const status = routeStatusLabel[assigned.status] || assigned.status;
  const nextStop = assigned.stops?.[assigned.current_stop_idx || 0];
  const nextCenter = state.centers?.find((c) => c.id === nextStop?.center_id);

  card.innerHTML = `
    <div class="row spaced">
      <div>
        <strong>${assigned.truck_id} -> ${assigned.id}</strong>
        <div class="muted small">${centerSummary}</div>
      </div>
      <span class="status ${assigned.status === "planificada" ? "warn" : "ok"}">${status}</span>
    </div>
    <div class="tank-meta">
      <span>Litros plan: ${formatLiters(liters)}</span>
      <span>${assigned.stops?.length || 0} paradas</span>
    </div>
    <div class="mini-row">
      ${(assigned.stops || [])
        .map((s) => {
          const c = state.centers?.find((cc) => cc.id === s.center_id);
          const centerName = c ? c.name : s.center_id;
          const tankLabel = c?.tanks?.find((t) => t.id === s.tank_id)?.label || s.tank_id;
          return `<span class="mini-tag">${centerName} -> ${tankLabel}</span>`;
        })
        .join("")}
    </div>
    ${
      assigned.status === "planificada"
        ? `<div class="muted small">Ruta asignada: ve al cami&oacute;n ${assigned.truck_id}, abre la c&aacute;mara y lee su QR para empezar.</div>`
        : `<div class="muted small">Ruta en curso. Pr&oacute;ximo destino: ${nextCenter ? nextCenter.name : nextStop?.center_id || "pendiente"}.</div>`
    }
  `;
  box.appendChild(card);
}



function saveSession(key, value) {

  localStorage.setItem(key, JSON.stringify(value));

}



function getCachedState() {

  try {

    const raw = localStorage.getItem("lastStateCache");

    return raw ? JSON.parse(raw) : null;

  } catch (_e) {

    return null;

  }

}



function saveCachedState(state) {

  try {

    localStorage.setItem("lastStateCache", JSON.stringify(state));

  } catch (_e) {

    /* ignore */

  }

}



function clearSession(key) {

  try {

    localStorage.removeItem(key);

  } catch (_e) {

    /* ignore */

  }

}



function refreshSessionBadges() {

  ensureSessionModal();

  const worker = ensureWorkerSession();

  const admin = getSession("adminSession");

  const active = worker || admin;

  const label = worker ? `Operario: ${worker.user}` : admin ? `Admin: ${admin.user}` : "Sesion no iniciada";

  const actionLabel = active ? "Cerrar sesion" : "Iniciar sesion";



  document.querySelectorAll("#session-worker").forEach((el) => {
    el.classList.add("session-chip");
    el.innerHTML = `<span>${label}</span><button class="mini-btn" type="button" data-session-action="${active ? "logout" : "login"}">${actionLabel}</button>`;
    el.querySelector("button")?.addEventListener("click", async () => {
      const mode = active ? "logout" : "login";
      if (mode === "logout") {
        flash("Sesion cerrada");
        await logoutAllSessions();
        return;
      }
      window.openSessionModal?.("worker");
    });
  });



  const topBtn = document.getElementById("session-toggle");

  if (topBtn) {

    topBtn.textContent = actionLabel;
    topBtn.style.display = active ? "inline-flex" : "none";

    topBtn.setAttribute("data-session-action", active ? "logout" : "login");
    topBtn.onclick = async () => {
      const mode = topBtn.getAttribute("data-session-action");
      if (mode === "logout") {
        flash("Sesion cerrada");
        await logoutAllSessions();
        return;
      }
      window.openSessionModal?.("worker");
    };

  }



  document.querySelectorAll("[data-session-action]").forEach((btn) => {

    btn.onclick = async () => {

      const workerSession = ensureWorkerSession();

      const adminSession = getSession("adminSession");

      const mode = btn.getAttribute("data-session-action");

      if (mode === "logout" && (workerSession || adminSession)) {
        flash("Sesion cerrada");
        await logoutAllSessions();

        return;

      }

      window.openSessionModal?.("worker");

    };

  });

  document.querySelectorAll(".admin-only-button").forEach((el) => {
    el.style.display = admin ? "inline-flex" : "none";
  });

}

function tankSeverityScore(tank) {
  const status = tank?.status || "unknown";
  const rank = severityRank[status] ?? severityRank.unknown;
  const pct = Number.isFinite(Number(tank?.percentage)) ? Number(tank.percentage) : 100;
  return rank * 1000 + (100 - pct);
}

function sortTanksBySeverity(tanks = []) {
  return [...(tanks || [])].sort((a, b) => tankSeverityScore(b) - tankSeverityScore(a));
}

function tankStatusLabel(status) {
  if (status === "critical") return "Alerta roja";
  if (status === "alert") return "Alerta";
  if (status === "warn") return "Precaucion";
  return "Normal";
}

function tankToneClass(status) {
  if (status === "critical") return "priority-critical vibrate-red";
  if (status === "alert" || status === "warn") return "priority-warn vibrate-warn";
  return "priority-ok";
}



function ensureSessionModal() {

  if (document.getElementById("session-modal")) return;

  const wrapper = document.createElement("div");

  wrapper.innerHTML = `

    <div id="session-modal" class="modal hidden">

      <div class="modal-card">

        <div class="row spaced">

          <div>

            <div class="caps">Sesion</div>

            <h3>Iniciar o cerrar sesion</h3>

          </div>

          <button class="mini-btn" id="close-session-modal" type="button">Cerrar</button>

        </div>

        <form id="session-modal-form" class="stack">

          <label>Rol

            <select name="role">

              <option value="worker">Operario</option>

              <option value="admin">Administrador</option>

            </select>

          </label>

          <label>Usuario<input name="username" placeholder="prueba1 o admin" required /></label>

          <label>Contrase&ntilde;a<input type="password" name="password" placeholder="123" required /></label>

          <div class="row">

            <button class="btn" type="submit">Entrar</button>

            <button class="btn ghost" type="button" id="session-logout-btn">Cerrar sesion actual</button>

          </div>

          <p class="muted small" id="session-hint">Sesion no iniciada</p>

        </form>

      </div>

    </div>

  `;

  const modalEl = wrapper.firstElementChild;

  if (modalEl) document.body.appendChild(modalEl);

  const modal = document.getElementById("session-modal");

  const form = document.getElementById("session-modal-form");

  const hint = document.getElementById("session-hint");



  const updateHint = () => {

    const worker = ensureWorkerSession();

    const admin = getSession("adminSession");

    if (worker) {

      hint.textContent = `Operario activo: ${worker.user}`;

    } else if (admin) {

      hint.textContent = `Admin activo: ${admin.user}`;

    } else {

      hint.textContent = "Sesion no iniciada";

    }

  };



  const openSessionModal = (role = "worker") => {

    ensureSessionModal();

    form.role.value = role;

    updateHint();

    modal?.classList.remove("hidden");

    modal?.classList.add("active");

  };



  const closeSessionModal = () => {

    modal?.classList.add("hidden");

    modal?.classList.remove("active");

  };



  form?.addEventListener("submit", async (e) => {

    e.preventDefault();

    const body = {

      username: form.username.value,

      password: form.password.value,

      role: form.role.value,

    };

    const res = await postJSON("/api/login", body);

    if (!res.ok) {

      flash(res.error || "Credenciales invalidas");

      return;

    }

    if (res.role === "admin") {
      saveSession("adminSession", { user: body.username });
      window.location.href = "/hub";
      return;
    } else {
      saveSession("workerSession", { user: body.username });
    }

    flash(`Sesion ${res.role === "admin" ? "admin" : "operario"} iniciada`);

    refreshSessionBadges();

    closeSessionModal();

  });



  document.getElementById("session-logout-btn")?.addEventListener("click", async () => {
    flash("Sesion cerrada");
    updateHint();
    closeSessionModal();
    await logoutAllSessions();
  });



  document.getElementById("close-session-modal")?.addEventListener("click", closeSessionModal);



  window.openSessionModal = openSessionModal;

  window.closeSessionModal = closeSessionModal;

  updateHint();

}



function parseAlbaranPayload(text) {

  if (!text) return null;

  try {

    const obj = JSON.parse(text);

    return {

      product_type: obj.product_type || obj.product || obj.prod || "",

      load_l: obj.load_l || obj.liters || obj.litros || obj.cantidad || obj.qty || 0,

      note: obj.note || obj.nota || "",

    };

  } catch (_e) {

    /* ignore */
  }

  try {
    const params = new URLSearchParams(text);

    if ([...params.keys()].length) {

      return {

        product_type: params.get("product_type") || params.get("product") || "",

        load_l: Number(params.get("load_l") || params.get("liters") || params.get("litros") || 0),

        note: params.get("note") || "",

      };

    }
  } catch (_e) {
    /* ignore */
  }

  return null;

}



function tankSvgSimple(tank) {

  const pct = Math.max(0, Math.min(tank.percentage || 0, 100));

  const fillH = 80 * (pct / 100);

  const y = 90 - fillH;

  const color = statusColor[tank.status] || statusColor.ok;

  return `

    <svg viewBox="0 0 90 110" class="tank-svg" aria-label="${pct}%">

      <defs>

        <linearGradient id="glass-${tank.id}" x1="0" y1="0" x2="0" y2="1">

          <stop offset="0%" stop-color="rgba(255,255,255,0.25)"/>

          <stop offset="100%" stop-color="rgba(255,255,255,0.08)"/>

        </linearGradient>

      </defs>

      <rect x="18" y="12" width="54" height="90" rx="14" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>

      <rect x="22" y="${y}" width="46" height="${fillH}" rx="12" fill="${color}" opacity="0.85"/>

      <rect x="18" y="12" width="54" height="90" rx="14" fill="url(#glass-${tank.id})"/>

      <text x="45" y="60" text-anchor="middle" fill="#f7fbff" font-size="14" font-weight="700">${pct}%</text>

    </svg>

  `;

}

function renderCenters(centers, targetId = "center-grid", options = {}) {
  const grid = document.getElementById(targetId);
  if (!grid) return;
  grid.innerHTML = "";
  const ordered = sortCentersByAlert(centers || []);
  if (!ordered.length) {
    grid.innerHTML = `<div class="muted">Sin centros.</div>`;
    return;
  }
  const canFocus = !options.skipFocus && document.getElementById("center-detail");
  ordered.forEach((c) => {
    const card = document.createElement("button");
    card.type = "button";
    const worst = worstStatus(c.tanks || []);
    card.className = `micro-card severity-${worst}`;
    const sorted = sortTanksBySeverity(c.tanks || []);
    const preview = sorted.slice(0, 6);
    const hiddenCount = Math.max(0, sorted.length - preview.length);
    card.innerHTML = `
      <div class="micro-head">
        <span class="name">${c.name}</span>
        <div class="micro-head-right">
          <span class="count-pill">${sorted.length} dep.</span>
          <span class="pill tiny ${worst}">${
            worst === "critical" ? "ALTA" : worst === "alert" ? "ALERTA" : worst === "warn" ? "PRE" : "OK"
          }</span>
        </div>
      </div>
      <div class="nano-row">
        ${preview
          .map((t, idx) => {
            const color = statusColor[t.status] || statusColor.ok;
            const pct = Math.max(0, Math.min(t.percentage || 0, 100));
            const fillPct = Math.max(6, pct);
            return `
              <div class="nano-tank">
                <div class="nano-jar">
                  <span class="nano-index">${idx + 1}</span>
                  <div class="nano-fill" style="height:${fillPct}%;background:${color};"></div>
                </div>
                <div class="nano-meta">${pct}% - ${compactProduct(t.product)}</div>
              </div>
            `;
          })
          .join("")}
        ${hiddenCount > 0 ? `<div class="nano-more">+${hiddenCount}</div>` : ""}
      </div>
    `;
    if (canFocus) {
      card.onclick = () => renderCenterDetail(c);
    } else {
      card.onclick = () => {
        window.location.href = `/centro/${c.id}`;
      };
    }
    grid.appendChild(card);
  });
  const preferred = ordered.find((c) => c.id === selectedCenterId) || ordered[0];
  if (canFocus && preferred) renderCenterDetail(preferred);
}
function renderCenterDetail(center, opts = {}) {
  const targetId = opts.targetId || "center-detail";
  const titleId = opts.titleId || "center-detail-title";
  const statusId = opts.statusId || "center-detail-status";
  const panel = document.getElementById(targetId);
  const title = document.getElementById(titleId);
  const badge = document.getElementById(statusId);
  if (!panel || !center) return;
  selectedCenterId = center.id;
  if (title) title.textContent = center.name;
  const worst = worstStatus(center.tanks || []);
  if (badge) {
    const label =
      worst === "critical" ? "Alerta" : worst === "alert" ? "Alerta 20%" : worst === "warn" ? "Precaucion" : "Ok";
    badge.textContent = label;
    badge.className = `chip soft severity-${worst}`;
  }
  panel.innerHTML = "";

  const sorted = sortTanksBySeverity(center.tanks || []);
  sorted.forEach((t, idx) => {
    const pct = Math.max(0, Math.min(t.percentage || 0, 100));
    const fillPct = Math.max(6, pct);
    const color = statusColor[t.status] || statusColor.ok;
    const statusText = tankStatusLabel(t.status);
    const desc = t.description || t.product || "-";
    const lastReading = formatEtaDateTime(t.last_reading || t.runout_eta);
    const toneClass = tankToneClass(t.status);
    const card = document.createElement("div");
    card.className = `focus-tank compact ${toneClass}`;
    card.innerHTML = `
      <div class="focus-main">
        <div class="focus-jar">
          <span class="focus-index">${idx + 1}</span>
          <div class="focus-fill" style="height:${fillPct}%;background:${color};"></div>
        </div>
        <div class="focus-meta">
          <div class="focus-head">
            <strong>${t.label || "-"}</strong>
            <span class="pill tiny ${t.status || "ok"}">${statusText}</span>
          </div>
          <div class="focus-line">${formatLiters(t.current_l)} / ${formatLiters(t.capacity_l)}</div>
          <div class="focus-line muted">${pct}% - ${shortText(desc, 28)}</div>
        </div>
      </div>
      <div class="focus-footer">
        <span class="muted small">Lectura: ${lastReading}</span>
        <span class="muted small">ID ${t.id_depositos_pantalla_elemento ?? "-"}</span>
      </div>
    `;
    panel.appendChild(card);
  });
}



function renderSensorPanel(centers) {

  const grid = document.getElementById("sensor-grid");

  if (!grid) return;

  grid.innerHTML = "";

  const ordered = sortCentersByAlert(centers || []);

  if (!ordered.length) {

    grid.innerHTML = `<div class="muted small">Sin datos.</div>`;

    return;

  }

  const metrics = [

    { label: "pH", path: ["ph"], digits: 2, suffix: "" },

    { label: "CE", path: ["ec"], digits: 2, suffix: " mS" },

    { label: "pH dr", path: ["drain_ph"], digits: 2, suffix: "" },

    { label: "CE dr", path: ["drain_ec"], digits: 2, suffix: " mS" },

    { label: "Temp", path: ["climate", "temp_c"], digits: 1, suffix: " C" },

    { label: "Hum", path: ["climate", "humidity_pct"], digits: 0, suffix: "%" },

    { label: "VPD", path: ["climate", "vpd"], digits: 2, suffix: " kPa" },

    { label: "Mix", path: ["fertilizer", "mix_l"], digits: 0, suffix: " L" },

    { label: "Bar", path: ["fertilizer", "pressure_bar"], digits: 2, suffix: " bar" },

  ];

  const matrix = document.createElement("div");

  matrix.className = "matrix";

  const colStyle = `grid-template-columns: 120px repeat(${ordered.length}, minmax(90px,1fr));`;

  const head = document.createElement("div");

  head.className = "matrix-row head";

  head.setAttribute("style", colStyle);

  head.innerHTML = `<div class="matrix-cell label">Var</div>${ordered

    .map((c) => `<div class="matrix-cell">${c.name}</div>`)

    .join("")}`;

  matrix.appendChild(head);

  metrics.forEach((m) => {

    const row = document.createElement("div");

    row.className = "matrix-row";

    row.setAttribute("style", colStyle);

    row.innerHTML = `<div class="matrix-cell label">${m.label}</div>${ordered

      .map((c) => {

        const avg = averageSensor(c.tanks || [], m.path, m.digits);

        return `<div class="matrix-cell">${avg}${avg !== "-" ? m.suffix : ""}</div>`;

      })

      .join("")}`;

    matrix.appendChild(row);

  });

  grid.appendChild(matrix);

}

function renderSingleCenterMatrix(center) {

  const grid = document.getElementById("center-matrix");

  if (!grid || !center) return;

  grid.innerHTML = "";

  const metrics = [
    { label: "pH", path: ["ph"], digits: 2, suffix: "" },
    { label: "CE", path: ["ec"], digits: 2, suffix: " mS" },
    { label: "pH dr", path: ["drain_ph"], digits: 2, suffix: "" },
    { label: "CE dr", path: ["drain_ec"], digits: 2, suffix: " mS" },
    { label: "Temp", path: ["climate", "temp_c"], digits: 1, suffix: " C" },
    { label: "Hum", path: ["climate", "humidity_pct"], digits: 0, suffix: "%" },
    { label: "VPD", path: ["climate", "vpd"], digits: 2, suffix: " kPa" },
    { label: "Mix", path: ["fertilizer", "mix_l"], digits: 0, suffix: " L" },
    { label: "Bar", path: ["fertilizer", "pressure_bar"], digits: 2, suffix: " bar" },
  ];

  const colStyle = "grid-template-columns: 120px 1fr;";

  const matrix = document.createElement("div");

  matrix.className = "matrix";

  metrics.forEach((m) => {

    const row = document.createElement("div");

    row.className = "matrix-row";

    row.setAttribute("style", colStyle);

    const avg = averageSensor(center.tanks || [], m.path, m.digits);

    row.innerHTML = `<div class="matrix-cell label">${m.label}</div><div class="matrix-cell">${avg}${avg !== "-" ? m.suffix : ""}</div>`;

    matrix.appendChild(row);

  });

  grid.appendChild(matrix);

}



function renderSensorSummary(centers) {

  const summary = document.getElementById("sensor-summary");

  const bubbles = document.getElementById("sensor-bubbles");

  if (!summary || !bubbles) return;

  const tanks = centers.flatMap((c) => c.tanks || []);

  if (!tanks.length) return;

  summary.textContent = "";

  bubbles.innerHTML = "";

  centers.forEach((c) => {

    const el = document.createElement("div");

    el.className = "bubble";

    el.textContent = `${c.name}: ${c.avg_ph} pH - ${c.avg_ec} CE`;

    bubbles.appendChild(el);

  });

}



function renderSensorDetail(centers) {

  const select = document.getElementById("sensor-center-filter");

  const detail = document.getElementById("sensor-detail");

  if (!select || !detail) return;

  if (!select.options.length) {

    select.innerHTML = centers.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");

  }

  const centerId = select.value || centers[0]?.id;

  select.value = centerId;

  const center = centers.find((c) => c.id === centerId) || centers[0];

  detail.innerHTML = "";

  center?.tanks.forEach((t) => {

    const card = document.createElement("div");

    card.className = "sensor-detail-card";

    card.innerHTML = `

      <div class="row"><strong>${t.label}</strong><span class="status ${t.status}">${t.percentage}%</span></div>

      <div class="sensor-row"><span>pH ${t.sensors.ph}</span><span>CE ${t.sensors.ec} mS/cm</span></div>

      <div class="sensor-row"><span>Drenaje pH ${t.sensors.drain_ph}</span><span>Drenaje CE ${t.sensors.drain_ec} mS/cm</span></div>

      <div class="sensor-row"><span>Temp ${t.sensors.climate.temp_c} C</span><span>Humedad ${t.sensors.climate.humidity_pct}%</span><span>VPD ${t.sensors.climate.vpd}</span></div>

      <div class="sensor-row"><span>Vol. fertilizante ${formatLiters(t.sensors.fertilizer.mix_l)}</span><span>Presion ${t.sensors.fertilizer.pressure_bar} bar</span></div>

    `;

    detail.appendChild(card);

  });

  select.onchange = () => renderSensorDetail(centers);

}



function buildAlertRows(alerts = [], state = null) {
  const rows = [];
  if (state?.centers?.length) {
    (state.centers || []).forEach((center) => {
      sortTanksBySeverity(center.tanks || [])
        .filter((t) => ["warn", "alert", "critical"].includes(t.status))
        .forEach((tank) => {
          rows.push({
            center: center.name,
            center_id: center.id,
            tank_id: tank.id,
            tank_label: tank.label || tank.id,
            status: tank.status || "warn",
            percentage: Number(tank.percentage || 0),
            liters: tank.current_l,
            capacity: tank.capacity_l,
            last_reading: tank.last_reading,
            message: tank.description || tank.product || "",
          });
        });
    });
  } else {
    (alerts || []).forEach((a) => {
      const pctMatch = String(a.message || "").match(/([0-9]+\\.?[0-9]*)%/);
      const pct = pctMatch ? Number(pctMatch[1]) : 0;
      rows.push({
        center: a.center || "-",
        center_id: a.center_id || a.center || "-",
        tank_id: a.tank_id || "-",
        tank_label: a.tank_id || "-",
        status: a.status || (a.severity === "alta" ? "critical" : "warn"),
        percentage: pct,
        liters: null,
        capacity: null,
        last_reading: a.runout_eta || null,
        message: a.message || "",
      });
    });
  }

  rows.sort((a, b) => {
    const rankDiff = (severityRank[b.status] ?? 0) - (severityRank[a.status] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return (a.percentage ?? 100) - (b.percentage ?? 100);
  });
  return rows;
}

function renderAlarms(alerts, targetId = "alarms-panel", state = null) {
  const box = document.getElementById(targetId);
  if (!box) return;
  box.innerHTML = "";

  const rows = buildAlertRows(alerts || [], state);
  if (!rows.length) {
    box.innerHTML = `<div class="muted small">Sin alarmas activas</div>`;
    return;
  }

  rows.forEach((row) => {
    const tone = tankToneClass(row.status);
    const statusText = tankStatusLabel(row.status);
    const card = document.createElement("div");
    card.className = `alert-card rich ${tone}`;
    card.innerHTML = `
      <div class="alert-top">
        <span>${row.center}</span>
        <span class="pill tiny ${row.status}">${statusText}</span>
      </div>
      <div class="alert-main">
        <strong>${row.tank_label}</strong>
        <span>${Math.round(row.percentage || 0)}%</span>
      </div>
      <div class="alert-mini">
        <span>${formatLiters(row.liters)} / ${formatLiters(row.capacity)}</span>
        <span>${formatEtaDateTime(row.last_reading)}</span>
      </div>
    `;
    box.appendChild(card);
  });
}

function renderCenterAlerts(center, alerts, state = null) {
  const panel = document.getElementById("center-alerts");
  if (!panel) return;
  const rows = buildAlertRows(alerts || [], state).filter((item) => item.center_id === center?.id);
  if (!rows.length) {
    panel.innerHTML = `<div class="muted small">Sin alertas activas en este centro</div>`;
    return;
  }
  panel.innerHTML = "";
  rows.forEach((row) => {
    const card = document.createElement("div");
    card.className = `alert-card rich ${tankToneClass(row.status)}`;
    card.innerHTML = `
      <div class="alert-top">
        <span>${row.tank_label}</span>
        <span class="pill tiny ${row.status}">${tankStatusLabel(row.status)}</span>
      </div>
      <div class="alert-mini">
        <span>${Math.round(row.percentage || 0)}%</span>
        <span>${formatLiters(row.liters)} / ${formatLiters(row.capacity)}</span>
      </div>
    `;
    panel.appendChild(card);
  });
}

function renderCenterRoutes(center, state) {

  const box = document.getElementById("center-routes");

  if (!box || !center) return;

  box.innerHTML = "";

  const related = state.routes.filter((r) =>
    r.stops?.some((s) => s.center_id === center.id)
  );

  if (!related.length) {
    box.innerHTML = `<div class="muted">Sin rutas activas en este centro.</div>`;
    return;
  }

  related.forEach((r) => {
    const stop = r.stops?.find((s) => s.center_id === center.id) || r.stops?.[r.current_stop_idx];
    const tankLabel = center.tanks.find((t) => t.id === stop?.tank_id)?.label || stop?.tank_id || "";
    const card = document.createElement("div");
    card.className = "route-card";
    card.innerHTML = `
      <div class="row">
        <strong>${r.truck_id} - ${r.id}</strong>
        <span class="status">${routeStatusLabel[r.status] || r.status}</span>
      </div>
      <div class="tank-meta">
        <span>${tankLabel}</span>
        <span>${compactProduct(stop?.product || r.product_type || "-")}</span>
      </div>
      <div class="tank-meta">
        <span>${formatLiters(stop?.liters || 0)}</span>
        <span>${formatLiters(r.total_delivered || 0)}</span>
      </div>
    `;
    box.appendChild(card);
  });
}



function renderActiveRoutes(routes, centers) {

  const box = document.getElementById("active-routes");

  if (!box) return;

  box.innerHTML = "";

  if (!routes.length) {

    box.innerHTML = `<div class="muted">Sin rutas activas por ahora.</div>`;

    return;

  }

  routes.forEach((r) => {

    const stop = r.stops?.[r.current_stop_idx] || r.stops?.[r.stops.length - 1];

    const center = centers.find((c) => c.id === stop?.center_id);

    const tank = center?.tanks.find((t) => t.id === stop?.tank_id);

    const card = document.createElement("div");

    card.className = "route-card";

    const statusLabel = routeStatusLabel[r.status] || r.status;

    const centerStatus = worstStatus(center?.tanks || []);

    const statusClass = centerStatus === "critical" ? "critical" : centerStatus === "warn" ? "warn" : "ok";

    card.innerHTML = `

      <div class="row">
        <strong>${r.truck_id} - ${r.worker}</strong>
        <span class="status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="tank-meta">
        <span>${center ? center.name : stop?.center_id || "-"}</span>
        <span>${tank ? tank.label : stop?.tank_id || ""}</span>
      </div>
      <div class="tank-meta">
        <span>${compactProduct(stop?.product || r.product_type || "-")}</span>
        <span>${formatLiters(stop?.liters || 0)} plan</span>
      </div>
      <div class="tank-meta">
        <span>Entregado: ${formatLiters(r.total_delivered || 0)}</span>
        <span>${stop?.arrival_at ? formatDatePlus1(stop.arrival_at) : ""}</span>
      </div>

    `;

  box.appendChild(card);

});

}

function renderUrgentWall(state) {
  const pendingBox = document.getElementById("urgent-pending");
  const btn = document.getElementById("btn-generate-urgent");
  if (!pendingBox) return;
  const activeRoutes = (state.routes || []).filter((r) => r.status && r.status !== "finalizada");
  const assignedCenters = new Set(
    activeRoutes.flatMap((r) => r.stops?.map((s) => s.center_id) || [])
  );

  const tanks = (state.tanks || []).filter((t) => (t.percentage || 0) < 20);
  const grouped = tanks.reduce((acc, t) => {
    const key = t.center_id || t.center_name || "centro";
    acc[key] = acc[key] || { center_id: t.center_id, center_name: t.center_name || t.center_id, tanks: [] };
    acc[key].tanks.push(t);
    return acc;
  }, {});

  const centers = Object.values(grouped)
    .map((c) => {
      const sorted = c.tanks.slice().sort((a, b) => (a.percentage || 0) - (b.percentage || 0));
      const minTank = sorted[0];
      const minPct = minTank?.percentage ?? 0;
      const totalDeficit = c.tanks.reduce((sum, t) => sum + (t.deficit_l || 0), 0);
      const etaMs = c.tanks
        .map((t) => (t.runout_eta ? new Date(t.runout_eta).getTime() : Number.MAX_SAFE_INTEGER))
        .sort((a, b) => a - b)[0];
      const etaText = Number.isFinite(etaMs) ? formatEtaDateTime(etaMs) : "n/d";
      const topTanks = sorted.slice(0, 3);
      const tone = minTank?.status === "critical" || minTank?.status === "alert" ? "bad" : "warn";
      const assigned = assignedCenters.has(c.center_id);
      return { ...c, minPct, totalDeficit, etaText, topTanks, tone, assigned };
    })
    .sort((a, b) => a.minPct - b.minPct)
    .slice(0, 180);

  const pending = centers.filter((c) => !c.assigned);
  if (!pending.length) {
    pendingBox.innerHTML = `<div class="empty-count">0</div>`;
  } else {
    pendingBox.innerHTML = `<div class="mini-grid refill-chip-grid">${pending
      .map((c) => {
        const toneClass = c.assigned ? "in-route" : c.tone === "bad" ? "alert" : "soft";
        const tankRows = c.tanks
          .slice()
          .sort((a, b) => (a.percentage || 0) - (b.percentage || 0))
          .slice(0, 4);
        const extra = c.tanks.length - tankRows.length;
        return `
          <div class="micro-card refill-chip ${toneClass}">
            <div class="micro-top">
              <span class="micro-label">${shortText(c.center_name || c.center_id)}</span>
              <span class="pill tiny tone-${c.tone}">${c.minPct}%</span>
            </div>
            <div class="micro-meta">
              <span>${formatLiters(c.totalDeficit)}</span>
              <span>${c.tanks.length} deps</span>
            </div>
            <div class="micro-meta">
              <span class="micro-eta">${c.etaText}</span>
              <span></span>
            </div>
            <div class="tank-mini-list">
              ${tankRows
                .map(
                  (t) => `
                <div class="tank-mini">
                  <div class="tank-mini-top">
                    <span>${t.label}</span>
                    <span>${t.percentage}%</span>
                  </div>
                  <div class="tank-bar"><span style="width:${Math.max(6, t.percentage)}%"></span></div>
                  <div class="tank-mini-meta">${formatLiters(t.deficit_l || 0)}</div>
                </div>`
                )
                .join("")}
              ${extra > 0 ? `<div class="tank-mini extra">+${extra} m&aacute;s</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("")}</div>`;
  }

  const availableTrucks = (state.trucks || []).filter((t) => t.status === "parked" && !t.route_id);
  if (btn) btn.disabled = !pending.length || !availableTrucks.length;

  const editBtn = document.getElementById("btn-edit-urgent");
  if (editBtn) editBtn.disabled = false;
}

function renderUrgentPlanner(state) {
  const centerBox = document.getElementById("urgent-center-list");
  const truckBox = document.getElementById("urgent-truck-list");
  const btn = document.getElementById("btn-generate-urgent");
  if (!centerBox || !truckBox) return;
  const urgent = state.urgent_centers || [];
  const assignedCenters = new Set(
    (state.routes || [])
      .filter((r) => r.status && r.status !== "finalizada")
      .flatMap((r) => r.stops?.map((s) => s.center_id) || [])
  );
  const availableTrucks = (state.trucks || []).filter((t) => t.status === "parked" && !t.route_id);
  if (!urgent.length) {
    centerBox.innerHTML = `<div class="empty-count">0</div>`;
  } else {
    const sortedCenters = urgent
      .map((c) => {
        const minPct = Math.min(...c.tanks.map((t) => t.percentage));
        return { ...c, minPct };
      })
      .sort((a, b) => a.minPct - b.minPct);
    centerBox.innerHTML = `<div class="mini-grid tight-grid">${sortedCenters
      .map((c) => {
        const etaMs = c.tanks
          .map((t) => (t.runout_eta ? new Date(t.runout_eta).getTime() : Number.MAX_SAFE_INTEGER))
          .sort((a, b) => a - b)[0];
        const eta = etaMs && Number.isFinite(etaMs) ? new Date(etaMs) : null;
        const topTanks = c.tanks.slice().sort((a, b) => a.percentage - b.percentage).slice(0, 2);
        const assigned = assignedCenters.has(c.center_id);
        const tone = assigned ? "ok" : "bad";
        return `
          <div class="micro-card ${assigned ? "soft" : "alert"}">
            <div class="micro-top">
              <span class="micro-label">${shortText(c.center_name)}</span>
              <span class="pill tiny tone-${tone}">${topTanks[0]?.percentage ?? "-"}%</span>
            </div>
            <div class="micro-meta">
              <span>${c.tanks.length} deps</span>
              <span>${eta ? formatEtaShort(eta) : "n/d"}</span>
            </div>
            <div class="micro-meta">
              <span>${formatLiters(c.total_deficit)}</span>
              <span>${assigned ? "Asignada" : "Libre"}</span>
            </div>
            <div class="tag-row small">
              ${topTanks
                .map((t) => `<span class="mini-tag">${t.label} ${t.percentage}%</span>`)
                .join("")}
            </div>
          </div>
        `;
      })
      .join("")}</div>`;
  }
  if (!availableTrucks.length) {
    truckBox.innerHTML = `<div class="empty-count">0</div>`;
  } else {
    truckBox.innerHTML = `<div class="mini-grid tight-grid">${availableTrucks
      .map(
        (t) => `
        <div class="micro-card soft">
          <div class="micro-top">
            <span class="micro-label">${t.id}</span>
            <span class="pill tiny">${formatLiters(t.capacity_l)}</span>
          </div>
          <div class="micro-meta">
            <span>${t.driver || "-"}</span>
            <span>${t.notes || ""}</span>
          </div>
        </div>
      `
      )
      .join("")}</div>`;
  }
  if (btn) btn.disabled = !urgent.length || !availableTrucks.length;
}

function renderUrgentPreview(state) {
  const box = document.getElementById("urgent-plan-preview");
  if (!box) return;
  const planned = (state.routes || []).filter((r) => r.auto_generated);
  if (!planned.length) {
    box.innerHTML = `<div class="empty-count">0</div>`;
    return;
  }
  box.innerHTML = `<div class="mini-grid route-mini-grid">${planned
    .map((r) => {
      const status = routeStatusLabel[r.status] || r.status;
      const tone = r.status === "finalizada" ? "ok" : r.status === "planificada" ? "warn" : "bad";
      const stopTags =
        r.stops
          ?.slice(0, 3)
          .map((s) => {
            const c = state.centers?.find((cc) => cc.id === s.center_id);
            const centerName = c ? c.name : s.center_id;
            const tankLabel = c?.tanks?.find((t) => t.id === s.tank_id)?.label || s.tank_id;
            return `<span class="mini-tag">${shortText(centerName, 16)} ${tankLabel}</span>`;
          })
          .join("") || "";
      return `
        <div class="micro-card in-route">
          <div class="micro-top">
            <span class="micro-label">${r.id}</span>
            <span class="pill tiny tone-${tone}">${status}</span>
          </div>
          <div class="micro-meta">
            <span>${r.truck_id}</span>
            <span>${r.worker || "Pendiente"}</span>
          </div>
          <div class="micro-meta">
            <span>${r.stops?.length || 0} paradas</span>
            <span>${formatLiters(r.planned_load_l || r.total_delivered || 0)}</span>
          </div>
          ${stopTags ? `<div class="tag-row tiny">${stopTags}</div>` : ""}
        </div>
      `;
    })
    .join("")}</div>`;
}

function collectStopDurations(routes = []) {
  const rows = [];
  routes.forEach((r) => {
    const worker = r.worker || "sin_operario";
    (r.stops || []).forEach((s) => {
      if (!s.arrival_at || !s.depart_at) return;
      const arrival = new Date(s.arrival_at);
      const depart = new Date(s.depart_at);
      const minutes = Math.max(0, Math.round((depart - arrival) / 60000));
      rows.push({
        center_id: s.center_id,
        tank_id: s.tank_id,
        worker,
        minutes,
        route_id: r.id,
        arrival,
      });
    });
  });
  return rows;
}

function renderReportsChart(rows, centersMap, filters) {
  const box = document.getElementById("report-chart");
  if (!box) return;
  const { centerId, worker } = filters;
  const filtered = rows.filter((row) => {
    const centerOk = centerId === "all" || row.center_id === centerId;
    const workerOk = worker === "all" || row.worker === worker;
    return centerOk && workerOk;
  });

  if (!filtered.length) {
    box.innerHTML = `<div class="muted small">Sin datos de tiempos con los filtros actuales.</div>`;
    return;
  }

  const grouped = filtered.reduce((acc, row) => {
    acc[row.center_id] = acc[row.center_id] || [];
    acc[row.center_id].push(row);
    return acc;
  }, {});

  const maxMinutes = Math.max(...filtered.map((r) => r.minutes), 1);

  const totalMinutes = filtered.reduce((sum, r) => sum + r.minutes, 0);

  const cards = Object.entries(grouped)
    .map(([centerId, list]) => {
      const centerName = centersMap[centerId]?.name || centerId;
      const byWorker = list.reduce((acc, row) => {
        acc[row.worker] = (acc[row.worker] || 0) + row.minutes;
        return acc;
      }, {});
      const rowsHtml = Object.entries(byWorker)
        .sort((a, b) => b[1] - a[1])
        .map(([w, minutes]) => {
          const pct = Math.max(4, Math.round((minutes / maxMinutes) * 100));
          return `
            <div class="bar-row">
              <span class="muted small">${w}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-meta">${minutes} min</span>
            </div>
          `;
        })
        .join("");
      return `
        <div class="bar-card">
          <h3>${centerName}</h3>
          ${rowsHtml}
        </div>
      `;
    })
    .join("");

  box.innerHTML = `
    <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      <span class="chip soft">Paradas: ${filtered.length}</span>
      <span class="chip soft">Min totales: ${totalMinutes}</span>
      <span class="chip soft">Centros: ${Object.keys(grouped).length}</span>
    </div>
    <div class="mini-grid">${cards}</div>
  `;
}

async function initReports() {
  await ensureBrowserSessionFromServer();
  const adminSession = getSession("adminSession");
  const label = document.getElementById("reports-session-label");
  if (!adminSession) {
    window.location.href = "/login";
    return;
  }
  if (label) label.textContent = `Sesion: ${adminSession.user}`;

  const centerSelect = document.getElementById("filter-center");
  const workerSelect = document.getElementById("filter-worker");

  const state = await fetchState();
  const centers = state.centers || [];
  const centersMap = centers.reduce((acc, c) => {
    acc[c.id] = c;
    return acc;
  }, {});

  const allRoutes = [...(state.route_history || []), ...(state.routes || [])];
  const rows = collectStopDurations(allRoutes);

  if (centerSelect) {
    centerSelect.innerHTML =
      `<option value="all">Todos los centros</option>` +
      centers.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  }

  if (workerSelect) {
    const workers = Array.from(new Set(rows.map((r) => r.worker))).sort();
    workerSelect.innerHTML =
      `<option value="all">Todos los operarios</option>` +
      workers.map((w) => `<option value="${w}">${w}</option>`).join("");
  }

  const render = () => {
    renderReportsChart(rows, centersMap, {
      centerId: centerSelect?.value || "all",
      worker: workerSelect?.value || "all",
    });
  };

  centerSelect?.addEventListener("change", render);
  workerSelect?.addEventListener("change", render);

  render();
}

async function initAlertsPage() {
  await ensureBrowserSessionFromServer();
  refreshSessionBadges();
  const adminSession = getSession("adminSession");
  if (!adminSession) {
    window.location.href = "/login";
    return;
  }
  const load = async () => {
    const state = await fetchState();
    renderAlarms(state.alerts || [], "alert-wall-full", state);
  };
  load();
  setInterval(load, 15000);
}

async function initMapPage() {
  await ensureBrowserSessionFromServer();
  refreshSessionBadges();
  const adminSession = getSession("adminSession");
  if (!adminSession) {
    window.location.href = "/login";
    return;
  }
  ensureGlobalQRButton();
  const load = async () => {
    const state = await fetchState();
    renderMap(state, "map-full");
    renderTruckStatusColumns(state.trucks || [], state.routes || []);
  };
  load();
  setInterval(load, 15000);
}

async function initHub() {
  await ensureBrowserSessionFromServer();
  refreshSessionBadges();
  const adminSession = getSession("adminSession");
  if (!adminSession) {
    window.location.href = "/login";
    return;
  }
  document.querySelectorAll("[data-hub-link]").forEach((btn) => {
    btn.onclick = () => {
      const target = btn.getAttribute("data-hub-link");
      if (target) window.location.href = target;
    };
  });
}

async function initLoginPage() {
  clearSession("workerSession");
  clearSession("adminSession");
  clearSession("activeRouteId");

  const form = document.getElementById("auth-login-form");
  const hint = document.getElementById("auth-login-hint");

  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    if (res.ok) {
      const data = await parseJSONResponse(res);
      if (data?.authenticated) {
        saveSession("adminSession", { user: data.user || "usuario" });
        window.location.href = "/";
        return;
      }
    }
  } catch (_e) {
    /* ignore */
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      username: form.username.value,
      password: form.password.value,
      role: "admin",
    };
    const res = await postJSON("/api/login", body);
    if (!res.ok) {
      const msg = res.error || "No se pudo iniciar sesion";
      if (hint) hint.textContent = msg;
      flash(msg);
      return;
    }
    saveSession("adminSession", { user: body.username });
    if (hint) hint.textContent = "";
    window.location.href = "/";
  });
}

function renderWorkerRoutes(state) {

  const session = ensureWorkerSession();

  const list = document.getElementById("worker-active");

  const historyBox = document.getElementById("worker-history");

  if (!list || !historyBox) return;

  list.innerHTML = "";

  historyBox.innerHTML = "";

  if (!session) {

    list.innerHTML = `<div class="muted">Inicia sesion de operario.</div>`;

    return;

  }

  const active = state.routes.filter((r) => r.worker === session.user);

  if (!active.length) {

    list.innerHTML = `<div class="muted">Sin rutas activas.</div>`;

  } else {

    active.forEach((r) => {

      const stop = r.stops?.[r.current_stop_idx] || r.stops?.[r.stops.length - 1];

      const center = state.centers.find((c) => c.id === stop?.center_id);

      const tank = center?.tanks.find((t) => t.id === stop?.tank_id);

      const card = document.createElement("div");

      card.className = "route-card emphasis";

      card.innerHTML = `
        <div class="row">
          <strong>${r.truck_id} - ${r.id}</strong>
          <span class="status badge">${routeStatusLabel[r.status] || r.status}</span>
        </div>
        <div class="tank-meta">
          <span>${center ? center.name : stop?.center_id || "-"}</span>
          <span>${tank ? tank.label : stop?.tank_id || ""}</span>
        </div>
        <div class="tank-meta">
          <span>${compactProduct(stop?.product || r.product_type || "-")}</span>
          <span>${formatLiters(stop?.liters || 0)} plan</span>
        </div>
        <div class="tank-meta highlight-row">
          <span>Entregado: ${formatLiters(r.total_delivered || 0)}</span>
          <span>${stop?.arrival_at ? formatDatePlus1(stop.arrival_at) : ""}</span>
        </div>
      `;
      list.appendChild(card);
    });

  }

  const history = state.route_history
    .filter((r) => r.worker === session.user)
    .slice(0, 8);

  if (!history.length) {

    historyBox.innerHTML = `<li>Sin historico</li>`;

  } else {

    history.forEach((r) => {

      const li = document.createElement("li");

      const firstStop = r.stops?.[0];
      const lastStop = r.stops?.[r.stops.length - 1];
      const centerName = firstStop?.center_id || "-";
      li.innerHTML = `<strong>${r.id}</strong> ${r.truck_id} - ${centerName} - ${formatLiters(r.total_delivered || 0)} - <span class="chip soft">${routeStatusLabel[r.status] || r.status}</span> - ${formatDatePlus1(r.finished_at || r.started_at)}`;

      historyBox.appendChild(li);

    });

  }

}



function updateStepPills(state) {
  const pills = document.querySelectorAll("[data-step-pill]");
  if (!pills.length) return;
  const session = ensureWorkerSession();
  let statuses = ["idle", "idle", "idle", "idle"];
  if (session && state?.routes?.length) {
    const route = state.routes.find((r) => r.worker === session.user);
    if (route) {
      statuses = ["done", "idle", "idle", "idle"];
      if (route.status === "finalizada") {
        statuses = ["done", "done", "done", "done"];
      } else if (route.status === "regresando") {
        statuses = ["done", "done", "current", "idle"];
      } else {
        statuses[1] = "current";
      }
    }
  }
  pills.forEach((pill) => {
    pill.classList.remove("done", "current");
    const idx = parseInt(pill.getAttribute("data-step-pill") || "0", 10) - 1;
    const st = statuses[idx] || "idle";
    if (st === "done") pill.classList.add("done");
    if (st === "current") pill.classList.add("current");
  });
}



function renderLog(logItems) {

  const log = document.getElementById("delivery-log");

  if (!log) return;

  const rangeEl = document.getElementById("filter-range");
  const workerEl = document.getElementById("filter-worker");
  const centerEl = document.getElementById("filter-center");

  const buildSwitch = (el, options, current, onChange) => {
    if (!el) return;
    el.innerHTML = options
      .map(
        (opt) =>
          `<button class="pill-btn ${current === opt.value ? "active" : ""}" data-value="${opt.value}">${opt.label}</button>`
      )
      .join("");
    el.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        onChange(btn.getAttribute("data-value"));
      };
    });
  };

  buildSwitch(
    rangeEl,
    [
      { label: "24h", value: "24h" },
      { label: "3d", value: "3d" },
      { label: "Todos", value: "all" },
    ],
    logFilters.range,
    (val) => {
      logFilters.range = val;
      renderLog(logItems);
    }
  );

  const workers = ["all", ...new Set((logItems || []).map((i) => i.by).filter(Boolean))];
  buildSwitch(
    workerEl,
    workers.map((w) => ({ label: w === "all" ? "Todos" : w, value: w })),
    logFilters.worker,
    (val) => {
      logFilters.worker = val;
      renderLog(logItems);
    }
  );

  const centers = ["all", ...new Set((logItems || []).map((i) => i.center).filter(Boolean))];
  buildSwitch(
    centerEl,
    centers.map((c) => ({ label: c === "all" ? "Centros" : c, value: c })),
    logFilters.center,
    (val) => {
      logFilters.center = val;
      renderLog(logItems);
    }
  );

  log.innerHTML = "";

  if (!logItems || !logItems.length) {

    log.innerHTML = `<li>Sin descargas recientes</li>`;

    return;

  }

  const now = Date.now();
  const filtered = logItems.filter((item) => {
    if (logFilters.worker !== "all" && item.by !== logFilters.worker) return false;
    if (logFilters.center !== "all" && item.center !== logFilters.center) return false;
    if (logFilters.range === "24h") {
      if (now - new Date(item.ts).getTime() > 24 * 3600 * 1000) return false;
    } else if (logFilters.range === "3d") {
      if (now - new Date(item.ts).getTime() > 3 * 24 * 3600 * 1000) return false;
    }
    return true;
  });

  if (!filtered.length) {
    log.innerHTML = `<li>Sin registros con ese filtro</li>`;
    return;
  }

  filtered.forEach((item) => {

    const ts = formatDatePlus1(item.ts);

    const li = document.createElement("li");

    li.innerHTML = `<strong>${ts}</strong> ${item.truck_id} -> ${item.center} (${formatLiters(item.delivered_l)}) - ${item.by} - ${item.note}`;

    log.appendChild(li);

  });

}

function renderWorkerFlow(state) {
  const box = document.getElementById("worker-flow");
  if (!box) return;
  const rows = [];
  state.routes.forEach((r) => {
    rows.push({
      worker: r.worker,
      ruta: r.id,
      evento: routeStatusLabel[r.status] || r.status,
      hora: formatDatePlus1(r.started_at),
    });
  });
  state.route_history.forEach((r) => {
    const last = r.history?.[r.history.length - 1];
    rows.push({
      worker: r.worker,
      ruta: r.id,
      evento: last ? `${last.event}` : "finalizada",
      hora: formatDatePlus1(r.finished_at || last?.ts),
    });
  });
  if (!rows.length) {
    box.innerHTML = `<div class="muted">Sin movimientos.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="excel-row head" style="grid-template-columns: repeat(4, minmax(120px,1fr));">
      <div class="excel-cell">Operario</div>
      <div class="excel-cell">Ruta</div>
      <div class="excel-cell">Evento</div>
      <div class="excel-cell">Hora</div>
    </div>
    ${rows
      .map(
        (r) => `
          <div class="excel-row" style="grid-template-columns: repeat(4, minmax(120px,1fr));">
            <div class="excel-cell">${r.worker}</div>
            <div class="excel-cell">${r.ruta}</div>
            <div class="excel-cell">${r.evento}</div>
            <div class="excel-cell">${r.hora}</div>
          </div>
        `
      )
      .join("")}
  `;
}

function initMap(targetId, center) {
  const m = L.map(targetId).setView([center.lat, center.lon], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
  }).addTo(m);
  return m;
}



function dropletIcon(color) {

  return `<svg width="28" height="34" viewBox="0 0 28 34" xmlns="http://www.w3.org/2000/svg">

    <path d="M14 2 C14 2 4 14 4 22 a10 10 0 0020 0C24 14 14 2 14 2z" fill="${color}" stroke="#0c1420" stroke-width="2"/>

    <circle cx="10" cy="16" r="3" fill="rgba(255,255,255,0.4)"/>

  </svg>`;

}



function truckSvg(tr) {

  const color = truckColor[tr.status] || "#9aa7b8";

  const cab = tr.status === "returning" ? "#d8e4f0" : "#eef3f8";

  return `

    <svg width="52" height="36" viewBox="0 0 104 72" xmlns="http://www.w3.org/2000/svg">

      <rect x="8" y="26" width="66" height="26" rx="7" fill="#dfe7f1" stroke="#0c1420" stroke-width="3"/>

      <rect x="12" y="30" width="58" height="18" rx="6" fill="${color}"/>

      <rect x="64" y="18" width="26" height="22" rx="5" fill="${cab}" stroke="#0c1420" stroke-width="3"/>

      <rect x="74" y="22" width="10" height="10" rx="2" fill="rgba(0,0,0,0.08)"/>

      <rect x="70" y="30" width="12" height="8" rx="2" fill="${color}"/>

      <circle cx="28" cy="54" r="8" fill="#0f1724" stroke="#e0e7ef" stroke-width="4"/>

      <circle cx="62" cy="54" r="8" fill="#0f1724" stroke="#e0e7ef" stroke-width="4"/>

      <circle cx="82" cy="54" r="8" fill="#0f1724" stroke="#e0e7ef" stroke-width="4"/>

    </svg>

  `;

}



function truckPopup(tr) {

  const color = truckColor[tr.status] || "#9aa7b8";

  return `

    <div class="map-popup">

      <strong>${tr.id} - ${tr.driver}</strong>

      <div class="chip" style="background:${color};color:#0c1420;">${truckStatusLabel[tr.status] || tr.status}</div>

      <div class="tank-meta">

        <span>Carga ${formatLiters(tr.current_load_l)} / ${formatLiters(tr.capacity_l)}</span>

        <span>Destino ${tr.destination?.name || "Almacen"}</span>

      </div>

      <div class="tank-meta">

        <span>Tiempo estimado: ${tr.eta_minutes ? tr.eta_minutes + " min" : "n/d"}</span>

        <span>${tr.notes || ""}</span>

      </div>

    </div>

  `;

}

function renderMapCenterDeposits(center, targetId = "map-center-deposits", titleId = "map-center-title") {
  const box = document.getElementById(targetId);
  const title = document.getElementById(titleId);
  if (!box) return;
  if (!center) {
    box.innerHTML = `<div class="muted small">Selecciona un centro en el mapa.</div>`;
    if (title) title.textContent = "Depositos del centro";
    return;
  }
  if (title) title.textContent = `Depositos - ${center.name}`;
  const rows = sortTanksBySeverity(center.tanks || []);
  if (!rows.length) {
    box.innerHTML = `<div class="muted small">Sin depositos.</div>`;
    return;
  }
  box.innerHTML = rows
    .map((tank) => {
      const toneClass = tankToneClass(tank.status);
      return `
        <div class="map-depot-row ${toneClass}">
          <div class="map-depot-main">
            <strong>${tank.label || tank.id}</strong>
            <span class="pill tiny ${tank.status || "ok"}">${tankStatusLabel(tank.status)}</span>
          </div>
          <div class="map-depot-meta">
            <span>${Math.round(tank.percentage || 0)}%</span>
            <span>${formatLiters(tank.current_l)} / ${formatLiters(tank.capacity_l)}</span>
            <span>${formatEtaDateTime(tank.last_reading)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}



function renderMap(state, targetId = "map") {
  const container = document.getElementById(targetId);
  if (!container) return;

  if (!mapInstances[targetId]) {
    const seedCenter = (state.centers || []).find((c) => c.location?.lat && c.location?.lon);
    mapInstances[targetId] = initMap(targetId, seedCenter?.location || state.warehouse);
    tankMarkerSets[targetId] = {};
    truckMarkerSets[targetId] = {};
  }
  const mapObj = mapInstances[targetId];
  const centerMarkers = tankMarkerSets[targetId];
  const truckMarkers = truckMarkerSets[targetId];

  const centersToRender = (state.centers || []).filter(
    (center) =>
      isCenterEnabledOnMap(center.name) &&
      Number.isFinite(center?.location?.lat) &&
      Number.isFinite(center?.location?.lon)
  );
  const visibleCenterKeys = new Set(centersToRender.map((c) => `center-${c.id}`));

  Object.keys(centerMarkers).forEach((key) => {
    if (!visibleCenterKeys.has(key)) {
      mapObj.removeLayer(centerMarkers[key]);
      delete centerMarkers[key];
    }
  });

  centersToRender.forEach((center) => {
    const key = `center-${center.id}`;
    const worst = worstStatus(center.tanks || []);
    const icon = L.divIcon({
      html: dropletIcon(statusColor[worst] || statusColor.ok),
      className: "",
      iconSize: [30, 36],
      iconAnchor: [15, 18],
    });
    const coords = [center.location.lat, center.location.lon];
    if (!centerMarkers[key]) {
      centerMarkers[key] = L.marker(coords, { icon }).addTo(mapObj);
    } else {
      centerMarkers[key].setLatLng(coords);
      centerMarkers[key].setIcon(icon);
    }

    const alertCount = (center.tanks || []).filter((t) => ["warn", "alert", "critical"].includes(t.status)).length;
    const tooltipHtml = `
      <div class="map-popup">
        <strong>${center.name}</strong>
        <div>ID centro: ${center.id}</div>
        <div>Lat ${Number(center.location.lat).toFixed(6)} - Lon ${Number(center.location.lon).toFixed(6)}</div>
        <div>Depositos: ${(center.tanks || []).length} - Alertas: ${alertCount}</div>
      </div>`;

    centerMarkers[key].unbindTooltip();
    centerMarkers[key].bindTooltip(tooltipHtml, {
      direction: "top",
      offset: [0, -10],
      opacity: 0.95,
      className: "map-tooltip",
    });
    centerMarkers[key].off("click");
    centerMarkers[key].on("click", () => {
      selectedMapCenterId = center.id;
      renderMapCenterDeposits(center);
    });
  });

  if (centersToRender.length && !mapObj.__fitDoneOnce) {
    const bounds = L.latLngBounds(centersToRender.map((c) => [c.location.lat, c.location.lon]));
    mapObj.fitBounds(bounds.pad(0.25));
    mapObj.__fitDoneOnce = true;
  }

  const selectedCenter =
    centersToRender.find((center) => center.id === selectedMapCenterId) || centersToRender[0] || null;
  if (selectedCenter) selectedMapCenterId = selectedCenter.id;
  renderMapCenterDeposits(selectedCenter);

  const trucks = state.trucks || [];
  const visibleTruckIds = new Set(trucks.map((tr) => tr.id));
  Object.keys(truckMarkers).forEach((id) => {
    if (!visibleTruckIds.has(id)) {
      mapObj.removeLayer(truckMarkers[id]);
      delete truckMarkers[id];
    }
  });

  trucks.forEach((tr) => {
    const icon = L.divIcon({
      html: truckSvg(tr),
      className: "",
      iconSize: [52, 36],
      iconAnchor: [26, 18],
    });
    let lat = tr.position?.lat;
    let lon = tr.position?.lon;
    if ((lat === undefined || lon === undefined) && tr.destination?.center_id) {
      const center = state.centers.find((c) => c.id === tr.destination.center_id);
      const tank = center?.tanks?.find((t) => t.id === tr.destination.tank_id);
      lat = tank?.location?.lat ?? center?.location?.lat;
      lon = tank?.location?.lon ?? center?.location?.lon;
    }
    if (lat === undefined || lon === undefined) {
      lat = state.warehouse.lat;
      lon = state.warehouse.lon;
    }
    if (!truckMarkers[tr.id]) {
      truckMarkers[tr.id] = L.marker([lat, lon], { icon }).addTo(mapObj);
    } else {
      truckMarkers[tr.id].setLatLng([lat, lon]);
      truckMarkers[tr.id].setIcon(icon);
    }
    truckMarkers[tr.id].unbindTooltip();
    truckMarkers[tr.id].bindTooltip(truckPopup(tr), {
      direction: "top",
      offset: [0, -12],
      opacity: 0.98,
      className: "map-tooltip",
    });
  });
}



async function initHome() {

  const drainBtn = document.getElementById("btn-drain");

  drainBtn?.addEventListener("click", async () => {

    await postJSON("/api/simulate-drain", {});

    flash("Variacion simulada en depositos y sensores.");

    loadHome();

  });

  const startBtn = document.getElementById("btn-start-route");

  startBtn?.addEventListener("click", () => {

    const session = ensureWorkerSession();

    if (session) {

      window.location.href = "/salida";

    } else {

      window.openSessionModal?.("worker");

    }

  });

  const loginForm = document.getElementById("login-form");
  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      username: loginForm.username.value,
      password: loginForm.password.value,
      role: loginForm.role.value,
    };
    const res = await postJSON("/api/login", body);
    if (!res.ok) {
      flash(res.error || "Credenciales invalidas");
      return;
    }
    if (res.role === "admin") {
      clearSession("workerSession");
      saveSession("adminSession", { user: body.username });
      window.location.href = "/hub";
      return;
    } else {
      clearSession("adminSession");
      saveSession("workerSession", { user: body.username });
    }
    refreshSessionBadges();
    toggleGate(false);
    flash("Sesion iniciada");
    loadHome();
  });

  ensureGlobalQRButton();
  loadHome();

  setInterval(loadHome, 15000);

}



async function loadHome() {

  await ensureBrowserSessionFromServer();
  const adminSession = getSession("adminSession");
  const workerSession = ensureWorkerSession();
  const hasSession = !!adminSession || !!workerSession;

  document.querySelectorAll(".admin-only").forEach((el) => (el.style.display = adminSession ? "block" : "none"));
  document.querySelectorAll(".worker-only").forEach((el) => (el.style.display = adminSession ? "none" : "block"));
  const adminButtons = document.querySelectorAll(".admin-only-button");
  adminButtons.forEach((el) => (el.style.display = adminSession ? "inline-flex" : "none"));
  toggleGate(!hasSession);
  if (adminSession) {
  }
  if (!hasSession) {
    window.location.href = "/login";
    return;
  }

  ensureGlobalQRButton();
  const cached = getCachedState();
  if (cached) {
    if (adminSession) {
      renderCenters(cached.centers || []);
      renderSensorSummary(cached.centers || []);
      renderSensorPanel(cached.centers || []);
      renderAlarms(cached.alerts || [], "alarms-panel", cached);
      renderActiveRoutes(cached.routes || [], cached.centers || []);
      renderLog(cached.delivery_log || []);
      renderMap(cached, "map-admin");
      renderWorkerFlow(cached);
    } else {
      renderWorkerAssignments(cached);
      renderWorkerRoutes(cached);
      updateStepPills(cached);
    }
  }

  const state = await fetchState();
  if (adminSession) {
    renderCenters(state.centers);
    renderSensorSummary(state.centers);
    renderSensorPanel(state.centers);
    renderAlarms(state.alerts, "alarms-panel", state);
    renderActiveRoutes(state.routes, state.centers);
    renderLog(state.delivery_log);
    renderMap(state, "map-admin");
    renderWorkerFlow(state);
  } else {
    renderWorkerAssignments(state);
    renderWorkerRoutes(state);
    updateStepPills(state);
  }
}

function ensureWorkerSession() {

  return getSession("workerSession");

}

function requireWorkerSession(redirectTo = "/trabajador") {
  const session = ensureWorkerSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}



function populateDestinations(centers, container) {

  const addRow = () => {

    const row = document.createElement("div");

    row.className = "destination-item";

    row.innerHTML = `

      <div class="row">

        <strong>Destino</strong>

        <button type="button" class="mini-btn remove-destination">Quitar</button>

      </div>

      <div class="form-grid">

        <label>Centro<select class="center-select"></select></label>

        <label>Deposito<select class="tank-select"></select></label>

        <label>Litros<input type="number" class="liters-input" value="2000" step="1" min="0" /></label>

        <label>Producto<input class="product-input" placeholder="Producto especifico (opcional)" /></label>

      </div>

    `;

    container.appendChild(row);

    const centerSelect = row.querySelector(".center-select");

    const tankSelect = row.querySelector(".tank-select");

    centerSelect.innerHTML = centers.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");

    const setTanks = () => {

      const centerId = centerSelect.value;

      const center = centers.find((c) => c.id === centerId);

      if (!center) return;

      tankSelect.innerHTML = center.tanks.map((t) => `<option value="${t.id}">${t.label} - ${t.product}</option>`).join("");

    };

    centerSelect.addEventListener("change", setTanks);

    setTanks();

    row.querySelector(".remove-destination").addEventListener("click", () => {

      if (container.children.length > 1) {

        row.remove();

      }

    });

  };



  addRow();

  const addBtn = document.getElementById("add-destination");

  addBtn?.addEventListener("click", addRow);

}



function renderTruckGrid(trucks) {

  const grid = document.getElementById("truck-grid");

  if (!grid) return;

  grid.innerHTML = "";

  trucks.forEach((tr) => {

    const card = document.createElement("div");

    card.className = "truck-card";

    card.innerHTML = `

      <strong>${tr.id} - ${tr.driver}</strong>

      <div class="muted">${truckStatusLabel[tr.status] || tr.status}</div>

      <div class="tank-meta">

        <span>${formatLiters(tr.current_load_l)}</span>

        <span>${tr.destination?.name || "Almacen"}</span>

      </div>

    `;

    grid.appendChild(card);

  });

}



function renderTruckStatusColumns(trucks, routes = []) {
  const availableBox = document.getElementById("truck-available");
  const activeBox = document.getElementById("truck-active");
  if (!availableBox || !activeBox) return;
  availableBox.innerHTML = "";
  activeBox.innerHTML = "";
  const routeByTruck = routes.reduce((acc, r) => {
    if (r.truck_id) acc[r.truck_id] = r;
    return acc;
  }, {});
  const buildCard = (tr) => {
    const route = routeByTruck[tr.id];
    const status = route ? routeStatusLabel[route.status] || route.status : truckStatusLabel[tr.status] || tr.status;
    const worker = route?.worker || tr.driver || "-";
    const routeId = route?.id || tr.route_id || "Sin ruta";
    const dest = tr.destination?.name || route?.origin || "Almacen";
    const card = document.createElement("div");
    card.className = "truck-card";
    card.innerHTML = `
      <div class="row spaced">
        <strong>${tr.id}</strong>
        <span class="status ${route ? "warn" : "ok"}">${status}</span>
      </div>
      <div class="muted small">Operario: ${worker}</div>
      <div class="tank-meta">
        <span>${routeId}</span>
        <span>${dest}</span>
      </div>
      <div class="tank-meta">
        <span>${formatLiters(tr.current_load_l)}</span>
        <span>${truckStatusLabel[tr.status] || tr.status}</span>
      </div>
    `;
    return card;
  };
  trucks.forEach((tr) => {
    const target = tr.status === "parked" ? availableBox : activeBox;
    target.appendChild(buildCard(tr));
  });
}


function renderMiniCenters(centers) {

  const grid = document.getElementById("mini-centers");

  if (!grid) return;

  grid.innerHTML = "";

  centers.forEach((c) => {

    const min = document.createElement("div");

    min.className = "mini-card";

    const avgLevel = c.tanks.reduce((acc, t) => acc + t.percentage, 0) / c.tanks.length;

    min.innerHTML = `<strong>${c.name}</strong><div class="muted">Nivel medio ${avgLevel.toFixed(1)}%</div>`;

    grid.appendChild(min);

  });

}


async function initCenterPage() {

  await ensureBrowserSessionFromServer();
  refreshSessionBadges();

  const centerId = document.body.dataset.centerId;

  const setSubtitle = (text) => {

    const sub = document.getElementById("center-sub");

    if (sub) sub.textContent = text;

  };

  const load = async () => {

    const state = await fetchState();

    const center = state.centers.find((c) => c.id === centerId);

    if (!center) {

      flash("Centro no encontrado");

      window.location.href = "/";

      return;

    }

    renderCenterDetail(center, { targetId: "center-tanks", titleId: "center-title", statusId: "center-status" });

    renderCenterAlerts(center, state.alerts, state);

    renderCenterRoutes(center, state);

    renderMap(state);
    const mapObj = mapInstances["map"];
    if (mapObj) mapObj.setView([center.location.lat, center.location.lon], 12);

    setSubtitle(
      `${center.tanks.length} depositos - Lat ${Number(center.location.lat).toFixed(6)} - Lon ${Number(
        center.location.lon
      ).toFixed(6)}`
    );

  };

  load();

  setInterval(load, 20000);

}




async function initSalida() {

  refreshSessionBadges();

  if (!requireWorkerSession()) return;

  const flowNotice = consumeFlowNotice();
  if (flowNotice) flash(flowNotice);

  ensureGlobalQRButton();
  const state = await fetchState();

  renderTruckGrid(state.trucks);

  renderMiniCenters(state.centers);

  const planned = (state.routes || []).filter((r) => r.status === "planificada");
  const session = ensureWorkerSession();
  const mine = planned.find((r) => r.worker === session?.user);
  const selectedTruckBox = document.getElementById("selected-truck");
  const scanBtn = document.getElementById("btn-activate-truck");
  if (scanBtn) {
    scanBtn.textContent = "Abrir camara y leer QR";
    scanBtn.disabled = false;
  }

  const setMessage = (msg) => {
    if (!selectedTruckBox) return;
    selectedTruckBox.innerHTML = msg;
  };

  if (!planned.length) {
    setMessage(`<div class="muted">Sin rutas planificadas ahora mismo.</div>`);
  } else if (mine) {
    setMessage(
      `<strong>Ruta asignada</strong><div class="muted small">Dir&iacute;gete al cami&oacute;n ${mine.truck_id} para comenzar.</div>`
    );
  } else {
    setMessage(`<div class="muted">Ruta planificada. Escanea el QR del cami&oacute;n asignado.</div>`);
  }

  const claimRoute = async (truckId) => {
    const workerSession = ensureWorkerSession();
    if (!workerSession) return;

    const already = (state.routes || []).find(
      (r) => r.worker === workerSession.user && r.status !== "planificada"
    );
    if (already) {
      saveSession("activeRouteId", already.id);
      flash(`Ruta ${already.id} ya en curso`);
      window.location.href = "/destino";
      return;
    }

    const res = await postJSON("/api/routes/claim", { worker: workerSession.user, truck_id: truckId });
    if (!res.ok) {
      const plannedForMe = planned.find((r) => r.worker === workerSession.user);
      if (plannedForMe) {
        flash(res.error || `Ese QR no es tu cami&oacute;n. Dir&iacute;gete a ${plannedForMe.truck_id}.`);
      } else {
        flash(res.error || "No se pudo activar la ruta");
      }
      return;
    }
    saveSession("activeRouteId", res.route?.id || null);
    flash(`Ruta ${res.route?.id || ""} activada`);
    window.location.href = "/destino";
  };

  if (scanBtn) {
    scanBtn.onclick = () => flash("Escanea el QR f\u00edsico del cami\u00f3n asignado para activar la ruta.");
    scanBtn.disabled = true;
  }

  const pendingScan = consumePendingScan();
  if (pendingScan?.type === "truck") {
    await claimRoute(pendingScan.id || pendingScan.truck_id);
    return;
  }
  if (pendingScan?.type === "center") {
    flash("Primero debes escanear el QR del camion asignado.");
  } else if (pendingScan?.type === "warehouse") {
    flash("Primero debes activar una ruta escaneando el camion.");
  }

  const already = (state.routes || []).find(
    (r) => r.worker === session?.user && r.status && r.status !== "planificada"
  );
  if (already) {
    saveSession("activeRouteId", already.id);
    window.location.href = "/destino";
  }
}



function buildRouteView(route, centers) {



  if (!route)

    return `<div class="muted">No hay ruta activa. Escanea el QR del cami&oacute;n asignado en el paso anterior.</div>`;



  const stop = route.stops?.[route.current_stop_idx] || route.stops?.[route.stops.length - 1];



  const center = centers.find((c) => c.id === stop?.center_id);



  const tank = center?.tanks.find((t) => t.id === stop?.tank_id);



  const arrival = stop?.arrival_at ? new Date(stop.arrival_at) : null;



  const depart = stop?.depart_at ? new Date(stop.depart_at) : null;



  const duration = arrival ? minutesBetween(arrival, depart || new Date()) : null;



  const hasMore = route.current_stop_idx + 1 < route.stops.length;



  const targetLabel = `${center ? center.name : stop?.center_id || "-"} / ${tank ? tank.label : stop?.tank_id || ""}`;

  const routeStatus = routeStatusLabel[route.status] || route.status;



  const waitingBlock = !arrival
    ? `<div class="chip primary">Paso 2: Dir&iacute;gete a ${center ? center.name : stop?.center_id} y escanea el QR f\u00edsico al llegar para marcar la llegada.</div>`
    : `<div class="chip muted">Llegada marcada. Completa la descarga y sal.</div>`;

  const returnBlock =
    route.status === "regresando"
      ? `<div class="chip">Ruta en retorno. Escanea el QR del almac&eacute;n para cerrar.</div>`
      : "";



  return `



    <div class="route-card big">



      <h3>${targetLabel}</h3>



      <div class="row">

        <div class="muted">${route.id} -> ${route.truck_id}</div>

        <span class="status ${route.status === "en_destino" ? "warn" : "ok"}">${routeStatus}</span>

      </div>



      <div class="tank-meta">



        <span>${compactProduct(stop?.product || route.product_type || "-")}</span>



        <span>${formatLiters(stop?.liters || 0)} plan</span>



      </div>



      <div class="tank-meta">



        <span>${arrival ? formatDatePlus1(arrival) : "Llegada pendiente"}</span>



        <span>${formatLiters(route.total_delivered || 0)} entregado</span>



      </div>



    </div>



    <div class="stack">

      ${waitingBlock}

    </div>



    <div class="stack">



      <form id="complete-stop-form" class="stack destination-item">



        <label>Litros descargados<input type="number" name="delivered" value="${stop?.liters || 0}" step="1" min="0" /></label>



        <label>Notas<input name="note" placeholder="Observaciones" /></label>



        <button class="btn" type="submit" ${!arrival || depart ? "disabled" : ""}>Finalizar descarga y salir</button>



      </form>



      ${



        hasMore



          ? `<div class="chip muted">Tras este destino se cargara el siguiente en la ruta.</div>`



          : `<div class="chip muted">Ultimo destino. Al cerrar pasaras a regreso.</div>`



      }



    </div>



    <div class="timeline-head">Todos los destinos</div>



    <div class="timeline">



      ${route.stops



        .map((s, idx) => {



          const c = centers.find((cc) => cc.id === s.center_id);



          return `<div class="timeline-item">${idx + 1}. ${c ? c.name : s.center_id} / ${s.tank_id} - ${



            s.status || "pendiente"



          } - ${s.arrival_at ? formatDatePlus1(s.arrival_at) : "esperando"}</div>`;



        })



        .join("")}



    </div>



    ${



      returnBlock



    }



  `;



}







async function initDestino() {

  refreshSessionBadges();

  if (!requireWorkerSession()) return;

  const flowNotice = consumeFlowNotice();
  if (flowNotice) flash(flowNotice);

  ensureGlobalQRButton();
  let pendingScan = consumePendingScan();

  async function load() {

    const session = ensureWorkerSession();
    if (!session) {
    window.location.href = "/";
      return;
    }

    const state = await fetchState();

    const routeId = getSession("activeRouteId");

    let route = state.routes.find((r) => r.id === routeId);

    if (!route && session) {

      route = state.routes.find(
        (r) => r.worker === session.user && r.status && r.status !== "planificada" && r.status !== "finalizada"
      );

    }

    const container = document.getElementById("route-container");

    if (!container) return;

    container.innerHTML = buildRouteView(route, state.centers);

    if (!route) {
      if (pendingScan?.type === "center") {
        pendingScan = null;
        flash("Debes activar primero la ruta escaneando el camion.");
        window.location.href = "/salida";
      }
      return;
    }
    if (route.status === "planificada") {
      if (pendingScan?.type === "center") {
        pendingScan = null;
      }
      flash("Ruta aun no activada. Escanea primero el QR del camion.");
      window.location.href = "/salida";
      return;
    }

    const form = document.getElementById("complete-stop-form");

    if (form) form.onsubmit = async (e) => {

      e.preventDefault();

      if (!session) {

        flash("Inicia sesion para cerrar el destino.");

        window.openSessionModal?.("worker");

        return;

      }

      const body = { route_id: route.id, delivered_l: Number(form.delivered.value), note: form.note.value };

      const res = await postJSON("/api/routes/complete-stop", body);

      if (!res.ok) {

        flash(res.error || "Error");

        return;

      }

      flash("Destino finalizado");

      if (res.route?.status === "regresando") {

        saveSession("activeRouteId", res.route.id);

        flash("Entrega exitosa. Marca llegada en almacen.");

        setTimeout(() => (window.location.href = "/llegada"), 400);

      } else {

        load();

      }

    };

    const applyCenterScan = async (scan) => {
      const currentStop = route.stops[route.current_stop_idx] || route.stops[0];
      if (!currentStop) {
        flash("Ruta sin paradas pendientes.");
        return;
      }
      const scannedCenter = scan.center_id || scan.id;
      if (!scannedCenter) {
        flash("QR de centro no reconocido.");
        return;
      }
      if (scan.type && scan.type !== "center") {
        flash("Ese QR no es de un centro asignado.");
        return;
      }
      if (scannedCenter !== currentStop.center_id) {
        const target = state.centers.find((c) => c.id === currentStop.center_id);
        flash(`Ese QR no corresponde al destino actual. Ve a ${target ? target.name : currentStop.center_id}.`);
        return;
      }
      if (scan.tank_id && scan.tank_id !== currentStop.tank_id) {
        const targetTank = currentStop.tank_id;
        flash(`Ese QR es de otro tanque. Busca ${targetTank}.`);
        return;
      }
      const res = await postJSON("/api/routes/arrive", { route_id: route.id });
      flash(res.ok ? "Llegada marcada por QR" : res.error || "Error");
      if (res.ok) {
        saveSession("activeRouteId", route.id);
        await load();
      }
    };

    if (pendingScan?.type === "center") {
      const scanCopy = pendingScan;
      pendingScan = null;
      const currentStop = route.stops[route.current_stop_idx] || route.stops[0];
      if (currentStop?.arrival_at) {
        // Ya marcado, no repetir
        return;
      }
      await applyCenterScan(scanCopy);
      return;
    }

  }

  load();

}


function buildArrivalView(route) {

  if (!route) return `<div class="muted">No hay ruta en retorno. Finaliza un destino primero.</div>`;

  if (route.status !== "regresando" && route.status !== "finalizada") {

    return `<div class="muted">Aun hay destinos pendientes. Vuelve al paso de destino.</div>`;

  }

  if (route.status === "finalizada") {

    return `<div class="chip">Ruta ${route.id} ya cerrada.</div>`;

  }

  return `

    <div class="route-card">

      <h4>${route.id} - ${route.truck_id}</h4>

      <div class="tank-meta"><span>Litros totales</span><span>${formatLiters(route.total_delivered)}</span></div>

      <div class="tank-meta"><span>Destinos</span><span>${route.stops.length}</span></div>

    </div>

    <div class="chip muted">Dir&iacute;gete al almac&eacute;n y escanea el QR para cerrar la ruta.</div>

  `;

}



async function initScan() {

  const status = document.getElementById("scan-status");

  const params = new URLSearchParams(window.location.search);

  const adminSession = getSession("adminSession");
  if (adminSession) {
    if (status) status.textContent = "Sesion de admin: escaneo ignorado.";
    return;
  }

  const rawPayload = params.get("payload") || params.get("code");
  const parsedPayload = rawPayload ? parseQRContent(rawPayload) : null;

  const payload = parsedPayload?.type
    ? parsedPayload
    : {
        type: params.get("type"),
        id: params.get("id"),
        center_id: params.get("center_id"),
        tank_id: params.get("tank_id"),
      };

  if (!payload?.type) {
    if (status) status.textContent = "QR no reconocido.";
    setTimeout(() => (window.location.href = "/"), 600);
    return;
  }

  const workerSession = getSession("workerSession");
  if (!workerSession) {
    savePendingScan(payload);
    if (status) status.textContent = "QR capturado. Inicia sesion de operario para continuar.";
    setTimeout(() => (window.location.href = "/trabajador"), 300);
    return;
  }

  const routeId = getSession("activeRouteId");
  if (payload.type === "truck") {
    savePendingScan(payload);
    if (status) status.textContent = "QR de camion capturado. Redirigiendo a salida...";
    setTimeout(() => (window.location.href = "/salida"), 220);
    return;
  }

  if (payload.type === "center") {
    if (!routeId) {
      saveFlowNotice("Orden incorrecto: primero QR de camion, despues QR de parada.");
      if (status) status.textContent = "Debes escanear primero el camion asignado.";
      setTimeout(() => (window.location.href = "/salida"), 320);
      return;
    }
    savePendingScan(payload);
    if (status) status.textContent = "QR de parada capturado. Redirigiendo a destino...";
    setTimeout(() => (window.location.href = "/destino"), 220);
    return;
  }

  if (payload.type === "warehouse") {
    if (!routeId) {
      saveFlowNotice("No hay ruta activa. Escanea primero el camion.");
      if (status) status.textContent = "No hay ruta activa para cerrar.";
      setTimeout(() => (window.location.href = "/salida"), 320);
      return;
    }
    savePendingScan(payload);
    if (status) status.textContent = "QR de almacen capturado. Redirigiendo a llegada...";
    setTimeout(() => (window.location.href = "/llegada"), 220);
    return;
  }

  if (status) status.textContent = "Tipo de QR no soportado.";
  setTimeout(() => (window.location.href = "/"), 600);
}


async function initLlegada() {

  refreshSessionBadges();

  if (!requireWorkerSession()) return;

  const flowNotice = consumeFlowNotice();
  if (flowNotice) flash(flowNotice);

  ensureGlobalQRButton();
  const container = document.getElementById("arrival-content");

  const qrBtn = document.getElementById("qr-warehouse-btn");

  let pendingScan = consumePendingScan();


  async function load() {

    const session = ensureWorkerSession();
    if (!session) {
    window.location.href = "/";
      return;
    }

    const state = await fetchState();

    const routeId = getSession("activeRouteId");

    let route = state.routes.find((r) => r.id === routeId);

    if (!route && session)
      route = state.routes.find(
        (r) => r.worker === session.user && r.status && r.status !== "planificada" && r.status !== "finalizada"
      );

    container.innerHTML = buildArrivalView(route);

    if (qrBtn) {

      qrBtn.disabled = !route || route.status === "finalizada";

    }

    if (!route || route.status !== "regresando") return;

    if (pendingScan?.type === "warehouse") {
      const scanCopy = pendingScan;
      pendingScan = null;
      if (route.status === "finalizada") return;
      await handleWarehouseQR(scanCopy);
      return;
    }

  }



  async function handleWarehouseQR(_scan) {

    const session = ensureWorkerSession();

    if (!session) {

      flash("Inicia sesion de operario para cerrar la ruta.");

      window.openSessionModal?.("worker");

      return;

    }

    const state = await fetchState();

    const routeId = getSession("activeRouteId");

    let route = state.routes.find((r) => r.id === routeId);

    if (!route) route = state.routes.find((r) => r.worker === session.user);

    if (!route) {

      flash("No hay ruta activa para este operario.");

      return;

    }

    if (route.status === "finalizada") {

      flash("La ruta ya esta cerrada.");

      return;

    }

    if (route.status !== "regresando") {

      flash("La ruta aun no esta en regreso.");

      return;

    }

    const res = await postJSON("/api/routes/arrive-warehouse", { route_id: route.id, success: true });

    if (!res.ok) {

      flash(res.error || "Error");

      return;

    }

    flash("Ruta cerrada via QR de almacen");

    saveSession("activeRouteId", null);

    load();

    setTimeout(() => (window.location.href = "/"), 600);

  }



  if (qrBtn) {
    qrBtn.onclick = () => flash("Escanea el QR f\u00edsico del almac\u00e9n para cerrar la ruta.");
  }

  load();

  setInterval(load, 60000);

}



async function initWorkerLogin() {

  const flowNotice = consumeFlowNotice();
  if (flowNotice) flash(flowNotice);

  const existing = ensureWorkerSession();
  if (existing) {
    // Si ya tiene sesion, reencaminar segun un QR pendiente
    const pending = consumePendingScan();
    if (pending?.type === "center") {
      if (getSession("activeRouteId")) {
        savePendingScan(pending);
        window.location.href = "/destino";
      } else {
        saveFlowNotice("Primero escanea el QR del camion para activar la ruta.");
        window.location.href = "/salida";
      }
    } else if (pending?.type === "warehouse") {
      if (getSession("activeRouteId")) {
        savePendingScan(pending);
        window.location.href = "/llegada";
      } else {
        saveFlowNotice("Primero escanea el QR del camion para activar la ruta.");
        window.location.href = "/salida";
      }
    } else {
      if (pending) savePendingScan(pending);
      window.location.href = "/salida";
    }
    return;
  }

  const form = document.getElementById("worker-login-form");

  form?.addEventListener("submit", async (e) => {

    e.preventDefault();

    const body = { username: form.username.value, password: form.password.value, role: "worker" };

    const res = await postJSON("/api/login", body);

    if (!res.ok) {

      flash(res.error || "Credenciales invalidas");

      return;

    }

    saveSession("workerSession", { user: body.username });

    refreshSessionBadges();

    flash("Sesion iniciada");

    const pending = consumePendingScan();
    if (pending) savePendingScan(pending);

    // Tras login, si hay una ruta activa del operario, guardarla en sesion
    try {
      const state = await fetchState();
      const active = (state.routes || []).find(
        (r) =>
          r.worker === body.username &&
          r.status &&
          r.status !== "finalizada" &&
          r.status !== "planificada"
      );
      if (active) saveSession("activeRouteId", active.id);
    } catch (_e) {
      /* ignore */
    }

    if (pending?.type === "center") {
      if (getSession("activeRouteId")) {
        window.location.href = "/destino";
      } else {
        saveFlowNotice("Primero escanea el QR del camion para activar la ruta.");
        window.location.href = "/salida";
      }
    } else if (pending?.type === "warehouse") {
      if (getSession("activeRouteId")) {
        window.location.href = "/llegada";
      } else {
        saveFlowNotice("Primero escanea el QR del camion para activar la ruta.");
        window.location.href = "/salida";
      }
    } else if (pending?.type === "truck") {
      window.location.href = "/salida";
    } else {
      window.location.href = "/salida";
    }

  });

}



function ensureRouteDetailModal() {
  if (document.getElementById("route-detail-modal")) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="route-detail-modal" class="modal hidden">
      <div class="modal-card route-detail-card">
        <div class="row spaced">
          <div>
            <div class="caps">Ruta</div>
            <h3 id="route-detail-title">Detalle</h3>
          </div>
          <button class="mini-btn" id="close-route-detail" type="button">Cerrar</button>
        </div>
        <div id="route-detail-body" class="route-detail-body"></div>
      </div>
    </div>
  `;
  const modalEl = wrapper.firstElementChild;
  if (modalEl) document.body.appendChild(modalEl);
  const modal = document.getElementById("route-detail-modal");
  const closeModal = () => {
    modal?.classList.add("hidden");
    modal?.classList.remove("active");
  };
  document.getElementById("close-route-detail")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
}

function ensureRouteEditModal() {
  if (document.getElementById("route-edit-modal")) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="route-edit-modal" class="modal hidden">
      <div class="modal-card route-detail-card">
        <div class="row spaced" style="gap:8px; flex-wrap:wrap;">
          <div>
            <div class="caps">Rutas urgentes</div>
            <h3>Editar asignaci&oacute;n</h3>
          </div>
          <button class="mini-btn" id="close-route-edit" type="button">Cerrar</button>
        </div>
        <div id="route-edit-body" class="route-detail-body">
          <div class="edit-block">
            <div class="caps">Auto generadas</div>
            <div id="auto-route-edit"></div>
            <div class="row" style="justify-content:flex-end; gap:8px;">
              <button class="mini-btn ghost" id="cancel-route-edit" type="button">Cancelar</button>
              <button class="mini-btn" id="save-route-edit" type="button">Guardar</button>
            </div>
          </div>
          <div class="edit-block">
            <div class="caps">Crear ruta manual</div>
            <div class="route-form-grid">
              <label>Operario<select id="manual-worker"></select></label>
              <label>Camion<select id="manual-truck"></select></label>
            </div>
            <div id="manual-stops" class="stop-list"></div>
            <div class="mini-row" style="justify-content:flex-start;">
              <button class="mini-btn" type="button" id="add-manual-stop">Anadir parada</button>
              <button class="mini-btn ghost" type="button" id="clear-manual-stops">Limpiar</button>
            </div>
            <button class="btn" type="button" id="save-route-manual">Crear ruta</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const modalEl = wrapper.firstElementChild;
  if (modalEl) document.body.appendChild(modalEl);
  const modal = document.getElementById("route-edit-modal");
  const close = () => {
    modal?.classList.add("hidden");
    modal?.classList.remove("active");
  };
  document.getElementById("close-route-edit")?.addEventListener("click", close);
  document.getElementById("cancel-route-edit")?.addEventListener("click", close);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
}


function openRouteDetail(route, state) {
  ensureRouteDetailModal();
  const modal = document.getElementById("route-detail-modal");
  const title = document.getElementById("route-detail-title");
  const body = document.getElementById("route-detail-body");
  if (!modal || !title || !body) return;

  const centers = state?.centers || [];
  const stops = route.stops || [];
  const started = route.started_at ? new Date(route.started_at) : null;
  const finished = route.finished_at ? new Date(route.finished_at) : null;
  const totalMinutes = started ? minutesBetween(started, finished || new Date()) : null;
  const statusTone = route.status === "finalizada" ? "ok" : route.status === "en_destino" ? "warn" : "";
  const product = route.product_type || route.stops?.[0]?.product;

  const stopBlocks =
    stops
      .map((s, idx) => {
        const center = centers.find((c) => c.id === s.center_id);
        const tank = center?.tanks?.find((t) => t.id === s.tank_id);
        const centerName = center?.name || s.center_id || "-";
        const tankLabel = tank?.label || s.tank_id || "-";
        const arrival = s.arrival_at ? new Date(s.arrival_at) : null;
        const depart = s.depart_at ? new Date(s.depart_at) : null;
        const duration = arrival ? minutesBetween(arrival, depart || new Date()) : null;
        const liters = s.delivered_l ?? s.liters ?? 0;
        const stopStatus = s.status === "completado" ? "Completado" : arrival ? "En destino" : "Pendiente";
        const stopTone = s.status === "completado" ? "ok" : arrival ? "warn" : "";
        const arrivalText = arrival
          ? `${arrival.toLocaleDateString()} ${formatDatePlus1(arrival)}`
          : "Llegada pendiente";
        const departText = depart ? `${depart.toLocaleDateString()} ${formatDatePlus1(depart)}` : "";
        return `
          <div class="route-stop-card ${stopTone}">
            <div class="row" style="flex-wrap:wrap;">
              <strong>${idx + 1}. ${centerName}</strong>
              <span class="chip soft">${tankLabel}</span>
            </div>
            <div class="small muted">${compactProduct(s.product || product || "-")} - ${formatLiters(liters)}</div>
            <div class="small muted">${arrivalText}${departText ? " - " + departText : ""}</div>
            <div class="row" style="flex-wrap:wrap;">
              <span class="small">${duration ? `${duration} min en destino` : "Tiempo pendiente"}</span>
              <span class="status ${stopTone || "warn"}">${stopStatus}</span>
            </div>
          </div>
        `;
      })
      .join("") || `<div class="muted">Sin paradas</div>`;

  title.textContent = `${route.id} - ${route.truck_id}${route.worker ? " - " + route.worker : ""}`;
  body.innerHTML = `
    <div class="row" style="flex-wrap:wrap; gap:6px;">
      <span class="chip soft"><span class="status ${statusTone}">${routeStatusLabel[route.status] || route.status}</span></span>
      <span class="chip soft">${formatLiters(route.total_delivered || 0)} entregado</span>
      <span class="chip soft">${stops.length} destinos</span>
    </div>
    <div class="detail-row"><strong>Inicio</strong><span>${started ? `${started.toLocaleDateString()} ${formatDatePlus1(started)}` : "n/d"}</span></div>
    <div class="detail-row"><strong>Fin</strong><span>${finished ? `${finished.toLocaleDateString()} ${formatDatePlus1(finished)}` : "En curso"}</span></div>
    <div class="detail-row"><strong>Duracion</strong><span>${totalMinutes ? `${totalMinutes} min` : "En curso"}</span></div>
    <div class="detail-row"><strong>Producto</strong><span>${compactProduct(product || "-")}</span></div>
    <div class="detail-row"><strong>Origen</strong><span>${route.origin || "Almacen"}</span></div>
    <div class="timeline-head">Destinos</div>
    <div class="route-stop-grid">${stopBlocks}</div>
  `;

  modal.classList.remove("hidden");
  modal.classList.add("active");
}


async function initAdmin() {
  await ensureBrowserSessionFromServer();

  const loginPanel = document.getElementById("admin-login-panel");

  const content = document.getElementById("admin-content");

  const sessionLabel = document.getElementById("admin-session-label");

  const adminSession = getSession("adminSession");
  if (!adminSession) {
    window.location.href = "/login";
    return;
  }

  let adminState = null;
  const routeFilters = { status: "all", worker: "all", truck: "all", center: "all", type: "all" };



  const renderStats = (state) => {

    const statsBox = document.getElementById("admin-stats");
    if (!statsBox) return;
    const active = state.routes.length;
    const inProgress = state.routes.filter((r) => r.status && r.status !== "planificada").length;
    const closed = state.route_history.length;
    const alerts = state.alerts.length;

    const summarizeRoutes = (routes) =>
      routes
        .slice(0, 4)
        .map((r) => `${r.id} - ${routeStatusLabel[r.status] || r.status}`)
        .join("<br>");

    const summarizeClosed = (routes) =>
      routes
        .slice(0, 4)
        .map((r) => `${r.id} - ${formatDatePlus1(r.finished_at || r.started_at)}`)
        .join("<br>");

    const summarizeAlerts = (list) =>
      list
        .slice(0, 4)
        .map((a) => a.message || `${a.center} / ${a.tank_id}`)
        .join("<br>");

    const buildCard = (label, value, _detail, tone = "") => `
      <div class="mini-card stat-card ${tone}">
        <div class="stat-title">${label}</div>
        <div class="stat-value">${value}</div>
      </div>
    `;

    const inProgressRoutes = state.routes.filter((r) => r.status && r.status !== "planificada");

    statsBox.innerHTML = [
      buildCard("Activas", active, summarizeRoutes(state.routes)),
      buildCard("En progreso", inProgress, summarizeRoutes(inProgressRoutes), "warn"),
      buildCard("Cerradas", closed, summarizeClosed(state.route_history)),
      buildCard("Alertas", alerts, summarizeAlerts(state.alerts), "bad"),
    ].join("");

  };



  const renderAdminCenters = (state) => {

    renderCenters(state.centers, "admin-center-grid", { skipFocus: true });

    renderAlarms(state.alerts, "admin-alerts", state);

  };



  const renderRouteTable = (state) => {
    const box = document.getElementById("admin-route-table");
    const statusSelect = document.getElementById("filter-route-status");
    const workerSelect = document.getElementById("filter-route-worker");
    const truckSelect = document.getElementById("filter-route-truck");
    const centerSelect = document.getElementById("filter-route-center");
    const typeSelect = document.getElementById("filter-route-type");
    if (!box) return;

    const combined = [...(state.routes || []), ...(state.route_history || [])];
    const statuses = Array.from(new Set(combined.map((r) => r.status).filter(Boolean)));
    const workers = Array.from(new Set(combined.map((r) => r.worker || "sin_operario"))).filter(Boolean);
    const trucks = state.trucks || [];
    const centers = Array.from(
      new Set(
        combined.flatMap((r) => (r.stops || []).map((s) => s.center_id).filter(Boolean))
      )
    );

    if (statusSelect) {
      statusSelect.innerHTML =
        `<option value="all">Todos</option>` +
        statuses.map((s) => `<option value="${s}">${routeStatusLabel[s] || s}</option>`).join("");
      statusSelect.value = routeFilters.status;
      statusSelect.onchange = (e) => {
        routeFilters.status = e.target.value || "all";
        renderRouteTable(state);
      };
    }

    if (workerSelect) {
      workerSelect.innerHTML =
        `<option value="all">Todos</option>` +
        workers.map((w) => `<option value="${w}">${w}</option>`).join("");
      workerSelect.value = routeFilters.worker;
      workerSelect.onchange = (e) => {
        routeFilters.worker = e.target.value || "all";
        renderRouteTable(state);
      };
    }

    if (truckSelect) {
      truckSelect.innerHTML =
        `<option value="all">Todos</option>` +
        trucks.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");
      truckSelect.value = routeFilters.truck;
      truckSelect.onchange = (e) => {
        routeFilters.truck = e.target.value || "all";
        renderRouteTable(state);
      };
    }

    if (centerSelect) {
      centerSelect.innerHTML =
        `<option value="all">Todos</option>` +
        centers.map((c) => `<option value="${c}">${c}</option>`).join("");
      centerSelect.value = routeFilters.center;
      centerSelect.onchange = (e) => {
        routeFilters.center = e.target.value || "all";
        renderRouteTable(state);
      };
    }

    if (typeSelect) {
      typeSelect.innerHTML = `
        <option value="all">Todos</option>
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      `;
      typeSelect.value = routeFilters.type;
      typeSelect.onchange = (e) => {
        routeFilters.type = e.target.value || "all";
        renderRouteTable(state);
      };
    }

    const matchesFilters = (r) => {
      const statusOk = routeFilters.status === "all" || r.status === routeFilters.status;
      const workerOk =
        routeFilters.worker === "all" || (r.worker || "sin_operario") === routeFilters.worker;
      const truckOk = routeFilters.truck === "all" || r.truck_id === routeFilters.truck;
      const typeOk =
        routeFilters.type === "all" ||
        (routeFilters.type === "auto" ? r.auto_generated : !r.auto_generated);
      const centerOk =
        routeFilters.center === "all" ||
        (r.stops || []).some((s) => s.center_id === routeFilters.center);
      return statusOk && workerOk && truckOk && typeOk && centerOk;
    };

    const cards = [];

    state.routes.filter(matchesFilters).forEach((r) => {
      const stop = r.stops?.[r.current_stop_idx] || r.stops?.[r.stops.length - 1];
      const center = state.centers.find((c) => c.id === stop?.center_id);
      const tank = center?.tanks.find((t) => t.id === stop?.tank_id);
      cards.push({ data: r, destino: `${center ? center.name : stop?.center_id || "-"} / ${tank ? tank.label : stop?.tank_id || ""}` });
    });

    state.route_history.filter(matchesFilters).slice(0, 12).forEach((r) => {
      const lastStop = r.stops?.[r.stops.length - 1];
      cards.push({ data: r, destino: `${lastStop?.center_id || "-"} / ${lastStop?.tank_id || ""}` });
    });

    if (!cards.length) {
      box.innerHTML = `<div class="empty-count">0</div>`;
      return;
    }

    box.innerHTML = `<div class="mini-grid route-mini-grid">${cards
      .map(({ data, destino }) => {
        const status = routeStatusLabel[data.status] || data.status;
        const tone = data.status === "finalizada" ? "ok" : data.status === "planificada" ? "warn" : "bad";
        return `
          <div class="route-card micro">
            <div class="micro-top">
              <span class="micro-label">${data.id}</span>
              <span class="pill tiny tone-${tone}">${status}</span>
            </div>
            <div class="micro-meta" aria-hidden="true">
              <span>${data.truck_id}</span>
              <span>${data.stops?.length || 0} paradas</span>
            </div>
            <div class="micro-meta" aria-hidden="true">
              <span>${data.worker || "Pendiente"}</span>
              <span>${data.auto_generated ? "Auto" : "Manual"}</span>
            </div>
            <div class="micro-meta" aria-hidden="true">
              <span>${destino}</span>
              <span>${formatLiters(data.total_delivered || data.planned_load_l || 0)}</span>
            </div>
            <button class="mini-btn" data-route="${data.id}">Más detalle</button>
          </div>
        `;
      })
      .join("")}</div>`;

    box.querySelectorAll("button[data-route]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-route");
        const route = cards.find((c) => c.data.id === id)?.data;
        if (!route) return;
        openRouteDetail(route, state);
      };
    });
  };



  const renderCharts = () => {};



  const load = async () => {

    const state = await fetchState();
    adminState = state;

    renderStats(state);
    renderAdminCenters(state);

    renderUrgentWall(state);

    renderUrgentPreview(state);

    renderRouteTable(state);

    renderCharts(state);

  };

  const openEditUrgentRoutes = () => {
    if (!adminState) return;
    ensureRouteEditModal();
    const modal = document.getElementById("route-edit-modal");
    const autoBox = document.getElementById("auto-route-edit");
    const saveBtn = document.getElementById("save-route-edit");
    const workerSelect = document.getElementById("manual-worker");
    const truckSelect = document.getElementById("manual-truck");
    const stopsBox = document.getElementById("manual-stops");
    const addStopBtn = document.getElementById("add-manual-stop");
    const clearStopsBtn = document.getElementById("clear-manual-stops");
    const saveManualBtn = document.getElementById("save-route-manual");
    if (!modal || !autoBox || !saveBtn || !workerSelect || !truckSelect || !stopsBox || !addStopBtn || !saveManualBtn)
      return;

    const planned = (adminState.routes || []).filter((r) => r.auto_generated);
    const centers = adminState.centers || [];
    const workers = adminState.workers || [];
    const trucks = adminState.trucks || [];
    const allowedTrucks = trucks.filter(
      (t) => t.status === "parked" || planned.some((r) => r.truck_id === t.id)
    );
    const parkedTrucks = trucks.filter((t) => t.status === "parked");

    const workerOptions =
      `<option value="">Elegir operario</option>` +
      workers.map((w) => `<option value="${w}">${w}</option>`).join("");
    workerSelect.innerHTML = workerOptions;

    const truckOptions =
      `<option value="">Elegir camion</option>` +
      parkedTrucks.map((t) => `<option value="${t.id}">${t.id} (${formatLiters(t.capacity_l)})</option>`).join("");
    truckSelect.innerHTML = truckOptions;

    if (planned.length) {
      const autoTruckOptions = allowedTrucks
        .map((t) => `<option value="${t.id}">${t.id} (${formatLiters(t.capacity_l)})</option>`)
        .join("");
      autoBox.innerHTML = planned
        .map((r) => {
          const tone = r.status === "finalizada" ? "ok" : r.status === "planificada" ? "warn" : "bad";
          return `
            <div class="detail-row route-edit-row">
              <strong>${r.id}</strong>
            <div class="route-edit-controls">
              <select data-route="${r.id}" data-current="${r.truck_id}" data-type="truck">
                ${autoTruckOptions}
              </select>
              <select data-route="${r.id}" data-current-worker="${r.worker || ""}" data-type="worker">
                <option value="">Operario</option>
                ${workers.map((w) => `<option value="${w}">${w}</option>`).join("")}
              </select>
            </div>
            <span class="pill tiny tone-${tone}">${routeStatusLabel[r.status] || r.status}</span>
            <button class="mini-btn ghost" data-delete-route="${r.id}" type="button">Eliminar</button>
          </div>
        `;
      })
      .join("");

      autoBox.querySelectorAll("select[data-type='truck']").forEach((sel) => {
        sel.value = sel.getAttribute("data-current") || sel.value;
      });
      autoBox.querySelectorAll("select[data-type='worker']").forEach((sel) => {
        sel.value = sel.getAttribute("data-current-worker") || sel.value;
      });
    } else {
      autoBox.innerHTML = `<div class="empty-count">0</div>`;
    }

    const close = () => {
      modal.classList.add("hidden");
      modal.classList.remove("active");
    };

    autoBox.querySelectorAll("button[data-delete-route]").forEach((btn) => {
      btn.onclick = async () => {
        const routeId = btn.getAttribute("data-delete-route");
        btn.disabled = true;
        const res = await postJSON("/api/admin/delete-route", { route_id: routeId });
        btn.disabled = false;
        if (!res.ok) {
          flash(res.error || "No se pudo eliminar");
          return;
        }
        flash("Ruta eliminada");
        load();
        close();
      };
    });

    saveBtn.onclick = async () => {
      const rows = Array.from(autoBox.querySelectorAll(".route-edit-row"));
      const changes = rows
        .map((row) => {
          const routeId = row.querySelector("select[data-type='truck']")?.getAttribute("data-route");
          const truckSel = row.querySelector("select[data-type='truck']");
          const workerSel = row.querySelector("select[data-type='worker']");
          const newTruck = truckSel?.value;
          const currentTruck = truckSel?.getAttribute("data-current");
          const newWorker = workerSel?.value;
          const currentWorker = workerSel?.getAttribute("data-current-worker") || "";
          const changed = (newTruck && newTruck !== currentTruck) || (newWorker || "") !== currentWorker;
          return changed ? { routeId, truckId: newTruck, worker: newWorker || undefined } : null;
        })
        .filter(Boolean);

      if (!changes.length) {
        close();
        return;
      }
      const original = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = "Guardando...";
      for (const change of changes) {
        const res = await postJSON("/api/admin/reassign-route", {
          route_id: change.routeId,
          truck_id: change.truckId,
          worker: change.worker,
        });
        if (!res.ok) {
          flash(res.error || "No se pudo reasignar");
          break;
        }
      }
      saveBtn.disabled = false;
      saveBtn.textContent = original;
      close();
      load();
    };

    const findCenter = (id) => centers.find((c) => c.id === id);
    const findTank = (cId, tId) => findCenter(cId)?.tanks?.find((t) => t.id === tId);

    const fillTankSelect = (row, centerId, preferredTank) => {
      const tankSel = row.querySelector(".stop-tank");
      if (!tankSel) return;
      const center = findCenter(centerId);
      if (!center || !center.tanks?.length) {
        tankSel.innerHTML = `<option value=\"\">Sin tanques</option>`;
        return;
      }
      tankSel.innerHTML = center.tanks
        .map((t) => `<option value="${t.id}">${t.label} (${t.percentage}%)</option>`)
        .join("");
      tankSel.value = preferredTank || tankSel.value;
      return tankSel.value;
    };

    const addStopRow = (preset = {}) => {
      const row = document.createElement("div");
      row.className = "stop-row";
      row.innerHTML = `
        <select class="stop-center">
          ${centers.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}
        </select>
        <select class="stop-tank"></select>
        <input type="number" class="stop-liters" placeholder="Litros" min="0" step="100" />
        <div class="controls">
          <button type="button" class="mini-btn" data-move="up">↑</button>
          <button type="button" class="mini-btn" data-move="down">↓</button>
          <button type="button" class="mini-btn ghost" data-remove="1">Quitar</button>
        </div>
      `;
      stopsBox.appendChild(row);
      const centerSel = row.querySelector(".stop-center");
      const tankSel = row.querySelector(".stop-tank");
      const litersInput = row.querySelector(".stop-liters");
      if (preset.center_id) centerSel.value = preset.center_id;
      const chosenTank = fillTankSelect(row, centerSel.value, preset.tank_id);
      if (preset.tank_id && tankSel) tankSel.value = preset.tank_id;
      const tankInfo = findTank(centerSel.value, tankSel?.value || chosenTank);
      litersInput.value = preset.liters ?? tankInfo?.deficit_l ?? "";

      centerSel.onchange = () => {
        const newTank = fillTankSelect(row, centerSel.value);
        const info = findTank(centerSel.value, newTank);
        if (info) litersInput.value = info.deficit_l || "";
      };
      row.querySelectorAll("button[data-move]").forEach((btn) => {
        btn.onclick = () => {
          if (btn.getAttribute("data-move") === "up" && row.previousElementSibling) {
            stopsBox.insertBefore(row, row.previousElementSibling);
          } else if (btn.getAttribute("data-move") === "down" && row.nextElementSibling) {
            stopsBox.insertBefore(row.nextElementSibling, row);
          }
        };
      });
      row.querySelector("button[data-remove]")?.addEventListener("click", () => row.remove());
    };

    stopsBox.innerHTML = "";
    addStopRow();

    addStopBtn.onclick = () => addStopRow();
    clearStopsBtn.onclick = () => {
      stopsBox.innerHTML = "";
      addStopRow();
    };

    saveManualBtn.onclick = async () => {
      const worker = workerSelect.value;
      const truckId = truckSelect.value;
      const stopRows = Array.from(stopsBox.querySelectorAll(".stop-row"));
      if (!worker || !truckId) {
        flash("Selecciona operario y camion");
        return;
      }
      const stops = stopRows
        .map((row) => {
          const centerId = row.querySelector(".stop-center")?.value;
          const tankId = row.querySelector(".stop-tank")?.value;
          const liters = Number(row.querySelector(".stop-liters")?.value || 0);
          const tankInfo = findTank(centerId, tankId);
          return centerId && tankId && liters > 0
            ? { center_id: centerId, tank_id: tankId, liters, product: tankInfo?.product }
            : null;
        })
        .filter(Boolean);
      if (!stops.length) {
        flash("Anade al menos una parada con litros");
        return;
      }
      const load_l = stops.reduce((sum, s) => sum + (s.liters || 0), 0);
      const product_type = stops[0]?.product || "Multiproducto";
      const payload = {
        worker,
        truck_id: truckId,
        origin: adminState.warehouse?.name,
        load_l,
        product_type,
        stops,
        auto_generated: true,
      };
      const original = saveManualBtn.textContent;
      saveManualBtn.disabled = true;
      saveManualBtn.textContent = "Creando...";
      const res = await postJSON("/api/routes/plan", payload);
      saveManualBtn.disabled = false;
      saveManualBtn.textContent = original;
      if (!res.ok) {
        flash(res.error || "No se pudo crear la ruta");
        return;
      }
      flash("Ruta creada");
      close();
      load();
    };

    modal.classList.remove("hidden");
    modal.classList.add("active");
  };


  const bindUrgentButton = () => {
    const btn = document.getElementById("btn-generate-urgent");
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Generando...";
      const res = await postJSON("/api/admin/auto-plan", {});
      if (!res.ok) {
        flash(res.error || "No se pudo generar rutas urgentes");
      } else {
        flash(`Rutas generadas: ${res.created}`);
      }
      btn.textContent = original || "Generar ruta";
      btn.disabled = false;
      load();
    };
  };



  if (adminSession) {

    loginPanel?.classList.add("hidden");

    content?.classList.remove("hidden");

    if (sessionLabel) sessionLabel.textContent = `Sesion: ${adminSession.user}`;

    load();

    setInterval(load, 60000);

  }

  bindUrgentButton();

  const editBtn = document.getElementById("btn-edit-urgent");
  if (editBtn) {
    editBtn.onclick = openEditUrgentRoutes;
  }

  const form = document.getElementById("admin-login-form");

  form?.addEventListener("submit", async (e) => {

    e.preventDefault();

    const body = { username: form.username.value, password: form.password.value, role: "admin" };

    const res = await postJSON("/api/login", body);

    if (!res.ok) {

      flash(res.error || "Credenciales invalidas");

      return;

    }

    saveSession("adminSession", { user: body.username });
    refreshSessionBadges();
    window.location.href = "/hub";

  });

}



document.addEventListener("DOMContentLoaded", () => {

  ensureSessionModal();

  refreshSessionBadges();

  const page = document.body.dataset.page;

  if (page === "login") initLoginPage();

  if (page === "home") initHome();

  if (page === "worker-login") initWorkerLogin();

  if (page === "salida") initSalida();

  if (page === "destino") initDestino();

  if (page === "llegada") initLlegada();

  if (page === "admin") initAdmin();

  if (page === "center") initCenterPage();

  if (page === "reports") initReports();

  if (page === "alerts") initAlertsPage();

  if (page === "map") initMapPage();

  if (page === "hub") initHub();

  if (page === "scan") initScan();

});

