import os, sys, json, sqlite3, requests, time
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, send_from_directory, flash, session, jsonify
from werkzeug.utils import secure_filename
from functools import wraps

from werkzeug.middleware.proxy_fix import ProxyFix
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = os.environ.get('FLASK_SECRET', 'cw-fixes-secret-key-change-in-prod')
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')

ADMIN_PASSWORD = os.environ.get('CW_ADMIN_PASS', 'cwtools2026')
DATABASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixes.db')
COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'luatools_cookies.txt')
PREFIX = '/CWshadow'

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

def get_lua_session():
    cookies = {}
    if os.path.exists(COOKIE_FILE):
        with open(COOKIE_FILE) as f:
            for line in f:
                line = line.strip().rstrip(';')
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    cookies[k.strip()] = v.strip()
    s = requests.Session()
    for k, v in cookies.items():
        s.cookies.set(k, v, domain='lua.tools')
    s.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    s.headers['Referer'] = 'https://lua.tools/'
    return s

def fetch_fix_from_lua(fix_id):
    s = get_lua_session()
    url = f"https://lua.tools/api/denuvo/download?fix={fix_id}&slot=fix"
    try:
        r = s.get(url, timeout=30)
        if r.status_code == 200 and len(r.content) > 100:
            return r.content
    except Exception as e:
        print(f"  fetch error: {e}", flush=True)
    return None

def get_db():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    db = get_db()
    db.execute('''CREATE TABLE IF NOT EXISTS fixes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_name TEXT NOT NULL,
        app_id TEXT DEFAULT '',
        category TEXT DEFAULT 'bypass',
        description TEXT DEFAULT '',
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        header_image TEXT DEFAULT '',
        tags TEXT DEFAULT '',
        source TEXT DEFAULT 'manual',
        lua_fix_id TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
    )''')
    cols = [r[1] for r in db.execute("PRAGMA table_info(fixes)").fetchall()]
    if 'header_image' not in cols:
        db.execute('ALTER TABLE fixes ADD COLUMN header_image TEXT DEFAULT ""')
    if 'tags' not in cols:
        db.execute('ALTER TABLE fixes ADD COLUMN tags TEXT DEFAULT ""')
    if 'source' not in cols:
        db.execute('ALTER TABLE fixes ADD COLUMN source TEXT DEFAULT "manual"')
    if 'lua_fix_id' not in cols:
        db.execute('ALTER TABLE fixes ADD COLUMN lua_fix_id TEXT DEFAULT ""')
    db.commit()

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('admin'):
            return redirect(url_for('admin_login'))
        return f(*args, **kwargs)
    return decorated

@app.route(PREFIX + '/')
def index():
    db = get_db()
    fixes = db.execute('SELECT * FROM fixes ORDER BY game_name ASC').fetchall()
    db.close()
    return render_template('index.html', fixes=fixes)

@app.route(PREFIX + '/api/fixes')
def api_fixes():
    db = get_db()
    fixes = db.execute('SELECT * FROM fixes ORDER BY game_name ASC').fetchall()
    db.close()
    return jsonify([dict(f) for f in fixes])

@app.route(PREFIX + '/download/<int:fix_id>')
def download(fix_id):
    db = get_db()
    fix = db.execute('SELECT * FROM fixes WHERE id = ?', (fix_id,)).fetchone()
    if not fix:
        flash('Fix not found.', 'error')
        db.close()
        return redirect(url_for('index'))

    if fix['file_size'] > 0 and os.path.exists(os.path.join(app.config['UPLOAD_FOLDER'], fix['filename'])):
        db.execute('UPDATE fixes SET download_count = download_count + 1 WHERE id = ?', (fix_id,))
        db.commit()
        db.close()
        download_name = fix['original_name']
        if not download_name or download_name == fix['filename']:
            if fix['filename'].endswith('.lua'):
                download_name = f"{fix['game_name']} ({fix['app_id']}).lua"
            else:
                download_name = fix['filename']
        return send_from_directory(app.config['UPLOAD_FOLDER'], fix['filename'],
                                   as_attachment=True, download_name=download_name)

    if fix['lua_fix_id']:
        print(f"  Proxying: {fix['game_name']} ({fix['app_id']}) fix_id={fix['lua_fix_id']}", flush=True)
        data = fetch_fix_from_lua(fix['lua_fix_id'])
        if data:
            title = fix['game_name'].replace(' ', '_').replace('/', '_')[:50]
            fn = f"lua_{fix['app_id']}_{title}.zip"
            fp = os.path.join(app.config['UPLOAD_FOLDER'], fn)
            with open(fp, 'wb') as f:
                f.write(data)
            now = datetime.now().isoformat()
            db.execute('UPDATE fixes SET filename=?, file_size=?, download_count=download_count+1, updated_at=? WHERE id=?',
                       (fn, len(data), now, fix_id))
            db.commit()
            db.close()
            return send_from_directory(app.config['UPLOAD_FOLDER'], fn,
                                       as_attachment=True, download_name=fix['original_name'])
        else:
            flash('Download limit reached on source. Try again later.', 'error')
            db.close()
            return redirect(url_for('index'))

    flash('Fix file not available.', 'error')
    db.close()
    return redirect(url_for('index'))

@app.route(PREFIX + '/admin/login', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password', '')
        if password == ADMIN_PASSWORD:
            session['admin'] = True
            return redirect(url_for('admin'))
        flash('Wrong password.', 'error')
    return render_template('admin_login.html')

@app.route(PREFIX + '/admin/logout')
def admin_logout():
    session.pop('admin', None)
    return redirect(url_for('index'))

@app.route(PREFIX + '/admin')
@admin_required
def admin():
    db = get_db()
    fixes = db.execute('SELECT * FROM fixes ORDER BY created_at DESC').fetchall()
    db.close()
    return render_template('admin.html', fixes=fixes)

@app.route(PREFIX + '/admin/upload', methods=['POST'])
@admin_required
def upload():
    game_name = request.form.get('game_name', '').strip()
    app_id = request.form.get('app_id', '').strip()
    category = request.form.get('category', 'bypass').strip()
    description = request.form.get('description', '').strip()
    file = request.files.get('file')

    if not game_name or not file:
        flash('Game name and file are required.', 'error')
        return redirect(url_for('admin'))

    original_name = secure_filename(file.filename)
    ts = datetime.now().strftime('%Y%m%d%H%M%S')
    filename = f"{ts}_{original_name}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    file_size = os.path.getsize(filepath)

    db = get_db()
    now = datetime.now().isoformat()
    db.execute('''INSERT INTO fixes (game_name, app_id, category, description, filename, original_name, file_size, created_at, updated_at, source)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
               (game_name, app_id, category, description, filename, original_name, file_size, now, now, 'manual'))
    db.commit()
    db.close()

    flash(f'Fix uploaded for {game_name}.', 'success')
    return redirect(url_for('admin'))

@app.route(PREFIX + '/admin/delete/<int:fix_id>', methods=['POST'])
@admin_required
def delete_fix(fix_id):
    db = get_db()
    fix = db.execute('SELECT * FROM fixes WHERE id = ?', (fix_id,)).fetchone()
    if fix:
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], fix['filename'])
        if os.path.exists(filepath):
            os.remove(filepath)
        db.execute('DELETE FROM fixes WHERE id = ?', (fix_id,))
        db.commit()
        flash('Fix deleted.', 'success')
    db.close()
    return redirect(url_for('admin'))

@app.route(PREFIX + '/admin/edit/<int:fix_id>', methods=['POST'])
@admin_required
def edit_fix(fix_id):
    game_name = request.form.get('game_name', '').strip()
    app_id = request.form.get('app_id', '').strip()
    category = request.form.get('category', '').strip()
    description = request.form.get('description', '').strip()

    db = get_db()
    now = datetime.now().isoformat()
    db.execute('''UPDATE fixes SET game_name=?, app_id=?, category=?, description=?, updated_at=? WHERE id=?''',
               (game_name, app_id, category, description, now, fix_id))
    db.commit()
    db.close()

    flash('Fix updated.', 'success')
    return redirect(url_for('admin'))

@app.route(PREFIX)
def root_redirect():
    return redirect(url_for('index'))

@app.template_filter('filesizeformat')
def filesizeformat(value):
    if value is None or value == 0:
        return '0 B'
    for unit in ['B', 'KB', 'MB', 'GB']:
        if value < 1024:
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"

app.jinja_env.filters['filesizeformat'] = filesizeformat

init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
