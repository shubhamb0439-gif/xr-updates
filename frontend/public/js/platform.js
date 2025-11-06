const loginForm = document.getElementById('loginFormElement');
const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');
const loginFormContainer = document.getElementById('loginForm');
const dashboardContent = document.getElementById('dashboardContent');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');

let currentUser = null;

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function checkSession() {
  try {
    const response = await fetch('/api/platform/me', {
      method: 'GET',
      credentials: 'include',
    });
    const data = await response.json();

    if (data.ok && data.role === 'superadmin') {
      currentUser = data;
      showDashboard(data.email);
      loadDashboardStats();
    } else {
      showLoginForm();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showLoginForm();
  }
}

function showLoginForm() {
  loginFormContainer.classList.remove('hidden');
  dashboardContent.classList.add('hidden');
}

function showDashboard(email) {
  loginFormContainer.classList.add('hidden');
  dashboardContent.classList.remove('hidden');
  if (userEmailSpan) {
    userEmailSpan.textContent = email || 'Super Admin';
  }
  switchView('dashboard');
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
  setTimeout(() => {
    errorMessage.classList.add('hidden');
  }, 5000);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showError('Please enter both email and password');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';
  errorMessage.classList.add('hidden');

  try {
    const response = await fetch('/api/platform/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      currentUser = data;
      showDashboard(data.email);
      document.getElementById('email').value = '';
      document.getElementById('password').value = '';
      loadDashboardStats();
    } else {
      showError(data.message || 'Login failed. Please check your credentials.');
    }
  } catch (err) {
    console.error('Login error:', err);
    showError('Connection error. Please try again.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/platform/logout', {
      method: 'POST',
      credentials: 'include',
    });
    currentUser = null;
    showLoginForm();
  } catch (err) {
    console.error('Logout error:', err);
    showLoginForm();
  }
});

function switchView(viewName) {
  document.querySelectorAll('.view-content').forEach(view => {
    view.classList.add('hidden');
  });

  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.remove('active');
  });

  const targetView = document.getElementById(`view-${viewName}`);
  const targetButton = document.querySelector(`[data-view="${viewName}"]`);

  if (targetView) {
    targetView.classList.remove('hidden');
    targetView.classList.add('fade-in');
  }

  if (targetButton) {
    targetButton.classList.add('active');
  }

  if (viewName === 'dashboard') {
    loadDashboardStats();
  } else if (viewName === 'assign-users') {
    loadAssignUsersTable();
  }
}

document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    const viewName = item.getAttribute('data-view');
    switchView(viewName);
  });
});

async function loadDashboardStats() {
  try {
    const response = await fetch('/api/platform/stats', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load stats');
    }

    const data = await response.json();

    if (data.ok && data.stats) {
      const stats = data.stats;

      document.getElementById('totalUsers').textContent = stats.totalUsers || 0;
      document.getElementById('totalProviders').textContent = stats.totalProviders || 0;
      document.getElementById('totalScribes').textContent = stats.totalScribes || 0;
      document.getElementById('totalEmployees').textContent = stats.totalEmployees || 0;

      const recentLoginsTable = document.getElementById('recentLoginsTable');
      if (stats.recentLogins && stats.recentLogins.length > 0) {
        recentLoginsTable.innerHTML = stats.recentLogins.map(login => `
          <tr class="table-row border-b border-gray-700">
            <td class="py-3">${login.name || 'N/A'}</td>
            <td class="py-3">${login.email || 'N/A'}</td>
            <td class="py-3">${login.xrId || 'N/A'}</td>
            <td class="py-3">
              <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">
                ${login.userType || 'N/A'}
              </span>
            </td>
            <td class="py-3 text-sm text-gray-400">
              ${login.lastLogin ? new Date(login.lastLogin).toLocaleString() : 'Never'}
            </td>
          </tr>
        `).join('');
      } else {
        recentLoginsTable.innerHTML = `
          <tr>
            <td colspan="5" class="py-8 text-center text-gray-500">No recent logins</td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to load dashboard stats:', err);
    showToast('Failed to load dashboard statistics', 'error');
  }
}

const createUserForm = document.getElementById('createUserForm');
createUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData(createUserForm);
  const userData = {
    name: formData.get('name'),
    email: formData.get('email'),
    xrId: formData.get('xrId'),
    userType: formData.get('userType'),
    status: formData.get('status'),
    rights: formData.get('rights'),
  };

  try {
    const response = await fetch('/api/platform/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(userData),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      showToast('User created successfully!', 'success');
      createUserForm.reset();
      loadDashboardStats();
    } else {
      showToast(data.message || 'Failed to create user', 'error');
    }
  } catch (err) {
    console.error('Create user error:', err);
    showToast('Connection error. Please try again.', 'error');
  }
});

async function loadAssignUsersTable() {
  try {
    const response = await fetch('/api/platform/users', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load users');
    }

    const data = await response.json();

    if (data.ok && data.users) {
      const assignUsersTable = document.getElementById('assignUsersTable');

      if (data.users.length > 0) {
        assignUsersTable.innerHTML = data.users.map(user => `
          <tr class="table-row border-b border-gray-700" data-user-id="${user.id}">
            <td class="py-3">${user.name || 'N/A'}</td>
            <td class="py-3 text-sm">${user.email || 'N/A'}</td>
            <td class="py-3">
              <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">
                ${user.xr_id || 'N/A'}
              </span>
            </td>
            <td class="py-3 text-sm">${user.userType || 'N/A'}</td>
            <td class="py-3">
              <input
                type="text"
                class="px-2 py-1 rounded text-sm w-24 bg-gray-700 border border-gray-600"
                value="${user.provider_id || ''}"
                data-field="providerId"
                placeholder="ID"
              />
            </td>
            <td class="py-3">
              <input
                type="text"
                class="px-2 py-1 rounded text-sm w-24 bg-gray-700 border border-gray-600"
                value="${user.scribe_id || ''}"
                data-field="scribeId"
                placeholder="ID"
              />
            </td>
            <td class="py-3">
              <select
                class="px-2 py-1 rounded text-sm bg-gray-700 border border-gray-600"
                data-field="level"
              >
                <option value="">Select</option>
                <option value="Primary" ${user.level === 'Primary' ? 'selected' : ''}>Primary</option>
                <option value="Secondary" ${user.level === 'Secondary' ? 'selected' : ''}>Secondary</option>
                <option value="Trainee" ${user.level === 'Trainee' ? 'selected' : ''}>Trainee</option>
              </select>
            </td>
            <td class="py-3">
              <button
                onclick="saveAssignment(${user.id})"
                class="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors"
              >
                Save
              </button>
            </td>
          </tr>
        `).join('');
      } else {
        assignUsersTable.innerHTML = `
          <tr>
            <td colspan="8" class="py-8 text-center text-gray-500">No users found</td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to load users:', err);
    showToast('Failed to load users', 'error');
  }
}

window.saveAssignment = async function(userId) {
  const row = document.querySelector(`tr[data-user-id="${userId}"]`);
  if (!row) return;

  const providerId = row.querySelector('[data-field="providerId"]').value.trim();
  const scribeId = row.querySelector('[data-field="scribeId"]').value.trim();
  const level = row.querySelector('[data-field="level"]').value;

  try {
    const response = await fetch('/api/platform/assign-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId,
        providerId: providerId || null,
        scribeId: scribeId || null,
        level: level || null,
      }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      showToast('Assignment saved successfully!', 'success');
    } else {
      showToast(data.message || 'Failed to save assignment', 'error');
    }
  } catch (err) {
    console.error('Save assignment error:', err);
    showToast('Connection error. Please try again.', 'error');
  }
};

checkSession();
