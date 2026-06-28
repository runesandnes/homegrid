// ============================================================
//  Home Grid — customizable home info screen
//  Vanilla JS, no build. Three layers: state, layouts, widgets.
// ============================================================

const STORAGE_KEY = "homegrid.config";
// RSS feeds can't be fetched cross-origin directly; route through a proxy.
// Swap this for a self-hosted proxy if you prefer.
const RSS_PROXY = (url) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;

// ---------- tiny DOM helpers ----------
const qs = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return node;
};
// Accept either a bare URL or a full "<iframe src=…>" embed snippet; return the URL.
const extractEmbedSrc = (value) => {
  const v = String(value || "").trim();
  if (/<iframe/i.test(v)) {
    const m = v.match(/src\s*=\s*["']([^"']+)["']/i);
    if (m) return m[1].replace(/&amp;/g, "&");
  }
  return v;
};
const fetchJSON = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Minimal IndexedDB key/value store — holds FileSystemDirectoryHandles for photo folders
// (these can't be saved in localStorage; only IndexedDB can persist a directory handle).
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open("homegrid", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbSet = async (key, val) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
};
const idbGet = async (key) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readonly");
    const rq = tx.objectStore("kv").get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
};

// ============================================================
//  LAYOUT REGISTRY
//  Each layout = a CSS grid template + ordered slot ids.
//  Area names in `areas` map to the slot ids (a, b, c, ...).
// ============================================================
const LAYOUTS = [
  { id: "split-v", label: "Two — side by side", slots: ["a", "b"],
    columns: "1fr 1fr", rows: "1fr", areas: ["a b"] },
  { id: "split-h", label: "Two — stacked", slots: ["a", "b"],
    columns: "1fr", rows: "1fr 1fr", areas: ["a", "b"] },
  { id: "left-stack-3", label: "Big right + two left", slots: ["a", "b", "c"],
    columns: "60fr 40fr", rows: "1fr 2fr", areas: ["a b", "c b"] },
  { id: "top-1-bottom-2", label: "One top, two bottom", slots: ["a", "b", "c"],
    columns: "1fr 1fr", rows: "1fr 1fr", areas: ["a a", "b c"] },
  { id: "cols-3", label: "Three columns", slots: ["a", "b", "c"],
    columns: "1fr 1fr 1fr", rows: "1fr", areas: ["a b c"] },
  { id: "grid-2x2", label: "2 × 2 grid", slots: ["a", "b", "c", "d"],
    columns: "1fr 1fr", rows: "1fr 1fr", areas: ["a b", "c d"] },
  { id: "big-left-3", label: "Big left + three right", slots: ["a", "b", "c", "d"],
    columns: "2fr 1fr", rows: "1fr 1fr 1fr", areas: ["a b", "a c", "a d"] },
  { id: "feature-left-4", label: "Feature left + four", slots: ["a", "b", "c", "d", "e"],
    columns: "2fr 1fr 1fr", rows: "1fr 1fr", areas: ["a b c", "a d e"] },
  { id: "three-left-1-right", label: "Three left + big right", slots: ["a", "b", "c", "d"],
    columns: "60fr 40fr", rows: "1fr 1fr 1fr", areas: ["a d", "b d", "c d"] },
];
const getLayout = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[2];

// ============================================================
//  WIDGET REGISTRY
//  render(el, cfg) mounts content and returns an optional
//  cleanup function (to clear timers when the pane changes).
// ============================================================

// WMO weather code -> icon + description
const WMO = {
  0: ["☀️", "Clear sky"], 1: ["🌤️", "Mainly clear"], 2: ["⛅", "Partly cloudy"], 3: ["☁️", "Overcast"],
  45: ["🌫️", "Fog"], 48: ["🌫️", "Rime fog"],
  51: ["🌦️", "Light drizzle"], 53: ["🌦️", "Drizzle"], 55: ["🌧️", "Dense drizzle"],
  61: ["🌦️", "Light rain"], 63: ["🌧️", "Rain"], 65: ["🌧️", "Heavy rain"],
  66: ["🌧️", "Freezing rain"], 67: ["🌧️", "Freezing rain"],
  71: ["🌨️", "Light snow"], 73: ["🌨️", "Snow"], 75: ["❄️", "Heavy snow"], 77: ["🌨️", "Snow grains"],
  80: ["🌦️", "Rain showers"], 81: ["🌧️", "Rain showers"], 82: ["⛈️", "Violent showers"],
  85: ["🌨️", "Snow showers"], 86: ["❄️", "Snow showers"],
  95: ["⛈️", "Thunderstorm"], 96: ["⛈️", "Thunderstorm"], 99: ["⛈️", "Thunderstorm"],
};
const wmo = (code) => WMO[code] || ["🌡️", "—"];

// Shared field definitions ----------------------------------
const LOCATION_FIELD = {
  key: "location", type: "location", label: "City",
  help: "Search for your city. Powered by Open-Meteo — no API key needed.", required: true,
};
// opts: { placeholder, help (intro), steps (array of string | {text, link:{label,url}, tail}) }
const urlField = (label, opts = {}) =>
  ({ key: "url", type: "url", label, required: true, ...opts });

// Appearance fields appended to every native widget. Blank = inherit the current theme.
const STYLE_FIELDS = [
  { key: "fg", type: "color", label: "Text colour", placeholder: "blank = theme default" },
  { key: "bg", type: "color", label: "Background", placeholder: "blank = theme default" },
  { key: "scale", type: "number", label: "Text size %", placeholder: "100" },
];
const fieldsFor = (w) => [...(w.fields || []), ...(w.kind === "native" ? STYLE_FIELDS : [])];

// Time/temperature rendering helpers ------------------------
function renderClockBlock(node, tz) {
  const time = qs(".big-time", node), date = qs(".sub-date", node);
  const tick = () => {
    const now = new Date();
    const opt = tz ? { timeZone: tz } : {};
    time.textContent = new Intl.DateTimeFormat("en-GB",
      { ...opt, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    date.textContent = new Intl.DateTimeFormat("en-GB",
      { ...opt, weekday: "long", day: "numeric", month: "long" }).format(now);
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

async function loadCurrentTemp(node, loc) {
  const t = qs(".big-temp", node);
  if (!t) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m`;
    const data = await fetchJSON(url);
    t.textContent = `${Math.round(data.current.temperature_2m)}°C`;
  } catch { t.textContent = "N/A"; }
}

const WIDGETS = [
  {
    id: "clock", label: "Clock", icon: "🕒", kind: "native",
    desc: "A clean digital clock.", fields: [{ ...LOCATION_FIELD, required: false,
      help: "Optional — sets the time zone. Leave empty to use this device's time." }],
    render(node, cfg) {
      node.className = "w";
      node.append(el("div", { className: "stack" },
        el("div", { className: "big-time", textContent: "--:--" }),
        el("div", { className: "sub-date" })));
      return renderClockBlock(node, cfg.location?.timezone);
    },
  },
  {
    id: "clock-temp", label: "Clock + Temp", icon: "🕑", kind: "native",
    desc: "Clock and temperature, side by side.", fields: [LOCATION_FIELD],
    render(node, cfg) {
      node.className = "w w-clock-temp";
      node.append(
        el("div", { className: "stack" },
          el("div", { className: "big-time", textContent: "--:--" }),
          el("div", { className: "sub-date" })),
        el("div", { className: "stack" },
          el("div", { className: "big-temp", textContent: "--°" }),
          el("div", { className: "loc-label", textContent: cfg.location?.label || "" })));
      const stop = renderClockBlock(node, cfg.location?.timezone);
      loadCurrentTemp(node, cfg.location);
      const id = setInterval(() => loadCurrentTemp(node, cfg.location), 600000);
      return () => { stop(); clearInterval(id); };
    },
  },
  {
    id: "temperature", label: "Temperature", icon: "🌡️", kind: "native",
    desc: "Current temperature for a city.", fields: [LOCATION_FIELD],
    render(node, cfg) {
      node.className = "w";
      node.append(el("div", { className: "stack" },
        el("div", { className: "big-temp", textContent: "--°" }),
        el("div", { className: "loc-label", textContent: cfg.location?.label || "" })));
      loadCurrentTemp(node, cfg.location);
      const id = setInterval(() => loadCurrentTemp(node, cfg.location), 600000);
      return () => clearInterval(id);
    },
  },
  {
    id: "weather-today", label: "Weather today", icon: "🌦️", kind: "native",
    desc: "Forecast for the day ahead.", fields: [LOCATION_FIELD],
    render(node, cfg) {
      node.className = "w w-weather";
      node.append(el("div", { className: "w-msg", textContent: "Loading forecast…" }));
      const draw = async () => {
        try {
          const loc = cfg.location;
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
            + `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min`
            + `&hourly=temperature_2m,weather_code&forecast_days=2&timezone=auto`;
          const d = await fetchJSON(url);
          const [icon, desc] = wmo(d.current.weather_code);
          const hiLo = `H ${Math.round(d.daily.temperature_2m_max[0])}°  ·  L ${Math.round(d.daily.temperature_2m_min[0])}°`;
          // pick the upcoming hours (spans past midnight thanks to forecast_days=2)
          const now = new Date();
          const hours = [];
          for (let i = 0; i < d.hourly.time.length && hours.length < 8; i++) {
            const t = new Date(d.hourly.time[i]);
            if (t < now && t.getHours() !== now.getHours()) continue;
            hours.push({ h: t.getHours(), t: d.hourly.temperature_2m[i], c: d.hourly.weather_code[i] });
          }
          node.replaceChildren(
            el("div", { className: "wx-main" },
              el("div", { className: "now" },
                el("div", { className: "icon", textContent: icon }),
                el("div", { className: "t", textContent: `${Math.round(d.current.temperature_2m)}°` })),
              el("div", { className: "desc", textContent: desc }),
              el("div", { className: "loc-label", textContent: loc.label || "" })),
            el("div", { className: "wx-side" },
              el("div", { className: "hilo", textContent: hiLo }),
              el("div", { className: "hours" }, ...hours.map((x) =>
                el("div", { className: "hour" },
                  el("div", { className: "h", textContent: `${String(x.h).padStart(2, "0")}:00` }),
                  el("div", { className: "i", textContent: wmo(x.c)[0] }),
                  el("div", { className: "ht", textContent: `${Math.round(x.t)}°` }))))));
        } catch {
          node.replaceChildren(el("div", { className: "w-msg", textContent: "Couldn't load forecast." }));
        }
      };
      draw();
      const id = setInterval(draw, 900000);
      return () => clearInterval(id);
    },
  },
  {
    id: "photos", label: "Photo slideshow", icon: "🖼️", kind: "native",
    desc: "Rotating images from a folder or URLs.",
    fields: [
      { key: "folder", type: "folder", label: "Local folder",
        help: "Pick a folder on this computer — every image in it rotates. You'll need to re-grant access after restarting the browser." },
      { key: "images", type: "textarea", label: "…or image URLs",
        help: "One image URL per line (used when no folder is chosen).",
        placeholder: "https://example.com/photo1.jpg\nhttps://example.com/photo2.jpg" },
      { key: "interval", type: "number", label: "Seconds per image", help: "Defaults to 8.", placeholder: "8" },
    ],
    render(node, cfg) {
      node.className = "w w-photos";
      let timer;
      const objectUrls = [];
      const cycle = (urls) => {
        if (!urls.length) { node.replaceChildren(el("div", { className: "w-msg", textContent: "No images yet." })); return; }
        const slides = urls.map((u, i) => {
          const s = el("div", { className: "slide" + (i === 0 ? " on" : "") });
          s.style.backgroundImage = `url("${u}")`;
          return s;
        });
        node.replaceChildren(...slides);
        let cur = 0;
        const every = Math.max(2, Number(cfg.interval) || 8) * 1000;
        if (slides.length > 1) timer = setInterval(() => {
          slides[cur].classList.remove("on");
          cur = (cur + 1) % slides.length;
          slides[cur].classList.add("on");
        }, every);
      };
      const collect = async (dir) => {
        const isImg = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
        const urls = [];
        try {
          for await (const entry of dir.values()) {
            if (entry.kind === "file" && isImg.test(entry.name)) {
              const u = URL.createObjectURL(await entry.getFile());
              objectUrls.push(u); urls.push(u);
            }
          }
        } catch { node.replaceChildren(el("div", { className: "w-msg", textContent: "Couldn't read that folder." })); return; }
        cycle(urls.sort());
      };
      const loadFolder = async () => {
        const dir = await idbGet("folder:" + cfg.folderId);
        if (!dir) { node.replaceChildren(el("div", { className: "w-msg", textContent: "Folder unavailable — pick it again in Customize." })); return; }
        const perm = await dir.queryPermission?.({ mode: "read" });
        if (perm === "granted") { collect(dir); return; }
        // Re-granting folder access needs a click (browser security).
        const btn = el("button", { className: "add-source" },
          el("span", { className: "plus", textContent: "🖼️" }),
          el("span", { textContent: `Load photos from “${cfg.folderName || dir.name}”` }));
        btn.addEventListener("click", async () => {
          if (await dir.requestPermission({ mode: "read" }) === "granted") collect(dir);
        });
        node.replaceChildren(el("div", { className: "w-msg" }, btn));
      };
      if (cfg.folderId) { node.append(el("div", { className: "w-msg", textContent: "Loading photos…" })); loadFolder(); }
      else cycle(String(cfg.images || "").split("\n").map((s) => s.trim()).filter(Boolean));
      return () => { clearInterval(timer); objectUrls.forEach((u) => URL.revokeObjectURL(u)); };
    },
  },
  {
    id: "rss", label: "News / RSS", icon: "📰", kind: "native",
    desc: "Headlines from any RSS feed.",
    fields: [urlField("Feed URL", {
      placeholder: "https://www.nrk.no/toppsaker.rss",
      help: "Show headlines from an RSS or Atom feed:",
      steps: [
        "Find a site's feed — often linked in the footer, or try adding /rss or /feed to its address",
        "Paste the feed URL in the box below",
        { text: "Feeds load through a public proxy (", link: { label: "rss2json", url: "https://rss2json.com" }, tail: ") because browsers block direct feed requests" },
      ],
    })],
    render(node, cfg) {
      node.className = "w w-rss";
      const list = el("div", { className: "rss-list" });
      const wrap = el("div", { className: "rss-wrap" },
        el("div", { className: "rss-head" }, "📰 ", el("span", { className: "rss-title", textContent: "Headlines" })),
        list);
      node.append(wrap);
      const draw = async () => {
        try {
          const d = await fetchJSON(RSS_PROXY(cfg.url));
          if (d.feed?.title) qs(".rss-title", wrap).textContent = d.feed.title;
          list.replaceChildren(...(d.items || []).slice(0, 15).map((it) => {
            const a = el("a", { className: "rss-item", href: it.link, target: "_blank", rel: "noreferrer" }, it.title);
            if (it.pubDate) a.append(el("span", { className: "when",
              textContent: new Date(it.pubDate).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }));
            return a;
          }));
          if (!list.children.length) list.append(el("div", { className: "rss-item", textContent: "No items found." }));
        } catch {
          list.replaceChildren(el("div", { className: "rss-item", textContent: "Couldn't load feed (check URL / proxy)." }));
        }
      };
      draw();
      const id = setInterval(draw, 600000);
      return () => clearInterval(id);
    },
  },
  {
    id: "gcal", label: "Google Calendar", icon: "📅", kind: "iframe",
    desc: "Embed a Google Calendar.",
    fields: [urlField("Calendar embed code or URL", {
      placeholder: "<iframe src=\"https://calendar.google.com/calendar/embed?src=…\"></iframe>",
      help: "Embed a Google Calendar:",
      steps: [
        { text: "Open the ", link: { label: "Google Calendar embed helper", url: "https://calendar.google.com/calendar/u/0/embedhelper" } },
        "Pick the calendar(s) and options you want",
        "Copy the “Embed Code” and paste it below — the whole <iframe …> snippet works, or just the src=… URL",
        "Note: plain calendar links can’t be embedded — use the embed code",
      ],
    })],
  },
  {
    id: "entur", label: "Entur board", icon: "🚆", kind: "iframe",
    desc: "Norwegian departures (Entur).",
    fields: [urlField("Entur board URL", {
      placeholder: "https://vis-tavla.entur.no/…",
      help: "Show a Norwegian public-transport board:",
      steps: [
        { text: "Build your board at ", link: { label: "vis-tavla.entur.no", url: "https://vis-tavla.entur.no" } },
        "Add the stops or quays you want to follow",
        "Copy the page URL from your browser’s address bar",
      ],
    })],
  },
  {
    id: "ruter", label: "Ruter departures", icon: "🚌", kind: "iframe",
    desc: "Oslo-area departures (Ruter).",
    fields: [urlField("Ruter URL", {
      placeholder: "https://mon.ruter.no/departures/…",
      help: "Show Oslo-area departures (Ruter):",
      steps: [
        { text: "Open ", link: { label: "mon.ruter.no", url: "https://mon.ruter.no" } },
        "Pick your stop",
        "Copy the page URL from the address bar",
      ],
    })],
  },
  {
    id: "custom-url", label: "Any web page", icon: "🌐", kind: "iframe",
    desc: "Embed any URL you like.",
    fields: [urlField("Page URL", {
      placeholder: "https://…",
      help: "Embed any web page:",
      steps: [
        "Paste any https:// address below",
        "Some sites refuse to be embedded (X-Frame-Options) and will appear blank",
      ],
    })],
  },
];
const getWidget = (id) => WIDGETS.find((w) => w.id === id);

// ============================================================
//  STATE
// ============================================================
const DEFAULT_CONFIG = {
  theme: "light",
  layoutId: "left-stack-3",
  // Remembered city — pre-selected for any new location widget until changed.
  lastLocation: { lat: 59.9139, lon: 10.7522, label: "Oslo, Norway", timezone: "Europe/Oslo" },
  panes: {
    a: { type: "clock-temp", location: { lat: 59.9139, lon: 10.7522, label: "Oslo, Norway", timezone: "Europe/Oslo" } },
    // b left blank by default — shows the "Add source" prompt
    c: { type: "entur", url: "https://vis-tavla.entur.no/CH3rXJu08WM2iRT9nIwN" },
  },
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw);
    if (!parsed.layoutId || !parsed.panes) return structuredClone(DEFAULT_CONFIG);
    return parsed;
  } catch { return structuredClone(DEFAULT_CONFIG); }
}
function saveConfig() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

let state = loadConfig();
// Back-fill the remembered city from any existing pane (for configs saved before this feature).
if (!state.lastLocation) {
  const withLoc = Object.values(state.panes).find((p) => p.location);
  if (withLoc) state.lastLocation = { ...withLoc.location };
}

// ============================================================
//  PANE RENDERING
// ============================================================
const grid = qs("#grid");
const cleanups = new Map(); // slot -> cleanup fn

function applyLayout() {
  const layout = getLayout(state.layoutId);
  grid.style.gridTemplateColumns = layout.columns;
  grid.style.gridTemplateRows = layout.rows;
  grid.style.gridTemplateAreas = layout.areas.map((r) => `"${r}"`).join(" ");

  // tear down old panes
  cleanups.forEach((fn) => fn && fn());
  cleanups.clear();
  grid.replaceChildren();

  for (const slot of layout.slots) {
    const pane = el("div", { className: "pane" });
    pane.dataset.slot = slot;
    pane.style.gridArea = slot;
    const content = el("div", { className: "pane-content" });
    const edit = el("button", { className: "pane-edit chrome", title: "Change source", innerHTML: "&#9998;" });
    edit.addEventListener("click", () => openWidgetMenu(slot));
    pane.append(content, edit);
    grid.append(pane);
    renderPane(slot, content);
  }
}

function applyWidgetStyle(content, cfg) {
  content.style.color = cfg.fg || "";
  content.style.background = cfg.bg || "";
  content.style.setProperty("--wscale", cfg.scale ? Number(cfg.scale) / 100 : 1);
}

function renderPane(slot, content) {
  const prev = cleanups.get(slot);
  if (prev) prev();
  cleanups.delete(slot);
  content.replaceChildren();
  content.className = "pane-content"; // keep a stable class so re-renders/iframes work
  content.style.cssText = "";         // clear any per-widget colour/scale overrides

  const cfg = state.panes[slot];
  const widget = cfg && getWidget(cfg.type);

  if (!widget) {
    const add = el("button", { className: "add-source" },
      el("span", { className: "plus", textContent: "+" }),
      el("span", { textContent: "Add source" }));
    add.addEventListener("click", () => openWidgetMenu(slot));
    content.append(add);
    return;
  }

  if (widget.kind === "iframe") {
    content.append(el("iframe", { src: extractEmbedSrc(cfg.url) || "about:blank", loading: "lazy" }));
    return;
  }
  // Native widget renders into an inner wrapper so `content` keeps its stable class.
  const inner = el("div");
  content.append(inner);
  const cleanup = widget.render(inner, cfg);
  applyWidgetStyle(content, cfg);
  if (cleanup) cleanups.set(slot, cleanup);
}

// Re-render a single slot in place. Finds the content by position (first child),
// not by class — native widgets reuse `content` and its class is stable now anyway.
function rerenderSlot(slot) {
  const pane = grid.querySelector(`.pane[data-slot="${slot}"]`);
  if (pane?.firstElementChild) renderPane(slot, pane.firstElementChild);
}

// ============================================================
//  CHROME: auto-hide + fullscreen
// ============================================================
let idleTimer;
function poke() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // don't hide while a panel/modal is open
    if (qs("#customize").classList.contains("open")) return;
    if (qs("#modal-backdrop").classList.contains("open")) return;
    document.body.classList.add("idle");
  }, 3000);
}
["mousemove", "mousedown", "keydown", "touchstart", "wheel"].forEach((ev) =>
  window.addEventListener(ev, poke, { passive: true }));

qs("#btn-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () =>
  document.body.classList.toggle("is-fullscreen", !!document.fullscreenElement));

// ============================================================
//  CUSTOMIZE PANEL
// ============================================================
const panel = qs("#customize");
qs("#btn-customize").addEventListener("click", () => { buildCustomize(); panel.classList.add("open"); poke(); });
qs("#btn-close-customize").addEventListener("click", () => panel.classList.remove("open"));

// Light / dark theme
function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const toggle = qs("#theme-toggle"); if (toggle) toggle.checked = dark;
  const thumb = qs(".theme-switch .thumb"); if (thumb) thumb.textContent = dark ? "🌙" : "☀️";
}
qs("#theme-toggle").addEventListener("change", (e) => {
  state.theme = e.target.checked ? "dark" : "light";
  saveConfig();
  applyTheme(state.theme);
});

function buildCustomize() {
  // layout thumbnails
  const picker = qs("#layout-picker");
  picker.replaceChildren(...LAYOUTS.map((layout) => {
    const thumb = el("button", { className: "layout-thumb" + (layout.id === state.layoutId ? " active" : ""), title: layout.label });
    thumb.style.gridTemplateColumns = layout.columns;
    thumb.style.gridTemplateRows = layout.rows;
    thumb.style.gridTemplateAreas = layout.areas.map((r) => `"${r}"`).join(" ");
    layout.slots.forEach((s) => {
      const cell = el("div", { className: "cell" });
      cell.style.gridArea = s;
      thumb.append(cell);
    });
    thumb.addEventListener("click", () => {
      state.layoutId = layout.id;
      saveConfig();
      applyLayout();
      buildCustomize();
    });
    return thumb;
  }));

  // frame list
  const list = qs("#frame-list");
  const layout = getLayout(state.layoutId);
  list.replaceChildren(...layout.slots.map((slot, i) => {
    const cfg = state.panes[slot];
    const widget = cfg && getWidget(cfg.type);
    const row = el("div", { className: "frame-row" },
      el("div", { className: "badge", textContent: String(i + 1) }),
      el("div", { className: "meta" },
        el("div", { className: "name", textContent: widget ? widget.label : "Empty" }),
        el("div", { className: "type", textContent: widget ? (cfg.location?.label || cfg.url || widget.desc) : "No source selected" })));
    const btn = el("button", { className: "change", textContent: widget ? "Change" : "Choose" });
    btn.addEventListener("click", () => openWidgetMenu(slot));
    row.append(btn);
    return row;
  }));
}

// ============================================================
//  MODALS: widget menu + config dialog
// ============================================================
const backdrop = qs("#modal-backdrop");
const modal = qs("#modal");
function openModal() { backdrop.classList.add("open"); poke(); }
function closeModal() { backdrop.classList.remove("open"); modal.replaceChildren(); }
backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

function openWidgetMenu(slot) {
  modal.replaceChildren(
    el("h3", {}, "Choose a source"),
    el("div", { className: "modal-sub", textContent: `For frame ${getLayout(state.layoutId).slots.indexOf(slot) + 1}` }),
    el("div", { className: "widget-grid" },
      ...WIDGETS.map((w) => {
        const card = el("button", { className: "widget-card" },
          el("div", { className: "wc-ic", textContent: w.icon }),
          el("div", { className: "wc-name", textContent: w.label }),
          el("div", { className: "wc-desc", textContent: w.desc }));
        card.addEventListener("click", () => chooseWidget(slot, w));
        return card;
      })),
  );
  const actions = el("div", { className: "modal-actions" });
  if (state.panes[slot]) {
    const rm = el("button", { className: "btn btn-danger-ghost", textContent: "Remove source" });
    rm.addEventListener("click", () => {
      delete state.panes[slot];
      saveConfig(); rerenderSlot(slot); buildCustomize(); closeModal();
    });
    actions.append(rm);
  }
  const cancel = el("button", { className: "btn btn-ghost", textContent: "Cancel" });
  cancel.addEventListener("click", closeModal);
  actions.append(cancel);
  modal.append(actions);
  openModal();
}

function chooseWidget(slot, widget) {
  if (!fieldsFor(widget).length) {
    state.panes[slot] = { type: widget.id };
    saveConfig(); rerenderSlot(slot); buildCustomize(); closeModal();
    return;
  }
  openConfigDialog(slot, widget);
}

// Build a field's help block: intro line + bulleted steps with clickable links.
function helpNode(f) {
  const wrap = el("div", { className: "help" });
  if (f.help) wrap.append(el("div", { className: "help-intro", textContent: f.help }));
  if (f.steps?.length) {
    const ul = el("ul", { className: "help-steps" });
    for (const s of f.steps) {
      const li = el("li");
      if (typeof s === "string") {
        li.textContent = s;
      } else {
        if (s.text) li.append(document.createTextNode(s.text));
        if (s.link) li.append(el("a", { href: s.link.url, target: "_blank", rel: "noreferrer", textContent: s.link.label }));
        if (s.tail) li.append(document.createTextNode(s.tail));
      }
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

// Build one form field element from a field definition.
function makeField(f, draft) {
  const field = el("div", { className: "field" });
  field.append(el("label", { textContent: f.label + (f.required ? " *" : "") }));
  if (f.help || f.steps) field.append(helpNode(f));

  if (f.type === "location") {
    buildLocationField(field, draft);
  } else if (f.type === "folder") {
    buildFolderField(field, draft);
  } else if (f.type === "color") {
    buildColorField(field, draft, f);
  } else if (f.type === "textarea") {
    field.append(el("textarea", { value: draft[f.key] || "", placeholder: f.placeholder || "",
      oninput: (e) => { draft[f.key] = e.target.value; } }));
  } else {
    const input = el("input", { type: f.type === "number" ? "number" : (f.type === "url" ? "url" : "text"),
      value: draft[f.key] ?? "", placeholder: f.placeholder || "" });
    input.addEventListener("input", (e) => { draft[f.key] = e.target.value; });
    field.append(input);
  }
  return field;
}

function openConfigDialog(slot, widget) {
  const existing = state.panes[slot]?.type === widget.id ? state.panes[slot] : {};
  const draft = { type: widget.id, ...existing };

  modal.replaceChildren(
    el("h3", {}, `${widget.icon} ${widget.label}`),
    el("div", { className: "modal-sub", textContent: widget.desc }));

  // The widget's own fields first…
  for (const f of (widget.fields || [])) modal.append(makeField(f, draft));
  // …then the appearance settings tucked into a collapsed section.
  if (widget.kind === "native") {
    const body = el("div", { className: "appearance-body" });
    for (const f of STYLE_FIELDS) body.append(makeField(f, draft));
    modal.append(el("details", { className: "appearance" }, el("summary", {}, "Appearance"), body));
  }

  const actions = el("div", { className: "modal-actions" });
  const cancel = el("button", { className: "btn btn-ghost", textContent: "Cancel" });
  cancel.addEventListener("click", () => openWidgetMenu(slot));
  const save = el("button", { className: "btn btn-primary", textContent: "Save" });
  save.addEventListener("click", () => {
    // validate required fields
    for (const f of fieldsFor(widget)) {
      if (f.required && !draft[f.key]) { alert(`Please provide: ${f.label}`); return; }
    }
    state.panes[slot] = draft;
    saveConfig(); rerenderSlot(slot); buildCustomize(); closeModal();
  });
  actions.append(cancel, save);
  modal.append(actions);
  openModal();
}

// Local-folder picker (File System Access API) ----------------
function buildFolderField(field, draft) {
  const status = el("div", { className: "loc-chosen", textContent: draft.folderName ? `✓ ${draft.folderName}` : "" });
  const btn = el("button", { type: "button", className: "btn btn-ghost folder-btn", textContent: draft.folderName ? "Change folder…" : "Choose folder…" });
  if (!("showDirectoryPicker" in window)) {
    btn.disabled = true;
    // Figure out *why* it's unavailable so the message is actionable.
    let reason;
    if (window.self !== window.top) {
      reason = "The folder picker is blocked because this page is running inside an embedded preview pane. "
        + "Open it in a normal browser tab — go to " + location.origin + " directly — then it'll work.";
    } else if (location.protocol === "file:") {
      reason = "The folder picker needs the page served over http(s), not opened as a file:// path. "
        + "Run a local server (e.g. `python3 -m http.server`) and reload.";
    } else if (!window.isSecureContext) {
      reason = "The folder picker needs a secure context (https, or http://localhost). Reload over one of those.";
    } else {
      reason = "This browser can't open local folders (needs a Chromium browser like Chrome or Edge). Use image URLs below instead.";
    }
    field.append(btn, el("div", { className: "help", textContent: reason }));
    return;
  }
  btn.addEventListener("click", async () => {
    try {
      const dir = await window.showDirectoryPicker();
      const id = draft.folderId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      await idbSet("folder:" + id, dir);
      draft.folderId = id; draft.folderName = dir.name;
      status.textContent = `✓ ${dir.name}`;
      btn.textContent = "Change folder…";
    } catch { /* picker cancelled */ }
  });
  const clear = el("button", { type: "button", className: "btn btn-ghost", textContent: "Clear" });
  clear.addEventListener("click", () => { draft.folderId = ""; draft.folderName = ""; status.textContent = ""; btn.textContent = "Choose folder…"; });
  field.append(el("div", { className: "loc-search" }, btn, clear), status);
}

// Colour field: optional text value, with a native colour swatch that fills it.
function buildColorField(field, draft, f) {
  const row = el("div", { className: "loc-search" });
  const text = el("input", { type: "text", value: draft[f.key] ?? "", placeholder: f.placeholder || "" });
  const swatch = el("input", { type: "color", className: "color-swatch", value: /^#[0-9a-f]{6}$/i.test(draft[f.key] || "") ? draft[f.key] : "#000000" });
  text.addEventListener("input", (e) => { draft[f.key] = e.target.value.trim(); });
  swatch.addEventListener("input", (e) => { draft[f.key] = e.target.value; text.value = e.target.value; });
  row.append(text, swatch);
  field.append(row);
}

// Location search field (Open-Meteo geocoding) ----------------
function buildLocationField(field, draft) {
  // Default to the last city the user picked, until they choose a different one here.
  if (!draft.location && state.lastLocation) draft.location = { ...state.lastLocation };
  const search = el("div", { className: "loc-search" });
  const input = el("input", { type: "text", placeholder: "e.g. Oslo" });
  const go = el("button", { type: "button", textContent: "Search" });
  search.append(input, go);
  const results = el("div", { className: "loc-results" });
  const chosen = el("div", { className: "loc-chosen", textContent: draft.location ? `✓ ${draft.location.label}` : "" });
  field.append(search, results, chosen);

  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.replaceChildren(el("button", { type: "button", disabled: true, textContent: "Searching…" }));
    try {
      const d = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6`);
      const items = d.results || [];
      if (!items.length) { results.replaceChildren(el("button", { type: "button", disabled: true, textContent: "No matches." })); return; }
      results.replaceChildren(...items.map((r) => {
        const label = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
        const b = el("button", { type: "button", textContent: label });
        b.addEventListener("click", () => {
          draft.location = { lat: r.latitude, lon: r.longitude, label, timezone: r.timezone };
          state.lastLocation = { ...draft.location }; // remember for future location widgets
          saveConfig();
          chosen.textContent = `✓ ${label}`;
          results.replaceChildren();
        });
        return b;
      }));
    } catch {
      results.replaceChildren(el("button", { type: "button", disabled: true, textContent: "Search failed." }));
    }
  };
  go.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
}

// ============================================================
//  INIT
// ============================================================
applyTheme(state.theme);
applyLayout();
poke();
