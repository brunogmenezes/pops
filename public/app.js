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
const importSection = document.getElementById('import-section');
const importSectionDivider = document.getElementById('import-section-divider');
const manualForm = document.getElementById('manual-form');
const manualMessage = document.getElementById('manual-message');
const manualSection = document.getElementById('manual-section');
const addDatacenterPermissionMessage = document.getElementById('add-datacenter-permission-message');
const searchForm = document.getElementById('search-form');
const resultsEl = document.getElementById('results');
const statTotalEl = document.getElementById('stat-total');
const statWithCityEl = document.getElementById('stat-with-city');
const statWithDistrictEl = document.getElementById('stat-with-district');
const statFilteredEl = document.getElementById('stat-filtered');
const themeSelect = document.getElementById('theme-select');
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editMessage = document.getElementById('edit-message');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const editNameInput = document.getElementById('edit-name');
const editCityInput = document.getElementById('edit-city');
const editDistrictInput = document.getElementById('edit-district');
const editLatitudeInput = document.getElementById('edit-latitude');
const editLongitudeInput = document.getElementById('edit-longitude');
const userEditModal = document.getElementById('user-edit-modal');
const userEditForm = document.getElementById('user-edit-form');
const userEditUsernameInput = document.getElementById('user-edit-username');
const userEditEmailInput = document.getElementById('user-edit-email');
const userEditGroupSelect = document.getElementById('user-edit-group');
const userEditPasswordInput = document.getElementById('user-edit-password');
const userEditMessage = document.getElementById('user-edit-message');
const userEditCancelBtn = document.getElementById('user-edit-cancel-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmModalDescription = document.getElementById('confirm-modal-description');
const confirmMessage = document.getElementById('confirm-message');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmSubmitBtn = document.getElementById('confirm-submit-btn');
const adminTabButton = document.getElementById('admin-tab-btn');
const adminTab = document.getElementById('admin-tab');
const adminSection = document.getElementById('admin-section');
const groupForm = document.getElementById('group-form');
const groupNameInput = document.getElementById('group-name');
const groupCancelEditBtn = document.getElementById('group-cancel-edit-btn');
const groupMessage = document.getElementById('group-message');
const groupList = document.getElementById('group-list');
const userForm = document.getElementById('user-form');
const userMessage = document.getElementById('user-message');
const userGroupSelect = document.getElementById('new-user-group');
const addDatacenterTabButton = document.querySelector('.tab-btn[data-tab="import-tab"]');

let currentUserEmail = '';
let editingDatacenterId = null;
let editingGroupId = null;
let editingUserId = null;
let pendingDeleteUser = null;
let currentIsAdmin = false;
let currentPermissions = getDefaultPermissions();
let availableGroups = [];

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
    currentUserEmail = me.email || '';
    setAccessContext(me);
    const initialTheme = getPreferredTheme(currentUserEmail, me.themePreference);
    applyTheme(initialTheme);

    showDashboard(me.email);
    await loadAdminGroups();
    await loadAdminUsers();
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
    username: String(formData.get('username') || ''),
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
    currentUserEmail = data.email || '';
    setAccessContext(data);
    const initialTheme = getPreferredTheme(currentUserEmail, data.themePreference);
    applyTheme(initialTheme);
    showDashboard(data.email);
    loginMessage.textContent = '';
    loginForm.reset();
    await loadAdminGroups();
    await loadAdminUsers();
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
    currentUserEmail = '';
    currentIsAdmin = false;
    currentPermissions = getDefaultPermissions();
    availableGroups = [];
    showLogin();
  }
});

themeSelect.addEventListener('change', async (event) => {
  const theme = String(event.target.value || '').toLowerCase();
  if (!['light', 'dark'].includes(theme)) {
    return;
  }

  applyTheme(theme);
  if (currentUserEmail) {
    localStorage.setItem(getThemeStorageKey(currentUserEmail), theme);
  }

  if (!csrfToken) {
    return;
  }

  try {
    const resp = await fetch('/api/preferences/theme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ theme }),
    });

    if (!resp.ok) {
      return;
    }

    const data = await resp.json();
    const savedTheme = String(data.themePreference || theme).toLowerCase();
    applyTheme(savedTheme);
    if (currentUserEmail) {
      localStorage.setItem(getThemeStorageKey(currentUserEmail), savedTheme);
    }
  } catch {
    // mantém fallback local
  }
});

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!currentPermissions.canImport && !currentIsAdmin) {
    importMessage.textContent = 'Seu usuário não tem permissão para importar dados.';
    return;
  }

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

manualForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!currentPermissions.canCreate && !currentIsAdmin) {
    manualMessage.textContent = 'Seu usuário não tem permissão para inserir datacenter.';
    return;
  }

  manualMessage.textContent = 'Salvando...';

  const formData = new FormData(manualForm);
  const payload = {
    name: String(formData.get('name') || '').trim(),
    city: String(formData.get('city') || '').trim(),
    district: String(formData.get('district') || '').trim(),
    latitude: String(formData.get('latitude') || '').trim(),
    longitude: String(formData.get('longitude') || '').trim(),
  };

  try {
    const resp = await fetch('/api/datacenters', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      manualMessage.textContent = data.error || 'Falha ao cadastrar datacenter';
      return;
    }

    manualMessage.textContent = 'Datacenter cadastrado com sucesso.';
    manualForm.reset();
    selectedDatacenterId = data.item?.id || null;
    await loadStats();
    await runSearch();
  } catch {
    manualMessage.textContent = 'Erro de rede ao cadastrar datacenter';
  }
});

groupForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const isEditing = Number.isInteger(editingGroupId) && editingGroupId > 0;
  groupMessage.textContent = isEditing ? 'Salvando alterações do grupo...' : 'Criando grupo...';

  const formData = new FormData(groupForm);
  const payload = {
    name: String(formData.get('name') || '').trim(),
    canImport: formData.get('canImport') !== null,
    canCreate: formData.get('canCreate') !== null,
    canEdit: formData.get('canEdit') !== null,
    canDelete: formData.get('canDelete') !== null,
  };

  try {
    const targetUrl = isEditing ? `/api/admin/groups/${editingGroupId}` : '/api/admin/groups';
    const targetMethod = isEditing ? 'PUT' : 'POST';

    const resp = await fetch(targetUrl, {
      method: targetMethod,
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      groupMessage.textContent = data.error || 'Falha ao criar grupo';
      return;
    }

    groupMessage.textContent = isEditing ? 'Grupo atualizado com sucesso.' : 'Grupo criado com sucesso.';
    resetGroupFormMode();
    await loadAdminGroups();
    await loadAdminUsers();
  } catch {
    groupMessage.textContent = isEditing ? 'Erro de rede ao editar grupo' : 'Erro de rede ao criar grupo';
  }
});

groupCancelEditBtn?.addEventListener('click', () => {
  resetGroupFormMode();
  groupMessage.textContent = 'Edição de grupo cancelada.';
});

userForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  userMessage.textContent = 'Criando usuário...';

  const formData = new FormData(userForm);
  const payload = {
    username: String(formData.get('username') || '').trim().toLowerCase(),
    email: String(formData.get('email') || '').trim().toLowerCase(),
    password: String(formData.get('password') || ''),
    groupId: Number(formData.get('groupId')),
  };

  if (!payload.username) {
    userMessage.textContent = 'Usuário é obrigatório';
    return;
  }

  try {
    const resp = await fetch('/api/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      userMessage.textContent = data.error || 'Falha ao criar usuário';
      return;
    }

    userMessage.textContent = 'Usuário criado com sucesso.';
    userForm.reset();
    await loadAdminUsers();
  } catch {
    userMessage.textContent = 'Erro de rede ao criar usuário';
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
  const canEdit = currentIsAdmin || currentPermissions.canEdit;
  const canDelete = currentIsAdmin || currentPermissions.canDelete;
  const canShowActions = canEdit || canDelete;

  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.id = String(item.id);
    li.innerHTML = `
      <div class="result-top-row">
        <strong>${escapeHtml(item.name)}</strong>
        ${
          canShowActions
            ? `<div class="result-actions">
                ${
                  canEdit
                    ? '<button type="button" class="icon-btn edit-btn" title="Editar" aria-label="Editar datacenter">✏️</button>'
                    : ''
                }
                ${
                  canDelete
                    ? '<button type="button" class="icon-btn delete-btn" title="Excluir" aria-label="Excluir datacenter">🗑️</button>'
                    : ''
                }
              </div>`
            : ''
        }
      </div>
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

    const editBtn = li.querySelector('.edit-btn');
    const deleteBtn = li.querySelector('.delete-btn');

    editBtn?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!canEdit) return;
      openEditModal(item);
    });

    deleteBtn?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!canDelete) return;
      await deleteDatacenter(item);
    });

    resultsEl.appendChild(li);
  }
}

function openEditModal(item) {
  if (!currentIsAdmin && !currentPermissions.canEdit) {
    return;
  }

  editingDatacenterId = item.id;
  editNameInput.value = item.name || '';
  editCityInput.value = item.city || '';
  editDistrictInput.value = item.district || '';
  editLatitudeInput.value = String(item.latitude ?? '');
  editLongitudeInput.value = String(item.longitude ?? '');
  editMessage.textContent = '';
  editModal.classList.remove('hidden');
}

function closeEditModal() {
  editModal.classList.add('hidden');
  editMessage.textContent = '';
  editingDatacenterId = null;
}

editCancelBtn.addEventListener('click', () => {
  closeEditModal();
});

editModal.addEventListener('click', (event) => {
  if (event.target === editModal) {
    closeEditModal();
  }
});

userEditCancelBtn?.addEventListener('click', () => {
  closeUserEditModal();
});

userEditModal?.addEventListener('click', (event) => {
  if (event.target === userEditModal) {
    closeUserEditModal();
  }
});

confirmCancelBtn?.addEventListener('click', () => {
  closeConfirmModal();
});

confirmModal?.addEventListener('click', (event) => {
  if (event.target === confirmModal) {
    closeConfirmModal();
  }
});

confirmSubmitBtn?.addEventListener('click', async () => {
  await confirmUserDeletion();
});

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!currentIsAdmin && !currentPermissions.canEdit) {
    editMessage.textContent = 'Seu usuário não tem permissão para editar datacenter.';
    return;
  }

  if (!editingDatacenterId) {
    closeEditModal();
    return;
  }

  editMessage.textContent = 'Salvando...';

  try {
    const resp = await fetch(`/api/datacenters/${editingDatacenterId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        name: editNameInput.value.trim(),
        city: editCityInput.value.trim(),
        district: editDistrictInput.value.trim(),
        latitude: editLatitudeInput.value.trim(),
        longitude: editLongitudeInput.value.trim(),
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      editMessage.textContent = data.error || 'Falha ao editar datacenter';
      return;
    }

    selectedDatacenterId = data.item?.id || editingDatacenterId;
    closeEditModal();
    await loadStats();
    await runSearch();
  } catch {
    editMessage.textContent = 'Erro de rede ao editar datacenter';
  }
});

async function deleteDatacenter(item) {
  if (!currentIsAdmin && !currentPermissions.canDelete) {
    alert('Seu usuário não tem permissão para excluir datacenter.');
    return;
  }

  const ok = confirm(`Deseja excluir o datacenter "${item.name}"?`);
  if (!ok) return;

  try {
    const resp = await fetch(`/api/datacenters/${item.id}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfToken },
    });

    const data = await resp.json();
    if (!resp.ok) {
      alert(data.error || 'Falha ao excluir datacenter');
      return;
    }

    if (selectedDatacenterId === item.id) {
      selectedDatacenterId = null;
    }

    await loadStats();
    await runSearch();
  } catch {
    alert('Erro de rede ao excluir datacenter');
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

function setAccessContext(data) {
  currentIsAdmin = Boolean(data?.isAdmin);
  const incoming = data?.permissions || {};
  currentPermissions = {
    canImport: Boolean(incoming.canImport),
    canCreate: Boolean(incoming.canCreate),
    canEdit: Boolean(incoming.canEdit),
    canDelete: Boolean(incoming.canDelete),
  };
  applyFeatureVisibility();
}

function applyFeatureVisibility() {
  const canImport = currentIsAdmin || currentPermissions.canImport;
  const canCreate = currentIsAdmin || currentPermissions.canCreate;
  const canAddDatacenter = currentIsAdmin || canImport || canCreate;

  if (manualSection) manualSection.classList.toggle('hidden', !canCreate);
  if (importSection) importSection.classList.toggle('hidden', !canImport);

  const showImportDivider = canCreate && canImport;
  if (importSectionDivider) importSectionDivider.classList.toggle('hidden', !showImportDivider);

  if (addDatacenterPermissionMessage) {
    addDatacenterPermissionMessage.classList.toggle('hidden', canAddDatacenter);
  }

  if (addDatacenterTabButton) {
    addDatacenterTabButton.classList.toggle('hidden', !canAddDatacenter && !currentIsAdmin);
  }

  if (adminSection) adminSection.classList.toggle('hidden', !currentIsAdmin);
  if (adminTabButton) adminTabButton.classList.toggle('hidden', !currentIsAdmin);
  if (adminTab) adminTab.classList.toggle('hidden', !currentIsAdmin);

  const activeTabButton = document.querySelector('.tab-btn.active');
  const activeTabId = activeTabButton?.getAttribute('data-tab');
  if ((!canAddDatacenter && activeTabId === 'import-tab') || (!currentIsAdmin && activeTabId === 'admin-tab')) {
    const searchBtn = document.querySelector('.tab-btn[data-tab="search-tab"]');
    searchBtn?.click();
  }
}

async function loadAdminGroups() {
  if (!currentIsAdmin) {
    availableGroups = [];
    renderGroupOptions([]);
    renderGroupList([]);
    return;
  }

  try {
    const resp = await fetch('/api/admin/groups');
    const data = await resp.json();
    if (!resp.ok) {
      groupMessage.textContent = data.error || 'Falha ao carregar grupos';
      return;
    }

    availableGroups = Array.isArray(data.items) ? data.items : [];
    renderGroupOptions(availableGroups);
    renderGroupList(availableGroups);
  } catch {
    groupMessage.textContent = 'Erro de rede ao carregar grupos';
  }
}

function renderGroupOptions(groups) {
  populateGroupSelect(userGroupSelect, groups, 'Selecione um grupo');
  populateGroupSelect(userEditGroupSelect, groups, 'Sem grupo');
}

function populateGroupSelect(selectEl, groups, placeholder) {
  if (!selectEl) return;

  selectEl.innerHTML = '';

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholder;
  selectEl.appendChild(placeholderOption);

  for (const group of groups) {
    const option = document.createElement('option');
    option.value = String(group.id);
    option.textContent = String(group.name || `Grupo ${group.id}`);
    selectEl.appendChild(option);
  }
}

function renderGroupList(groups) {
  if (!groupList) return;

  if (!groups.length) {
    groupList.innerHTML = '<li>Nenhum grupo cadastrado.</li>';
    return;
  }

  groupList.innerHTML = '';
  for (const group of groups) {
    const li = document.createElement('li');
    const parts = [];
    if (group.can_import) parts.push('Importar');
    if (group.can_create) parts.push('Inserir');
    if (group.can_edit) parts.push('Editar');
    if (group.can_delete) parts.push('Excluir');

    const usersCount = Number(group.users_count || 0);
    const permissionsLabel = parts.length ? parts.join(', ') : 'sem permissões';

    li.innerHTML = `
      <div class="group-row">
        <div>
          <strong>${escapeHtml(group.name)}</strong>
          <small>${escapeHtml(permissionsLabel)} | usuários: ${usersCount}</small>
        </div>
        <div class="group-actions">
          <button type="button" class="icon-btn" data-action="edit" title="Editar grupo" aria-label="Editar grupo">✏️</button>
          <button
            type="button"
            class="icon-btn"
            data-action="delete"
            title="Excluir grupo"
            aria-label="Excluir grupo"
            ${usersCount > 0 ? 'disabled' : ''}
          >🗑️</button>
        </div>
      </div>
    `;

    const editBtn = li.querySelector('button[data-action="edit"]');
    const deleteBtn = li.querySelector('button[data-action="delete"]');

    editBtn?.addEventListener('click', async () => {
      startGroupEdit(group);
    });

    deleteBtn?.addEventListener('click', async () => {
      await deleteGroup(group);
    });

    groupList.appendChild(li);
  }
}

function startGroupEdit(group) {
  if (!groupForm) return;

  editingGroupId = Number(group.id);
  groupNameInput.value = String(group.name || '');

  const canImportEl = groupForm.querySelector('input[name="canImport"]');
  const canCreateEl = groupForm.querySelector('input[name="canCreate"]');
  const canEditEl = groupForm.querySelector('input[name="canEdit"]');
  const canDeleteEl = groupForm.querySelector('input[name="canDelete"]');

  if (canImportEl) canImportEl.checked = Boolean(group.can_import);
  if (canCreateEl) canCreateEl.checked = Boolean(group.can_create);
  if (canEditEl) canEditEl.checked = Boolean(group.can_edit);
  if (canDeleteEl) canDeleteEl.checked = Boolean(group.can_delete);

  const submitBtn = groupForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = 'Salvar alterações';
  if (groupCancelEditBtn) groupCancelEditBtn.classList.remove('hidden');

  groupMessage.textContent = `Editando grupo: ${group.name}`;
  groupNameInput.focus();
}

function resetGroupFormMode() {
  editingGroupId = null;
  groupForm?.reset();

  const submitBtn = groupForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = 'Criar grupo';

  if (groupCancelEditBtn) groupCancelEditBtn.classList.add('hidden');
}

async function deleteGroup(group) {
  const usersCount = Number(group.users_count || 0);
  if (usersCount > 0) {
    groupMessage.textContent = 'Não é possível excluir: há usuários associados a este grupo.';
    return;
  }

  const ok = confirm(`Deseja excluir o grupo "${group.name}"?`);
  if (!ok) return;

  groupMessage.textContent = 'Excluindo grupo...';

  try {
    const resp = await fetch(`/api/admin/groups/${group.id}`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': csrfToken,
      },
    });

    const data = await resp.json();
    if (!resp.ok) {
      groupMessage.textContent = data.error || 'Falha ao excluir grupo';
      return;
    }

    groupMessage.textContent = 'Grupo excluído com sucesso.';
    await loadAdminGroups();
    await loadAdminUsers();
  } catch {
    groupMessage.textContent = 'Erro de rede ao excluir grupo';
  }
}

async function loadAdminUsers() {
  if (!currentIsAdmin) {
    renderUserList([]);
    return;
  }

  try {
    const resp = await fetch('/api/admin/users');
    const data = await resp.json();
    if (!resp.ok) {
      const userListMessage = document.getElementById('user-list-message');
      if (userListMessage) userListMessage.textContent = data.error || 'Falha ao carregar usuários';
      return;
    }

    const users = Array.isArray(data.items) ? data.items : [];
    renderUserList(users);
  } catch {
    const userListMessage = document.getElementById('user-list-message');
    if (userListMessage) userListMessage.textContent = 'Erro de rede ao carregar usuários';
  }
}

function renderUserList(users) {
  const userList = document.getElementById('user-list');
  const userListMessage = document.getElementById('user-list-message');
  if (!userList) return;

  if (!users.length) {
    userList.innerHTML = '<li>Nenhum usuário cadastrado.</li>';
    if (userListMessage) userListMessage.textContent = '';
    return;
  }

  userList.innerHTML = '';
  for (const user of users) {
    const li = document.createElement('li');
    const groupName = String(user.group_name || 'Sem grupo');
    const email = user.email ? `${escapeHtml(user.email)}` : '';
    
    li.innerHTML = `
      <div class="group-row">
        <div>
          <strong>${escapeHtml(user.username)}</strong>
          <small>Grupo: ${escapeHtml(groupName)}${user.is_admin ? ' | Admin' : ''}${email ? ' | ' + email : ''}</small>
        </div>
        <div class="group-actions">
          <button type="button" class="icon-btn" data-action="edit" data-user-id="${user.id}" title="Editar usuário" aria-label="Editar usuário">✏️</button>
          <button type="button" class="icon-btn" data-action="delete" data-user-id="${user.id}" title="Excluir usuário" aria-label="Excluir usuário">🗑️</button>
        </div>
      </div>
    `;

    const editBtn = li.querySelector('button[data-action="edit"]');
    const deleteBtn = li.querySelector('button[data-action="delete"]');

    editBtn?.addEventListener('click', () => {
      openUserEditModal(user);
    });

    deleteBtn?.addEventListener('click', () => {
      openDeleteUserModal(user);
    });

    userList.appendChild(li);
  }
  
  if (userListMessage) userListMessage.textContent = '';
}

function openUserEditModal(user) {
  editingUserId = Number(user.id);
  userEditUsernameInput.value = String(user.username || '');
  userEditEmailInput.value = String(user.email || '');
  userEditGroupSelect.value = user.group_id ? String(user.group_id) : '';
  userEditPasswordInput.value = '';
  setMessage(userEditMessage, '', 'default');
  userEditModal?.classList.remove('hidden');
  userEditUsernameInput.focus();
}

function closeUserEditModal() {
  editingUserId = null;
  userEditForm?.reset();
  setMessage(userEditMessage, '', 'default');
  userEditModal?.classList.add('hidden');
}

function openDeleteUserModal(user) {
  pendingDeleteUser = user;
  if (confirmModalDescription) {
    confirmModalDescription.textContent = `Você está prestes a excluir o usuário ${user.username}.`;
  }
  setMessage(confirmMessage, '', 'default');
  confirmSubmitBtn?.removeAttribute('disabled');
  confirmModal?.classList.remove('hidden');
}

function closeConfirmModal() {
  pendingDeleteUser = null;
  setMessage(confirmMessage, '', 'default');
  confirmSubmitBtn?.removeAttribute('disabled');
  confirmModal?.classList.add('hidden');
}

userEditForm?.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!editingUserId) {
    closeUserEditModal();
    return;
  }

  const payload = {
    username: userEditUsernameInput.value.trim().toLowerCase(),
    email: userEditEmailInput.value.trim().toLowerCase(),
    groupId: userEditGroupSelect.value,
    password: userEditPasswordInput.value,
  };

  if (!payload.username) {
    setMessage(userEditMessage, 'Usuário é obrigatório.', 'danger');
    return;
  }

  if (payload.password && payload.password.length < 8) {
    setMessage(userEditMessage, 'A senha deve ter pelo menos 8 caracteres.', 'danger');
    return;
  }

  setMessage(userEditMessage, 'Salvando alterações...', 'default');

  try {
    const resp = await fetch(`/api/admin/users/${editingUserId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      setMessage(userEditMessage, data.error || 'Falha ao atualizar usuário.', 'danger');
      return;
    }

    closeUserEditModal();
    setUserListMessage('Usuário atualizado com sucesso.', 'success');
    await loadAdminUsers();
  } catch {
    setMessage(userEditMessage, 'Erro de rede ao atualizar usuário.', 'danger');
  }
});

async function confirmUserDeletion() {
  if (!pendingDeleteUser) {
    closeConfirmModal();
    return;
  }

  setMessage(confirmMessage, 'Excluindo usuário...', 'default');
  confirmSubmitBtn?.setAttribute('disabled', 'disabled');

  try {
    const resp = await fetch(`/api/admin/users/${pendingDeleteUser.id}`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': csrfToken,
      },
    });

    const data = await resp.json();
    if (!resp.ok) {
      setMessage(confirmMessage, data.error || 'Falha ao excluir usuário.', 'danger');
      confirmSubmitBtn?.removeAttribute('disabled');
      return;
    }

    closeConfirmModal();
    setUserListMessage('Usuário excluído com sucesso.', 'success');
    await loadAdminUsers();
  } catch {
    setMessage(confirmMessage, 'Erro de rede ao excluir usuário.', 'danger');
    confirmSubmitBtn?.removeAttribute('disabled');
  }
}

function setUserListMessage(text, tone = 'default') {
  const userListMessage = document.getElementById('user-list-message');
  setMessage(userListMessage, text, tone);
}

function setMessage(element, text, tone = 'default') {
  if (!element) return;
  element.textContent = text;
  if (tone === 'default') {
    element.removeAttribute('data-tone');
    return;
  }
  element.setAttribute('data-tone', tone);
}

function getDefaultPermissions() {
  return {
    canImport: false,
    canCreate: false,
    canEdit: false,
    canDelete: false,
  };
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

function getThemeStorageKey(email) {
  return `pops.theme.${String(email || '').toLowerCase()}`;
}

function getPreferredTheme(email, serverTheme) {
  const fromServer = String(serverTheme || '').toLowerCase();
  if (['light', 'dark'].includes(fromServer)) {
    return fromServer;
  }

  if (!email) {
    return 'dark';
  }

  const fromLocal = String(localStorage.getItem(getThemeStorageKey(email)) || '').toLowerCase();
  return ['light', 'dark'].includes(fromLocal) ? fromLocal : 'dark';
}

function applyTheme(theme) {
  const normalized = ['light', 'dark'].includes(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', normalized);
  if (themeSelect.value !== normalized) {
    themeSelect.value = normalized;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
