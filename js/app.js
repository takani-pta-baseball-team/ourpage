import { CONFIG } from './config.js';
import { isAuthed, logout, showLoginModal } from './auth.js';

// LINE等のアプリ内ブラウザを検知してバナーを出す
maybeShowInAppBrowserBanner();

function maybeShowInAppBrowserBanner() {
  if (sessionStorage.getItem('inapp_banner_dismissed') === '1') return;
  const ua = navigator.userAgent || '';
  // Line/, FBAN/FBAV (Facebook), Instagram, Twitter, X-app などのアプリ内ブラウザ
  const isInApp = /Line\//i.test(ua)
    || /FBAN|FBAV/i.test(ua)
    || /Instagram/i.test(ua)
    || /Twitter/i.test(ua);
  if (!isInApp) return;

  const isAndroid = /Android/i.test(ua);
  const html = `
    <div id="inapp-banner" style="position:sticky;top:0;z-index:60;background:#fff3cd;border-bottom:1px solid #f0d160;color:#5c4400;padding:10px 12px;font-size:.85rem;line-height:1.5">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <strong>⚠ アプリ内ブラウザでは正しく動かない場合があります</strong><br>
          ${isAndroid
            ? '右上の <strong>︙</strong> メニューから「<strong>ブラウザで開く</strong>」を選んでください。'
            : '右下/右上の <strong>共有/メニュー</strong> から「<strong>Safari/ブラウザで開く</strong>」を選んでください。'}
        </div>
        <button id="inapp-dismiss" style="background:transparent;border:none;font-size:18px;cursor:pointer;padding:0 4px;color:#5c4400">×</button>
      </div>
    </div>
  `;
  const inject = () => {
    if (!document.body || document.getElementById('inapp-banner')) return;
    document.body.insertAdjacentHTML('afterbegin', html);
    document.getElementById('inapp-dismiss')?.addEventListener('click', () => {
      sessionStorage.setItem('inapp_banner_dismissed', '1');
      document.getElementById('inapp-banner')?.remove();
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  } else {
    inject();
  }
}

export function renderHeader({ showLogout = true } = {}) {
  const header = document.getElementById('app-header');
  if (!header) return;
  const authed = isAuthed();
  header.innerHTML = `
    <h1>${escapeHtml(CONFIG.TEAM_NAME)}</h1>
    <div class="header-status">
      ${authed && showLogout
        ? '<button class="btn btn-sm" id="logout-btn" style="background:rgba(255,255,255,.15);color:#fff;border-color:rgba(255,255,255,.3)">ログアウト</button>'
        : ''}
    </div>
  `;
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) logout();
  });
}

export function renderNav(activeKey) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  const items = [
    { key: 'home', label: 'ホーム', icon: '🏠', href: './' },
    { key: 'games', label: '試合', icon: '⚾', href: 'games.html' },
    { key: 'members', label: 'メンバー', icon: '👥', href: 'members.html' },
    { key: 'attendance', label: '出欠', icon: '📅', href: 'attendance.html' },
  ];
  nav.innerHTML = items
    .map(
      (it) => `
    <a href="${it.href}" class="${it.key === activeKey ? 'active' : ''}">
      <span class="nav-icon">${it.icon}</span>
      <span>${it.label}</span>
    </a>
  `
    )
    .join('');
}

export function requireAuth(callback) {
  if (isAuthed()) {
    callback();
    return;
  }
  showLoginModal({
    onSuccess: () => {
      renderHeader();
      callback();
    },
  });
}

export function showToast(message, type = 'info') {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.className = `toast ${type}`;
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 2500);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${yyyy}/${mm}/${dd}(${wd})`;
}

export function uid(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}`;
}

export function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
