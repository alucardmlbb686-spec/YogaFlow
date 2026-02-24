const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

try {
  require('dotenv').config();
} catch {}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── ENV CONFIG ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'yoga_secret_key_2024';
const DATABASE_URL = process.env.DATABASE_URL;
const hasPlaceholderDatabaseUrl =
  !DATABASE_URL ||
  DATABASE_URL.includes('ep-xxx.neon.tech') ||
  DATABASE_URL.includes('user:password');

let isDatabaseReady = false;

// ─── DATABASE ─────────────────────────────────────────────────
let pool = null;
if (!hasPlaceholderDatabaseUrl) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.warn('⚠️ DATABASE_URL is not configured. API routes will return 503 until you set it in .env');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const UPLOADS_DIR = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/health', (req, res) => {
  res.json({
    server: 'ok',
    database: isDatabaseReady ? 'ok' : 'not_configured'
  });
});

app.use('/api', (req, res, next) => {
  if (isDatabaseReady || req.path === '/health') return next();
  return res.status(503).json({
    error: 'Database is not configured. Add DATABASE_URL to .env and restart the server.'
  });
});

// ─── UPLOAD CONFIG ────────────────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only image files are allowed!'));
  }
});

// ─── DB INIT ──────────────────────────────────────────────────
async function initDB() {
  if (!pool) {
    throw new Error('DATABASE_URL is missing or still using the placeholder value.');
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        friend_id VARCHAR(16) UNIQUE,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name VARCHAR(100),
        bio TEXT,
        avatar_url TEXT,
        yoga_style VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        caption TEXT,
        image_url TEXT NOT NULL,
        likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, post_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS follows (
        id SERIAL PRIMARY KEY,
        follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(follower_id, following_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        post_id INTEGER,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_id VARCHAR(16);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT;
      UPDATE users
      SET friend_id = 'YF' || LPAD(id::text, 6, '0')
      WHERE friend_id IS NULL OR friend_id = '';
      CREATE UNIQUE INDEX IF NOT EXISTS users_friend_id_unique ON users(friend_id);
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── AUTH ROUTES ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, full_name, yoga_style } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, full_name, yoga_style) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, email, full_name, yoga_style, avatar_url, friend_id',
      [username, email, hash, full_name, yoga_style]
    );
    let user = result.rows[0];
    if (!user.friend_id) {
      const generatedFriendId = `YF${String(user.id).padStart(6, '0')}`;
      const updated = await pool.query(
        'UPDATE users SET friend_id = $1 WHERE id = $2 RETURNING id, username, email, full_name, yoga_style, avatar_url, friend_id',
        [generatedFriendId, user.id]
      );
      user = updated.rows[0];
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── USER ROUTES ──────────────────────────────────────────────
app.get('/api/users/me', auth, async (req, res) => {
  const result = await pool.query('SELECT id, friend_id, username, email, full_name, bio, avatar_url, yoga_style, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

app.get('/api/users/find/:identifier', auth, async (req, res) => {
  const identifier = req.params.identifier.trim();
  const normalizedIdentifier = identifier.replace(/^id\s*[:\-]?\s*/i, '').replace(/^@/, '').trim();
  const compactIdentifier = normalizedIdentifier.replace(/[\s-]+/g, '');
  const parsedId = Number.parseInt(compactIdentifier, 10);
  const numericId = Number.isNaN(parsedId) ? null : parsedId;

  const result = await pool.query(
    `SELECT u.id, u.friend_id, u.username, u.full_name, u.bio, u.avatar_url, u.yoga_style, u.created_at,
      COUNT(DISTINCT f1.follower_id) as followers_count,
      COUNT(DISTINCT f2.following_id) as following_count,
      COUNT(DISTINCT p.id) as posts_count,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = $5 AND following_id = u.id) as is_following,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $5) as follows_you,
      (
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $5 AND following_id = u.id)
        AND EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $5)
      ) as is_friend
     FROM users u
     LEFT JOIN follows f1 ON f1.following_id = u.id
     LEFT JOIN follows f2 ON f2.follower_id = u.id
     LEFT JOIN posts p ON p.user_id = u.id
      WHERE LOWER(u.username) = LOWER($1)
        OR LOWER(u.username) = LOWER($2)
        OR LOWER(u.friend_id) = LOWER($1)
        OR LOWER(u.friend_id) = LOWER($2)
        OR REPLACE(REPLACE(LOWER(u.friend_id), ' ', ''), '-', '') = LOWER($4)
        OR ($3::INT IS NOT NULL AND u.id = $3)
     GROUP BY u.id
     LIMIT 1`,
     [identifier, normalizedIdentifier, numericId, compactIdentifier.toLowerCase(), req.user.id]
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

app.get('/api/users/:username', auth, async (req, res) => {
  const username = (req.params.username || '').trim();
  const result = await pool.query(
    `SELECT u.id, u.friend_id, u.username, u.full_name, u.bio, u.avatar_url, u.yoga_style, u.created_at,
      COUNT(DISTINCT f1.follower_id) as followers_count,
      COUNT(DISTINCT f2.following_id) as following_count,
      COUNT(DISTINCT p.id) as posts_count,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) as is_following,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $2) as follows_you,
      (
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id)
        AND EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $2)
      ) as is_friend
     FROM users u
     LEFT JOIN follows f1 ON f1.following_id = u.id
     LEFT JOIN follows f2 ON f2.follower_id = u.id
     LEFT JOIN posts p ON p.user_id = u.id
     WHERE LOWER(u.username) = LOWER($1)
     GROUP BY u.id`,
    [username, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

app.put('/api/users/me', auth, upload.single('avatar'), async (req, res) => {
  const { full_name, bio, yoga_style } = req.body;
  const avatar_url = req.file ? `/uploads/${req.file.filename}` : undefined;
  const fields = [];
  const values = [];
  let i = 1;
  if (full_name !== undefined) { fields.push(`full_name = $${i++}`); values.push(full_name); }
  if (bio !== undefined) { fields.push(`bio = $${i++}`); values.push(bio); }
  if (yoga_style !== undefined) { fields.push(`yoga_style = $${i++}`); values.push(yoga_style); }
  if (avatar_url) { fields.push(`avatar_url = $${i++}`); values.push(avatar_url); }
  values.push(req.user.id);
  const result = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, username, email, full_name, bio, avatar_url, yoga_style`,
    values
  );
  res.json(result.rows[0]);
});

app.get('/api/users/search/:query', auth, async (req, res) => {
  const rawQuery = req.params.query.trim();
  const normalizedQuery = rawQuery.replace(/^id\s*[:\-]?\s*/i, '').replace(/^@/, '').trim();
  const compactQuery = normalizedQuery.replace(/[\s-]+/g, '');
  const parsedId = Number.parseInt(compactQuery, 10);
  const numericId = Number.isNaN(parsedId) ? null : parsedId;
  const result = await pool.query(
    `SELECT u.id, u.friend_id, u.username, u.full_name, u.avatar_url, u.yoga_style,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) as is_following,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $2) as follows_you,
      (
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id)
        AND EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = $2)
      ) as is_friend
     FROM users u
     WHERE u.username ILIKE $1
        OR u.username ILIKE $4
        OR u.full_name ILIKE $1
        OR u.full_name ILIKE $4
        OR u.friend_id ILIKE $1
        OR u.friend_id ILIKE $4
        OR REPLACE(REPLACE(LOWER(u.friend_id), ' ', ''), '-', '') LIKE LOWER($5)
        OR ($3::INT IS NOT NULL AND u.id = $3)
     ORDER BY
      CASE
        WHEN REPLACE(REPLACE(LOWER(u.friend_id), ' ', ''), '-', '') = LOWER($6) THEN 0
        WHEN LOWER(u.friend_id) = LOWER($4) THEN 1
        WHEN LOWER(u.username) = LOWER($4) THEN 2
        ELSE 2
      END,
      u.created_at DESC
     LIMIT 20`,
    [`%${rawQuery}%`, req.user.id, numericId, `%${normalizedQuery}%`, `%${compactQuery}%`, compactQuery]
  );
  res.json(result.rows);
});

// ─── POST ROUTES ──────────────────────────────────────────────
app.post('/api/posts', auth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });
  const { caption } = req.body;
  const image_url = `/uploads/${req.file.filename}`;
  const result = await pool.query(
    'INSERT INTO posts (user_id, caption, image_url) VALUES ($1,$2,$3) RETURNING *',
    [req.user.id, caption, image_url]
  );
  const post = result.rows[0];
  const user = await pool.query('SELECT username, full_name, avatar_url, friend_id FROM users WHERE id = $1', [req.user.id]);
  res.json({ ...post, ...user.rows[0] });
});

app.get('/api/posts/feed', auth, async (req, res) => {
  const { page = 1 } = req.query;
  const limit = 10;
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT p.*, u.username, u.full_name, u.avatar_url, u.friend_id,
      EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND post_id = p.id) as is_liked
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id = $1 OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json(result.rows);
});

app.get('/api/posts/explore', auth, async (req, res) => {
  const { page = 1 } = req.query;
  const limit = 12;
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT p.*, u.username, u.full_name, u.avatar_url, u.friend_id,
      EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND post_id = p.id) as is_liked
     FROM posts p
     JOIN users u ON u.id = p.user_id
     ORDER BY p.likes_count DESC, p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json(result.rows);
});

app.get('/api/posts/user/:username', auth, async (req, res) => {
  const username = (req.params.username || '').trim();
  const result = await pool.query(
    `SELECT p.*, u.username, u.full_name, u.avatar_url, u.friend_id,
      EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND post_id = p.id) as is_liked
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE LOWER(u.username) = LOWER($2)
     ORDER BY p.created_at DESC`,
    [req.user.id, username]
  );
  res.json(result.rows);
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// ─── LIKES ────────────────────────────────────────────────────
app.post('/api/posts/:id/like', auth, async (req, res) => {
  const postId = req.params.id;
  try {
    await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1,$2)', [req.user.id, postId]);
    await pool.query('UPDATE posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (post.rows[0].user_id !== req.user.id) {
      await pool.query('INSERT INTO notifications (user_id, from_user_id, type, post_id) VALUES ($1,$2,$3,$4)',
        [post.rows[0].user_id, req.user.id, 'like', postId]);
    }
    res.json({ liked: true });
  } catch {
    await pool.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, postId]);
    await pool.query('UPDATE posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1', [postId]);
    res.json({ liked: false });
  }
});

// ─── COMMENTS ─────────────────────────────────────────────────
app.get('/api/posts/:id/comments', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, u.username, u.full_name, u.avatar_url, u.friend_id FROM comments c
     JOIN users u ON u.id = c.user_id WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
    [req.params.id]
  );
  res.json(result.rows);
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const result = await pool.query(
    'INSERT INTO comments (user_id, post_id, content) VALUES ($1,$2,$3) RETURNING *',
    [req.user.id, req.params.id, content]
  );
  await pool.query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1', [req.params.id]);
  const user = await pool.query('SELECT username, full_name, avatar_url, friend_id FROM users WHERE id = $1', [req.user.id]);
  res.json({ ...result.rows[0], ...user.rows[0] });
});

// ─── FOLLOWS ──────────────────────────────────────────────────
app.post('/api/users/:id/follow', auth, async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(targetId)) return res.status(400).json({ error: 'Invalid user id' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
  try {
    await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1,$2)', [req.user.id, targetId]);
    await pool.query('INSERT INTO notifications (user_id, from_user_id, type) VALUES ($1,$2,$3)',
      [targetId, req.user.id, 'follow']);
    const status = await pool.query(
      `SELECT
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2) as is_following,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1) as follows_you,
        (
          EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)
          AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1)
        ) as is_friend`,
      [req.user.id, targetId]
    );
    res.json({
      following: true,
      is_following: status.rows[0].is_following,
      follows_you: status.rows[0].follows_you,
      is_friend: status.rows[0].is_friend
    });
  } catch {
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.user.id, targetId]);
    const status = await pool.query(
      `SELECT
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2) as is_following,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1) as follows_you,
        (
          EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)
          AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1)
        ) as is_friend`,
      [req.user.id, targetId]
    );
    res.json({
      following: false,
      is_following: status.rows[0].is_following,
      follows_you: status.rows[0].follows_you,
      is_friend: status.rows[0].is_friend
    });
  }
});

app.post('/api/friend-requests/:fromUserId/accept', auth, async (req, res) => {
  const fromUserId = Number.parseInt(req.params.fromUserId, 10);
  if (Number.isNaN(fromUserId)) return res.status(400).json({ error: 'Invalid user id' });
  if (fromUserId === req.user.id) return res.status(400).json({ error: 'Invalid request' });

  const pending = await pool.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2 LIMIT 1',
    [fromUserId, req.user.id]
  );
  if (!pending.rows[0]) return res.status(404).json({ error: 'Friend request not found' });

  await pool.query(
    'INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT (follower_id, following_id) DO NOTHING',
    [req.user.id, fromUserId]
  );
  await pool.query(
    'INSERT INTO notifications (user_id, from_user_id, type) VALUES ($1,$2,$3)',
    [fromUserId, req.user.id, 'friend_accept']
  );

  res.json({ accepted: true, is_friend: true });
});

app.post('/api/friend-requests/:fromUserId/reject', auth, async (req, res) => {
  const fromUserId = Number.parseInt(req.params.fromUserId, 10);
  if (Number.isNaN(fromUserId)) return res.status(400).json({ error: 'Invalid user id' });
  if (fromUserId === req.user.id) return res.status(400).json({ error: 'Invalid request' });

  await pool.query(
    'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
    [fromUserId, req.user.id]
  );

  res.json({ rejected: true });
});

// ─── MESSAGES ─────────────────────────────────────────────────
app.get('/api/messages/conversations', auth, async (req, res) => {
  const result = await pool.query(
    `WITH friends AS (
      SELECT f1.following_id AS partner_id
      FROM follows f1
      JOIN follows f2
        ON f2.follower_id = f1.following_id
       AND f2.following_id = f1.follower_id
      WHERE f1.follower_id = $1
    ), latest_messages AS (
      SELECT DISTINCT ON (
        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
      )
        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS partner_id,
        m.content,
        m.created_at
      FROM messages m
      WHERE m.sender_id = $1 OR m.receiver_id = $1
      ORDER BY
        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END,
        m.created_at DESC
    )
    SELECT
      fr.partner_id,
      u.username,
      u.full_name,
      u.avatar_url,
      u.friend_id,
      lm.content as last_message,
      lm.created_at as last_at,
      (SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND sender_id = fr.partner_id AND is_read = FALSE) as unread_count
    FROM friends fr
    JOIN users u ON u.id = fr.partner_id
    LEFT JOIN latest_messages lm ON lm.partner_id = fr.partner_id
    ORDER BY COALESCE(lm.created_at, u.created_at) DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

app.get('/api/messages/friends/search/:query', auth, async (req, res) => {
  const rawQuery = req.params.query.trim();
  if (rawQuery.length < 2) return res.json([]);

  const parsedId = Number.parseInt(rawQuery, 10);
  const numericId = Number.isNaN(parsedId) ? null : parsedId;

  const result = await pool.query(
    `SELECT u.id, u.friend_id, u.username, u.full_name, u.avatar_url
     FROM users u
     WHERE u.id IN (
       SELECT f1.following_id
       FROM follows f1
       JOIN follows f2
         ON f2.follower_id = f1.following_id
        AND f2.following_id = f1.follower_id
       WHERE f1.follower_id = $2
     )
       AND (
         u.username ILIKE $1
         OR u.full_name ILIKE $1
         OR u.friend_id ILIKE $1
         OR ($3::INT IS NOT NULL AND u.id = $3)
       )
     ORDER BY u.username ASC
     LIMIT 20`,
    [`%${rawQuery}%`, req.user.id, numericId]
  );

  res.json(result.rows);
});

app.get('/api/messages/:userId', auth, async (req, res) => {
  const otherUserId = Number.parseInt(req.params.userId, 10);
  if (Number.isNaN(otherUserId)) return res.status(400).json({ error: 'Invalid user id' });

  const friendship = await pool.query(
    `SELECT (
      EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1)
    ) as is_friend`,
    [req.user.id, otherUserId]
  );
  if (!friendship.rows[0]?.is_friend) return res.status(403).json({ error: 'Only friends can chat' });

  await pool.query('UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2', [otherUserId, req.user.id]);
  const result = await pool.query(
    `SELECT m.*, u.username, u.avatar_url, u.friend_id FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
     ORDER BY m.created_at ASC LIMIT 100`,
    [req.user.id, otherUserId]
  );
  res.json(result.rows);
});

app.post('/api/messages', auth, upload.single('image'), async (req, res) => {
  const { receiver_id, content } = req.body;
  const targetUserId = Number.parseInt(receiver_id, 10);
  if (Number.isNaN(targetUserId)) return res.status(400).json({ error: 'Invalid user id' });

  const textContent = String(content || '').trim();
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  if (!textContent && !imageUrl) return res.status(400).json({ error: 'Message text or image is required' });

  const friendship = await pool.query(
    `SELECT (
      EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = $1)
    ) as is_friend`,
    [req.user.id, targetUserId]
  );
  if (!friendship.rows[0]?.is_friend) return res.status(403).json({ error: 'Only friends can chat' });

  const messageType = imageUrl ? 'image' : 'text';
  const result = await pool.query(
    'INSERT INTO messages (sender_id, receiver_id, content, message_type, image_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.id, targetUserId, textContent || '', messageType, imageUrl]
  );
  const msg = result.rows[0];
  // broadcast via WebSocket
  const senderInfo = await pool.query('SELECT username, avatar_url, friend_id FROM users WHERE id = $1', [req.user.id]);
  const payload = { ...msg, ...senderInfo.rows[0] };
  broadcastToUser(targetUserId, { type: 'new_message', data: payload });
  broadcastToUser(req.user.id, { type: 'new_message', data: payload });
  res.json(payload);
});

// ─── NOTIFICATIONS ────────────────────────────────────────────
app.get('/api/notifications', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT n.*, u.username, u.full_name, u.avatar_url, u.friend_id,
      CASE
        WHEN n.type = 'follow'
          AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = n.from_user_id AND f.following_id = n.user_id)
          AND NOT EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id = n.user_id AND f2.following_id = n.from_user_id)
          THEN 'pending'
        WHEN n.type = 'follow'
          AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = n.from_user_id AND f.following_id = n.user_id)
          AND EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id = n.user_id AND f2.following_id = n.from_user_id)
          THEN 'accepted'
        ELSE NULL
      END as friend_request_status
     FROM notifications n
     JOIN users u ON u.id = n.from_user_id
     WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 30`,
    [req.user.id]
  );
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
  res.json(result.rows);
});

app.get('/api/notifications/unread-count', auth, async (req, res) => {
  const result = await pool.query('SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
  res.json({ count: parseInt(result.rows[0].count) });
});

// ─── WEBSOCKET ────────────────────────────────────────────────
const clients = new Map(); // userId -> ws

wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        clients.set(decoded.id, ws);
        ws.userId = decoded.id;
      }
    } catch {}
  });
  ws.on('close', () => {
    if (ws.userId) clients.delete(ws.userId);
  });
});

function broadcastToUser(userId, data) {
  const ws = clients.get(parseInt(userId));
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── START ────────────────────────────────────────────────────
async function startServer() {
  try {
    await initDB();
    isDatabaseReady = true;
  } catch (error) {
    console.error(`⚠️ Database init failed: ${error.message}`);
  }

  server.listen(PORT, () => console.log(`🧘 YogaFlow server running on port ${PORT}`));
}

startServer();