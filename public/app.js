/* ═══════════════════════════════════════════════
   YogaFlow — App.js
   Full client-side logic with real-time WebSocket
   ═══════════════════════════════════════════════ */

const API = '';  // same origin
let token = localStorage.getItem('yf_token');
let currentUser = JSON.parse(localStorage.getItem('yf_user') || 'null');
let ws = null;
let currentPage = 'feed';
let feedPage = 1;
let loadingFeed = false;
let currentChatUserId = null;
let activeProfileUsername = currentUser?.username || null;
let profileLoadRequestId = 0;
const VERIFIED_FRIEND_ID = 'YF000001';

function isMobileViewport() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function setMessagesMobileView(view) {
  const layout = document.querySelector('.messages-layout');
  const conversationsPanel = document.querySelector('.conversations-panel');
  if (!layout || !conversationsPanel) return;

  layout.classList.remove('mobile-list', 'mobile-chat');
  conversationsPanel.classList.remove('show');

  if (!isMobileViewport()) return;

  if (view === 'chat') {
    layout.classList.add('mobile-chat');
    return;
  }

  layout.classList.add('mobile-list');
  conversationsPanel.classList.add('show');
}

function showMessagesList() {
  currentChatUserId = null;
  setMessagesMobileView('list');
}

function getFriendButtonLabel(user) {
  if (user?.is_friend) return 'Friends';
  if (user?.is_following) return user?.follows_you ? 'Accept Friend' : 'Friend Request Sent';
  if (user?.follows_you) return 'Accept Friend';
  return 'Add Friend';
}

function applyFriendButtonState(btn, user) {
  if (!btn || !user) return;
  btn.textContent = getFriendButtonLabel(user);
  btn.classList.toggle('btn-secondary', !!user.is_friend || !!user.is_following);
  btn.classList.toggle('btn-primary', !(user.is_friend || user.is_following));
}

function formatFriendId(user) {
  if (user?.friend_id) return user.friend_id;
  if (user?.id) return `YF${String(user.id).padStart(6, '0')}`;
  return '—';
}

function isVerifiedUser(user) {
  return formatFriendId(user) === VERIFIED_FRIEND_ID;
}

function renderVerifiedBadge(user) {
  if (!isVerifiedUser(user)) return '';
  return '<span class="verified-badge" title="Verified">✔</span>';
}

function normalizeLookupInput(value) {
  return String(value || '')
    .trim()
    .replace(/^id\s*[:\-]?\s*/i, '')
    .replace(/^@/, '')
    .trim();
}

function setAuthUIState(isAuthenticated) {
  const authScreen = document.getElementById('auth-screen');
  const appRoot = document.getElementById('app');
  if (!authScreen || !appRoot) return;

  document.body.classList.toggle('authenticated', isAuthenticated);

  if (isAuthenticated) {
    authScreen.style.display = 'none';
    appRoot.classList.remove('hidden');
  } else {
    appRoot.classList.add('hidden');
    authScreen.style.display = 'flex';
  }
}

// ─── AUTH ─────────────────────────────────────────────────────
async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return toast('Please fill all fields');
  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Login failed');
    saveAuth(data.token, data.user);
    initApp();
  } catch { toast('Connection error'); }
}

async function register() {
  const username = document.getElementById('reg-username').value.trim();
  const full_name = document.getElementById('reg-fullname').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const yoga_style = document.getElementById('reg-style').value;
  if (!username || !email || !password) return toast('Please fill required fields');
  try {
    const res = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, full_name, yoga_style })
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Registration failed');
    saveAuth(data.token, data.user);
    initApp();
  } catch { toast('Connection error'); }
}

function saveAuth(t, u) {
  token = t;
  currentUser = u;
  activeProfileUsername = u?.username || null;
  localStorage.setItem('yf_token', t);
  localStorage.setItem('yf_user', JSON.stringify(u));
}

function logout() {
  localStorage.removeItem('yf_token');
  localStorage.removeItem('yf_user');
  token = null; currentUser = null;
  activeProfileUsername = null;
  if (ws) ws.close();
  setAuthUIState(false);
  showLogin();
}

function showLogin() {
  document.getElementById('login-form').classList.add('active');
  document.getElementById('register-form').classList.remove('active');
}
function showRegister() {
  document.getElementById('login-form').classList.remove('active');
  document.getElementById('register-form').classList.add('active');
}

// ─── API HELPER ───────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (res.status === 401) { logout(); return; }
  return res;
}

// ─── INIT ─────────────────────────────────────────────────────
function initApp() {
  setAuthUIState(true);
  updateSidebarUser();
  connectWebSocket();
  navigate('feed');
  loadSuggestions();
  pollNotifications();
}

function updateSidebarUser() {
  if (!currentUser) return;
  document.getElementById('sidebar-avatar').src = currentUser.avatar_url || avatarFallback(currentUser.username);
  document.getElementById('sidebar-username').innerHTML = `${escapeHtml(currentUser.username || '')}${renderVerifiedBadge(currentUser)}`;
  document.getElementById('sidebar-style').textContent = currentUser.yoga_style || '';
  const sidebarFriendId = document.getElementById('sidebar-friend-id');
  if (sidebarFriendId) sidebarFriendId.textContent = `ID: ${formatFriendId(currentUser)}`;
  document.getElementById('create-avatar').src = currentUser.avatar_url || avatarFallback(currentUser.username);
  document.getElementById('create-username').textContent = currentUser.username || '';
}

function avatarFallback(username) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'U')}&background=c8a96e&color=fff&size=128`;
}

// ─── WEBSOCKET ────────────────────────────────────────────────
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'new_message') handleIncomingMessage(msg.data);
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function handleIncomingMessage(msg) {
  if (currentPage === 'messages' && currentChatUserId) {
    const partnerId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
    if (partnerId === currentChatUserId) {
      appendMessage(msg);
    }
  }
  loadConversations();
  loadNotificationCount();
}

// ─── NAVIGATION ───────────────────────────────────────────────
function navigate(page) {
  currentPage = page;
  closeMobileMenu();
  document.getElementById('app')?.classList.toggle('messages-mode', page === 'messages');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  switch (page) {
    case 'feed': loadFeed(true); break;
    case 'explore': loadExplore(); break;
    case 'friends': loadFriendsPage(); break;
    case 'messages':
      currentChatUserId = null;
      setMessagesMobileView('list');
      loadConversations();
      break;
    case 'notifications': loadNotifications(); break;
    case 'profile': {
      const targetProfile = activeProfileUsername || currentUser?.username;
      loadProfile(targetProfile);
      break;
    }
  }
}

// ─── FEED ─────────────────────────────────────────────────────
async function loadFeed(reset = false) {
  if (loadingFeed) return;
  if (reset) { feedPage = 1; document.getElementById('feed-posts').innerHTML = ''; }
  loadingFeed = true;
  document.getElementById('feed-loading').style.display = 'flex';
  const res = await api(`/posts/feed?page=${feedPage}`);
  document.getElementById('feed-loading').style.display = 'none';
  loadingFeed = false;
  if (!res) return;
  let posts = await res.json();
  if (!Array.isArray(posts)) return;
  const container = document.getElementById('feed-posts');

  if (posts.length === 0 && feedPage === 1) {
    const exploreRes = await api('/posts/explore?page=1');
    const explorePosts = exploreRes?.ok ? await exploreRes.json() : [];
    if (Array.isArray(explorePosts) && explorePosts.length > 0) {
      posts = explorePosts;
      container.innerHTML = '<div class="empty-state" style="padding:20px"><h3>Discover posts</h3><p>Your personal feed is empty right now, showing community posts.</p></div>';
    }
  }

  if (posts.length === 0 && feedPage === 1) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🧘‍♀️</div><h3>Your feed is empty</h3><p>Follow some yogis to see their posts!</p></div>`;
    return;
  }
  posts.forEach(post => container.insertAdjacentHTML('beforeend', renderPost(post)));
  if (posts.length === 10) feedPage++;
  loadStories();
}

function renderPost(post) {
  const avatar = post.avatar_url || avatarFallback(post.username);
  const timeAgo = getTimeAgo(post.created_at);
  const liked = post.is_liked;
  const postUserRef = { id: post.user_id, friend_id: post.friend_id };
  return `
  <article class="post-card" id="post-${post.id}">
    <div class="post-header">
      <img src="${avatar}" class="avatar-sm" onerror="this.src='${avatarFallback(post.username)}'" />
      <div class="info">
        <a onclick="viewProfile('${post.username}')">${post.username}${renderVerifiedBadge(postUserRef)}</a>
        <small>${post.yoga_style || 'Yoga'} · ${timeAgo}</small>
      </div>
      ${post.user_id === currentUser?.id ? `
      <button class="post-more" onclick="deletePost(${post.id})"><i class="fas fa-trash-alt"></i></button>` : ''}
    </div>
    <div class="post-image-wrap">
      <img class="post-image" src="${post.image_url}" loading="lazy" onclick="openPostModal(${post.id})" onerror="this.parentElement.remove()" />
    </div>
    <div class="post-actions">
      <button class="action-btn ${liked ? 'liked' : ''}" onclick="toggleLike(${post.id}, this)">
        <i class="${liked ? 'fas' : 'far'} fa-heart"></i>
        <span class="count">${post.likes_count}</span>
      </button>
      <button class="action-btn" onclick="openPostModal(${post.id})">
        <i class="far fa-comment"></i>
        <span class="count">${post.comments_count}</span>
      </button>
      <button class="action-btn action-share" onclick="sharePost(${post.id})">
        <i class="far fa-paper-plane"></i>
      </button>
    </div>
    <div class="post-meta">
      <p class="post-likes">${post.likes_count} likes</p>
      ${post.caption ? `<p class="post-caption"><span class="username" onclick="viewProfile('${post.username}')">${post.username}${renderVerifiedBadge(postUserRef)}</span>${escapeHtml(post.caption)}</p>` : ''}
      <span class="view-comments" onclick="openPostModal(${post.id})">View all ${post.comments_count} comments</span>
      <p class="post-time">${timeAgo}</p>
    </div>
    <div class="comment-input-row">
      <img src="${currentUser?.avatar_url || avatarFallback(currentUser?.username)}" class="avatar-sm" />
      <input type="text" placeholder="Add a comment…" onkeydown="if(event.key==='Enter')quickComment(${post.id},this)" />
      <button onclick="quickComment(${post.id}, this.previousElementSibling)">Post</button>
    </div>
  </article>`;
}

async function loadStories() {
  const res = await api('/posts/explore?page=1');
  if (!res) return;
  const posts = await res.json();
  if (!Array.isArray(posts)) return;
  const seen = new Set();
  const users = posts.filter(p => {
    if (seen.has(p.user_id)) return false;
    seen.add(p.user_id); return true;
  }).slice(0, 12);
  document.getElementById('stories-row').innerHTML = users.map(u => `
    <div class="story-item" onclick="viewProfile('${u.username}')">
      <div class="story-ring">
        <img src="${u.avatar_url || avatarFallback(u.username)}" onerror="this.src='${avatarFallback(u.username)}'" />
      </div>
      <span class="story-label">${u.username}${renderVerifiedBadge(u)}</span>
    </div>
  `).join('');
}

// ─── LIKES ────────────────────────────────────────────────────
async function toggleLike(postId, btn) {
  const res = await api(`/posts/${postId}/like`, { method: 'POST' });
  if (!res) return;
  const data = await res.json();
  const icon = btn.querySelector('i');
  const count = btn.querySelector('.count');
  const card = document.getElementById(`post-${postId}`);
  const likesEl = card?.querySelector('.post-likes');
  if (data.liked) {
    btn.classList.add('liked');
    icon.className = 'fas fa-heart';
    count.textContent = parseInt(count.textContent) + 1;
    if (likesEl) likesEl.textContent = `${parseInt(count.textContent)} likes`;
  } else {
    btn.classList.remove('liked');
    icon.className = 'far fa-heart';
    count.textContent = Math.max(0, parseInt(count.textContent) - 1);
    if (likesEl) likesEl.textContent = `${parseInt(count.textContent)} likes`;
  }
}

// ─── QUICK COMMENT ────────────────────────────────────────────
async function quickComment(postId, input) {
  const content = input.value.trim();
  if (!content) return;
  const res = await api(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (res?.ok) {
    input.value = '';
    toast('Comment posted!');
    // update count
    const card = document.getElementById(`post-${postId}`);
    const countEl = card?.querySelectorAll('.count')[1];
    if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
  }
}

// ─── EXPLORE ──────────────────────────────────────────────────
async function loadExplore() {
  document.getElementById('explore-posts').innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';
  const res = await api('/posts/explore?page=1');
  if (!res) return;
  const posts = await res.json();
  document.getElementById('explore-posts').innerHTML = posts.map(p => `
    <div class="explore-item" onclick="openPostModal(${p.id})">
      <img src="${p.image_url}" loading="lazy" onerror="this.parentElement.remove()" />
      <div class="explore-overlay">
        <span><i class="fas fa-heart"></i> ${p.likes_count}</span>
        <span><i class="fas fa-comment"></i> ${p.comments_count}</span>
      </div>
    </div>
  `).join('');
}

// ─── POST MODAL ───────────────────────────────────────────────
async function openPostModal(postId) {
  document.getElementById('post-modal').classList.remove('hidden');
  document.getElementById('post-modal-content').innerHTML = '<div class="loading-indicator" style="padding:60px"><div class="spinner"></div></div>';
  const commentsRes = await api(`/posts/${postId}/comments`);
  const comments = commentsRes?.ok ? await commentsRes.json() : [];

  const [exploreRes, feedRes, myRes] = await Promise.all([
    api('/posts/explore?page=1'),
    api('/posts/feed?page=1'),
    currentUser?.username ? api(`/posts/user/${currentUser.username}`) : Promise.resolve(null)
  ]);

  const explorePosts = exploreRes?.ok ? await exploreRes.json() : [];
  const feedPosts = feedRes?.ok ? await feedRes.json() : [];
  const myPosts = myRes?.ok ? await myRes.json() : [];
  const allPosts = [...explorePosts, ...feedPosts, ...myPosts];
  const post = allPosts.find(p => p.id === postId);

  if (!post) {
    document.getElementById('post-modal-content').innerHTML = '<p style="padding:20px">Post not found</p>';
    return;
  }

  const avatar = post.avatar_url || avatarFallback(post.username);
  const postUserRef = { id: post.user_id, friend_id: post.friend_id };
  document.getElementById('post-modal-content').innerHTML = `
    <div class="post-modal-image">
      <img src="${post.image_url}" />
    </div>
    <div class="post-modal-sidebar">
      <div class="post-modal-header">
        <img src="${avatar}" class="avatar-sm" onerror="this.src='${avatarFallback(post.username)}'" />
        <div class="info">
          <a style="font-weight:700;cursor:pointer" onclick="closePostModal();viewProfile('${post.username}')">${post.username}${renderVerifiedBadge(postUserRef)}</a>
          <p style="font-size:12px;color:var(--text-3)">${getTimeAgo(post.created_at)}</p>
        </div>
      </div>
      <div class="post-modal-comments" id="modal-comments">
        ${post.caption ? `<div class="comment-item"><img src="${avatar}" class="avatar-sm" /><div class="text"><strong onclick="closePostModal();viewProfile('${post.username}')">${post.username}${renderVerifiedBadge(postUserRef)}</strong> ${escapeHtml(post.caption)}</div></div>` : ''}
        ${comments.map(c => renderComment(c)).join('')}
      </div>
      <div class="post-modal-actions">
        <div class="post-actions">
          <button class="action-btn ${post.is_liked ? 'liked' : ''}" onclick="toggleLike(${post.id},this)">
            <i class="${post.is_liked ? 'fas' : 'far'} fa-heart"></i>
            <span class="count">${post.likes_count}</span>
          </button>
          <button class="action-btn"><i class="far fa-comment"></i></button>
          <button class="action-btn action-share" onclick="sharePost(${post.id})"><i class="far fa-paper-plane"></i></button>
        </div>
        <p class="post-likes">${post.likes_count} likes</p>
      </div>
      <div class="post-modal-input">
        <img src="${currentUser?.avatar_url || avatarFallback(currentUser?.username)}" class="avatar-sm" />
        <input type="text" placeholder="Add a comment…" id="modal-comment-input" onkeydown="if(event.key==='Enter')submitModalComment(${post.id})" />
        <button onclick="submitModalComment(${post.id})">Post</button>
      </div>
    </div>`;
}

function renderComment(c) {
  const avatar = c.avatar_url || avatarFallback(c.username);
  const commenterRef = { id: c.user_id, friend_id: c.friend_id };
  return `<div class="comment-item">
    <img src="${avatar}" class="avatar-sm" onerror="this.src='${avatarFallback(c.username)}'" />
    <div class="text">
      <strong onclick="closePostModal();viewProfile('${c.username}')">${c.username}${renderVerifiedBadge(commenterRef)}</strong> ${escapeHtml(c.content)}
      <div class="time">${getTimeAgo(c.created_at)}</div>
    </div>
  </div>`;
}

async function submitModalComment(postId) {
  const input = document.getElementById('modal-comment-input');
  const content = input.value.trim();
  if (!content) return;
  const res = await api(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (res?.ok) {
    const comment = await res.json();
    input.value = '';
    document.getElementById('modal-comments').insertAdjacentHTML('beforeend', renderComment(comment));
    document.getElementById('modal-comments').scrollTop = 999999;
  }
}

function closePostModal() {
  document.getElementById('post-modal').classList.add('hidden');
}

// ─── CREATE POST ──────────────────────────────────────────────
function openCreatePost() { document.getElementById('create-modal').classList.remove('hidden'); }
function closeCreatePost() {
  document.getElementById('create-modal').classList.add('hidden');
  document.getElementById('post-image').value = '';
  document.getElementById('post-preview').classList.add('hidden');
  document.getElementById('upload-placeholder').style.display = '';
  document.getElementById('post-caption').value = '';
}

function previewImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Only images allowed!'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('post-preview').src = e.target.result;
    document.getElementById('post-preview').classList.remove('hidden');
    document.getElementById('upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

async function submitPost() {
  const imageFile = document.getElementById('post-image').files[0];
  const caption = document.getElementById('post-caption').value.trim();
  if (!imageFile) { toast('Please select an image'); return; }
  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('caption', caption);
  const res = await api('/posts', { method: 'POST', body: formData });
  if (!res) return;
  if (res.ok) {
    const post = await res.json();
    closeCreatePost();
    toast('Post shared! 🧘');
    if (currentPage === 'feed') {
      const container = document.getElementById('feed-posts');
      container.insertAdjacentHTML('afterbegin', renderPost({ ...post, is_liked: false }));
    }
  } else {
    const err = await res.json();
    toast(err.error || 'Failed to post');
  }
}

async function deletePost(postId) {
  if (!confirm('Delete this post?')) return;
  const res = await api(`/posts/${postId}`, { method: 'DELETE' });
  if (res?.ok) {
    document.getElementById(`post-${postId}`)?.remove();
    toast('Post deleted');
  }
}

// ─── PROFILE ──────────────────────────────────────────────────
async function loadProfile(username) {
  const targetUsername = username || activeProfileUsername || currentUser?.username;
  if (!targetUsername) return;
  activeProfileUsername = targetUsername;
  const requestId = ++profileLoadRequestId;

  const container = document.getElementById('profile-content');
  if (!container) return;
  container.innerHTML = '<div class="loading-indicator" style="padding:60px"><div class="spinner"></div></div>';

  const [userRes, postsRes] = await Promise.all([
    api(`/users/${targetUsername}`),
    api(`/posts/user/${targetUsername}`)
  ]);

  if (requestId !== profileLoadRequestId || activeProfileUsername !== targetUsername) return;
  if (!userRes?.ok) { container.innerHTML = '<p>User not found</p>'; return; }

  const user = await userRes.json();
  const posts = postsRes?.ok ? await postsRes.json() : [];
  if (requestId !== profileLoadRequestId || activeProfileUsername !== targetUsername) return;

  const avatar = user.avatar_url || avatarFallback(user.username);
  const isMe = user.id === currentUser?.id;
  container.innerHTML = `
    <div class="profile-header">
      <div class="profile-top">
        ${isMe ? `<div class="avatar-edit" onclick="document.getElementById('avatar-file-input').click()">
          <img src="${avatar}" class="avatar-xl" onerror="this.src='${avatarFallback(user.username)}'" />
          <div class="avatar-edit-overlay"><i class="fas fa-camera"></i></div>
          <input type="file" id="avatar-file-input" accept="image/*" style="display:none" onchange="uploadAvatar(this)" />
        </div>` : `<img src="${avatar}" class="avatar-xl" onerror="this.src='${avatarFallback(user.username)}'" />`}
        <div class="profile-info">
          <h2>${user.full_name || user.username}</h2>
          <p class="username">@${user.username}${renderVerifiedBadge(user)}</p>
          <p class="text-muted small">Friend ID: ${formatFriendId(user)}</p>
          ${user.yoga_style ? `<div class="yoga-tag">🧘 ${user.yoga_style}</div>` : ''}
          ${user.bio ? `<p class="bio" style="margin-top:8px">${escapeHtml(user.bio)}</p>` : ''}
          <div class="profile-actions">
            ${isMe ? `
              <button class="btn-primary" onclick="openEditProfile()">Edit Profile</button>
            ` : `
              <button class="${user.is_friend || user.is_following ? 'btn-secondary' : 'btn-primary'}" id="follow-btn" onclick="toggleFollow(${user.id}, this)">
                ${getFriendButtonLabel(user)}
              </button>
              <button class="btn-secondary" id="message-btn" onclick="startDM(${user.id}, '${user.username}', '${avatar}')" ${user.is_friend ? '' : 'style="display:none"'}>
                <i class="fas fa-paper-plane"></i> Message
              </button>
            `}
          </div>
        </div>
      </div>
      <div class="profile-stats">
        <div class="stat"><div class="num">${posts.length}</div><div class="label">Posts</div></div>
        <div class="stat"><div class="num">${user.followers_count || 0}</div><div class="label">Followers</div></div>
        <div class="stat"><div class="num">${user.following_count || 0}</div><div class="label">Following</div></div>
      </div>
    </div>
    <div class="profile-posts-grid">
      ${posts.length === 0 ? `<div class="empty-state" style="grid-column:1/-1;padding:40px"><div class="icon">📸</div><p>No posts yet</p></div>` : ''}
      ${posts.map(p => `
        <div class="explore-item" onclick="openPostModal(${p.id})">
          <img src="${p.image_url}" loading="lazy" onerror="this.parentElement.remove()" />
          <div class="explore-overlay">
            <span><i class="fas fa-heart"></i> ${p.likes_count}</span>
            <span><i class="fas fa-comment"></i> ${p.comments_count}</span>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function viewProfile(username) {
  activeProfileUsername = username;
  navigate('profile');
}

function openMyProfile() {
  if (!currentUser?.username) return;
  activeProfileUsername = currentUser.username;
  navigate('profile');
}

async function toggleFollow(userId, btn) {
  const res = await api(`/users/${userId}/follow`, { method: 'POST' });
  if (!res) return;
  const data = await res.json();
  applyFriendButtonState(btn, data);

  const messageBtn = document.getElementById('message-btn');
  if (messageBtn) messageBtn.style.display = data.is_friend ? '' : 'none';

  if (currentPage === 'friends') {
    const term = document.getElementById('friend-search-input')?.value?.trim();
    if (term) searchFriends(term);
  }

  loadSuggestions();
}

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);
  const res = await api('/users/me', { method: 'PUT', body: formData });
  if (res?.ok) {
    const user = await res.json();
    currentUser = { ...currentUser, ...user };
    localStorage.setItem('yf_user', JSON.stringify(currentUser));
    updateSidebarUser();
    loadProfile(currentUser.username);
    toast('Avatar updated!');
  }
}

// Edit Profile
let editModal = null;
function openEditProfile() {
  const html = `
    <div class="modal-overlay" id="edit-profile-modal">
      <div class="modal">
        <div class="modal-header">
          <h3>Edit Profile</h3>
          <button class="btn-icon" onclick="document.getElementById('edit-profile-modal').remove()"><i class="fas fa-times"></i></button>
        </div>
        <div class="edit-profile-form">
          <div class="form-group"><label>Full Name</label><input id="ep-name" value="${escapeHtml(currentUser.full_name || '')}" /></div>
          <div class="form-group"><label>Bio</label><textarea id="ep-bio" rows="3">${escapeHtml(currentUser.bio || '')}</textarea></div>
          <div class="form-group"><label>Yoga Style</label>
            <select id="ep-style">
              ${['Hatha','Vinyasa','Ashtanga','Yin Yoga','Restorative','Power Yoga','Kundalini','Iyengar','Bikram','Other'].map(s =>
                `<option ${currentUser.yoga_style === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="document.getElementById('edit-profile-modal').remove()">Cancel</button>
          <button class="btn-primary" onclick="saveProfile()">Save</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function saveProfile() {
  const formData = new FormData();
  formData.append('full_name', document.getElementById('ep-name').value);
  formData.append('bio', document.getElementById('ep-bio').value);
  formData.append('yoga_style', document.getElementById('ep-style').value);
  const res = await api('/users/me', { method: 'PUT', body: formData });
  if (res?.ok) {
    const user = await res.json();
    currentUser = { ...currentUser, ...user };
    localStorage.setItem('yf_user', JSON.stringify(currentUser));
    updateSidebarUser();
    document.getElementById('edit-profile-modal')?.remove();
    loadProfile(currentUser.username);
    toast('Profile updated!');
  }
}

// ─── MESSAGES ─────────────────────────────────────────────────
async function loadConversations() {
  if (currentPage === 'messages' && !currentChatUserId) {
    setMessagesMobileView('list');
  }
  const res = await api('/messages/conversations');
  if (!res) return;
  const convos = await res.json();
  const list = document.getElementById('conversations-list');
  if (convos.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:40px"><div class="icon">🤝</div><p>Add friends to start chatting</p></div>`;
    return;
  }
  list.innerHTML = convos.map(c => `
    <div class="convo-item ${c.partner_id === currentChatUserId ? 'active' : ''}" onclick="openChat(${c.partner_id}, '${c.username}', '${c.avatar_url || avatarFallback(c.username)}', '${c.friend_id || ''}')">
      <img src="${c.avatar_url || avatarFallback(c.username)}" class="avatar-sm" onerror="this.src='${avatarFallback(c.username)}'" />
      <div class="info">
        <div class="name">${c.full_name || c.username}${renderVerifiedBadge({ id: c.partner_id, friend_id: c.friend_id })}</div>
        <div class="preview">${escapeHtml(c.last_message || 'You are friends now. Say hello! 👋')}</div>
      </div>
      <div class="meta">
        <div class="time">${getTimeAgo(c.last_at)}</div>
        ${parseInt(c.unread_count) > 0 ? `<div class="unread-dot"></div>` : ''}
      </div>
    </div>
  `).join('');
  // Update badge
  const totalUnread = convos.reduce((sum, c) => sum + parseInt(c.unread_count || 0), 0);
  const badge = document.getElementById('msg-badge');
  badge.textContent = totalUnread;
  badge.style.display = totalUnread > 0 ? '' : 'none';
}

async function openChat(userId, username, avatar, friendId = '') {
  currentChatUserId = userId;
  setMessagesMobileView('chat');
  document.querySelectorAll('.convo-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList?.add('active');
  const panel = document.getElementById('chat-panel');
  panel.innerHTML = `
    <div class="chat-header">
      <button class="btn-icon mobile-chat-back" onclick="showMessagesList()" aria-label="Back to conversations">
        <i class="fas fa-arrow-left"></i>
      </button>
      <img src="${avatar}" class="avatar-sm" onclick="viewProfile('${username}')" style="cursor:pointer" onerror="this.src='${avatarFallback(username)}'" />
      <div>
        <div class="name" onclick="viewProfile('${username}')" style="cursor:pointer">${username}${renderVerifiedBadge({ id: userId, friend_id: friendId || undefined })}</div>
        <div class="status">Active</div>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages"><div class="loading-indicator"><div class="spinner"></div></div></div>
    <div class="chat-input-area">
      <input type="file" id="chat-image-input" accept="image/*" style="display:none" onchange="sendMessageImage(${userId}, this)" />
      <button class="btn-icon chat-media-btn" onclick="document.getElementById('chat-image-input').click()" aria-label="Send image">
        <i class="fas fa-image"></i>
      </button>
      <input type="text" placeholder="Message…" id="chat-input" onkeydown="if(event.key==='Enter')sendMessage(${userId})" />
      <button class="send-btn" onclick="sendMessage(${userId})"><i class="fas fa-paper-plane"></i></button>
    </div>`;
  loadMessages(userId);
}

async function loadMessages(userId) {
  const res = await api(`/messages/${userId}`);
  if (!res) return;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    toast(data.error || 'Could not open chat');
    return;
  }
  const messages = await res.json();
  const container = document.getElementById('chat-messages');
  container.innerHTML = messages.length === 0 ? '<div class="empty-state"><p>Say hello! 👋</p></div>' :
    messages.map(m => renderBubble(m)).join('');
  container.scrollTop = container.scrollHeight;
  loadConversations();
}

function renderBubble(msg) {
  const sent = msg.sender_id === currentUser?.id;
  const hasImage = !!msg.image_url;
  const imageBlock = hasImage
    ? `<img src="${msg.image_url}" class="chat-image" onclick="window.open('${msg.image_url}', '_blank')" />`
    : '';
  const textBlock = msg.content ? `<div class="chat-text">${escapeHtml(msg.content)}</div>` : '';
  return `<div class="message-wrap ${sent ? 'sent' : 'received'}">
    ${!sent ? `<img src="${msg.avatar_url || avatarFallback(msg.username)}" class="avatar-sm" style="width:28px;height:28px" />` : ''}
    <div class="bubble ${sent ? 'sent' : 'received'} ${hasImage ? 'bubble-image' : ''}">${imageBlock}${textBlock}</div>
    <span class="msg-time">${getShortTime(msg.created_at)}</span>
  </div>`;
}

function appendMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', renderBubble(msg));
  container.scrollTop = container.scrollHeight;
}

async function sendMessage(receiverId) {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  const res = await api('/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiver_id: receiverId, content })
  });
  if (res?.ok) {
    const msg = await res.json();
    appendMessage(msg);
    loadConversations();
  } else if (res) {
    const data = await res.json().catch(() => ({}));
    toast(data.error || 'Message failed');
  }
}

async function sendMessageImage(receiverId, input) {
  const file = input?.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('receiver_id', receiverId);
  formData.append('image', file);

  const res = await api('/messages', {
    method: 'POST',
    body: formData
  });

  input.value = '';

  if (res?.ok) {
    const msg = await res.json();
    appendMessage(msg);
    loadConversations();
  } else if (res) {
    const data = await res.json().catch(() => ({}));
    toast(data.error || 'Image send failed');
  }
}

function startDM(userId, username, avatar, friendId = '') {
  navigate('messages');
  setTimeout(() => openChat(userId, username, avatar, friendId), 100);
}

window.addEventListener('resize', () => {
  if (currentPage !== 'messages') return;
  setMessagesMobileView(currentChatUserId ? 'chat' : 'list');
});

function openNewConversation() { document.getElementById('new-convo-modal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

async function searchConvoUsers(query) {
  if (query.length < 2) { document.getElementById('convo-search-results').innerHTML = ''; return; }
  const res = await api(`/messages/friends/search/${encodeURIComponent(query)}`);
  if (!res) return;
  const users = await res.json();
  if (!users.length) {
    document.getElementById('convo-search-results').innerHTML = `<div class="empty-state" style="padding:16px"><p>No friends found</p></div>`;
    return;
  }
  document.getElementById('convo-search-results').innerHTML = users.map(u => `
    <div class="search-dropdown-item" onclick="closeModal('new-convo-modal');startDM(${u.id},'${u.username}','${u.avatar_url || avatarFallback(u.username)}','${u.friend_id || ''}')">
      <img src="${u.avatar_url || avatarFallback(u.username)}" class="avatar-sm" onerror="this.src='${avatarFallback(u.username)}'" />
      <div class="info"><p>${u.username}${renderVerifiedBadge(u)}</p><small>${u.full_name || ''}</small></div>
    </div>
  `).join('');
}

// ─── NOTIFICATIONS ────────────────────────────────────────────
async function loadNotifications() {
  const container = document.getElementById('notifications-list');
  container.innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';
  const res = await api('/notifications');
  if (!res) return;
  const notifs = await res.json();
  document.getElementById('notif-badge').style.display = 'none';
  if (notifs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🔔</div><h3>No activity yet</h3><p>Interactions will appear here</p></div>`;
    return;
  }
  container.innerHTML = notifs.map(n => {
    const icon = n.type === 'like'
      ? { cls: 'like', ico: '❤️' }
      : (n.type === 'follow' || n.type === 'friend_accept')
        ? { cls: 'follow', ico: '🤝' }
        : { cls: 'comment', ico: '💬' };

    const text = n.type === 'like'
      ? 'liked your post'
      : n.type === 'follow'
        ? (n.friend_request_status === 'pending' ? 'sent you a friend request' : 'is now your friend')
        : n.type === 'friend_accept'
          ? 'accepted your friend request'
          : 'commented on your post';

    const requestActions = (n.type === 'follow' && n.friend_request_status === 'pending')
      ? `<div class="notif-actions" onclick="event.stopPropagation()">
          <button class="btn-primary" onclick="acceptFriendRequest(${n.from_user_id})">Accept</button>
          <button class="btn-secondary" onclick="rejectFriendRequest(${n.from_user_id})">Reject</button>
        </div>`
      : '';

    const avatar = n.avatar_url || avatarFallback(n.username);
    return `<div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="viewProfile('${n.username}')">
      <img src="${avatar}" class="avatar-sm" onerror="this.src='${avatarFallback(n.username)}'" />
      <div class="notif-text">
        <strong>${n.username}${renderVerifiedBadge(n)}</strong> ${text}
        ${requestActions}
      </div>
      <div class="notif-time">${getTimeAgo(n.created_at)}</div>
    </div>`;
  }).join('');
}

async function acceptFriendRequest(fromUserId) {
  const res = await api(`/friend-requests/${fromUserId}/accept`, { method: 'POST' });
  if (!res?.ok) {
    const data = await res?.json().catch(() => ({}));
    toast(data?.error || 'Could not accept request');
    return;
  }
  toast('Friend request accepted');
  loadNotifications();
  loadConversations();
}

async function rejectFriendRequest(fromUserId) {
  const res = await api(`/friend-requests/${fromUserId}/reject`, { method: 'POST' });
  if (!res?.ok) {
    const data = await res?.json().catch(() => ({}));
    toast(data?.error || 'Could not reject request');
    return;
  }
  toast('Friend request rejected');
  loadNotifications();
  loadConversations();
}

async function pollNotifications() {
  const res = await api('/notifications/unread-count');
  if (res?.ok) {
    const data = await res.json();
    const badge = document.getElementById('notif-badge');
    badge.textContent = data.count;
    badge.style.display = data.count > 0 ? '' : 'none';
  }
  setTimeout(pollNotifications, 30000);
}

async function loadNotificationCount() {
  pollNotifications();
}

// ─── SEARCH ───────────────────────────────────────────────────
let searchTimeout;
async function searchUsers(query) {
  clearTimeout(searchTimeout);
  const dropdown = document.getElementById('search-results');
  if (query.length < 2) { dropdown.classList.remove('visible'); return; }
  searchTimeout = setTimeout(async () => {
    const normalized = normalizeLookupInput(query);
    const res = await api(`/users/search/${encodeURIComponent(normalized)}`);
    if (!res) return;
    let users = await res.json();
    if (!users.length) {
      const exactRes = await api(`/users/find/${encodeURIComponent(normalized)}`);
      if (exactRes?.ok) users = [await exactRes.json()];
    }
    dropdown.innerHTML = users.map(u => `
      <div class="search-dropdown-item" onclick="viewProfile('${u.username}');document.getElementById('search-results').classList.remove('visible')">
        <img src="${u.avatar_url || avatarFallback(u.username)}" class="avatar-sm" onerror="this.src='${avatarFallback(u.username)}'" />
        <div class="info"><p>${u.username}${renderVerifiedBadge(u)}</p><small>${formatFriendId(u)} · ${u.yoga_style || 'Yoga'}</small></div>
      </div>
    `).join('');
    dropdown.classList.toggle('visible', users.length > 0);
  }, 300);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-bar')) document.getElementById('search-results')?.classList.remove('visible');
  if (!e.target.closest('.mobile-topbar')) closeMobileMenu();
});

// ─── SUGGESTIONS ──────────────────────────────────────────────
async function loadSuggestions() {
  const res = await api('/posts/explore?page=1');
  if (!res) return;
  const posts = await res.json();
  const seen = new Set([currentUser?.id]);
  const users = posts.filter(p => { if (seen.has(p.user_id)) return false; seen.add(p.user_id); return true; }).slice(0, 6);
  document.getElementById('suggestions-list').innerHTML = users.map(u => `
    <div class="suggestion-item">
      <img src="${u.avatar_url || avatarFallback(u.username)}" class="avatar-sm" onclick="viewProfile('${u.username}')" style="cursor:pointer" onerror="this.src='${avatarFallback(u.username)}'" />
      <div class="info">
        <p onclick="viewProfile('${u.username}')" style="cursor:pointer">${u.username}${renderVerifiedBadge(u)}</p>
        <small>${u.yoga_style || 'Yoga'}</small>
      </div>
      <button class="btn-follow" onclick="quickFollow(${u.user_id}, '${u.username}', this)">Follow</button>
    </div>
  `).join('');
}

function loadFriendsPage() {
  const container = document.getElementById('friends-search-results');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><div class="icon">🤝</div><h3>Find Your Friends</h3><p>Search by username, Friend ID, or numeric user ID.</p></div>`;
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (!menu) return;
  menu.classList.toggle('hidden');
}

function closeMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (!menu) return;
  menu.classList.add('hidden');
}

function navigateFromMobileMenu(page) {
  closeMobileMenu();
  navigate(page);
}

async function searchFriends(query) {
  const container = document.getElementById('friends-search-results');
  if (!container) return;

  const term = normalizeLookupInput(query);
  if (!term) {
    loadFriendsPage();
    return;
  }

  container.innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';
  const res = await api(`/users/search/${encodeURIComponent(term)}`);
  if (!res?.ok) {
    container.innerHTML = '<div class="empty-state"><p>Could not search users right now.</p></div>';
    return;
  }

  let users = await res.json();
  if (!users.length) {
    const exactRes = await api(`/users/find/${encodeURIComponent(term)}`);
    if (exactRes?.ok) users = [await exactRes.json()];
  }
  if (!users.length) {
    container.innerHTML = '<div class="empty-state"><p>No users found for that username or ID.</p></div>';
    return;
  }

  container.innerHTML = users.map(u => {
    const avatar = u.avatar_url || avatarFallback(u.username);
    const isMe = u.id === currentUser?.id;
    const friendBtnClass = u.is_friend || u.is_following ? 'btn-secondary' : 'btn-primary';
    return `
      <div class="friend-card">
        <img src="${avatar}" class="avatar-md" onerror="this.src='${avatarFallback(u.username)}'" />
        <div class="friend-meta">
          <p class="friend-name" onclick="viewProfile('${u.username}')">${u.full_name || u.username}${renderVerifiedBadge(u)}</p>
          <p class="friend-username">@${u.username}</p>
          <p class="friend-id">ID: ${formatFriendId(u)}</p>
        </div>
        <div class="friend-actions">
          <button class="btn-secondary" onclick="viewProfile('${u.username}')">View</button>
          ${isMe ? '<button class="btn-secondary" disabled>You</button>' : `<button class="${friendBtnClass}" onclick="toggleFollow(${u.id}, this)">${getFriendButtonLabel(u)}</button>`}
        </div>
      </div>
    `;
  }).join('');
}

async function quickFollow(userId, username, btn) {
  const res = await api(`/users/${userId}/follow`, { method: 'POST' });
  if (res?.ok) {
    const data = await res.json();
    applyFriendButtonState(btn, data);
    toast(data.is_friend ? `You and ${username} are now friends!` : (data.is_following ? `Friend request sent to ${username}` : `Friend request cancelled for ${username}`));
  }
}

// ─── SHARE ────────────────────────────────────────────────────
function sharePost(postId) {
  const url = `${location.origin}/?post=${postId}`;
  if (navigator.share) {
    navigator.share({ title: 'YogaFlow Post', url });
  } else {
    navigator.clipboard.writeText(url);
    toast('Link copied!');
  }
}

// ─── UTILS ────────────────────────────────────────────────────
function getTimeAgo(dateStr) {
  if (!dateStr) return 'new';
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d`;
  return new Date(dateStr).toLocaleDateString();
}
function getShortTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// ─── SCROLL PAGINATION ─────────────────────────────────────────
window.addEventListener('scroll', () => {
  if (currentPage !== 'feed') return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
    loadFeed();
  }
});

// ─── INIT ON LOAD ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (token && currentUser) {
    initApp();
  } else {
    setAuthUIState(false);
  }
});
