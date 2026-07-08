/* ============================================================
   VPN SaaS Admin Dashboard — SPA
   ============================================================ */
(() => {
  'use strict';

  const API = '/api/v1';
  const STORAGE_KEY = 'vpn_sas_token';
  let token = localStorage.getItem(STORAGE_KEY) || null;
  let currentUser = null;
  let currentPage = 'dashboard';

  // ── DOM refs ──
  const $loginScreen = document.getElementById('login-screen');
  const $appShell    = document.getElementById('app-shell');
  const $loginForm   = document.getElementById('login-form');
  const $loginError  = document.getElementById('login-error');
  const $contentArea = document.getElementById('content-area');
  const $pageTitle   = document.getElementById('page-title');
  const $userInfo    = document.getElementById('user-info');
  const $toastContainer = document.getElementById('toast-container');
  const $modalOverlay   = document.getElementById('modal-overlay');
  const $modalTitle     = document.getElementById('modal-title');
  const $modalBody      = document.getElementById('modal-body');
  const $modalFooter    = document.getElementById('modal-footer');
  const $clock          = document.getElementById('current-time');

  // ── Utilities ──
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function showModal(title, bodyHtml, footerHtml = '') {
    $modalTitle.textContent = title;
    $modalBody.innerHTML = bodyHtml;
    $modalFooter.innerHTML = footerHtml;
    $modalOverlay.classList.remove('hidden');
  }

  function hideModal() { $modalOverlay.classList.add('hidden'); }
  document.getElementById('modal-close').onclick = hideModal;
  $modalOverlay.addEventListener('click', (e) => { if (e.target === $modalOverlay) hideModal(); });

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
  }

  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status) {
    const cls = (status || '').toLowerCase();
    return `<span class="badge badge-${cls}">${status || '—'}</span>`;
  }

  // ── Auth ──
  $loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $loginError.classList.add('hidden');
    const btn = document.getElementById('login-btn');
    btn.innerHTML = '<span class="spinner"></span> Signing in...';
    btn.disabled = true;
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      });
      token = data.accessToken || data.access_token || data.token;
      localStorage.setItem(STORAGE_KEY, token);
      await loadProfile();
      enterApp();
    } catch (err) {
      $loginError.textContent = err.message;
      $loginError.classList.remove('hidden');
    } finally {
      btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
      btn.disabled = false;
    }
  });

  async function loadProfile() {
    try {
      currentUser = await api('/auth/me');
    } catch {
      currentUser = null;
    }
  }

  function enterApp() {
    $loginScreen.classList.add('hidden');
    $appShell.classList.remove('hidden');
    $userInfo.textContent = currentUser?.email || 'Admin';
    navigateTo('dashboard');
  }

  function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem(STORAGE_KEY);
    $appShell.classList.add('hidden');
    $loginScreen.classList.remove('hidden');
  }

  document.getElementById('logout-btn').onclick = logout;

  // ── Navigation ──
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(el.dataset.page);
    });
  });

  document.getElementById('sidebar-toggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
  };

  function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
    const titles = {
      dashboard: 'Dashboard', users: 'Users', subscriptions: 'Subscriptions',
      orders: 'Orders', payments: 'Payments', wallet: 'Wallet', plans: 'Plans',
      servers: 'Servers', panels: 'Panels', tickets: 'Tickets',
      broadcasts: 'Broadcasts', affiliate: 'Affiliates', settings: 'Settings',
    };
    $pageTitle.textContent = titles[page] || page;
    loadPage(page);
    document.getElementById('sidebar').classList.remove('open');
  }

  // ── Clock ──
  setInterval(() => {
    $clock.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, 1000);

  // ── Page Router ──
  async function loadPage(page) {
    $contentArea.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span></div>';
    try {
      const render = pages[page];
      if (render) await render();
      else $contentArea.innerHTML = '<div class="empty-state"><i class="fas fa-construction"></i><p>Page not implemented yet.</p></div>';
    } catch (err) {
      $contentArea.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i><p>${err.message}</p></div>`;
    }
  }

  // ── Pages ──
  const pages = {};

  // ====== DASHBOARD ======
  pages.dashboard = async () => {
    let stats = {};
    try { stats = await api('/admin/dashboard'); } catch {}
    const s = stats;
    $contentArea.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon purple"><i class="fas fa-users"></i></div><div class="stat-info"><h3>${s.totalUsers ?? 0}</h3><p>Total Users</p></div></div>
        <div class="stat-card"><div class="stat-icon green"><i class="fas fa-check-circle"></i></div><div class="stat-info"><h3>${s.activeSubscriptions ?? 0}</h3><p>Active Subs</p></div></div>
        <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-dollar-sign"></i></div><div class="stat-info"><h3>${formatCurrency(s.totalRevenue ?? 0)}</h3><p>Revenue</p></div></div>
        <div class="stat-card"><div class="stat-icon orange"><i class="fas fa-shopping-cart"></i></div><div class="stat-info"><h3>${s.totalOrders ?? 0}</h3><p>Orders</p></div></div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon green"><i class="fas fa-coins"></i></div><div class="stat-info"><h3>${formatCurrency(s.revenueToday ?? 0)}</h3><p>Today Revenue</p></div></div>
        <div class="stat-card"><div class="stat-icon red"><i class="fas fa-user-plus"></i></div><div class="stat-info"><h3>${s.usersToday ?? 0}</h3><p>New Users Today</p></div></div>
      </div>
      <div class="card"><div class="card-header"><h3>Quick Actions</h3></div><div class="card-body btn-group">
        <button class="btn btn-primary btn-sm" onclick="window.__nav('users')"><i class="fas fa-users"></i> Manage Users</button>
        <button class="btn btn-outline btn-sm" onclick="window.__nav('orders')"><i class="fas fa-shopping-cart"></i> View Orders</button>
        <button class="btn btn-outline btn-sm" onclick="window.__nav('broadcasts')"><i class="fas fa-bullhorn"></i> Broadcast</button>
        <button class="btn btn-outline btn-sm" onclick="window.__nav('payments')"><i class="fas fa-credit-card"></i> Receipts</button>
      </div></div>`;
  };
  window.__nav = navigateTo;

  // ====== USERS ======
  pages.users = async () => {
    let data = { items: [], total: 0, page: 1, pageSize: 20 };
    let search = '';
    let pg = 1;

    async function load() {
      const q = search ? `?search=${encodeURIComponent(search)}&page=${pg}&limit=10` : `?page=${pg}&limit=10`;
      try { data = await api(`/users${q}`); } catch { data = { items: [], total: 0, page: 1, pageSize: 10 }; }
      render();
    }

    function render() {
      const items = data.items || data.data || [];
      const total = data.total || 0;
      const totalPages = Math.ceil(total / 10);
      $contentArea.innerHTML = `
        <div class="toolbar">
          <input type="text" id="user-search" placeholder="Search by email or name..." value="${search}" />
          <button class="btn btn-primary btn-sm" id="user-search-btn"><i class="fas fa-search"></i> Search</button>
        </div>
        <div class="card">
          <div class="card-header"><h3>Users (${total})</h3></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
              <tbody>${items.map((u) => `
                <tr>
                  <td>${u.email || u.telegramId || '—'}</td>
                  <td>${u.role || 'USER'}</td>
                  <td>${statusBadge(u.status || 'ACTIVE')}</td>
                  <td>${formatDate(u.createdAt)}</td>
                  <td>
                    <button class="btn btn-sm btn-outline" onclick="window.__viewUser('${u.publicId}')"><i class="fas fa-eye"></i></button>
                    <button class="btn btn-sm btn-danger" onclick="window.__toggleUser('${u.publicId}','${u.status}')"><i class="fas fa-ban"></i></button>
                  </td>
                </tr>`).join('')}
                ${items.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No users found</td></tr>' : ''}
              </tbody>
            </table>
          </div>
        </div>
        ${totalPages > 1 ? `<div class="pagination" id="users-pagination"></div>` : ''}`;

      document.getElementById('user-search-btn').onclick = () => { search = document.getElementById('user-search').value; pg = 1; load(); };
      document.getElementById('user-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { search = e.target.value; pg = 1; load(); } });

      if (totalPages > 1) {
        const pag = document.getElementById('users-pagination');
        let html = '';
        for (let i = 1; i <= Math.min(totalPages, 10); i++) {
          html += `<button class="${i === pg ? 'active' : ''}" onclick="window.__usersPage(${i})">${i}</button>`;
        }
        pag.innerHTML = html;
      }
    }

    window.__usersPage = (p) => { pg = p; load(); };

    window.__viewUser = async (id) => {
      try {
        const u = await api(`/users/${id}`);
        showModal('User Details', `
          <div style="display:grid;gap:12px">
            <div><strong>Email:</strong> ${u.email || '—'}</div>
            <div><strong>Telegram:</strong> ${u.telegramId || '—'}</div>
            <div><strong>Role:</strong> ${u.role}</div>
            <div><strong>Status:</strong> ${statusBadge(u.status)}</div>
            <div><strong>Wallet Balance:</strong> ${formatCurrency(u.walletBalance ?? u.wallet?.balance ?? 0)}</div>
            <div><strong>Created:</strong> ${formatDate(u.createdAt)}</div>
          </div>`);
      } catch (err) { toast(err.message, 'error'); }
    };

    window.__toggleUser = async (id, currentStatus) => {
      const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      if (!confirm(`Change user status to ${newStatus}?`)) return;
      try {
        await api(`/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
        toast('User status updated', 'success');
        load();
      } catch (err) { toast(err.message, 'error'); }
    };

    await load();
  };

  // ====== SUBSCRIPTIONS ======
  pages.subscriptions = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/subscriptions/admin/all?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>All Subscriptions (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Start</th><th>Expiry</th><th>Traffic</th></tr></thead>
            <tbody>${items.map((s) => `
              <tr>
                <td>${s.user?.email || s.userId || '—'}</td>
                <td>${s.plan?.name || s.planId || '—'}</td>
                <td>${statusBadge(s.status)}</td>
                <td>${formatDate(s.startDate)}</td>
                <td>${formatDate(s.endDate)}</td>
                <td>${s.trafficUsed ? (s.trafficUsed / 1073741824).toFixed(1) + ' GB' : '—'}</td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No subscriptions</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;
  };

  // ====== ORDERS ======
  pages.orders = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/orders/admin/all?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>All Orders (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Status</th><th>Method</th><th>Date</th></tr></thead>
            <tbody>${items.map((o) => `
              <tr>
                <td>${o.user?.email || o.userId || '—'}</td>
                <td>${o.plan?.name || o.planId || '—'}</td>
                <td>${formatCurrency(o.amount)}</td>
                <td>${statusBadge(o.status)}</td>
                <td>${o.paymentMethod || '—'}</td>
                <td>${formatDate(o.createdAt)}</td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No orders</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;
  };

  // ====== PAYMENTS / RECEIPTS ======
  pages.payments = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/payments/admin/receipts?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Payment Receipts (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Amount</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>${items.map((r) => `
              <tr>
                <td>${r.user?.email || r.userId || '—'}</td>
                <td>${formatCurrency(r.amount)}</td>
                <td>${statusBadge(r.status)}</td>
                <td>${formatDateTime(r.createdAt)}</td>
                <td>
                  ${r.status === 'PENDING' ? `
                    <button class="btn btn-sm btn-success" onclick="window.__verifyReceipt('${r.publicId}')"><i class="fas fa-check"></i> Approve</button>
                    <button class="btn btn-sm btn-danger" onclick="window.__rejectReceipt('${r.publicId}')"><i class="fas fa-times"></i> Reject</button>` : ''}
                  ${r.fileUrl ? `<a href="${r.fileUrl}" target="_blank" class="btn btn-sm btn-outline"><i class="fas fa-image"></i></a>` : ''}
                </td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No receipts</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;

    window.__verifyReceipt = async (id) => {
      try {
        await api(`/payments/admin/receipts/${id}/verify`, { method: 'POST', body: JSON.stringify({ status: 'APPROVED' }) });
        toast('Receipt approved', 'success');
        pages.payments();
      } catch (err) { toast(err.message, 'error'); }
    };

    window.__rejectReceipt = async (id) => {
      if (!confirm('Reject this receipt?')) return;
      try {
        await api(`/payments/admin/receipts/${id}/verify`, { method: 'POST', body: JSON.stringify({ status: 'REJECTED' }) });
        toast('Receipt rejected', 'success');
        pages.payments();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== WALLET ======
  pages.wallet = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/wallet/transactions?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Wallet Transactions (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Amount</th><th>Balance After</th><th>Description</th><th>Date</th></tr></thead>
            <tbody>${items.map((t) => `
              <tr>
                <td><span class="badge badge-${t.type === 'CREDIT' ? 'active' : 'inactive'}">${t.type || '—'}</span></td>
                <td style="color:${(t.type === 'CREDIT' || t.amount > 0) ? 'var(--success)' : 'var(--danger)'}">${t.amount > 0 ? '+' : ''}${formatCurrency(t.amount)}</td>
                <td>${formatCurrency(t.balanceAfter)}</td>
                <td>${t.description || '—'}</td>
                <td>${formatDateTime(t.createdAt)}</td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No transactions</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;
  };

  // ====== PLANS ======
  pages.plans = async () => {
    let items = [];
    try { items = await api('/plans/admin'); } catch {}
    if (!Array.isArray(items)) items = items?.items || items?.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Plans (${items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Price</th><th>Duration</th><th>Traffic</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${items.map((p) => `
              <tr>
                <td><strong>${p.name}</strong></td>
                <td>${formatCurrency(p.price)}</td>
                <td>${p.durationDays || p.duration || '—'} days</td>
                <td>${p.trafficGB || p.trafficBytes ? (p.trafficGB || p.trafficBytes / 1073741824) + ' GB' : 'Unlimited'}</td>
                <td>${statusBadge(p.status || (p.isActive ? 'ACTIVE' : 'INACTIVE'))}</td>
                <td><button class="btn btn-sm btn-outline" onclick="window.__editPlan('${p.publicId}')"><i class="fas fa-edit"></i></button></td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No plans</td></tr>' : ''}
          </table>
        </div>
      </div>`;

    window.__editPlan = (id) => {
      const plan = items.find((p) => p.publicId === id);
      if (!plan) return;
      showModal('Edit Plan', `
        <div class="form-group"><label>Name</label><input id="plan-name" value="${plan.name || ''}" /></div>
        <div class="form-group"><label>Price</label><input type="number" id="plan-price" value="${plan.price || 0}" /></div>
        <div class="form-group"><label>Duration (days)</label><input type="number" id="plan-duration" value="${plan.durationDays || plan.duration || 30}" /></div>
        <div class="form-group"><label>Status</label><select id="plan-status"><option value="ACTIVE" ${plan.status==='ACTIVE'||plan.isActive?'selected':''}>Active</option><option value="INACTIVE" ${plan.status==='INACTIVE'||!plan.isActive?'selected':''}>Inactive</option></select></div>
      `, `<button class="btn btn-primary" onclick="window.__savePlan('${id}')">Save</button>`);
    };

    window.__savePlan = async (id) => {
      try {
        await api(`/plans/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: document.getElementById('plan-name').value,
            price: parseFloat(document.getElementById('plan-price').value),
            durationDays: parseInt(document.getElementById('plan-duration').value),
            status: document.getElementById('plan-status').value,
          }),
        });
        hideModal();
        toast('Plan updated', 'success');
        pages.plans();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== SERVERS ======
  pages.servers = async () => {
    let items = [];
    try { items = await api('/servers'); } catch {}
    if (!Array.isArray(items)) items = items?.items || items?.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Servers (${items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Country</th><th>IP</th><th>Status</th><th>Load</th><th>Actions</th></tr></thead>
            <tbody>${items.map((s) => `
              <tr>
                <td><strong>${s.name || s.host}</strong></td>
                <td>${s.country || s.countryId || '—'}</td>
                <td><code>${s.ip || s.host || '—'}</code></td>
                <td>${statusBadge(s.status || (s.isActive ? 'ACTIVE' : 'INACTIVE'))}</td>
                <td>${s.load ? s.load + '%' : '—'}</td>
                <td><button class="btn btn-sm btn-outline" onclick="window.__viewServer('${s.id || s.publicId}')"><i class="fas fa-eye"></i></button></td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No servers</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;

    window.__viewServer = async (id) => {
      try {
        const s = await api(`/servers/${id}`);
        showModal('Server Details', `
          <div style="display:grid;gap:12px">
            <div><strong>Name:</strong> ${s.name}</div>
            <div><strong>IP:</strong> <code>${s.ip || s.host}</code></div>
            <div><strong>Country:</strong> ${s.country || '—'}</div>
            <div><strong>Status:</strong> ${statusBadge(s.status)}</div>
            <div><strong>Protocol:</strong> ${s.protocol || '—'}</div>
            <div><strong>Port:</strong> ${s.port || '—'}</div>
          </div>`);
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== PANELS ======
  pages.panels = async () => {
    let items = [];
    try { items = await api('/panels'); } catch {}
    if (!Array.isArray(items)) items = items?.items || items?.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Panels (${items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>URL</th><th>Status</th><th>Last Check</th><th>Actions</th></tr></thead>
            <tbody>${items.map((p) => `
              <tr>
                <td><strong>${p.name || '—'}</strong></td>
                <td><code style="font-size:11px">${p.baseUrl || p.url || '—'}</code></td>
                <td>${statusBadge(p.status || (p.isActive ? 'ACTIVE' : 'INACTIVE'))}</td>
                <td>${formatDateTime(p.lastHealthCheck || p.lastCheck)}</td>
                <td>
                  <button class="btn btn-sm btn-outline" onclick="window.__healthCheck('${p.id || p.publicId}')"><i class="fas fa-heartbeat"></i></button>
                  <button class="btn btn-sm btn-danger" onclick="window.__deletePanel('${p.id || p.publicId}')"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No panels</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;

    window.__healthCheck = async (id) => {
      try {
        await api(`/panels/${id}/health-check`, { method: 'POST' });
        toast('Health check passed', 'success');
      } catch (err) { toast('Health check failed: ' + err.message, 'error'); }
    };

    window.__deletePanel = async (id) => {
      if (!confirm('Delete this panel?')) return;
      try {
        await api(`/panels/${id}`, { method: 'DELETE' });
        toast('Panel deleted', 'success');
        pages.panels();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== TICKETS ======
  pages.tickets = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/tickets/admin/all?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Tickets (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Subject</th><th>User</th><th>Status</th><th>Priority</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>${items.map((t) => `
              <tr>
                <td>${t.subject || t.title || '—'}</td>
                <td>${t.user?.email || t.userId || '—'}</td>
                <td>${statusBadge(t.status)}</td>
                <td>${t.priority || '—'}</td>
                <td>${formatDate(t.createdAt)}</td>
                <td><button class="btn btn-sm btn-outline" onclick="window.__viewTicket('${t.publicId}')"><i class="fas fa-eye"></i></button></td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No tickets</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;

    window.__viewTicket = async (id) => {
      try {
        const msgs = await api(`/tickets/${id}/messages`);
        const arr = Array.isArray(msgs) ? msgs : msgs?.items || msgs?.data || [];
        showModal('Ticket Messages', `
          <div style="display:flex;flex-direction:column;gap:12px;max-height:400px;overflow-y:auto">
            ${arr.map((m) => `
              <div style="padding:10px;border-radius:6px;background:var(--bg-input)">
                <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px"><strong>${m.senderId || 'User'}</strong> · ${formatDateTime(m.createdAt)}</div>
                <div style="font-size:13px">${m.content || m.message || m.text || ''}</div>
              </div>`).join('')}
            ${arr.length === 0 ? '<div style="color:var(--text-dim)">No messages yet</div>' : ''}
          </div>`, `<textarea id="ticket-reply" class="form-group" style="width:100%;min-height:60px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px" placeholder="Reply..."></textarea><button class="btn btn-primary btn-sm" onclick="window.__replyTicket('${id}')">Send</button>`);
      } catch (err) { toast(err.message, 'error'); }
    };

    window.__replyTicket = async (id) => {
      const msg = document.getElementById('ticket-reply')?.value?.trim();
      if (!msg) return;
      try {
        await api(`/tickets/admin/${id}/reply`, { method: 'POST', body: JSON.stringify({ content: msg }) });
        hideModal();
        toast('Reply sent', 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== BROADCASTS ======
  pages.broadcasts = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/admin/notifications/broadcasts?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="btn-group" style="margin-bottom:16px">
        <button class="btn btn-primary btn-sm" onclick="window.__newBroadcast()"><i class="fas fa-plus"></i> New Broadcast</button>
      </div>
      <div class="card">
        <div class="card-header"><h3>Broadcast History (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Message</th><th>Target</th><th>Sent</th><th>Success</th><th>Failed</th><th>Date</th></tr></thead>
            <tbody>${items.map((b) => `
              <tr>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.message || b.text || '—'}</td>
                <td>${b.target || b.audience || 'All'}</td>
                <td>${b.sentCount ?? b.successCount ?? 0}</td>
                <td style="color:var(--success)">${b.successCount ?? 0}</td>
                <td style="color:${(b.failedCount ?? 0) > 0 ? 'var(--danger)' : 'inherit'}">${b.failedCount ?? 0}</td>
                <td>${formatDateTime(b.createdAt)}</td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No broadcasts yet</td></tr>' : ''}
          </table>
        </div>
      </div>`;

    window.__newBroadcast = () => {
      showModal('New Broadcast', `
        <div class="form-group"><label>Message</label><textarea id="broadcast-msg" rows="4" style="width:100%;background:var(--bg-input);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px" placeholder="Enter broadcast message..."></textarea></div>
        <div class="form-group"><label>Target Audience</label><select id="broadcast-target"><option value="all">All Users</option><option value="active">Active Subscribers</option><option value="inactive">Inactive Users</option></select></div>
      `, `<button class="btn btn-primary" onclick="window.__sendBroadcast()">Send Broadcast</button>`);
    };

    window.__sendBroadcast = async () => {
      const msg = document.getElementById('broadcast-msg')?.value?.trim();
      if (!msg) { toast('Message is required', 'error'); return; }
      try {
        await api('/admin/notifications/broadcast', {
          method: 'POST',
          body: JSON.stringify({ message: msg, target: document.getElementById('broadcast-target').value }),
        });
        hideModal();
        toast('Broadcast sent!', 'success');
        pages.broadcasts();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ====== AFFILIATES ======
  pages.affiliate = async () => {
    let data = { items: [], total: 0 };
    try { data = await api('/affiliate/admin/accounts?limit=50'); } catch {}
    const items = data.items || data.data || [];
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Affiliate Accounts (${data.total || items.length})</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Code</th><th>Commissions</th><th>Total Earned</th><th>Status</th></tr></thead>
            <tbody>${items.map((a) => `
              <tr>
                <td>${a.user?.email || a.userId || '—'}</td>
                <td><code>${a.code || a.referralCode || '—'}</code></td>
                <td>${a.referralCount ?? a.totalReferrals ?? 0}</td>
                <td>${formatCurrency(a.totalEarned ?? a.earnings ?? 0)}</td>
                <td>${statusBadge(a.status || (a.isActive ? 'ACTIVE' : 'INACTIVE'))}</td>
              </tr>`).join('')}
              ${items.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No affiliates</td></tr>' : ''}
          </tbody>
        </div>
      </div>`;
  };

  // ====== SETTINGS ======
  pages.settings = async () => {
    let settings = {};
    try { settings = await api('/admin/settings'); } catch {}
    const arr = Array.isArray(settings) ? settings : Object.entries(settings).map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
    $contentArea.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>System Settings</h3><button class="btn btn-sm btn-primary" onclick="window.__addSetting()"><i class="fas fa-plus"></i> Add</button></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Value</th><th>Actions</th></tr></thead>
            <tbody>${arr.map((s) => `
              <tr>
                <td><code>${s.key || s.settingKey || '—'}</code></td>
                <td style="max-width:400px;word-break:break-all;font-size:12px">${s.value || s.settingValue || '—'}</td>
                <td>
                  <button class="btn btn-sm btn-outline" onclick="window.__editSetting('${s.key || s.settingKey}','${(s.value || s.settingValue || '').replace(/'/g, "\\'")}')"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-sm btn-danger" onclick="window.__deleteSetting('${s.key || s.settingKey}')"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('')}
              ${arr.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:var(--text-dim)">No settings</td></tr>' : ''}
          </table>
        </div>
      </div>`;

    window.__editSetting = (key, value) => {
      showModal(`Setting: ${key}`, `
        <div class="form-group"><label>Key</label><input id="set-key" value="${key}" /></div>
        <div class="form-group"><label>Value</label><input id="set-value" value="${value}" /></div>
      `, `<button class="btn btn-primary" onclick="window.__saveSetting()">Save</button>`);
    };

    window.__saveSetting = async () => {
      try {
        await api('/admin/settings', {
          method: 'POST',
          body: JSON.stringify({ key: document.getElementById('set-key').value, value: document.getElementById('set-value').value }),
        });
        hideModal();
        toast('Setting saved', 'success');
        pages.settings();
      } catch (err) { toast(err.message, 'error'); }
    };

    window.__deleteSetting = async (key) => {
      if (!confirm(`Delete setting "${key}"?`)) return;
      try {
        await api(`/admin/settings/${key}`, { method: 'DELETE' });
        toast('Setting deleted', 'success');
        pages.settings();
      } catch (err) { toast(err.message, 'error'); }
    };

    window.__addSetting = () => {
      showModal('Add Setting', `
        <div class="form-group"><label>Key</label><input id="set-key" placeholder="e.g. maintenance_mode" /></div>
        <div class="form-group"><label>Value</label><input id="set-value" placeholder="e.g. true" /></div>
      `, `<button class="btn btn-primary" onclick="window.__saveSetting()">Save</button>`);
    };
  };

  // ── Init ──
  if (token) {
    loadProfile().then(() => {
      if (currentUser) enterApp();
      else { logout(); }
    });
  }
})();