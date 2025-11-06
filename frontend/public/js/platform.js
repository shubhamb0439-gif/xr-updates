const loginForm = document.getElementById('loginFormElement');
const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');
const loginFormContainer = document.getElementById('loginForm');
const dashboardContent = document.getElementById('dashboardContent');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');

async function checkSession() {
  try {
    const response = await fetch('/api/platform/me', {
      method: 'GET',
      credentials: 'include',
    });
    const data = await response.json();

    if (data.ok && data.role === 'superadmin') {
      showDashboard(data.email);
    } else {
      showLoginForm();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showLoginForm();
  }
}

function showLoginForm() {
  loginFormContainer.style.display = 'block';
  dashboardContent.classList.remove('active');
}

function showDashboard(email) {
  loginFormContainer.style.display = 'none';
  dashboardContent.classList.add('active');
  if (userEmailSpan) {
    userEmailSpan.textContent = email || 'Super Admin';
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
  setTimeout(() => {
    errorMessage.style.display = 'none';
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
  errorMessage.style.display = 'none';

  try {
    const response = await fetch('/api/platform/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      showDashboard(data.email);
      document.getElementById('email').value = '';
      document.getElementById('password').value = '';
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
    showLoginForm();
  } catch (err) {
    console.error('Logout error:', err);
    showLoginForm();
  }
});

checkSession();
