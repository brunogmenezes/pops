let csrfToken = '';
let map;
let marker;
let manualPickerMap;
let manualPickerMarker;
let selectedManualCoordinates = null;
let searchDebounceTimer;
let markersLayer;
const markerById = new Map();
let selectedDatacenterId = null;

const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const loginForm = document.getElementById('login-form');
const loginMessage = document.getElementById('login-message');
const userLabel = document.getElementById('user-label');
const changePasswordBtn = document.getElementById('change-password-btn');
const logoutBtn = document.getElementById('logout-btn');
const importForm = document.getElementById('import-form');
const importMessage = document.getElementById('import-message');
const importSection = document.getElementById('import-section');
const importSectionDivider = document.getElementById('import-section-divider');
const manualForm = document.getElementById('manual-form');
const manualMessage = document.getElementById('manual-message');
const manualLatitudeInput = document.getElementById('manual-latitude');
const manualLongitudeInput = document.getElementById('manual-longitude');
const openManualMapBtn = document.getElementById('open-manual-map-btn');
const manualMapModal = document.getElementById('manual-map-modal');
const manualPickerMapElement = document.getElementById('manual-picker-map');
const manualMapSelectionMessage = document.getElementById('manual-map-selection');
const manualMapApplyBtn = document.getElementById('manual-map-apply-btn');
const manualMapCancelBtn = document.getElementById('manual-map-cancel-btn');
const manualSection = document.getElementById('manual-section');
const addDatacenterPermissionMessage = document.getElementById('add-datacenter-permission-message');
const searchForm = document.getElementById('search-form');
const exportKmlBtn = document.getElementById('export-kml-btn');
const searchMessage = document.getElementById('search-message');
const subtleToast = document.getElementById('subtle-toast');
const resultsEl = document.getElementById('results');
const statTotalEl = document.getElementById('stat-total');
const statWithCityEl = document.getElementById('stat-with-city');
const statWithoutCnlEl = document.getElementById('stat-without-cnl');
const statWithoutCnlCard = document.getElementById('stat-without-cnl-card');
const statFilteredEl = document.getElementById('stat-filtered');
const themeSelect = document.getElementById('theme-select');
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editMessage = document.getElementById('edit-message');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const editNameInput = document.getElementById('edit-name');
const editCityInput = document.getElementById('edit-city');
const editCnlInput = document.getElementById('edit-cnl');
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
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalDescription = document.getElementById('confirm-modal-description');
const confirmModalNote = document.getElementById('confirm-modal-note');
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
const userMustChangePasswordInput = document.getElementById('new-user-must-change-password');
const userEditMustChangePasswordInput = document.getElementById('user-edit-must-change-password');
const forcePasswordModal = document.getElementById('force-password-modal');
const forcePasswordForm = document.getElementById('force-password-form');
const forcePasswordCurrentInput = document.getElementById('force-current-password');
const forcePasswordNewInput = document.getElementById('force-new-password');
const forcePasswordConfirmInput = document.getElementById('force-confirm-password');
const forcePasswordMessage = document.getElementById('force-password-message');
const forcePasswordLogoutBtn = document.getElementById('force-password-logout-btn');
const accountPasswordModal = document.getElementById('account-password-modal');
const accountPasswordForm = document.getElementById('account-password-form');
const accountPasswordCurrentInput = document.getElementById('account-current-password');
const accountPasswordNewInput = document.getElementById('account-new-password');
const accountPasswordConfirmInput = document.getElementById('account-confirm-password');
const accountPasswordMessage = document.getElementById('account-password-message');
const accountPasswordCancelBtn = document.getElementById('account-password-cancel-btn');
const addDatacenterTabButton = document.querySelector('.tab-btn[data-tab="import-tab"]');

let currentUserEmail = '';
let editingDatacenterId = null;
let editingGroupId = null;
let editingUserId = null;
let subtleToastTimer = null;
let confirmDialogResolver = null;
let currentIsAdmin = false;
let currentPermissions = getDefaultPermissions();
let availableGroups = [];
let mustChangePasswordPending = false;

const MANUAL_PICKER_DEFAULT = {
  latitude: -5.514589,
  longitude: -47.485614,
  zoom: 11,
};
const MAP_MAX_ZOOM = 18;
const ESRI_SAFE_NATIVE_ZOOM = 17;

function getManualPickerFallbackView() {
  if (map) {
    const center = map.getCenter();
    return {
      latitude: Number(center.lat),
      longitude: Number(center.lng),
      zoom: Number(map.getZoom()),
    };
  }

  return { ...MANUAL_PICKER_DEFAULT };
}

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

    if (me.mustChangePassword) {
      mustChangePasswordPending = true;
      showPasswordChangeRequired(me.email || me.username || '');
      return;
    }

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

    if (data.mustChangePassword) {
      mustChangePasswordPending = true;
      loginMessage.textContent = '';
      loginForm.reset();
      showPasswordChangeRequired(data.email || data.username || payload.username);
      return;
    }

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
  await performLogout();
});

forcePasswordLogoutBtn?.addEventListener('click', async () => {
  await performLogout();
});

async function performLogout() {
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
    mustChangePasswordPending = false;
    closeForcePasswordModal();
    closeAccountPasswordModal();
    showLogin();
    loginMessage.textContent = '';
  }
}

changePasswordBtn?.addEventListener('click', () => {
  openAccountPasswordModal();
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
    const ok = await openConfirmDialog({
      title: 'Substituir dados atuais?',
      description: 'Esta operação apagará os datacenters atuais e importará os dados do arquivo selecionado.',
      note: 'Esta ação é irreversível. Faça backup antes, se necessário.',
      confirmLabel: 'Apagar e importar',
      confirmStyle: 'danger',
    });

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

    const citySummary = Array.isArray(data.citySummary) ? data.citySummary : [];
    const cityPreview = citySummary
      .slice(0, 5)
      .map((item) => `${item.city}: ${item.total}`)
      .join(' | ');

    importMessage.textContent =
      `Importado com sucesso. Total no arquivo: ${data.totalPointsInFile}, inseridos: ${data.imported}, ` +
      `ignorados: ${data.ignored}, cidades: ${data.totalCitiesInFile || 0}.` +
      (cityPreview ? ` Resumo: ${cityPreview}.` : '');
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
    cnl: String(formData.get('cnl') || '').trim(),
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

openManualMapBtn?.addEventListener('click', () => {
  openManualMapPicker();
});

manualMapCancelBtn?.addEventListener('click', () => {
  closeManualMapPicker();
});

manualMapModal?.addEventListener('click', (event) => {
  if (event.target === manualMapModal) {
    closeManualMapPicker();
  }
});

manualMapApplyBtn?.addEventListener('click', () => {
  if (!selectedManualCoordinates) {
    setMessage(manualMapSelectionMessage, 'Selecione uma coordenada no minimapa.', 'danger');
    return;
  }

  manualLatitudeInput.value = selectedManualCoordinates.latitude.toFixed(6);
  manualLongitudeInput.value = selectedManualCoordinates.longitude.toFixed(6);
  setMessage(manualMessage, '', 'default');
  showSubtleToast('Coordenadas selecionadas no minimapa.', 'success');
  closeManualMapPicker();
});

groupForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const isEditing = Number.isInteger(editingGroupId) && editingGroupId > 0;
  groupMessage.textContent = isEditing ? 'Salvando alterações do grupo...' : 'Criando grupo...';

  const formData = new FormData(groupForm);
  const payload = {
    name: String(formData.get('name') || '').trim(),
    canImport:    formData.get('canImport') !== null,
    canCreate:    formData.get('canCreate') !== null,
    canEdit:      formData.get('canEdit') !== null,
    canDelete:    formData.get('canDelete') !== null,
    canExportKml: formData.get('canExportKml') !== null,
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
    mustChangePasswordOnLogin: formData.get('mustChangePasswordOnLogin') !== null,
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

statWithoutCnlCard?.addEventListener('click', async () => {
  const hasCnlInput = document.getElementById('has-cnl-filter');
  const cnlInput = document.getElementById('cnl');
  if (!hasCnlInput) return;

  const isActive = hasCnlInput.value === 'false';
  hasCnlInput.value = isActive ? '' : 'false';
  if (!isActive && cnlInput) cnlInput.value = '';

  updateWithoutCnlCardState();
  await runSearch();
});

statWithoutCnlCard?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  statWithoutCnlCard.click();
});

exportKmlBtn?.addEventListener('click', async () => {
  const previousLabel = exportKmlBtn.textContent;
  exportKmlBtn.disabled = true;
  exportKmlBtn.textContent = 'Exportando...';
  setMessage(searchMessage, 'Preparando arquivo KML...', 'default');

  try {
    const formData = new FormData(searchForm);
    const q = encodeURIComponent(String(formData.get('q') || '').trim());
    const city = encodeURIComponent(String(formData.get('city') || '').trim());
    const cnl = encodeURIComponent(String(formData.get('cnl') || '').trim());
    const hasCnl = encodeURIComponent(String(formData.get('hasCnl') || '').trim());
    const url = `/api/datacenters/export.kml?q=${q}&city=${city}&cnl=${cnl}&hasCnl=${hasCnl}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setMessage(searchMessage, data.error || 'Falha ao exportar KML', 'danger');
      return;
    }

    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;

    const contentDisposition = resp.headers.get('content-disposition') || '';
    const matched = contentDisposition.match(/filename="?([^";]+)"?/i);
    link.download = matched?.[1] || `pops-datacenters-${new Date().toISOString().slice(0, 10)}.kml`;

    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setMessage(searchMessage, '', 'default');
    showSubtleToast('Arquivo KML exportado com sucesso.', 'success');
  } catch {
    setMessage(searchMessage, 'Erro de rede ao exportar KML', 'danger');
  } finally {
    exportKmlBtn.disabled = false;
    exportKmlBtn.textContent = previousLabel;
  }
});

searchForm.addEventListener('keyup', (event) => {
  const target = event.target;
  if (!target || !target.name) return;

  if (['q', 'city', 'cnl'].includes(target.name)) {
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
  setMessage(searchMessage, '', 'default');
  const formData = new FormData(searchForm);
  const q = encodeURIComponent(String(formData.get('q') || '').trim());
  const city = encodeURIComponent(String(formData.get('city') || '').trim());
  const cnl = encodeURIComponent(String(formData.get('cnl') || '').trim());
  const hasCnl = encodeURIComponent(String(formData.get('hasCnl') || '').trim());
  updateWithoutCnlCardState();

  const url = `/api/datacenters?q=${q}&city=${city}&cnl=${cnl}&hasCnl=${hasCnl}`;

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

  const groupedByCity = new Map();
  for (const item of items) {
    const cityKey = normalizeResultCity(item.city);
    if (!groupedByCity.has(cityKey)) {
      groupedByCity.set(cityKey, []);
    }
    groupedByCity.get(cityKey).push(item);
  }

  const sortedCities = Array.from(groupedByCity.keys()).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  for (const city of sortedCities) {
    const cityItems = groupedByCity.get(city) || [];
    cityItems.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));

    const cityHeader = document.createElement('li');
    cityHeader.className = 'result-group-header';
    cityHeader.innerHTML = `<strong>${escapeHtml(city)}</strong><small>${cityItems.length} datacenter(s)</small>`;
    resultsEl.appendChild(cityHeader);

    for (const item of cityItems) {
      const li = document.createElement('li');
      li.classList.add('result-item');
      li.dataset.id = String(item.id);
      li.innerHTML = `
        <div class="result-top-row">
          <strong>${escapeHtml(item.name)}</strong>
          <div class="result-actions">
            <button type="button" class="icon-btn share-btn" title="Copiar link do Google Maps" aria-label="Copiar link do Google Maps">🔗</button>
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
          </div>
        </div>
        <small>🏙️ Cidade: ${escapeHtml(item.city || '-')} | 🧾 CNL: ${escapeHtml(item.cnl || item.district || '-')}</small><br/>
        <small>📍 Lat: ${Number(item.latitude).toFixed(6)} | Lng: ${Number(item.longitude).toFixed(6)}</small>
      `;

      if (selectedDatacenterId === item.id) {
        li.classList.add('active');
      }

      li.addEventListener('click', () => {
        selectedDatacenterId = item.id;
        selectResultItem(item.id);
        focusMap(item.id, item.latitude, item.longitude, item.name, item.cnl || item.district);
      });

      const shareBtn = li.querySelector('.share-btn');
      const editBtn = li.querySelector('.edit-btn');
      const deleteBtn = li.querySelector('.delete-btn');

      shareBtn?.addEventListener('click', (event) => {
        event.stopPropagation();

        const lat = Number(item.latitude);
        const lng = Number(item.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
        const shareText = [
          `🏢 Datacenter: ${item.name || '-'}`,
          `🏙️ Cidade: ${item.city || '-'}`,
          `🧾 CNL: ${item.cnl || item.district || '-'}`,
          `📍 Link para google maps: ${mapsUrl}`,
        ].join('\n');
        if (navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(shareText)
            .then(() => showSubtleToast('Texto com link do Google Maps copiado.', 'success'))
            .catch(() => showSubtleToast('Não foi possível copiar o link.', 'danger'));
          return;
        }

        showSubtleToast('Seu navegador não suporta cópia automática de link.', 'danger');
      });

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
}

function normalizeResultCity(city) {
  const value = String(city || '').trim();
  return value || 'Sem cidade';
}

function openEditModal(item) {
  if (!currentIsAdmin && !currentPermissions.canEdit) {
    return;
  }

  editingDatacenterId = item.id;
  editNameInput.value = item.name || '';
  editCityInput.value = item.city || '';
  editCnlInput.value = item.cnl || item.district || '';
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

accountPasswordCancelBtn?.addEventListener('click', () => {
  closeAccountPasswordModal();
});

accountPasswordModal?.addEventListener('click', (event) => {
  if (event.target === accountPasswordModal) {
    closeAccountPasswordModal();
  }
});

confirmCancelBtn?.addEventListener('click', () => {
  resolveConfirmDialog(false);
});

confirmModal?.addEventListener('click', (event) => {
  if (event.target === confirmModal) {
    resolveConfirmDialog(false);
  }
});

confirmSubmitBtn?.addEventListener('click', () => {
  resolveConfirmDialog(true);
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
        cnl: editCnlInput.value.trim(),
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
    setMessage(searchMessage, 'Seu usuário não tem permissão para excluir datacenter.', 'danger');
    return;
  }

  const ok = await openConfirmDialog({
    title: 'Excluir datacenter?',
    description: `Deseja excluir o datacenter "${item.name}"?`,
    note: 'Esta ação remove o datacenter permanentemente.',
    confirmLabel: 'Excluir datacenter',
    confirmStyle: 'danger',
  });

  if (!ok) return;

  try {
    const resp = await fetch(`/api/datacenters/${item.id}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfToken },
    });

    const data = await resp.json();
    if (!resp.ok) {
      setMessage(searchMessage, data.error || 'Falha ao excluir datacenter', 'danger');
      return;
    }

    if (selectedDatacenterId === item.id) {
      selectedDatacenterId = null;
    }

    setMessage(searchMessage, '', 'default');
    showSubtleToast('Datacenter excluído com sucesso.', 'success');
    await loadStats();
    await runSearch();
  } catch {
    setMessage(searchMessage, 'Erro de rede ao excluir datacenter', 'danger');
  }
}

function initMap() {
  map = L.map('map', { maxZoom: MAP_MAX_ZOOM }).setView([-14.235, -51.9253], 4);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: ESRI_SAFE_NATIVE_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(map);

  L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    {
      maxNativeZoom: ESRI_SAFE_NATIVE_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      opacity: 0.95,
      attribution: 'Labels &copy; Esri',
    }
  ).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function openManualMapPicker() {
  if (!manualMapModal || !manualPickerMapElement) return;

  manualMapModal.classList.remove('hidden');

  const rawLatitude = String(manualLatitudeInput?.value || '').trim();
  const rawLongitude = String(manualLongitudeInput?.value || '').trim();
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  const hasValidInput = rawLatitude !== '' && rawLongitude !== '' && Number.isFinite(latitude) && Number.isFinite(longitude);

  if (!manualPickerMap) {
    const fallback = getManualPickerFallbackView();
    manualPickerMap = L.map(manualPickerMapElement, { maxZoom: MAP_MAX_ZOOM }).setView(
      [fallback.latitude, fallback.longitude],
      fallback.zoom
    );
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: ESRI_SAFE_NATIVE_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }).addTo(manualPickerMap);

    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: ESRI_SAFE_NATIVE_ZOOM,
        maxZoom: MAP_MAX_ZOOM,
        opacity: 0.95,
        attribution: 'Labels &copy; Esri',
      }
    ).addTo(manualPickerMap);

    manualPickerMap.on('click', (event) => {
      const lat = Number(event.latlng.lat);
      const lng = Number(event.latlng.lng);

      selectedManualCoordinates = { latitude: lat, longitude: lng };
      setMessage(
        manualMapSelectionMessage,
        `Latitude: ${lat.toFixed(6)} | Longitude: ${lng.toFixed(6)}`,
        'success'
      );

      if (!manualPickerMarker) {
        manualPickerMarker = L.marker([lat, lng]).addTo(manualPickerMap);
      } else {
        manualPickerMarker.setLatLng([lat, lng]);
      }
    });
  }

  setTimeout(() => {
    manualPickerMap.invalidateSize();

    if (hasValidInput) {
      manualPickerMap.setView([latitude, longitude], 14);
      selectedManualCoordinates = { latitude, longitude };
      setMessage(
        manualMapSelectionMessage,
        `Latitude: ${latitude.toFixed(6)} | Longitude: ${longitude.toFixed(6)}`,
        'success'
      );

      if (!manualPickerMarker) {
        manualPickerMarker = L.marker([latitude, longitude]).addTo(manualPickerMap);
      } else {
        manualPickerMarker.setLatLng([latitude, longitude]);
      }
      return;
    }

    selectedManualCoordinates = null;
    if (manualPickerMarker) {
      manualPickerMap.removeLayer(manualPickerMarker);
      manualPickerMarker = null;
    }

    const fallback = getManualPickerFallbackView();
    manualPickerMap.setView(
      [fallback.latitude, fallback.longitude],
      fallback.zoom
    );
    setMessage(manualMapSelectionMessage, 'Nenhuma coordenada selecionada.', 'default');
  }, 60);
}

function closeManualMapPicker() {
  if (!manualMapModal) return;
  manualMapModal.classList.add('hidden');
}

function buildDatacenterPopupHtml(label, cnl) {
  const safeName = escapeHtml(label || 'Datacenter');
  const safeCnl = escapeHtml(cnl || '-');
  return `<strong>${safeName}</strong><br/><small>CNL: ${safeCnl}</small>`;
}

function focusMap(id, lat, lng, label, cnl = '') {
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
  marker.bindPopup(buildDatacenterPopupHtml(label, cnl)).openPopup();
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
    mk.bindPopup(buildDatacenterPopupHtml(item.name, item.cnl || item.district));
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
      focusMap(selected.id, selected.latitude, selected.longitude, selected.name, selected.cnl || selected.district);
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
    statWithCityEl.textContent = String(stats.total_cities || stats.cities || 0);
    statWithoutCnlEl.textContent = String(stats.without_cnl || 0);
  } catch {
    // silencia erro de stats e mantém a tela funcional
  }
}

function updateWithoutCnlCardState() {
  const hasCnlInput = document.getElementById('has-cnl-filter');
  const isActive = hasCnlInput?.value === 'false';
  if (statWithoutCnlCard) statWithoutCnlCard.classList.toggle('active', Boolean(isActive));
}

function setAccessContext(data) {
  currentIsAdmin = Boolean(data?.isAdmin);
  const incoming = data?.permissions || {};
  currentPermissions = {
    canImport:    Boolean(incoming.canImport),
    canCreate:    Boolean(incoming.canCreate),
    canEdit:      Boolean(incoming.canEdit),
    canDelete:    Boolean(incoming.canDelete),
    canExportKml: Boolean(incoming.canExportKml),
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

  const canExportKml = currentIsAdmin || currentPermissions.canExportKml;
  if (exportKmlBtn) exportKmlBtn.classList.toggle('hidden', !canExportKml);

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

  if (groupMessage) groupMessage.textContent = '';

  let resp;
  try {
    resp = await fetch('/api/admin/groups');
  } catch (err) {
    console.error('loadAdminGroups fetch error:', err);
    if (groupMessage) groupMessage.textContent = 'Servidor inacessível ao carregar grupos';
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    console.error('loadAdminGroups json parse error:', err);
    if (groupMessage) groupMessage.textContent = 'Resposta inválida ao carregar grupos';
    return;
  }

  if (!resp.ok) {
    if (groupMessage) groupMessage.textContent = data.error || 'Falha ao carregar grupos';
    return;
  }

  availableGroups = Array.isArray(data.items) ? data.items : [];
  try {
    renderGroupOptions(availableGroups);
    renderGroupList(availableGroups);
  } catch (err) {
    console.error('loadAdminGroups render error:', err);
    if (groupMessage) groupMessage.textContent = `Erro ao renderizar grupos: ${err.message}`;
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
    if (group.can_export_kml) parts.push('Exportar KML');

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

  const canImportEl    = groupForm.querySelector('input[name="canImport"]');
  const canCreateEl    = groupForm.querySelector('input[name="canCreate"]');
  const canEditEl      = groupForm.querySelector('input[name="canEdit"]');
  const canDeleteEl    = groupForm.querySelector('input[name="canDelete"]');
  const canExportKmlEl = groupForm.querySelector('input[name="canExportKml"]');

  if (canImportEl) canImportEl.checked    = Boolean(group.can_import);
  if (canCreateEl) canCreateEl.checked    = Boolean(group.can_create);
  if (canEditEl) canEditEl.checked        = Boolean(group.can_edit);
  if (canDeleteEl) canDeleteEl.checked    = Boolean(group.can_delete);
  if (canExportKmlEl) canExportKmlEl.checked = Boolean(group.can_export_kml);

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

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('pt-BR');
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(Number(ms || 0) / 1000);
  if (totalSeconds <= 0) {
    return '';
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 1) {
    return 'menos de 1 min restante';
  }

  if (totalMinutes < 60) {
    return totalMinutes === 1 ? '1 min restante' : `${totalMinutes} min restantes`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return hours === 1 ? '1 hora restante' : `${hours} horas restantes`;
  }

  return `${hours}h ${minutes}min restantes`;
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
  let blockedCount = 0;

  for (const user of users) {
    const li = document.createElement('li');
    const groupName = String(user.group_name || 'Sem grupo');
    const email = user.email ? `${escapeHtml(user.email)}` : '';
    const isBlocked = Boolean(user.login_blocked);
    const mustChangePassword = Boolean(user.must_change_password);
    const blockedUntilLabel = isBlocked ? formatDateTime(user.login_blocked_until) : '';
    const remainingLabel = isBlocked ? formatRemainingTime(user.login_block_remaining_ms) : '';

    if (isBlocked) {
      blockedCount += 1;
    }
    
    li.innerHTML = `
      <div class="group-row">
        <div class="user-row-main">
          <div class="user-row-title">
            <strong>${escapeHtml(user.username)}</strong>
            ${isBlocked ? '<span class="lock-badge">Bloqueado</span>' : ''}
            ${mustChangePassword ? '<span class="lock-badge lock-badge-info">Troca senha</span>' : ''}
          </div>
          <small>Grupo: ${escapeHtml(groupName)}${user.is_admin ? ' | Admin' : ''}${email ? ' | ' + email : ''}</small>
          ${
            isBlocked
              ? `<small class="user-lock-status">Bloqueado até ${escapeHtml(blockedUntilLabel)}${remainingLabel ? ` | ${escapeHtml(remainingLabel)}` : ''}</small>`
              : ''
          }
        </div>
        <div class="group-actions">
          ${
            isBlocked
              ? `<button type="button" class="secondary unlock-login-btn" data-action="unlock" data-user-id="${user.id}">Desbloquear</button>`
              : ''
          }
          <button type="button" class="icon-btn" data-action="edit" data-user-id="${user.id}" title="Editar usuário" aria-label="Editar usuário">✏️</button>
          <button type="button" class="icon-btn" data-action="delete" data-user-id="${user.id}" title="Excluir usuário" aria-label="Excluir usuário">🗑️</button>
        </div>
      </div>
    `;

    const unlockBtn = li.querySelector('button[data-action="unlock"]');
    const editBtn = li.querySelector('button[data-action="edit"]');
    const deleteBtn = li.querySelector('button[data-action="delete"]');

    unlockBtn?.addEventListener('click', async () => {
      await unlockUserLogin(user);
    });

    editBtn?.addEventListener('click', () => {
      openUserEditModal(user);
    });

    deleteBtn?.addEventListener('click', async () => {
      await deleteUser(user);
    });

    userList.appendChild(li);
  }
  
  if (userListMessage) {
    userListMessage.textContent = blockedCount > 0
      ? `${blockedCount} usuário(s) com login bloqueado no momento.`
      : '';
  }
}

function openUserEditModal(user) {
  editingUserId = Number(user.id);
  userEditUsernameInput.value = String(user.username || '');
  userEditEmailInput.value = String(user.email || '');
  userEditGroupSelect.value = user.group_id ? String(user.group_id) : '';
  userEditPasswordInput.value = '';
  if (userEditMustChangePasswordInput) {
    userEditMustChangePasswordInput.checked = Boolean(user.must_change_password);
  }
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

async function deleteUser(user) {
  const ok = await openConfirmDialog({
    title: 'Excluir usuário?',
    description: `Você está prestes a excluir o usuário ${user.username}.`,
    note: 'Esta ação remove o acesso imediatamente e não pode ser desfeita.',
    confirmLabel: 'Excluir usuário',
    confirmStyle: 'danger',
  });

  if (!ok) return;

  setUserListMessage('Excluindo usuário...', 'default');

  try {
    const resp = await fetch(`/api/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': csrfToken,
      },
    });

    const data = await resp.json();
    if (!resp.ok) {
      setUserListMessage(data.error || 'Falha ao excluir usuário.', 'danger');
      return;
    }

    setUserListMessage('', 'default');
    showSubtleToast('Usuário excluído com sucesso.', 'success');
    await loadAdminUsers();
  } catch {
    setUserListMessage('Erro de rede ao excluir usuário.', 'danger');
  }
}

async function unlockUserLogin(user) {
  const ok = await openConfirmDialog({
    title: 'Remover bloqueio de login?',
    description: `Deseja remover o bloqueio de login do usuário ${user.username}?`,
    note: 'O usuário poderá tentar fazer login novamente imediatamente.',
    confirmLabel: 'Remover bloqueio',
    confirmStyle: 'danger',
  });

  if (!ok) return;

  setUserListMessage('Removendo bloqueio de login...', 'default');

  try {
    const resp = await fetch(`/api/admin/users/${user.id}/login-block`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': csrfToken,
      },
    });

    const data = await resp.json();
    if (!resp.ok) {
      setUserListMessage(data.error || 'Falha ao remover bloqueio de login.', 'danger');
      return;
    }

    showSubtleToast('Bloqueio de login removido com sucesso.', 'success');
    await loadAdminUsers();
  } catch {
    setUserListMessage('Erro de rede ao remover bloqueio de login.', 'danger');
  }
}

function closeConfirmModal() {
  setMessage(confirmMessage, '', 'default');
  confirmSubmitBtn?.removeAttribute('disabled');
  confirmSubmitBtn?.classList.add('danger-btn');
  confirmModal?.classList.add('hidden');
}

function resolveConfirmDialog(confirmed) {
  const resolver = confirmDialogResolver;
  confirmDialogResolver = null;
  closeConfirmModal();
  if (resolver) {
    resolver(Boolean(confirmed));
  }
}

function openConfirmDialog({ title, description, note, confirmLabel, confirmStyle = 'danger' }) {
  if (!confirmModal || !confirmSubmitBtn || !confirmModalTitle || !confirmModalDescription || !confirmModalNote) {
    return Promise.resolve(false);
  }

  confirmModalTitle.textContent = title || 'Confirmar ação';
  confirmModalDescription.textContent = description || '';
  confirmModalNote.textContent = note || '';
  confirmModalNote.classList.toggle('hidden', !note);

  confirmSubmitBtn.textContent = confirmLabel || 'Confirmar';
  confirmSubmitBtn.classList.toggle('danger-btn', confirmStyle === 'danger');
  setMessage(confirmMessage, '', 'default');

  confirmModal.classList.remove('hidden');

  return new Promise((resolve) => {
    confirmDialogResolver = resolve;
  });
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
    mustChangePasswordOnLogin: Boolean(userEditMustChangePasswordInput?.checked),
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

function showSubtleToast(text, tone = 'success') {
  if (!subtleToast) return;

  subtleToast.textContent = text;
  subtleToast.setAttribute('data-tone', tone);
  subtleToast.classList.add('show');

  if (subtleToastTimer) {
    clearTimeout(subtleToastTimer);
  }

  subtleToastTimer = setTimeout(() => {
    subtleToast.classList.remove('show');
  }, 2800);
}

function getDefaultPermissions() {
  return {
    canImport: false,
    canCreate: false,
    canEdit: false,
    canDelete: false,
    canExportKml: false,
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

function showPasswordChangeRequired(email) {
  showLogin();
  loginMessage.textContent = 'Troca de senha obrigatória. Atualize sua senha para continuar.';
  openForcePasswordModal(email);
}

function openForcePasswordModal(email) {
  if (!forcePasswordModal) return;
  setMessage(forcePasswordMessage, '', 'default');
  forcePasswordForm?.reset();
  forcePasswordModal.classList.remove('hidden');
  if (forcePasswordCurrentInput) {
    forcePasswordCurrentInput.focus();
  }

  if (email) {
    userLabel.textContent = `Troca obrigatória para ${email}`;
  }
}

function closeForcePasswordModal() {
  forcePasswordModal?.classList.add('hidden');
  setMessage(forcePasswordMessage, '', 'default');
}

function openAccountPasswordModal() {
  if (!accountPasswordModal) return;
  accountPasswordForm?.reset();
  setMessage(accountPasswordMessage, '', 'default');
  accountPasswordModal.classList.remove('hidden');
  accountPasswordCurrentInput?.focus();
}

function closeAccountPasswordModal() {
  accountPasswordModal?.classList.add('hidden');
  setMessage(accountPasswordMessage, '', 'default');
}

async function submitPasswordChange({ currentPassword, newPassword, confirmPassword, messageElement }) {
  if (!currentPassword || !newPassword || !confirmPassword) {
    setMessage(messageElement, 'Preencha todos os campos.', 'danger');
    return false;
  }

  if (newPassword.length < 8) {
    setMessage(messageElement, 'A nova senha deve ter pelo menos 8 caracteres.', 'danger');
    return false;
  }

  if (newPassword !== confirmPassword) {
    setMessage(messageElement, 'A confirmação da nova senha não confere.', 'danger');
    return false;
  }

  setMessage(messageElement, 'Salvando nova senha...', 'default');

  try {
    const resp = await fetch('/api/account/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      setMessage(messageElement, data.error || 'Falha ao alterar senha.', 'danger');
      return false;
    }

    return true;
  } catch {
    setMessage(messageElement, 'Erro de rede ao alterar senha.', 'danger');
    return false;
  }
}

forcePasswordForm?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const currentPassword = String(forcePasswordCurrentInput?.value || '');
  const newPassword = String(forcePasswordNewInput?.value || '');
  const confirmPassword = String(forcePasswordConfirmInput?.value || '');

  const ok = await submitPasswordChange({
    currentPassword,
    newPassword,
    confirmPassword,
    messageElement: forcePasswordMessage,
  });
  if (!ok) {
    return;
  }

  mustChangePasswordPending = false;
  closeForcePasswordModal();
  loginMessage.textContent = '';
  showDashboard(currentUserEmail);
  showSubtleToast('Senha alterada com sucesso.', 'success');
  await loadAdminGroups();
  await loadAdminUsers();
  await loadStats();
  await runSearch();
});

accountPasswordForm?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const currentPassword = String(accountPasswordCurrentInput?.value || '');
  const newPassword = String(accountPasswordNewInput?.value || '');
  const confirmPassword = String(accountPasswordConfirmInput?.value || '');

  const ok = await submitPasswordChange({
    currentPassword,
    newPassword,
    confirmPassword,
    messageElement: accountPasswordMessage,
  });
  if (!ok) {
    return;
  }

  closeAccountPasswordModal();
  showSubtleToast('Senha alterada com sucesso.', 'success');
});

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
