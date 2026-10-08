const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false }));
app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });

const auth = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const STATUSES = ['Todo', 'In Progress', 'Done'];
const PRIORITIES = ['Low', 'Medium', 'High'];

app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

// ---------- Module 1: Authentication ----------
app.get('/register', (req, res) => res.render('auth', { mode: 'register', error: null }));
app.post('/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.render('auth', { mode: 'register', error: 'All fields required; password min 6 characters.' });
  const [dup] = await db.query('SELECT id FROM users WHERE email=?', [email]);
  if (dup.length) return res.render('auth', { mode: 'register', error: 'Email already registered.' });
  await db.query('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)', [name, email, await bcrypt.hash(password, 10)]);
  res.redirect('/login');
}));
app.get('/login', (req, res) => res.render('auth', { mode: 'login', error: null }));
app.post('/login', wrap(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM users WHERE email=?', [req.body.email || '']);
  if (!rows.length || !(await bcrypt.compare(req.body.password || '', rows[0].password_hash)))
    return res.render('auth', { mode: 'login', error: 'Invalid email or password.' });
  req.session.user = { id: rows[0].id, name: rows[0].name };
  res.redirect('/dashboard');
}));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- Dashboard / Reports ----------
app.get('/dashboard', auth, wrap(async (req, res) => {
  const uid = req.session.user.id;
  const [byStatus] = await db.query('SELECT status, COUNT(*) c FROM tasks WHERE user_id=? GROUP BY status', [uid]);
  const [[o]] = await db.query("SELECT COUNT(*) c FROM tasks WHERE user_id=? AND due_date<CURDATE() AND status<>'Done'", [uid]);
  const [[p]] = await db.query('SELECT COUNT(*) c FROM projects WHERE user_id=?', [uid]);
  const counts = { Todo: 0, 'In Progress': 0, Done: 0 };
  byStatus.forEach(r => (counts[r.status] = r.c));
  res.render('dashboard', { counts, overdue: o.c, projects: p.c });
}));

// ---------- Module 2: Projects ----------
app.get('/projects', auth, wrap(async (req, res) => {
  const [projects] = await db.query(
    'SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) task_count FROM projects p WHERE user_id=? ORDER BY p.id DESC', [req.session.user.id]);
  res.render('projects', { projects });
}));
app.get('/projects/new', auth, (req, res) => res.render('project_form', { project: {}, error: null }));
app.post('/projects', auth, wrap(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.render('project_form', { project: req.body, error: 'Project name is required.' });
  await db.query('INSERT INTO projects (user_id,name,description) VALUES (?,?,?)', [req.session.user.id, name.trim(), description]);
  res.redirect('/projects');
}));
app.get('/projects/:id/edit', auth, wrap(async (req, res) => {
  const [r] = await db.query('SELECT * FROM projects WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
  if (!r.length) return res.redirect('/projects');
  res.render('project_form', { project: r[0], error: null });
}));
app.post('/projects/:id', auth, wrap(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.render('project_form', { project: { ...req.body, id: req.params.id }, error: 'Project name is required.' });
  await db.query('UPDATE projects SET name=?, description=? WHERE id=? AND user_id=?', [name.trim(), description, req.params.id, req.session.user.id]);
  res.redirect('/projects');
}));
app.post('/projects/:id/delete', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM projects WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
  res.redirect('/projects');
}));

// ---------- Module 3: Tasks ----------
const loadProjects = uid => db.query('SELECT id,name FROM projects WHERE user_id=? ORDER BY name', [uid]).then(r => r[0]);
app.get('/tasks', auth, wrap(async (req, res) => {
  const uid = req.session.user.id;
  const { q = '', status = '', project = '' } = req.query;
  let sql = 'SELECT t.*, p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.user_id=?';
  const args = [uid];
  if (q) { sql += ' AND t.title LIKE ?'; args.push(`%${q}%`); }
  if (status) { sql += ' AND t.status=?'; args.push(status); }
  if (project) { sql += ' AND t.project_id=?'; args.push(project); }
  sql += ' ORDER BY t.due_date IS NULL, t.due_date, t.id DESC';
  const [tasks] = await db.query(sql, args);
  res.render('tasks', { tasks, projects: await loadProjects(uid), q, status, project, STATUSES });
}));
app.get('/tasks/new', auth, wrap(async (req, res) =>
  res.render('task_form', { task: {}, projects: await loadProjects(req.session.user.id), error: null, STATUSES, PRIORITIES })));
const saveTask = isNew => wrap(async (req, res) => {
  const uid = req.session.user.id;
  const { title, description, project_id, priority, status, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.render('task_form', { task: { ...req.body, id: req.params.id }, projects: await loadProjects(uid), error: 'Task title is required.', STATUSES, PRIORITIES });
  }
  const vals = [title.trim(), description, project_id || null, priority, status, due_date || null];
  if (isNew) await db.query('INSERT INTO tasks (title,description,project_id,priority,status,due_date,user_id) VALUES (?,?,?,?,?,?,?)', [...vals, uid]);
  else await db.query('UPDATE tasks SET title=?,description=?,project_id=?,priority=?,status=?,due_date=? WHERE id=? AND user_id=?', [...vals, req.params.id, uid]);
  res.redirect('/tasks');
});
app.post('/tasks', auth, saveTask(true));
app.get('/tasks/:id/edit', auth, wrap(async (req, res) => {
  const uid = req.session.user.id;
  const [r] = await db.query('SELECT * FROM tasks WHERE id=? AND user_id=?', [req.params.id, uid]);
  if (!r.length) return res.redirect('/tasks');
  res.render('task_form', { task: r[0], projects: await loadProjects(uid), error: null, STATUSES, PRIORITIES });
}));
app.post('/tasks/:id', auth, saveTask(false));
app.post('/tasks/:id/done', auth, wrap(async (req, res) => {
  await db.query("UPDATE tasks SET status='Done' WHERE id=? AND user_id=?", [req.params.id, req.session.user.id]);
  res.redirect('/tasks');
}));
app.post('/tasks/:id/delete', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM tasks WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
  res.redirect('/tasks');
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).send('Server error: ' + err.message); });

// Create tables automatically on startup (safe: IF NOT EXISTS)
(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
    console.log('Schema ready');
  } catch (e) { console.error('Schema init failed:', e.message); }
  app.listen(process.env.PORT || 3000, () => console.log('Listening'));
})();
