let csrfToken = '';
let map;
let marker;
let searchDebounceTimer;
let markersLayer;
const markerById = new Map();
let selectedDatacenterId = null;

const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const loginForm = document.getElementById('login-form');
const loginMessage = document.getElementById('login-message');
const userLabel = document.getElementById('user-label');
const logoutBtn = document.getElementById('logout-btn');
const importForm = document.getElementById('import-form');
const importMessage = document.getElementById('import-message');
const searchForm = document.getElementById('search-form');
const resultsEl = document.getElementById('results');
const statTotalEl = document.getElementById('stat-total');
const statWithCityEl = document.getElementById('stat-with-city');
const statWithDistrictEl = document.getElementById('stat-with-district');
const statFilteredEl = document.getElementById('stat-filtered');

setupTabs();
initMap();
bootstrap();

async function bootstrap() {
  try {
    const meResp = await fetch('/api/me');
    if (!meResp.ok) {
      showLogin();
      return;
    }

    const me = await meResp.json();
    const csrfResp = await fetch('/api/csrf');
    const csrfData = await csrfResp.json();
    csrfToken = csrfData.csrfToken || '';

    showDashboard(me.email);
    await loadStats();
    await runSearch();
  } catch {
    showLogin();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMessage.textContent = 'Autenticando...';

  const formData = new FormData(loginForm);
  const payload = {
    email: String(formData.get('email') || ''),
    password: String(formData.get('password') || ''),
  };

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      loginMessage.textContent = data.error || 'Falha no login';
      return;
    }

    csrfToken = data.csrfToken || '';
    showDashboard(payload.email);
    loginMessage.textContent = '';
    loginForm.reset();
    await loadStats();
    await runSearch();
  } catch {
    loginMessage.textContent = 'Erro de rede no login';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
    });
  } finally {
    csrfToken = '';
    showLogin();
  }
});

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  importMessage.textContent = 'Importando...';

  const formData = new FormData(importForm);
  const mode = String(formData.get('mode') || 'skip_existing');

  if (mode === 'overwrite') {
    const ok = window.confirm('Isto vai apagar os dados atuais e importar os novos. Deseja continuar?');
    if (!ok) {
      importMessage.textContent = 'Importação cancelada.';
      return;
    }
  }

  try {
    const resp = await fetch('/api/import', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: formData,
    });

    const data = await resp.json();
    if (!resp.ok) {
      importMessage.textContent = data.error || 'Falha na importação';
      return;
    }

    importMessage.textContent = `Importado com sucesso. Total no arquivo: ${data.totalPointsInFile}, inseridos: ${data.imported}, ignorados: ${data.ignored}.`;
    selectedDatacenterId = null;
    await loadStats();
    await runSearch();
  } catch {
    importMessage.textContent = 'Erro de rede na importação';
  }
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runSearch();
});

searchForm.addEventListener('keyup', (event) => {
  const target = event.target;
  if (!target || !target.name) return;

  if (['q', 'city', 'district'].includes(target.name)) {
    scheduleSearch();
  }
});

function scheduleSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    runSearch().catch(() => {
      resultsEl.innerHTML = '<li>Erro ao pesquisar.</li>';
    });
  }, 250);
}

async function runSearch() {
  const formData = new FormData(searchForm);
  const q = encodeURIComponent(String(formData.get('q') || '').trim());
  const city = encodeURIComponent(String(formData.get('city') || '').trim());
  const district = encodeURIComponent(String(formData.get('district') || '').trim());

  const url = `/api/datacenters?q=${q}&city=${city}&district=${district}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!resp.ok) {
    resultsEl.innerHTML = `<li>Erro: ${data.error || 'falha na busca'}</li>`;
    updateFilteredStat(0);
    renderMapMarkers([]);
    return;
  }

  const items = data.items || [];
  updateFilteredStat(items.length);
  renderResults(items);
  renderMapMarkers(items);
}

function renderResults(items) {
  if (items.length === 0) {
    resultsEl.innerHTML = '<li>Nenhum datacenter encontrado.</li>';
    return;
  }

  resultsEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.id = String(item.id);
    li.innerHTML = `
      <strong>${escapeHtml(item.name)}</strong><br/>
      <small>${escapeHtml(item.city || '-')}, ${escapeHtml(item.district || '-')}</small><br/>
      <small>Lat: ${Number(item.latitude).toFixed(6)} | Lng: ${Number(item.longitude).toFixed(6)}</small>
    `;

    if (selectedDatacenterId === item.id) {
      li.classList.add('active');
    }

    li.addEventListener('click', () => {
      selectedDatacenterId = item.id;
      selectResultItem(item.id);
      focusMap(item.id, item.latitude, item.longitude, item.name);
    });

    resultsEl.appendChild(li);
  }
}

function initMap() {
  map = L.map('map').setView([-14.235, -51.9253], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function focusMap(id, lat, lng, label) {
  const latitude = Number(lat);
  const longitude = Number(lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }

  map.setView([latitude, longitude], 14);

  const existing = markerById.get(id);
  if (existing) {
    existing.openPopup();
    if (marker) {
      marker.remove();
      marker = null;
    }
    return;
  }

  if (marker) {
    marker.remove();
  }

  marker = L.marker([latitude, longitude]).addTo(map);
  marker.bindPopup(`<strong>${escapeHtml(label || 'Datacenter')}</strong>`).openPopup();
}

function renderMapMarkers(items) {
  if (!markersLayer) return;

  markersLayer.clearLayers();
  markerById.clear();

  if (items.length === 0) {
    map.setView([-14.235, -51.9253], 4);
    return;
  }

  const bounds = [];

  for (const item of items) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const mk = L.marker([latitude, longitude]);
    mk.bindPopup(`<strong>${escapeHtml(item.name || 'Datacenter')}</strong>`);
    mk.on('click', () => {
      selectedDatacenterId = item.id;
      selectResultItem(item.id);
    });
    mk.addTo(markersLayer);
    markerById.set(item.id, mk);
    bounds.push([latitude, longitude]);
  }

  if (selectedDatacenterId && markerById.has(selectedDatacenterId)) {
    const selected = items.find((x) => x.id === selectedDatacenterId);
    if (selected) {
      focusMap(selected.id, selected.latitude, selected.longitude, selected.name);
      return;
    }
  }

  selectedDatacenterId = null;
  if (marker) {
    marker.remove();
    marker = null;
  }

  if (bounds.length === 1) {
    map.setView(bounds[0], 12);
  } else if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
  }
}

async function loadStats() {
  try {
    const resp = await fetch('/api/datacenters/stats');
    if (!resp.ok) return;
    const stats = await resp.json();
    statTotalEl.textContent = String(stats.total || 0);
    statWithCityEl.textContent = String(stats.with_city || 0);
    statWithDistrictEl.textContent = String(stats.with_district || 0);
  } catch {
    // silencia erro de stats e mantém a tela funcional
  }
}

function updateFilteredStat(count) {
  statFilteredEl.textContent = String(count || 0);
}

function selectResultItem(id) {
  const items = resultsEl.querySelectorAll('li');
  for (const li of items) {
    li.classList.toggle('active', li.dataset.id === String(id));
  }
}

function setupTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');

  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const b of buttons) b.classList.remove('active');
      for (const c of contents) c.classList.remove('active');

      button.classList.add('active');
      const targetId = button.getAttribute('data-tab');
      const target = document.getElementById(targetId);
      if (target) target.classList.add('active');

      if (targetId === 'search-tab') {
        setTimeout(() => map.invalidateSize(), 80);
      }
    });
  }
}

function showLogin() {
  loginSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');
}

function showDashboard(email) {
  userLabel.textContent = `Logado como ${email}`;
  loginSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');
  setTimeout(() => map.invalidateSize(), 120);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
