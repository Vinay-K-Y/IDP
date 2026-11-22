(function () {
    'use strict';

    const API_BASE = window.location.origin;
    const TOKEN_KEY = 'idp_auth_token';
    const ROLE_KEY = 'idp_auth_role';

    let state = {
        token: sessionStorage.getItem(TOKEN_KEY) || null,
        role: sessionStorage.getItem(ROLE_KEY) || null,
        username: null,
        sessionId: null,
        docs: [],
        userDocs: [],
        schemas: [],
        currentSchema: null,
        currentErrors: [],
        currentState: 'idle',
        completed: false,
        jobs: [],
        userJobs: [],
        selectedJobId: null,
        pipelineAvailable: false,
        lastConfirmedSchemaId: null,
    };

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, html) => {
        const d = document.createElement(tag);
        if (cls) d.className = cls;
        if (html != null) d.innerHTML = html;
        return d;
    };

    function fmtSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    }

    // Inline SVG file icons. No icon font, so they render without a network request.
    const PDF_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const FILE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async function api(path, opts = {}) {
        const url = path.startsWith('http') ? path : API_BASE + path;
        const headers = opts.headers ? { ...opts.headers } : {};

        if (opts.json) {
            headers['Content-Type'] = 'application/json';
        }
        if (state.token) {
            headers['Authorization'] = 'Bearer ' + state.token;
        }

        const resp = await fetch(url, {
            ...opts,
            headers,
            body: opts.json ? JSON.stringify(opts.json) : opts.body,
        });

        if (resp.status === 401) {
            // Token expired or invalid
            logout();
            throw new Error('Session expired or unauthorized. Please log in again.');
        }

        const ct = resp.headers.get('content-type') || '';
        const body = ct.includes('application/json') ? await resp.json() : await resp.text();
        if (!resp.ok) {
            const msg = typeof body === 'object' ? (body.detail || resp.statusText) : String(body || resp.statusText);
            throw new Error(msg);
        }
        return body;
    }

    // ======================= Auth & Role Management =======================

    function showLoginModal() {
        const overlay = $('loginOverlay');
        if (overlay) overlay.classList.remove('hidden');
        const userHeader = $('userHeaderSection');
        if (userHeader) userHeader.classList.add('hidden');
    }

    function hideLoginModal() {
        const overlay = $('loginOverlay');
        if (overlay) overlay.classList.add('hidden');
    }

    function logout() {
        state.token = null;
        state.role = null;
        state.username = null;
        state.sessionId = null;
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(ROLE_KEY);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(ROLE_KEY);
        showLoginModal();
    }

    async function handleLoginSubmit(e) {
        e.preventDefault();
        const username = $('loginUsername').value.trim();
        const password = $('loginPassword').value;
        const errorBox = $('loginError');
        const submitBtn = $('loginSubmitBtn');

        if (!username || !password) return;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in...';
        hideStatus('loginError');

        try {
            const fd = new URLSearchParams();
            fd.append('username', username);
            fd.append('password', password);

            const resp = await fetch(API_BASE + '/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: fd.toString(),
            });

            const data = await resp.json();
            if (!resp.ok) {
                throw new Error(data.detail || 'Login failed');
            }

            state.token = data.access_token;
            state.role = data.role;
            sessionStorage.setItem(TOKEN_KEY, state.token);
            sessionStorage.setItem(ROLE_KEY, state.role);
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(ROLE_KEY);

            hideLoginModal();
            await initAuthenticatedSession();
        } catch (err) {
            showStatus('loginError', err.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
        }
    }

    async function initAuthenticatedSession() {
        try {
            const me = await api('/auth/me');
            state.username = me.username;
            state.role = me.role;

            const userHeader = $('userHeaderSection');
            if (userHeader) userHeader.classList.remove('hidden');
            const userBadge = $('userBadge');
            if (userBadge) {
                userBadge.textContent = `${state.username} (${state.role})`;
                userBadge.className = 'badge ' + (state.role === 'admin' ? 'badge-primary' : 'badge-info');
            }

            applyRoleVisibility();

            if (state.role === 'admin') {
                loadDocuments();
                loadSchemas();
                loadPipelineStatus();
                loadJobs();
                loadAllExtractedData();
            } else {
                loadUserDocuments();
                loadUserJobs();
                loadUserSchemas();
                loadAllExtractedData();
            }

            initSchemaBuilder();
        } catch (err) {
            console.warn('initAuthenticatedSession failed', err);
            showLoginModal();
        }
    }

    function applyRoleVisibility() {
        const isAdmin = state.role === 'admin';

        document.querySelectorAll('.admin-only').forEach(el => {
            if (isAdmin) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });

        document.querySelectorAll('.user-only').forEach(el => {
            if (!isAdmin) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });
    }

    // ======================= Theme Toggle =======================
    const THEME_KEY = 'idp_console_theme';

    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY) || 'dark';
        applyTheme(saved);

        const btn = $('themeToggleBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme') || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                applyTheme(next);
            });
        }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(THEME_KEY, theme);
        const icon = $('themeIcon');
        const label = $('themeLabel');
        if (icon) icon.textContent = theme === 'dark' ? '' : '';
        if (label) label.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
    }

    // ======================= Tabs =======================

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const targetPanel = $('tab-' + btn.dataset.tab);
            if (targetPanel) targetPanel.classList.add('active');

            if (btn.dataset.tab === 'chatbot') {
                if (state.role === 'admin') {
                    loadSchemas();
                    loadPipelineStatus();
                    loadJobs();
                    if (state.docs.length === 0) loadDocuments();
                    else renderDocChecklist();
                } else {
                    loadUserJobs();
                    loadUserSchemas();
                }
            } else if (btn.dataset.tab === 'documents') {
                loadDocuments();
            } else if (btn.dataset.tab === 'user-documents') {
                loadUserDocuments();
            } else if (btn.dataset.tab === 'logs') {
                loadUserActivityLogs();
            } else if (btn.dataset.tab === 'users') {
                loadUsersList();
            } else if (btn.dataset.tab === 'graph-builds') {
                loadGraphBuilds();
            } else if (btn.dataset.tab === 'querybot') {
                loadAllExtractedData();
            }
        });
    });

    // ======================= Health / Boot =======================

    async function checkHealth() {
        try {
            await api('/health');
        } catch (e) {
            /* health check failed; status badges removed from UI */
        }
    }

    // ======================= Admin Documents Tab =======================

    async function loadDocuments() {
        if (state.role !== 'admin') return;
        try {
            const data = await api('/documents');
            state.docs = data.documents || [];
            const outs = data.outputs || [];
            if ($('docCount')) $('docCount').textContent = state.docs.length;
            if ($('outCount')) $('outCount').textContent = outs.length;
            renderDocList(state.docs, outs);
            renderDocChecklist();
            loadOcrDocs('admin');
            loadOcrOwnerOptions();
        } catch (e) {
            if ($('docList')) $('docList').innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`;
        }
    }

    function renderDocList(docs, outs) {
        const docList = $('docList');
        if (!docList) return;
        if (!docs.length) {
            docList.innerHTML = '<p class="muted">No documents yet. Upload PDFs above.</p>';
        } else {
            docList.innerHTML = '';
            docs.forEach(d => {
                const row = el('div', 'doc-item');
                const info = el('div', 'doc-item-info');
                info.innerHTML = `
                    <span class="doc-icon" aria-hidden="true">${PDF_ICON_SVG}</span>
                    <div>
                        <div class="doc-name">${escapeHtml(d.name)}</div>
                        <div class="doc-meta">${fmtSize(d.size)} • ${fmtDateTime(d.modified)}</div>
                    </div>
                `;
                const badge = renderDocStatusBadge(d.status);
                const actions = el('div', 'doc-item-actions');
                const delBtn = el('button', 'btn btn-danger btn-sm');
                delBtn.type = 'button';
                delBtn.textContent = 'Delete';
                delBtn.title = 'Delete document from storage';
                delBtn.addEventListener('click', () => deleteAdminDocument(d.name));
                actions.innerHTML = badge;
                actions.appendChild(delBtn);
                row.appendChild(info);
                row.appendChild(actions);
                docList.appendChild(row);
            });
        }

        const outList = $('outList');
        if (!outList) return;
        if (!outs.length) {
            outList.innerHTML = '<p class="muted">No processed outputs yet. Run the pipeline.</p>';
        } else {
            outList.innerHTML = '';
            outs.forEach(o => outList.appendChild(buildOutputRow('admin', o)));
        }
    }

    // One row of the Outputs card. The admin and user cards share it. scope picks the OCR routes.
    function buildOutputRow(scope, o) {
        const row = el('div', 'doc-item');
        const info = el('div', 'doc-item-info');
        const schema = o.schema_ref ? ` • schema: <code>${escapeHtml(o.schema_ref.schema_id || '--')}</code>` : '';
        const job = o.job_id ? `<code>${escapeHtml(o.job_id)}</code>` : '--';
        info.innerHTML = `
            <span class="doc-icon doc-icon-file" aria-hidden="true">${FILE_ICON_SVG}</span>
            <div>
                <div class="doc-name">${escapeHtml(o.name)}</div>
                <div class="doc-meta">${fmtSize(o.size)} • ${fmtDateTime(o.created_at || o.modified)} • job ${job}${schema}</div>
            </div>
        `;
        const doc = {
            doc_id: o.doc_id || o.name,
            owner: o.owner,
            md_filename: o.name,
            created_at: o.created_at || o.modified,
        };
        const actions = el('div', 'doc-item-actions');
        const view = el('button', 'btn btn-ghost btn-sm');
        view.type = 'button';
        view.textContent = 'View';
        view.setAttribute('aria-label', `View ${o.name}`);
        view.addEventListener('click', () => viewOcrDocument(scope, doc));
        const md = el('button', 'btn btn-outline btn-sm');
        md.type = 'button';
        md.textContent = 'Download .md';
        md.setAttribute('aria-label', `Download ${o.name}`);
        md.addEventListener('click', () => downloadOcrDocument(scope, doc));
        actions.append(view, md);
        if (o.has_extracted) {
            const js = el('button', 'btn btn-outline btn-sm');
            js.type = 'button';
            js.textContent = 'Download JSON';
            js.setAttribute('aria-label', `Download JSON for ${o.name}`);
            if (scope === 'admin') {
                js.addEventListener('click', () => downloadOutput('/documents/output/', o.name, o.owner));
            } else {
                js.addEventListener('click', () => downloadOutput('/me/outputs/output/', o.name));
            }
            actions.appendChild(js);
        }
        row.append(info, actions);
        return row;
    }

    async function downloadOutput(basePath, name, owner) {
        try {
            const query = owner ? `?owner=${encodeURIComponent(owner)}` : '';
            const data = await api(basePath + encodeURIComponent(name) + query);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name.replace(/\.(md|extracted\.json)$/i, '') + '.extracted.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Download failed: ' + e.message);
        }
    }

    // ======================= OCR Documents (Shared Dataset and My Documents) =======================

    // One table builder serves both the admin view (all owners) and the user view (own documents).
    // Names, text and owners are set with textContent or created with createElement, never innerHTML.
    const OCR_SCOPES = {
        admin: { prefix: 'ocr', base: '/documents/ocr', showOwner: true },
        user: { prefix: 'userOcr', base: '/me/ocr-documents', showOwner: false },
    };
    let ocrViewerSeq = 0; // a newer View click makes older responses stale

    function ocrEl(scope, suffix) {
        return $(OCR_SCOPES[scope].prefix + suffix);
    }

    function setOcrState(scope, message, isError = false) {
        const node = ocrEl(scope, 'State');
        if (!node) return;
        node.textContent = message || '';
        node.classList.toggle('is-error', isError);
        node.classList.toggle('hidden', !message);
    }

    function ocrDocUrl(scope, doc, suffix = '') {
        let url = `${OCR_SCOPES[scope].base}/${encodeURIComponent(doc.doc_id)}${suffix}`;
        if (scope === 'admin') url += `?owner=${encodeURIComponent(doc.owner)}`;
        return url;
    }

    // API timestamps are UTC. A value with no offset is read as UTC, then shown in the browser's time zone.
    const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    function fmtDateTime(value) {
        if (!value) return '--';
        let text = String(value).trim();
        if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text += 'Z';
        const d = new Date(text);
        return Number.isNaN(d.getTime()) ? '--' : dateTimeFormat.format(d);
    }

    // One badge for every processing state. The Shared Dataset, Run Pipeline and OCR views all use it.
    const DOC_STATUS_BADGES = {
        pending: ['badge-mute', 'Pending'],
        processing: ['badge-primary', 'Processing'],
        completed: ['badge-success', 'Completed'],
        failed: ['badge-danger', 'Failed'],
        cancelled: ['badge-cancelled', 'Cancelled'],
    };
    function renderDocStatusBadge(status) {
        // Unknown values, including the legacy 'paused' that the API no longer returns, fall back to Pending.
        const key = Object.prototype.hasOwnProperty.call(DOC_STATUS_BADGES, status) ? status : 'pending';
        const [cls, label] = DOC_STATUS_BADGES[key];
        return `<span class="badge doc-badge ${cls}" data-status="${key}">${label}</span>`;
    }

    function ocrCell(text, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = text;
        return td;
    }

    function ocrBadge(text, className) {
        const span = document.createElement('span');
        span.className = `badge ${className}`;
        span.textContent = text;
        return span;
    }

    function ocrRow(scope, doc) {
        const tr = document.createElement('tr');

        const nameTd = document.createElement('td');
        const name = document.createElement('div');
        name.className = 'doc-name';
        name.textContent = doc.doc_id;
        const mdLine = document.createElement('div');
        mdLine.className = 'doc-meta';
        mdLine.textContent = doc.md_filename;
        nameTd.append(name, mdLine);
        tr.appendChild(nameTd);

        if (OCR_SCOPES[scope].showOwner) tr.appendChild(ocrCell(doc.owner || '--', 'ocr-col-owner'));
        tr.appendChild(ocrCell(doc.page_count ?? '--', 'ocr-col-num'));
        const size = Number.isFinite(doc.size_chars) ? `${doc.size_chars.toLocaleString()} chars` : '--';
        tr.appendChild(ocrCell(size, 'ocr-col-num'));
        tr.appendChild(ocrCell(fmtDateTime(doc.created_at), 'ocr-col-saved'));

        const storedTd = document.createElement('td');
        storedTd.className = 'ocr-col-stored';
        storedTd.innerHTML = renderDocStatusBadge(doc.status);
        if (doc.has_graph) storedTd.appendChild(ocrBadge('Graph', 'badge-primary'));
        if (doc.has_extraction) storedTd.appendChild(ocrBadge('Extraction', 'badge-info'));
        if (!doc.has_graph && !doc.has_extraction) storedTd.appendChild(ocrBadge('Text only', 'badge-mute'));
        tr.appendChild(storedTd);

        const actTd = document.createElement('td');
        actTd.className = 'ocr-col-actions';
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-ghost btn-sm';
        viewBtn.textContent = 'View';
        viewBtn.setAttribute('aria-label', `View ${doc.doc_id}`);
        viewBtn.addEventListener('click', () => viewOcrDocument(scope, doc));
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'btn btn-outline btn-sm';
        dlBtn.textContent = 'Download .md';
        dlBtn.setAttribute('aria-label', `Download ${doc.md_filename}`);
        dlBtn.addEventListener('click', () => downloadOcrDocument(scope, doc));
        actTd.append(viewBtn, dlBtn);
        tr.appendChild(actTd);
        return tr;
    }

    function ensureOwnerOption(select, name) {
        if (!name || [...select.options].some((o) => o.value === name)) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }

    function renderOcrTable(scope, docs) {
        const body = ocrEl(scope, 'Body');
        const wrap = ocrEl(scope, 'Wrap');
        if (!body || !wrap) return;
        if (scope === 'admin') {
            const select = ocrEl(scope, 'Owner');
            docs.forEach((doc) => ensureOwnerOption(select, doc.owner));
        }
        body.replaceChildren(...docs.map((doc) => ocrRow(scope, doc)));
        wrap.classList.toggle('hidden', docs.length === 0);
        if (docs.length === 0) {
            setOcrState(scope, scope === 'admin'
                ? 'No OCR documents yet. Run the pipeline to create one.'
                : 'You have no OCR documents yet. Run the pipeline on your uploads.');
        } else {
            setOcrState(scope, '');
        }
    }

    async function loadOcrDocs(scope) {
        const body = ocrEl(scope, 'Body');
        const wrap = ocrEl(scope, 'Wrap');
        if (!body || !wrap) return;
        let path = OCR_SCOPES[scope].base;
        if (scope === 'admin') {
            const owner = ocrEl(scope, 'Owner').value;
            if (owner) path += `?owner=${encodeURIComponent(owner)}`;
        }
        setOcrState(scope, 'Loading OCR documents…');
        try {
            const data = await api(path);
            const docs = data.documents || [];
            ocrEl(scope, 'DocCount').textContent = data.truncated ? `${docs.length}+` : String(docs.length);
            renderOcrTable(scope, docs);
        } catch (e) {
            body.replaceChildren();
            wrap.classList.add('hidden');
            ocrEl(scope, 'DocCount').textContent = '0';
            setOcrState(scope, `Failed to load OCR documents: ${e.message}`, true);
        }
    }

    async function loadOcrOwnerOptions() {
        const select = ocrEl('admin', 'Owner');
        if (!select) return;
        try {
            const users = await api('/admin/users');
            const current = select.value;
            select.replaceChildren();
            const all = document.createElement('option');
            all.value = '';
            all.textContent = 'All owners';
            select.appendChild(all);
            users.map((u) => u.username).sort().forEach((name) => ensureOwnerOption(select, name));
            select.value = current;
        } catch (e) {
            // The filter keeps "All owners". Owners that appear in the table are added when it renders.
        }
    }

    async function viewOcrDocument(scope, doc) {
        const viewer = ocrEl(scope, 'Viewer');
        const text = ocrEl(scope, 'ViewerText');
        if (!viewer || !text) return;
        const seq = ++ocrViewerSeq;
        ocrEl(scope, 'ViewerTitle').textContent = doc.doc_id;
        const ownerPart = OCR_SCOPES[scope].showOwner ? ` \u2022 owner ${doc.owner}` : '';
        ocrEl(scope, 'ViewerMeta').textContent = `${doc.md_filename}${ownerPart} \u2022 saved ${fmtDateTime(doc.created_at)}`;
        text.textContent = 'Loading…';
        viewer.classList.remove('hidden');
        viewer.scrollIntoView({ block: 'nearest' });
        try {
            const data = await api(ocrDocUrl(scope, doc));
            if (seq !== ocrViewerSeq) return;
            text.textContent = data.markdown_content || '(empty document)';
            text.scrollTop = 0;
        } catch (e) {
            if (seq !== ocrViewerSeq) return;
            text.textContent = `Failed to load document: ${e.message}`;
        }
    }

    function closeOcrViewer(scope) {
        ocrViewerSeq++;
        const viewer = ocrEl(scope, 'Viewer');
        if (viewer) viewer.classList.add('hidden');
        const text = ocrEl(scope, 'ViewerText');
        if (text) text.textContent = '';
    }

    async function downloadOcrDocument(scope, doc) {
        try {
            const markdown = await api(ocrDocUrl(scope, doc, '/markdown'));
            const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = doc.md_filename || 'document.md';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Download failed: ' + e.message);
        }
    }

    // ======================= User Documents Tab =======================

    async function loadUserDocuments() {
        try {
            const data = await api('/me/documents');
            state.userDocs = data.documents || [];
            if ($('userDocCount')) $('userDocCount').textContent = state.userDocs.length;
            renderUserDocList(state.userDocs);
        } catch (e) {
            if ($('userDocList')) $('userDocList').innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`;
        }
        loadOcrDocs('user');
        loadUserOutputs();
    }

    async function loadUserOutputs() {
        const host = $('userOutList');
        if (!host) return;
        try {
            const data = await api('/me/outputs');
            const outs = data.outputs || [];
            if ($('userOutCount')) $('userOutCount').textContent = outs.length;
            if (!outs.length) {
                host.innerHTML = '<p class="muted">No processed outputs yet. Run the pipeline.</p>';
                return;
            }
            host.innerHTML = '';
            outs.forEach(o => host.appendChild(buildOutputRow('user', o)));
        } catch (e) {
            host.innerHTML = `<p class="muted">Failed to load outputs: ${e.message}</p>`;
        }
    }

    function renderUserDocList(docs) {
        const host = $('userDocList');
        if (!host) return;
        if (!docs.length) {
            host.innerHTML = '<p class="muted">No private documents yet. Upload PDFs above.</p>';
        } else {
            host.innerHTML = '';
            docs.forEach(d => {
                const row = el('div', 'doc-item');
                const info = el('div', 'doc-item-info');
                info.innerHTML = `
                    <span class="doc-icon" aria-hidden="true">${PDF_ICON_SVG}</span>
                    <div>
                        <div class="doc-name">${escapeHtml(d.name)}</div>
                        <div class="doc-meta">${fmtSize(d.size)} • ${fmtDateTime(d.modified)}</div>
                    </div>
                `;
                const actions = el('div', 'doc-item-actions');
                actions.innerHTML = renderDocStatusBadge(d.status);
                const delBtn = el('button', 'btn btn-danger btn-sm');
                delBtn.type = 'button';
                delBtn.textContent = 'Delete';
                delBtn.title = 'Delete document from storage';
                delBtn.addEventListener('click', () => deleteUserDocument(d.name));
                actions.appendChild(delBtn);
                row.appendChild(info);
                row.appendChild(actions);
                host.appendChild(row);
            });
        }
    }

    async function deleteAdminDocument(name) {
        if (!confirm(`Delete "${name}" from storage? This cannot be undone.`)) return;
        try {
            await api('/documents/' + encodeURIComponent(name), { method: 'DELETE' });
            showStatus('uploadStatus', `Deleted ${name}`, 'success');
            loadDocuments();
        } catch (e) {
            showStatus('uploadStatus', 'Delete failed: ' + e.message, 'error');
        }
        setTimeout(() => hideStatus('uploadStatus'), 4000);
    }

    async function deleteUserDocument(name) {
        if (!confirm(`Delete "${name}" from your workspace? This cannot be undone.`)) return;
        try {
            await api('/me/documents/' + encodeURIComponent(name), { method: 'DELETE' });
            showStatus('userUploadStatus', `Deleted ${name}`, 'success');
            loadUserDocuments();
        } catch (e) {
            showStatus('userUploadStatus', 'Delete failed: ' + e.message, 'error');
        }
        setTimeout(() => hideStatus('userUploadStatus'), 4000);
    }

    // ======================= Upload Handlers =======================

    // Client checks run before any request. Server errors are mapped to readable text below.
    const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // matches MAX_UPLOAD_SIZE_BYTES in pipeline_routes.py

    // Status text uses textContent, so a file name can never become markup.
    function setUploadMessage(id, text, kind) {
        const s = $(id);
        if (!s) return;
        s.className = 'status-box' + (kind ? ' ' + kind : '');
        s.textContent = text;
        s.classList.remove('hidden');
    }

    function checkUploadFiles(files, existingNames) {
        const accepted = [];
        const errors = [];
        const seen = new Set(existingNames.map((n) => String(n).toLowerCase()));
        files.forEach((f) => {
            if (!f.name.toLowerCase().endsWith('.pdf')) {
                errors.push(`"${f.name}" is not a PDF. Only .pdf files can be uploaded.`);
            } else if (f.size > UPLOAD_MAX_BYTES) {
                errors.push(`"${f.name}" is larger than the 20 MB limit.`);
            } else if (seen.has(f.name.toLowerCase())) {
                errors.push(`"${f.name}" is already in this list.`);
            } else {
                seen.add(f.name.toLowerCase());
                accepted.push(f);
            }
        });
        return { accepted, errors };
    }

    // XMLHttpRequest reports upload progress, which the fetch-based api() helper cannot.
    function sendUploadRequest(path, files, onProgress) {
        return new Promise((resolve, reject) => {
            const fd = new FormData();
            files.forEach((f) => fd.append('files', f, f.name));
            const xhr = new XMLHttpRequest();
            xhr.open('POST', API_BASE + path);
            if (state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress(e.loaded / e.total);
            };
            xhr.onload = () => {
                let body = null;
                try { body = JSON.parse(xhr.responseText); } catch (_) { body = null; }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(body || {});
                    return;
                }
                if (xhr.status === 401) {
                    logout();
                    reject(new Error('Session expired. Please log in again.'));
                    return;
                }
                const detail = body && typeof body.detail === 'string' ? body.detail : '';
                if (xhr.status === 413) reject(new Error('The file is larger than the 20 MB limit.'));
                else if (xhr.status === 400) reject(new Error(detail || 'The server rejected the file. Check that it is a valid PDF.'));
                else if (xhr.status >= 500) reject(new Error('The server could not save the file. Try again.'));
                else reject(new Error(detail || `Upload failed (HTTP ${xhr.status}).`));
            };
            xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
            xhr.send(fd);
        });
    }

    // One wiring function for both dropzones (shared dataset and private documents).
    function wireUploadZone(cfg) {
        const { zone, input, progress, bar, statusId, path, existingNames, onDone } = cfg;
        if (!zone || !input || !progress || !bar) return;
        let busy = false;

        async function handleFiles(fileList) {
            const files = Array.from(fileList || []);
            if (!files.length) return;
            if (busy) {
                setUploadMessage(statusId, 'An upload is already running. Wait for it to finish.', 'warn');
                return;
            }
            const { accepted, errors } = checkUploadFiles(files, existingNames());
            if (!accepted.length) {
                setUploadMessage(statusId, errors.join(' '), 'error');
                return;
            }
            busy = true;
            zone.classList.add('is-uploading');
            progress.classList.remove('hidden');
            bar.style.width = '0%';
            let shown = 0;
            setUploadMessage(statusId, `Uploading ${accepted.length} file(s)...`, '');
            try {
                const res = await sendUploadRequest(path, accepted, (fraction) => {
                    shown = Math.max(shown, fraction); // the bar never goes backwards
                    bar.style.width = (shown * 100).toFixed(1) + '%';
                });
                bar.style.width = '100%';
                const saved = Array.isArray(res.saved) ? res.saved.join(', ') : '';
                const note = errors.length ? errors.join(' ') + ' ' : '';
                setUploadMessage(statusId, `${note}Saved ${res.count ?? accepted.length} file(s): ${saved}`, 'success');
                onDone();
            } catch (e) {
                setUploadMessage(statusId, 'Upload failed: ' + e.message, 'error');
            } finally {
                busy = false;
                zone.classList.remove('is-uploading');
                setTimeout(() => progress.classList.add('hidden'), 600);
                setTimeout(() => hideStatus(statusId), 6000);
            }
        }

        zone.addEventListener('dragenter', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragover');
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', () => {
            handleFiles(input.files);
            input.value = '';
        });
    }

    wireUploadZone({
        zone: $('uploadZone'),
        input: $('fileInput'),
        progress: $('uploadProgress'),
        bar: $('uploadProgressBar'),
        statusId: 'uploadStatus',
        path: '/documents/upload',
        existingNames: () => state.docs.map((d) => d.name),
        onDone: () => loadDocuments(),
    });

    wireUploadZone({
        zone: $('userUploadZone'),
        input: $('userFileInput'),
        progress: $('userUploadProgress'),
        bar: $('userUploadProgressBar'),
        statusId: 'userUploadStatus',
        path: '/me/documents',
        existingNames: () => state.userDocs.map((d) => d.name),
        onDone: () => loadUserDocuments(),
    });

    if ($('refreshDocsBtn')) $('refreshDocsBtn').addEventListener('click', loadDocuments);
    if ($('refreshUserDocsBtn')) $('refreshUserDocsBtn').addEventListener('click', loadUserDocuments);
    if ($('refreshUserOutputsBtn')) $('refreshUserOutputsBtn').addEventListener('click', loadUserOutputs);
    if ($('ocrRefresh')) $('ocrRefresh').addEventListener('click', () => { loadOcrDocs('admin'); loadOcrOwnerOptions(); });
    if ($('ocrOwner')) $('ocrOwner').addEventListener('change', () => loadOcrDocs('admin'));
    if ($('ocrViewerClose')) $('ocrViewerClose').addEventListener('click', () => closeOcrViewer('admin'));
    if ($('userOcrRefresh')) $('userOcrRefresh').addEventListener('click', () => loadOcrDocs('user'));
    if ($('userOcrViewerClose')) $('userOcrViewerClose').addEventListener('click', () => closeOcrViewer('user'));

    function showStatus(id, html, kind) {
        const s = $(id);
        if (!s) return;
        s.className = 'status-box' + (kind ? ' ' + kind : '');
        s.innerHTML = html;
        s.classList.remove('hidden');
    }
    function hideStatus(id) { const s = $(id); if (s) s.classList.add('hidden'); }

    function addChatMsg(who, text) {
        const log = $('chatLog');
        if (!log) return;
        const wrap = el('div', 'chat-msg ' + who);
        const b = el('div', 'msg-bubble');
        b.textContent = text;
        wrap.appendChild(b);
        log.appendChild(wrap);
        log.scrollTop = log.scrollHeight;
    }

    function setStateBadge(s, s2) {
        const b = $('stateBadge');
        if (!b) return;
        const map = {
            START: 'badge-info', REVIEW: 'badge-warn', COMPLETED: 'badge-success',
        };
        b.className = 'badge ' + (map[s] || 'badge-mute');
        b.textContent = s.toLowerCase() + (s2 ? ' • ' + s2 : '');
    }

    // ======================= Interactive Schema Builder =======================

    const SCHEMA_PRESETS = {
        medical: {
            document_type: 'medical_discharge_summary',
            fields: [
                { name: 'patient_name', type: 'string', required: true, description: 'Full legal name of the patient' },
                { name: 'patient_id', type: 'string', required: false, description: 'Hospital patient identifier or MRN' },
                { name: 'admission_date', type: 'date', required: true, description: 'Date patient was admitted to hospital' },
                { name: 'discharge_date', type: 'date', required: false, description: 'Date patient was discharged from hospital' },
                { name: 'primary_diagnosis', type: 'string', required: true, description: 'Primary diagnosis or clinical condition diagnosed' },
                { name: 'procedure_performed', type: 'string', required: false, description: 'Surgical or medical procedure performed' },
                { name: 'approved_claim_amount', type: 'number', required: false, description: 'Total approved insurance claim settlement amount' },
            ]
        },
        invoice: {
            document_type: 'invoice',
            fields: [
                { name: 'invoice_number', type: 'string', required: true, description: 'Unique invoice reference or billing number' },
                { name: 'invoice_date', type: 'date', required: true, description: 'Date the invoice was issued' },
                { name: 'vendor_name', type: 'string', required: true, description: 'Name of the issuing vendor or supplier' },
                { name: 'total_amount', type: 'number', required: true, description: 'Total invoice amount payable including all taxes' },
                { name: 'tax_amount', type: 'number', required: false, description: 'Total tax or VAT amount charged' },
                { name: 'line_items', type: 'array', item_type: 'object', required: false, description: 'List of individual itemized charges or services' },
            ]
        },
        resume: {
            document_type: 'resume',
            fields: [
                { name: 'candidate_name', type: 'string', required: true, description: 'Full legal name of the job candidate' },
                { name: 'email_address', type: 'string', required: true, description: 'Primary contact email address' },
                { name: 'phone_number', type: 'string', required: false, description: 'Contact phone or mobile number' },
                { name: 'skills', type: 'array', item_type: 'string', required: false, description: 'List of technical and professional skills' },
                { name: 'years_of_experience', type: 'number', required: false, description: 'Total years of relevant professional experience' },
            ]
        },
        blank: {
            document_type: '',
            fields: [
                { name: 'field_1', type: 'string', required: true, description: '' }
            ]
        }
    };

    function collectSchemaFromInputs() {
        if (!state.currentSchema) {
            state.currentSchema = { document_type: '', fields: [] };
        }
        const docTypeInput = $('editDocType');
        if (docTypeInput) {
            state.currentSchema.document_type = docTypeInput.value.trim().toLowerCase().replace(/[\s-]+/g, '_');
        }

        const rows = document.querySelectorAll('#schemaPanel table.schema-table tbody tr');
        const fields = [];
        rows.forEach(tr => {
            const nameInput = tr.querySelector('.field-name-input');
            const typeSelect = tr.querySelector('.field-type-select');
            const reqBtn = tr.querySelector('.req-toggle');
            const descInput = tr.querySelector('.field-desc-input');

            const name = nameInput ? nameInput.value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';

            let rawType = typeSelect ? typeSelect.value : 'string';
            let itemType = null;
            if (rawType.startsWith('array[')) {
                itemType = rawType.substring(6, rawType.length - 1);
                rawType = 'array';
            }

            fields.push({
                name: name,
                type: rawType,
                item_type: itemType,
                required: reqBtn ? reqBtn.classList.contains('is-req') : false,
                description: descInput ? descInput.value.trim() : ''
            });
        });

        state.currentSchema.fields = fields;
        const jsonView = $('schemaJsonView');
        if (jsonView) {
            jsonView.textContent = JSON.stringify(state.currentSchema, null, 2);
        }
        return state.currentSchema;
    }

    function validateAndRefreshUI() {
        const schema = state.currentSchema;
        const errs = $('schemaErrors');
        if (!schema) {
            if (errs) errs.classList.add('hidden');
            if ($('confirmBtn')) $('confirmBtn').disabled = true;
            return;
        }

        const errors = [];
        const docType = schema.document_type || ($('editDocType') ? $('editDocType').value.trim() : '');
        if (!docType) {
            errors.push('Document Type is required and cannot be empty.');
        }

        const fields = schema.fields || [];
        if (!fields.length) {
            errors.push('Schema must contain at least one field.');
        } else {
            const seen = new Set();
            fields.forEach((f, idx) => {
                if (!f.name || !f.name.trim()) {
                    errors.push(`Row ${idx + 1}: Field name cannot be blank.`);
                } else {
                    const norm = f.name.trim().toLowerCase().replace(/[\s-]+/g, '_');
                    if (seen.has(norm)) {
                        errors.push(`Duplicate field name: '${f.name}' (row ${idx + 1}).`);
                    }
                    seen.add(norm);
                }
                if (f.type === 'array' && !f.item_type) {
                    errors.push(`Field '${f.name}' is an array but has no item_type.`);
                }
            });
        }

        state.currentErrors = errors;
        if (errors.length) {
            if (errs) {
                errs.innerHTML = '<strong>Schema issues:</strong><ul>' + errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
                errs.classList.remove('hidden');
            }
        } else {
            if (errs) errs.classList.add('hidden');
        }

        const canConfirm = !errors.length && fields.length > 0 && !!docType;
        if ($('confirmBtn')) $('confirmBtn').disabled = !canConfirm;
    }

    function addNewSchemaField() {
        if (!state.currentSchema) {
            state.currentSchema = { document_type: '', fields: [] };
        }
        const count = (state.currentSchema.fields || []).length + 1;
        state.currentSchema.fields.push({
            name: 'field_' + count,
            type: 'string',
            required: false,
            description: ''
        });
        renderSchemaPanel();
        validateAndRefreshUI();
        setTimeout(() => {
            const inputs = document.querySelectorAll('.field-name-input');
            if (inputs.length) {
                inputs[inputs.length - 1].focus({ preventScroll: true });
                inputs[inputs.length - 1].select();
            }
        }, 50);
    }

    function renderSchemaPanel() {
        const schema = state.currentSchema;
        const panel = $('schemaPanel');
        if (!panel) return;

        if (!schema || !schema.fields || !schema.fields.length) {
            panel.innerHTML = `
                <div style="padding: 24px; text-align: center; background: rgba(0,0,0,0.1); border-radius: var(--radius-sm); border: 1px dashed var(--border);">
                    <p class="muted" style="margin-bottom: 8px;">No fields defined yet. Choose a Quick Preset above or click below to add your first field.</p>
                    <button type="button" class="btn btn-outline btn-sm" id="addFieldInlineBtn">Add First Field</button>
                </div>
            `;
            const inlineBtn = $('addFieldInlineBtn');
            if (inlineBtn) inlineBtn.addEventListener('click', addNewSchemaField);
            validateAndRefreshUI();
            return;
        }

        const fields = schema.fields;
        const typeOptions = [
            'string', 'number', 'integer', 'boolean', 'date',
            'array[string]', 'array[object]', 'object'
        ];

        let html = `
            <table class="schema-table">
                <thead>
                    <tr>
                        <th style="width: 26%;">Field Name</th>
                        <th style="width: 22%;">Type</th>
                        <th style="width: 14%; text-align: center;">Required</th>
                        <th style="width: 32%;">Extraction Guidance / Description</th>
                        <th style="width: 6%; text-align: center;">Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        fields.forEach((f, idx) => {
            const curType = f.type === 'array' ? (f.item_type ? `array[${f.item_type}]` : 'array[string]') : (f.type || 'string');
            const isReq = !!f.required;
            const opts = typeOptions.map(t => `<option value="${t}" ${t === curType ? 'selected' : ''}>${t}</option>`).join('');

            html += `
                <tr data-idx="${idx}">
                    <td>
                        <input type="text" class="schema-input field-name-input" data-field="name" value="${escapeHtml(f.name || '')}" placeholder="e.g. patient_name">
                    </td>
                    <td>
                        <select class="schema-select field-type-select" data-field="type">
                            ${opts}
                        </select>
                    </td>
                    <td style="text-align: center;">
                        <button type="button" class="req-toggle ${isReq ? 'is-req' : 'is-opt'}" data-idx="${idx}">
                            ${isReq ? 'YES' : 'NO'}
                        </button>
                    </td>
                    <td>
                        <input type="text" class="schema-input field-desc-input" data-field="description" value="${escapeHtml(f.description || '')}" placeholder="Instructions for Layer 3 extraction...">
                    </td>
                    <td style="text-align: center;">
                        <button type="button" class="btn-del-field" data-idx="${idx}" title="Delete field"></button>
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
            <div class="schema-bottom-actions mt-1" style="display: flex; justify-content: space-between; align-items: center;">
                <button type="button" class="btn btn-ghost btn-sm" id="addFieldInlineBtn">Add Field</button>
                <span class="muted small">${fields.length} field(s) configured</span>
            </div>
        `;

        panel.innerHTML = html;
        const inlineBtn = $('addFieldInlineBtn');
        if (inlineBtn) inlineBtn.addEventListener('click', addNewSchemaField);

        validateAndRefreshUI();
    }

    function applyPreset(presetKey) {
        const preset = SCHEMA_PRESETS[presetKey];
        if (!preset) return;
        state.currentSchema = JSON.parse(JSON.stringify(preset));
        state.completed = false;
        const docTypeInput = $('editDocType');
        if (docTypeInput) docTypeInput.value = state.currentSchema.document_type;
        const postBox = $('postConfirmBox');
        if (postBox) postBox.classList.add('hidden');
        renderSchemaPanel();
        validateAndRefreshUI();
    }

    function clearSchema() {
        if (state.currentSchema && state.currentSchema.fields && state.currentSchema.fields.length) {
            if (!confirm('Are you sure you want to clear all fields in the builder?')) return;
        }
        applyPreset('blank');
    }

    function toggleJsonPreview() {
        collectSchemaFromInputs();
        const box = $('schemaJsonPreviewBox');
        if (!box) return;
        const view = $('schemaJsonView');
        if (view && state.currentSchema) {
            view.textContent = JSON.stringify(state.currentSchema, null, 2);
        }
        // Always reveal the JSON on click (never hide) so the button behaves
        // like a "show me this" action: click -> JSON shows and scrolls into
        // view, centered in the viewport. Clicking again keeps it shown.
        box.classList.remove('hidden');
        requestAnimationFrame(() => {
            box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    async function saveCustomSchema() {
        collectSchemaFromInputs();
        validateAndRefreshUI();

        const schema = state.currentSchema;
        if (!schema || !schema.document_type || !schema.fields || !schema.fields.length) {
            showStatus('confirmStatus', 'Please specify a document type and at least one field.', 'error');
            return;
        }

        if (state.currentErrors && state.currentErrors.length) {
            showStatus('confirmStatus', 'Please fix schema issues before confirming: ' + state.currentErrors.join(', '), 'error');
            return;
        }

        const btn = $('confirmBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving & Registering...';
        }

        try {
            const schemaNameInput = $('editSchemaName');
            const payload = {
                document_type: schema.document_type,
                schema_name: (schemaNameInput && schemaNameInput.value.trim()) || schema.document_type,
                fields: schema.fields.map(f => ({
                    name: f.name,
                    type: f.type || 'string',
                    required: !!f.required,
                    description: f.description || '',
                    item_type: f.item_type || null,
                    pattern: f.pattern || null,
                    currency: f.currency || null,
                }))
            };

            const data = await api('/schema/custom', {
                method: 'POST',
                json: payload
            });

            state.lastConfirmedSchemaId = data.schema_id;
            state.completed = true;

            showStatus('confirmStatus', `Schema saved and confirmed! Schema ID: <code>${escapeHtml(data.schema_id)}</code>`, 'success');

            const confIdText = $('confirmedSchemaIdText');
            if (confIdText) confIdText.textContent = `ID: ${data.schema_id}`;

            const postBox = $('postConfirmBox');
            if (postBox) postBox.classList.remove('hidden');

            const quickBtn = $('quickRunPipelineBtn');
            if (quickBtn) quickBtn.disabled = false;

            const downloadPdfBtn = $('downloadSchemaPdfBtn');
            if (downloadPdfBtn) downloadPdfBtn.disabled = false;
            const downloadJsonBtn = $('downloadSchemaJsonBtn');
            if (downloadJsonBtn) downloadJsonBtn.disabled = false;

            // Refresh pipeline schema selector and pre-select the newly created schema
            if (state.role === 'admin') {
                await loadSchemas();
                const sel = $('schemaSelect');
                if (sel) {
                    sel.value = data.schema_id;
                    updateRunBtn();
                }
            }
        } catch (err) {
            showStatus('confirmStatus', 'Failed to save schema: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save & Confirm Schema';
            }
        }
    }

    function initSchemaBuilder() {
        if (!state.currentSchema) {
            applyPreset('medical');
        } else {
            const docTypeInput = $('editDocType');
            if (docTypeInput && state.currentSchema.document_type) {
                docTypeInput.value = state.currentSchema.document_type;
            }
            renderSchemaPanel();
            validateAndRefreshUI();
        }
    }

    if ($('addSchemaFieldBtn')) $('addSchemaFieldBtn').addEventListener('click', addNewSchemaField);
    if ($('clearSchemaBtn')) $('clearSchemaBtn').addEventListener('click', clearSchema);
    if ($('toggleJsonPreviewBtn')) $('toggleJsonPreviewBtn').addEventListener('click', toggleJsonPreview);
    if ($('confirmBtn')) $('confirmBtn').addEventListener('click', saveCustomSchema);

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const presetKey = e.currentTarget.getAttribute('data-preset');
            if (presetKey) applyPreset(presetKey);
        });
    });

    if ($('editDocType')) {
        $('editDocType').addEventListener('input', () => {
            collectSchemaFromInputs();
            validateAndRefreshUI();
        });
        $('editDocType').addEventListener('change', () => {
            collectSchemaFromInputs();
            validateAndRefreshUI();
        });
    }

    if ($('schemaPanel')) {
        $('schemaPanel').addEventListener('input', () => {
            collectSchemaFromInputs();
            validateAndRefreshUI();
        });
        $('schemaPanel').addEventListener('change', () => {
            collectSchemaFromInputs();
            validateAndRefreshUI();
        });
        $('schemaPanel').addEventListener('click', (e) => {
            const reqToggle = e.target.closest('.req-toggle');
            if (reqToggle) {
                const isCurrentlyReq = reqToggle.classList.contains('is-req');
                const nextReq = !isCurrentlyReq;

                reqToggle.classList.toggle('is-req', nextReq);
                reqToggle.classList.toggle('is-opt', !nextReq);
                reqToggle.textContent = nextReq ? 'YES' : 'NO';

                const tr = reqToggle.closest('tr');
                const idx = tr ? parseInt(tr.getAttribute('data-idx'), 10) : parseInt(reqToggle.getAttribute('data-idx'), 10);
                if (!isNaN(idx) && state.currentSchema && state.currentSchema.fields && state.currentSchema.fields[idx]) {
                    state.currentSchema.fields[idx].required = nextReq;
                }
                collectSchemaFromInputs();
                validateAndRefreshUI();
                return;
            }

            const delBtn = e.target.closest('.btn-del-field');
            if (delBtn) {
                const tr = delBtn.closest('tr');
                const idx = tr ? parseInt(tr.getAttribute('data-idx'), 10) : parseInt(delBtn.getAttribute('data-idx'), 10);
                if (!isNaN(idx) && state.currentSchema && state.currentSchema.fields) {
                    state.currentSchema.fields.splice(idx, 1);
                    renderSchemaPanel();
                    validateAndRefreshUI();
                }
                return;
            }
        });
    }

    if ($('downloadSchemaPdfHeaderBtn')) {
        $('downloadSchemaPdfHeaderBtn').addEventListener('click', () => downloadSchemaPdf());
    }
    if ($('downloadSchemaJsonHeaderBtn')) {
        $('downloadSchemaJsonHeaderBtn').addEventListener('click', () => downloadSchemaJson());
    }
    if ($('downloadSchemaPdfBtn')) {
        $('downloadSchemaPdfBtn').addEventListener('click', () => downloadSchemaPdf());
    }
    if ($('downloadSchemaJsonBtn')) {
        $('downloadSchemaJsonBtn').addEventListener('click', () => downloadSchemaJson());
    }

    // Sample inference upload
    (function setupInferUpload() {
        const input = $('inferInput');
        const browse = $('inferBrowseBtn');
        const sel = $('inferSelected');
        const run = $('inferBtn');
        let files = [];

        if (!input || !browse || !run) return;

        browse.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            files = Array.from(e.target.files).filter(f =>
                f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
            sel.textContent = files.length ? `${files.length} file(s): ${files.map(f => f.name).join(', ')}` : 'no files';
            run.disabled = !(files.length >= 2 && files.length <= 5);
        });

        run.addEventListener('click', async () => {
            if (!(files.length >= 2 && files.length <= 5)) return;
            const fd = new FormData();
            files.forEach(f => fd.append('files', f, f.name));
            if (state.sessionId) fd.append('session_id', state.sessionId);

            showStatus('inferStatus', 'Running Bedrock document analysis + schema inference... Please be patient.', 'warn');
            run.disabled = true;
            const t0 = Date.now();
            try {
                const data = await api('/schema/infer', { method: 'POST', body: fd, timeout: 0 });
                const secs = (Date.now() - t0) / 1000;
                if ($('chatLog') && !$('chatLog').children.length) {
                    $('chatLog').innerHTML = '';
                }
                addChatMsg('bot', `[Inference returned in ${secs.toFixed(1)}s]`);
                handleChatResponse(data);
                showStatus('inferStatus', `Inference complete (${secs.toFixed(1)}s).`, 'success');
                setTimeout(() => hideStatus('inferStatus'), 5000);
            } catch (e) {
                showStatus('inferStatus', 'Inference failed: ' + e.message, 'error');
            } finally {
                run.disabled = !(files.length >= 2 && files.length <= 5);
            }
        });
    })();

    // ======================= Admin Pipeline Section =======================

    function renderDocChecklist() {
        const host = $('docChecklist');
        const allBtn = $('selAllBtn');
        const noneBtn = $('selNoneBtn');
        if (!host) return;
        if (!state.docs.length) {
            host.innerHTML = '<p class="muted small">Load documents from the Documents tab first.</p>';
            if (allBtn) allBtn.disabled = true;
            if (noneBtn) noneBtn.disabled = true;
            return;
        }
        if (allBtn) allBtn.disabled = false;
        if (noneBtn) noneBtn.disabled = false;
        host.innerHTML = '';
        state.docs.forEach(d => {
            const row = el('label', 'check-item');
            row.innerHTML = `
                <input type="checkbox" class="doc-check" value="${escapeHtml(d.name)}" checked>
                <span class="cname">${escapeHtml(d.name)}</span>
                <span class="cmeta">${fmtSize(d.size)}</span>
                <span class="cmeta">${renderDocStatusBadge(d.status)}</span>
            `;
            host.appendChild(row);
        });
        updateRunBtn();
    }

    if ($('selAllBtn')) {
        $('selAllBtn').addEventListener('click', () => {
            document.querySelectorAll('.doc-check').forEach(c => c.checked = true);
            updateRunBtn();
        });
    }
    if ($('selNoneBtn')) {
        $('selNoneBtn').addEventListener('click', () => {
            document.querySelectorAll('.doc-check').forEach(c => c.checked = false);
            updateRunBtn();
        });
    }

    function updateRunBtn() {
        const runBtn = $('runPipelineBtn');
        if (!runBtn) return;
        const anyChecked = document.querySelectorAll('.doc-check:checked').length > 0;
        const sel = $('schemaSelect');
        runBtn.disabled = !(anyChecked && state.pipelineAvailable && sel && !!sel.value);
    }

    if ($('docChecklist')) $('docChecklist').addEventListener('change', updateRunBtn);

    async function loadSchemas() {
        if (state.role !== 'admin') return;
        try {
            const data = await api('/schemas');
            state.schemas = data.schemas || [];
            const sel = $('schemaSelect');
            if (!sel) return;
            if (!state.schemas.length) {
                sel.innerHTML = '<option value="">-- no confirmed schemas --</option>';
                sel.disabled = true;
            } else {
                sel.innerHTML = '<option value="">-- select a schema --</option>' +
                    state.schemas.map(s => `<option value="${escapeHtml(s.schema_id)}">
                        ${escapeHtml(s.document_type || 'untitled')} • ${s.field_count} fields • ${escapeHtml(s.schema_id.slice(0, 12))}
                    </option>`).join('');
                sel.disabled = false;
            }
            sel.removeEventListener('change', updateRunBtn);
            sel.addEventListener('change', updateRunBtn);
            updateRunBtn();
        } catch (e) {
            console.warn('loadSchemas failed', e);
        }
    }

    if ($('refreshSchemasBtn')) $('refreshSchemasBtn').addEventListener('click', loadSchemas);

    async function loadPipelineStatus() {
        if (state.role !== 'admin') return;
        try {
            const data = await api('/pipeline/status');
            state.pipelineAvailable = !!data.available;
            const badge = $('pipelineAvail');
            if (badge) {
                if (data.available) {
                    badge.textContent = 'available • ' + (data.routing_mode || '');
                    badge.className = 'badge badge-success';
                } else {
                    badge.textContent = 'unavailable';
                    badge.className = 'badge badge-danger';
                }
            }
            if (data.layer3_strategy && $('layer3StrategySelect') && !window.__userChangedStrategy) {
                $('layer3StrategySelect').value = data.layer3_strategy;
            }
            updateRunBtn();
        } catch (e) {
            console.warn('pipeline status failed', e);
        }
    }

    function jobStatusBadgeClass(s) {
        return {
            queued: 'badge-warn',
            running: 'badge-info',
            killed: 'badge-danger',
            completed: 'badge-success'
        }[s] || 'badge-mute';
    }

    // ======================= OCR page progress =======================

    // Elapsed time as m:ss, or h:mm:ss from one hour. Returns --:-- for missing values.
    function formatClock(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
        const t = Math.floor(seconds);
        const h = Math.floor(t / 3600);
        const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
        const s = String(t % 60).padStart(2, '0');
        return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    // Time left, phrased as an estimate. Never shows a negative or huge value.
    function formatEta(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return 'Calculating...';
        if (seconds < 60) return 'under a minute';
        if (seconds > 86400) return 'more than a day';
        const mins = Math.round(seconds / 60);
        if (mins < 60) return `about ${mins} min`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m ? `about ${h} h ${m} min` : `about ${h} h`;
    }

    // Phase of an OCR job as the UI shows it.
    function ocrState(progress, status) {
        if (status === 'completed' || progress.phase === 'finished') return 'completed';
        if (status === 'killed' || progress.phase === 'killed') return progress.stopping ? 'stopping' : 'stopped';
        if (progress.phase === 'queued' || status === 'queued') return 'queued';
        if (progress.phase === 'rendering') return 'preparing';
        if (progress.phase === 'extracting') return 'extracting';
        if (progress.phase === 'graph_building') return 'graph';
        if (progress.phase === 'saving') return 'saving';
        if (!(progress.pages_total > 0)) return 'counting';
        return 'running';
    }

    // Highest percentage shown so far for each job. The bar never moves backwards, even
    // when a poll reports a smaller value (for example when the page total is revised).
    const ocrShownPct = new Map();

    // Jobs that are still doing OCR, from the last list poll. Only these are fetched every second.
    let liveOcrJobIds = new Set();
    const liveOcrStatus = new Map();
    let liveOcrPollBusy = false;

    function displayPct(key, pct) {
        const prev = ocrShownPct.get(key);
        const next = prev === undefined ? pct : Math.max(prev, pct);
        ocrShownPct.set(key, next);
        return next;
    }

    // Everything the progress UI needs. progress is null for jobs created before
    // page progress existed. In that case the model falls back to document counts.
    function ocrModel(progress, status, fallback) {
        const fb = fallback || {};
        if (!progress) {
            const docsTotal = fb.docsTotal || 0;
            const docsDone = Math.min(fb.docsDone || 0, docsTotal);
            return {
                legacy: true,
                key: '',
                state: 'legacy',
                pct: docsTotal ? Math.round(100 * docsDone / docsTotal) : 0,
                indeterminate: false,
                barClass: '',
                statusText: 'Document progress',
                statusTone: '',
                caption: `${docsDone} of ${docsTotal} documents`,
                note: 'Page-level progress is not recorded for this job.',
                currentDoc: null,
                etaText: '--',
                pagesText: '--',
                docsText: `${docsDone} of ${docsTotal}`,
                rowText: '',
            };
        }

        const state = ocrState(progress, status);
        const total = Number(progress.pages_total) || 0;
        const done = Math.max(0, Math.min(Number(progress.pages_done) || 0, total));
        const docsTotal = Number(progress.docs_total) || 0;
        const docsDone = Number(progress.docs_done) || 0;
        const docNo = docsTotal ? Math.min(docsDone + 1, docsTotal) : 0;
        const pagePart = total ? `Page ${done} of ${total}` : '';
        const docPart = docsTotal ? `Document ${docNo} of ${docsTotal}` : '';
        const inFlight = Number(progress.pages_in_flight) || 0;
        const flightPart = state === 'running' && inFlight > 0 ? `${inFlight} in flight` : '';
        const currentDoc = progress.current_doc || null;
        const eta = Number.isFinite(progress.eta_s) ? progress.eta_s : null;
        const etaPhrase = eta === null ? 'Calculating...' : formatEta(eta);
        const pct = total > 0 ? Math.round(100 * done / total) : null;

        const m = {
            legacy: false,
            key: fb.key || '',
            state,
            pct,
            indeterminate: false,
            barClass: '',
            statusText: '',
            statusTone: '',
            caption: [pagePart, flightPart, docPart].filter(Boolean).join('  \u2022  '),
            note: '',
            currentDoc: null,
            etaText: etaPhrase,
            pagesText: total ? `${done} of ${total}` : '--',
            docsText: docsTotal ? `${docsDone} of ${docsTotal}` : '--',
            rowText: '',
        };

        switch (state) {
            case 'queued':
                m.statusText = 'Waiting to start';
                m.caption = 'Waiting to start';
                m.barClass = 'is-queued';
                m.pct = null;
                m.etaText = '--';
                m.pagesText = '--';
                m.rowText = 'Waiting to start';
                break;
            case 'preparing':
                m.statusText = 'Preparing document';
                m.caption = m.caption || 'Rendering pages';
                // Rendering runs before the first page is OCR'd, so the bar moves but shows no value yet.
                m.indeterminate = true;
                m.pct = null;
                m.etaText = '--';
                m.currentDoc = currentDoc;
                m.rowText = 'Preparing document';
                break;
            case 'counting':
                m.statusText = 'Counting pages';
                m.caption = 'Counting pages...';
                m.indeterminate = true;
                m.pct = null;
                m.currentDoc = currentDoc;
                m.rowText = 'Counting pages';
                break;
            case 'running':
                m.statusText = 'OCR running';
                m.currentDoc = currentDoc;
                if (done === 0) {
                    // No page has finished, so there is no rate yet. Show a moving bar, not a frozen 0%.
                    m.indeterminate = true;
                    m.pct = null;
                    m.caption = [total ? `Waiting for first page of ${total}` : 'Waiting for first page', flightPart]
                        .filter(Boolean)
                        .join('  \u2022  ');
                    m.etaText = '--';
                    m.rowText = `${m.pagesText} pages \u2022 waiting for first page`;
                } else {
                    m.caption = m.caption || 'Preparing pages';
                    m.rowText = `${m.pagesText} pages \u2022 ${eta === null ? 'estimating time left' : formatEta(eta) + ' left'}`;
                }
                break;
            case 'extracting':
                m.statusText = 'Extracting fields';
                m.note = 'Field extraction is not counted in OCR progress.';
                m.currentDoc = currentDoc;
                m.rowText = `${m.pagesText} pages \u2022 extracting fields`;
                break;
            case 'stopping':
                m.statusText = 'Stopping after this document';
                m.statusTone = 'is-stopping';
                m.barClass = 'is-stopping';
                m.note = 'The current document finishes first, then the job stops.';
                m.currentDoc = currentDoc;
                m.rowText = `${m.pagesText} pages \u2022 stopping after this document`;
                break;
            case 'stopped': {
                // Pages that never ran were removed from pages_total. Measure against the planned
                // total (run + not run), so a stopped job does not show 100%.
                const skipped = Number(progress.pages_skipped) || 0;
                const planned = total + skipped;
                m.pct = planned ? Math.round(100 * done / planned) : null;
                m.pagesText = planned ? `${done} of ${planned}` : '--';
                m.statusText = planned ? `Stopped at page ${done} of ${planned}` : 'Stopped';
                m.statusTone = 'is-stopped';
                m.barClass = 'is-killed';
                m.caption = [skipped ? `${skipped} pages not run` : '', docPart].filter(Boolean).join('  \u2022  ');
                m.note = 'Pages already finished are kept.';
                m.etaText = '--';
                m.currentDoc = currentDoc;
                m.rowText = m.statusText;
                break;
            }
            case 'saving':
                m.statusText = 'Saving OCR output';
                m.note = 'Saving the output is not counted in OCR time.';
                m.etaText = 'OCR finished';
                m.currentDoc = currentDoc;
                m.rowText = `${m.pagesText} pages \u2022 OCR done \u2022 saving output`;
                break;
            case 'graph':
                m.statusText = 'OCR done, building graph memory';
                m.note = 'OCR time is frozen. Graph memory time counts separately.';
                m.etaText = 'OCR finished';
                m.currentDoc = currentDoc;
                m.rowText = 'OCR done \u2022 building graph memory';
                break;
            case 'completed':
                m.statusText = 'Completed';
                m.statusTone = 'is-completed';
                m.pct = 100;
                m.caption = [total ? `${total} pages` : '', docsTotal ? `${docsTotal} documents` : '']
                    .filter(Boolean)
                    .join('  \u2022  ');
                m.rowText = total ? `${total} pages \u2022 done` : 'Done';
                break;
            default:
                break;
        }

        if (fb.key && m.pct !== null) m.pct = displayPct(fb.key, m.pct);

        // Two timers, each with its own value from the server. A timer runs while its
        // start timestamp is set and its finish timestamp is not. The totals include
        // every document of the job.
        const ocrSeconds = Number(progress.ocr_elapsed_s ?? progress.ocr_s) || 0;
        const graphSeconds = Number(progress.graph_elapsed_s) || 0;
        const ocrRunning = Boolean(progress.ocr_started_at) && !progress.ocr_finished_at;
        const graphRunning = Boolean(progress.graph_started_at) && !progress.graph_finished_at;
        // "done" refers to the current document. The server clears these timestamps when
        // the next document starts, so the OCR box does not claim "done" while that
        // document is still being prepared.
        m.ocr = {
            running: ocrRunning,
            seconds: ocrSeconds,
            done: !ocrRunning && Boolean(progress.ocr_finished_at),
        };
        // Graph memory is only built by graph_memory* strategies. An unknown strategy
        // (older jobs) keeps the graph box.
        m.graphUsed = fb.strategy ? String(fb.strategy).startsWith('graph_memory') : true;
        m.graph = {
            running: graphRunning,
            seconds: graphSeconds,
            done: !graphRunning && Boolean(progress.graph_finished_at),
        };
        m.graphStarted = graphRunning || Boolean(progress.graph_started_at) || graphSeconds > 0;
        return m;
    }

    function ocrBarAttrs(m) {
        // Legacy jobs have no page counts, so their bar measures documents.
        const label = m.legacy ? 'OCR document progress' : 'OCR page progress';
        const unit = m.legacy ? '% of documents' : '% of pages';
        if (m.indeterminate || m.pct === null) {
            return `role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${escapeHtml(m.caption || m.statusText)}"`;
        }
        return `role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.pct}" aria-valuetext="${escapeHtml(`${m.pct}${unit}. ${m.caption}`)}"`;
    }

    // Compact bar for list rows. Replaces the document-only bar in the same slot.
    function ocrRowBarMarkup(m) {
        const cls = ['progress-bar-fill', 'ocr-fill', m.barClass, m.indeterminate ? 'is-indeterminate' : '']
            .filter(Boolean)
            .join(' ');
        const style = m.indeterminate ? '' : ` style="width:${m.pct === null ? 0 : m.pct}%"`;
        return `<div class="progress-bar-wrap" data-ocr-bar="${escapeHtml(m.key)}" ${ocrBarAttrs(m)}><div class="${cls}"${style}></div></div>`;
    }

    function ocrRowTextMarkup(m) {
        if (m.legacy || !m.rowText) return '';
        return `<div class="job-meta ocr-row-text" data-ocr-text="${escapeHtml(m.key)}">${escapeHtml(m.rowText)}</div>`;
    }

    // Updates a row bar that is already on screen. The fill element is kept, so the CSS
    // width transition runs from the old value to the new one.
    function paintRowBar(wrap, m) {
        const fill = wrap.querySelector('.progress-bar-fill');
        if (!fill) return;
        // Leaving the indeterminate segment (30% wide) must not animate down to the first value.
        const leavingIndeterminate = fill.classList.contains('is-indeterminate') && !m.indeterminate;
        if (leavingIndeterminate) fill.style.transition = 'none';
        fill.className = ['progress-bar-fill', 'ocr-fill', m.barClass, m.indeterminate ? 'is-indeterminate' : '']
            .filter(Boolean)
            .join(' ');
        fill.style.width = m.indeterminate ? '' : `${m.pct === null ? 0 : m.pct}%`;
        if (leavingIndeterminate) {
            void fill.offsetWidth; // commit the new width before the transition is switched back on
            fill.style.transition = '';
        }
        if (m.indeterminate || m.pct === null) {
            wrap.removeAttribute('aria-valuenow');
            wrap.setAttribute('aria-valuetext', m.caption || m.statusText);
        } else {
            wrap.setAttribute('aria-valuenow', String(m.pct));
            wrap.setAttribute('aria-valuetext', `${m.pct}% of pages. ${m.caption}`);
        }
    }

    // Data attributes that let tickOcrElapsed count a running timer between polls.
    function timerClockAttrs(kind, timer) {
        if (!timer.running) return '';
        return ` data-${kind}-clock="running" data-${kind}-base="${timer.seconds}" data-${kind}-at="${Date.now()}"`;
    }

    // The OCR timer and the graph memory timer, side by side. Their text is fixed
    // strings or numbers from the server, so no escaping is needed for the sub-lines.
    function timerStatsHtml(m, showEta) {
        const ocr = m.ocr;
        const graph = m.graph;
        const ocrValue = ocr.running || ocr.seconds > 0 ? formatClock(ocr.seconds) : '--:--';
        let ocrSub = 'Not started';
        if (ocr.running) ocrSub = 'OCR running';
        else if (ocr.done) ocrSub = `OCR done in ${ocr.seconds.toFixed(1)}s`;
        else if (ocr.seconds > 0) ocrSub = 'Waiting for next document';

        let graphValue = '--:--';
        let graphSub;
        if (!m.graphUsed) {
            graphSub = 'Not used for page scan';
        } else {
            graphValue = graph.running || graph.seconds > 0 ? formatClock(graph.seconds) : '--:--';
            if (graph.running) {
                graphSub = '<span class="graph-build-spinner" aria-hidden="true"></span><span>Building graph memory\u2026</span>';
            } else if (graph.done) {
                graphSub = `Graph built in ${graph.seconds.toFixed(1)}s`;
            } else if (m.state === 'completed' || m.state === 'stopped') {
                graphSub = 'Not run';
            } else if (graph.seconds > 0) {
                graphSub = 'Waiting for next document';
            } else {
                graphSub = 'Starts after OCR';
            }
        }

        return `
            <div class="job-summary-grid ocr-stats">
                <div class="summary-box ocr-timer${ocr.running ? ' is-running' : ''}" data-timer="ocr">
                    <div class="lbl">OCR time</div>
                    <div class="val"${timerClockAttrs('ocr', ocr)}>${ocrValue}</div>
                    <div class="ocr-timer-sub">${ocrSub}</div>
                </div>
                <div class="summary-box ocr-timer graph-timer${graph.running ? ' is-running' : ''}" data-timer="graph">
                    <div class="lbl">Graph memory</div>
                    <div class="val"${timerClockAttrs('graph', graph)}>${graphValue}</div>
                    <div class="ocr-timer-sub">${graphSub}</div>
                </div>
                <div class="summary-box"><div class="lbl">${showEta ? 'OCR time left' : 'Documents'}</div><div class="val">${escapeHtml(showEta ? m.etaText : m.docsText)}</div></div>
                <div class="summary-box"><div class="lbl">Pages</div><div class="val">${escapeHtml(m.pagesText)}</div></div>
            </div>`;
    }

    function jobProgressHtml(m) {
        const cls = ['ocr-fill', m.barClass, m.indeterminate ? 'is-indeterminate' : '']
            .filter(Boolean)
            .join(' ');
        const fillStyle = m.indeterminate ? '' : ` style="width:${m.pct === null ? 0 : m.pct}%"`;
        const pctText = m.pct === null ? '--' : `${m.pct}%`;
        const showEta = m.state !== 'completed';
        const stats = m.legacy ? '' : timerStatsHtml(m, showEta);
        return `
            <div class="ocr-progress-status-line"><span class="ocr-progress-status ${m.statusTone}">${escapeHtml(m.statusText)}</span></div>
            <div class="ocr-progress-bar-row">
                <div class="ocr-progress-track" ${ocrBarAttrs(m)}><div class="${cls}"${fillStyle}></div></div>
                <div class="ocr-progress-pct" aria-hidden="true">${pctText}</div>
            </div>
            ${m.caption ? `<div class="ocr-progress-caption">${escapeHtml(m.caption)}</div>` : ''}
            ${m.currentDoc ? `<div class="ocr-progress-doc">Current file: <code>${escapeHtml(m.currentDoc)}</code></div>` : ''}
            ${m.note ? `<div class="ocr-progress-note">${escapeHtml(m.note)}</div>` : ''}
            ${stats}`;
    }

    // Draws the detail panel. The fill animates from its previous width when the
    // panel is redrawn on the next poll.
    function renderJobProgressPanel(host, job) {
        const m = ocrModel(job.progress, job.status, {
            key: job.job_id,
            docsDone: (job.successes || []).length + (job.failures || []).length,
            docsTotal: (job.targets || []).length,
            strategy: job.strategy,
        });
        host.classList.remove('hidden');
        host.innerHTML = jobProgressHtml(m);

        const fill = host.querySelector('.ocr-fill');
        const prevRaw = host.dataset.pct;
        if (fill && !m.indeterminate && prevRaw !== undefined && prevRaw !== '' && Number(prevRaw) !== m.pct) {
            fill.style.width = `${prevRaw}%`;
            void fill.offsetWidth; // commit the previous width so the change animates
            fill.style.width = `${m.pct === null ? 0 : m.pct}%`;
        }
        host.dataset.pct = m.pct === null ? '' : String(m.pct);
    }

    // Counts each running timer forward between polls. Each poll sets the server value
    // and the time it was received, so a page refresh resumes from the server's number.
    function tickOcrElapsed() {
        const now = Date.now();
        ['ocr', 'graph'].forEach((kind) => {
            document.querySelectorAll(`[data-${kind}-clock="running"]`).forEach((node) => {
                const base = Number(node.dataset[`${kind}Base`]);
                const at = Number(node.dataset[`${kind}At`]);
                if (!Number.isFinite(base) || !Number.isFinite(at)) return;
                node.textContent = formatClock(base + (now - at) / 1000);
            });
        });
    }

    function isLiveOcrJob(j) {
        return j.status === 'running' || j.status === 'queued';
    }

    function setLiveOcrJobs(jobs) {
        liveOcrJobIds = new Set(jobs.filter(isLiveOcrJob).map((j) => j.job_id));
    }

    // Redraws one job's row bar, row text and (when open) detail panel from a fresh job detail.
    function applyLiveOcrJob(j) {
        const docsDone = j.completed ?? ((j.succeeded || 0) + (j.failed || 0));
        const docsTotal = j.total ?? (j.targets || []).length;
        const m = ocrModel(j.progress, j.status, { key: j.job_id, docsDone, docsTotal, strategy: j.strategy });
        const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
        document.querySelectorAll(`[data-ocr-bar="${esc(j.job_id)}"]`).forEach((wrap) => paintRowBar(wrap, m));
        document.querySelectorAll(`[data-ocr-text="${esc(j.job_id)}"]`).forEach((node) => {
            node.textContent = m.rowText;
        });
        if (state.selectedJobId === j.job_id) {
            const host = state.role === 'user' ? $('userJobProgress') : $('adminJobProgress');
            if (host && j.progress) renderJobProgressPanel(host, j);
        }
        // A status change (for example running to completed) reloads the lists once, so the
        // dataset, status badges and outputs follow without a manual refresh.
        const prev = liveOcrStatus.get(j.job_id);
        liveOcrStatus.set(j.job_id, j.status);
        if (prev !== undefined && prev !== j.status) {
            if (state.role === 'user') loadUserJobs();
            else loadJobs();
        }
    }

    // Polls each live OCR job's detail once per second. Skips a tick while the last one is still in flight.
    async function pollLiveOcrJobs() {
        if (liveOcrPollBusy || !state.token || liveOcrJobIds.size === 0) return;
        liveOcrPollBusy = true;
        try {
            const base = state.role === 'user' ? '/me/pipeline/jobs/' : '/pipeline/jobs/';
            await Promise.all([...liveOcrJobIds].map(async (id) => {
                try {
                    applyLiveOcrJob(await api(base + id));
                } catch (e) {
                    // The 4 s list poll retries this job on its next pass.
                }
            }));
        } finally {
            liveOcrPollBusy = false;
        }
    }

    async function killJob(jobId, e) {
        if (e) e.stopPropagation();
        if (!confirm(`Are you sure you want to kill / cancel job ${jobId}?`)) return;
        try {
            await api(`/pipeline/jobs/${jobId}/kill`, { method: 'POST' });
            loadJobs();
            if (state.selectedJobId === jobId) loadJobDetail(jobId);
        } catch (err) {
            alert('Failed to kill job: ' + err.message);
        }
    }

    // Last job-state signature seen by the poll. A change refreshes the document, OCR and Outputs views once.
    let adminJobSignature = null;
    async function loadJobs() {
        if (state.role !== 'admin') return;
        try {
            const data = await api('/pipeline/status');
            const jobs = Object.values(data.jobs || {});
            state.jobs = jobs;
            setLiveOcrJobs(jobs);
            const signature = jobs
                .map(j => `${j.job_id}|${j.status}|${j.completed || 0}|${j.current_document || ''}`)
                .sort()
                .join('\n');
            if (adminJobSignature !== null && signature !== adminJobSignature) loadDocuments();
            adminJobSignature = signature;
            const host = $('jobList');
            if (!host) return;
            if (!jobs.length) {
                host.innerHTML = '<p class="muted">No jobs yet.</p>';
                return;
            }
            host.innerHTML = '';
            jobs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            jobs.forEach(j => {
                const done = j.completed || 0;
                const total = j.total || 0;
                const ocr = ocrModel(j.progress, j.status, { key: j.job_id, docsDone: done, docsTotal: total, strategy: j.strategy });
                const row = el('div', 'job-item');

                let actionButtons = '';
                if (j.status === 'running' || j.status === 'queued') {
                    actionButtons = `
                        <button class="btn btn-ghost btn-sm" title="Kill job" style="color:#fca5a5" data-action="kill" data-job="${escapeHtml(j.job_id)}"></button>
                    `;
                }

                row.innerHTML = `
                    <div class="job-item-left">
                        <div class="job-id">${escapeHtml(j.job_id)}</div>
                        <div class="job-meta">${escapeHtml(fmtDateTime(j.created_at))} • schema: ${escapeHtml(j.schema_id || '--')} • ${done}/${total} docs</div>
                        ${ocrRowTextMarkup(ocr)}
                    </div>
                    <div class="job-item-right">
                        ${ocrRowBarMarkup(ocr)}
                        <span class="badge ${jobStatusBadgeClass(j.status)}">${escapeHtml(j.status)}</span>
                        <div class="job-item-actions">${actionButtons}</div>
                    </div>
                `;
                row.addEventListener('click', (e) => {
                    const btn = e.target.closest('button[data-action]');
                    if (btn) {
                        e.stopPropagation();
                        const act = btn.dataset.action;
                        const jid = btn.dataset.job;
                        if (act === 'kill') killJob(jid, e);
                        return;
                    }
                    loadJobDetail(j.job_id, true);
                });
                host.appendChild(row);
            });
            if (state.selectedJobId) loadJobDetail(state.selectedJobId, false);
        } catch (e) {
            console.warn('loadJobs failed', e);
        }
    }

    async function killUserJob(jobId, e) {
        if (e) e.stopPropagation();
        if (!confirm(`Cancel job ${jobId}?`)) return;
        try {
            await api(`/me/pipeline/jobs/${jobId}/kill`, { method: 'POST' });
            loadUserJobs();
            loadJobDetail(jobId);
        } catch (err) {
            alert('Kill failed: ' + err.message);
        }
    }

    async function loadJobDetail(jobId, shouldScroll = false) {
        if (!jobId || jobId === 'undefined') return;
        state.selectedJobId = jobId;
        try {
            const apiPath = state.role === 'user' ? ('/me/pipeline/jobs/' + jobId) : ('/pipeline/jobs/' + jobId);
            const j = await api(apiPath);
            window.__currentJobDetail = j;

            const isUser = state.role === 'user';
            const card = isUser ? ($('userJobDetailCard') || $('jobDetailCard')) : $('jobDetailCard');
            if (card) {
                card.classList.remove('hidden');
                if (shouldScroll) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
            const idSpan = isUser ? ($('userDetailJobId') || $('detailJobId')) : $('detailJobId');
            if (idSpan) idSpan.textContent = jobId;
            const st = isUser ? ($('userDetailStatus') || $('detailStatus')) : $('detailStatus');
            if (st) {
                st.textContent = j.status;
                st.className = 'badge ' + jobStatusBadgeClass(j.status);
            }

            const killBtn = isUser ? ($('userJobKillBtn') || $('jobKillBtn')) : $('jobKillBtn');

            if (killBtn) {
                killBtn.classList.toggle('hidden', !(j.status === 'running' || j.status === 'queued'));
                killBtn.onclick = (e) => isUser ? killUserJob(jobId, e) : killJob(jobId, e);
            }

            const progressHost = isUser ? $('userJobProgress') : $('adminJobProgress');
            if (progressHost) renderJobProgressPanel(progressHost, j);

            const host = isUser ? ($('userJobDetail') || $('jobDetail')) : $('jobDetail');
            if (!host) return;

            // progress has live elapsed time, so it is kept out of the JSON view and the change check.
            // Otherwise the JSON view would be rebuilt on every poll.
            const { progress: _progress, ...jobForView } = j;
            const newJsonStr = JSON.stringify(jobForView);
            // Skip full DOM rebuild if this job's data is identical to what's already rendered
            if (window.__renderedJobId === j.job_id && window.__renderedJobJson === newJsonStr && host.children.length > 0) {
                return;
            }

            // Capture current scroll positions before replacing innerHTML
            const fullJsonEl = document.getElementById('fullJsonView');
            const preScrollTop = fullJsonEl ? fullJsonEl.scrollTop : 0;
            const preScrollLeft = fullJsonEl ? fullJsonEl.scrollLeft : 0;
            const hostScrollTop = host.scrollTop;

            const wall = j.wall_time_s ? `${j.wall_time_s.toFixed(1)}s` : '--';
            const sucs = j.successes || [];
            const fails = j.failures || [];

            host.innerHTML = `
                <div class="job-summary-grid">
                    <div class="summary-box"><div class="lbl">Status</div><div class="val">${escapeHtml(j.status)}</div></div>
                    <div class="summary-box"><div class="lbl">Strategy</div><div class="val" style="font-size:12px; font-weight:600; color:${(j.strategy || '').startsWith('graph_memory') ? '#c084fc' : '#94a3b8'}">${(j.strategy || '').startsWith('graph_memory') ? ((j.strategy === 'graph_memory_concurrent') ? 'Graph Memory Concurrent' : 'Graph Memory') : 'Page Scan'}</div></div>
                    <div class="summary-box"><div class="lbl">Docs</div><div class="val">${sucs.length + fails.length} / ${(j.targets || []).length || 0}</div></div>
                    <div class="summary-box"><div class="lbl">Success</div><div class="val" style="color:#6ee7b7">${sucs.length}</div></div>
                    <div class="summary-box"><div class="lbl">Wall time</div><div class="val">${wall}</div></div>
                </div>
                ${sucs.length ? `
                <div class="job-section">
                    <h3>Successful (${sucs.length})</h3>
                    ${sucs.map((s, idx) => `
                        <div class="result-row ok" style="flex-direction: column; align-items: stretch; gap: 8px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div>
                                    <span class="result-name">${escapeHtml(s.pdf)}</span>
                                    <div class="result-meta">pages: ${s.pages} • conf: ${(s.avg_conf || 0).toFixed(3)} • Layer 1+2: ${s.elapsed_s}s ${s.extract_elapsed_s ? `• Layer 3 (${s.strategy || 'extract'}): ${s.extract_elapsed_s}s` : ''}${s.ocr_elapsed_s !== undefined ? ` • OCR ${Number(s.ocr_elapsed_s).toFixed(1)}s • graph ${s.graph_elapsed_s ? `${Number(s.graph_elapsed_s).toFixed(1)}s` : 'not run'}` : ''}</div>
                                </div>
                                <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                                    ${(s.strategy || '').startsWith('graph_memory')
                                        ? `<span class="badge badge-primary">${s.strategy === 'graph_memory_concurrent' ? '' : ''} ${s.strategy === 'graph_memory_concurrent' ? 'Graph Memory Concurrent' : 'Graph Memory'} (${s.graph_nodes || 0} nodes, ${s.graph_edges || 0} edges)</span>`
                                        : `<span class="badge badge-mute">Classic Page Scan</span>`}
                                    ${s.db_run_id ? `<span class="badge badge-success">PostgreSQL: Run #${s.db_run_id}</span>` : ''}
                                    ${s.md_db_saved === true ? '<span class="badge badge-success">OCR text saved to DB</span>' : (s.md_db_saved === false ? '<span class="badge badge-warn">OCR text not saved to DB</span>' : '')}
                                    <span class="result-meta"><code>${escapeHtml(s.md)}</code></span>
                                </div>
                            </div>
                            ${s.extracted_data ? `
                            <div class="extracted-json-box">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                    <strong class="extracted-json-title">Layer 3 Extracted JSON (${escapeHtml(s.extracted_json || 'record.json')})</strong>
                                    <button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText(JSON.stringify(${escapeHtml(JSON.stringify(s.extracted_data))}, null, 2)); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy JSON', 1500)">Copy JSON</button>
                                </div>
                                <pre class="extracted-json-pre">${escapeHtml(JSON.stringify(s.extracted_data, null, 2))}</pre>
                            </div>
                            ` : ''}
                            ${s.graph_memory && s.graph_memory.snapshot ? `
                            <details class="graph-memory-details">
                                <summary class="graph-memory-summary">
                                    Document Knowledge Graph (${s.graph_nodes || 0} Entities, ${s.graph_edges || 0} Relationships)
                                </summary>
                                <div style="margin-top: 8px; font-size: 11px;">
                                    <div style="display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
                                        <span class="badge badge-info font-mono">Entities: ${s.graph_nodes || 0}</span>
                                        <span class="badge badge-warn font-mono">Relationships: ${s.graph_edges || 0}</span>
                                        <span class="badge badge-primary font-mono">Strategy: Graph Memory</span>
                                    </div>
                                    <div class="graph-memory-list" style="max-height: 220px; margin-bottom: 6px;">
                                        <strong>Captured Graph Nodes &amp; Evidence:</strong>
                                        <ul style="margin: 4px 0 0 16px; padding: 0;">
                                            ${(s.graph_memory.snapshot.nodes || []).map(n => `
                                                <li style="margin-bottom: 4px;">
                                                    <span class="graph-memory-type">[${escapeHtml(n.type)}]</span>
                                                    <strong>${escapeHtml(n.label || '')}:</strong> <code>${escapeHtml(n.value || '')}</code>
                                                    <span class="muted small">(Pages: ${(n.source_pages || []).join(',')}, conf: ${n.confidence})</span>
                                                    ${(n.evidence && n.evidence.length) ? `<div class="muted small" style="padding-left: 12px; font-style: italic;">"${escapeHtml(n.evidence[0].text || '')}"</div>` : ''}
                                                </li>
                                            `).join('')}
                                        </ul>
                                    </div>
                                    ${(s.graph_memory.snapshot.edges || []).length ? `
                                    <div class="graph-memory-list" style="max-height: 180px;">
                                        <strong>Entity Relationships &amp; Cross-Page Anaphora:</strong>
                                        <ul style="margin: 4px 0 0 16px; padding: 0;">
                                            ${(s.graph_memory.snapshot.edges || []).map(e => `
                                                <li style="margin-bottom: 4px;">
                                                    <code>${escapeHtml(e.source_node)}</code> --[<strong class="graph-memory-rel">${escapeHtml(e.relationship)}</strong> (status: ${escapeHtml(e.status)})]--> <code>${escapeHtml(e.target_node)}</code>
                                                    <span class="muted small">(P${e.source_page})</span>
                                                    ${e.evidence ? `<div class="muted small" style="padding-left: 12px; font-style: italic;">"${escapeHtml(e.evidence)}"</div>` : ''}
                                                </li>
                                            `).join('')}
                                        </ul>
                                    </div>
                                    ` : ''}
                                </div>
                            </details>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
                ` : ''}
                ${fails.length ? `
                <div class="job-section">
                    <h3>Failed (${fails.length})</h3>
                    ${fails.map(f => `
                        <div class="result-row fail">
                            <div>
                                <span class="result-name">${escapeHtml(f.pdf)}</span>
                                <div class="result-error">${escapeHtml(f.error_type)}: ${escapeHtml(f.error)}</div>
                            </div>
                            <div class="result-meta">${f.elapsed_s}s</div>
                        </div>
                    `).join('')}
                </div>
                ` : ''}

                <div class="job-section">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
                        <h3 style="margin:0;">Full JSON</h3>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText(JSON.stringify(window.__currentJobDetail, null, 2)); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy JSON', 1500)">Copy JSON</button>
                            <button class="btn btn-sm btn-outline" onclick="downloadJobJson()">Download JSON</button>
                            <button class="btn btn-sm btn-primary" onclick="downloadJobPdf('${j.job_id}')">Download PDF</button>
                        </div>
                    </div>
                    <pre id="fullJsonView" class="job-full-json-pre">${escapeHtml(JSON.stringify(jobForView, null, 2))}</pre>
                </div>

            `;

            // Restore scroll positions after rebuilding
            const restoredPre = document.getElementById('fullJsonView');
            if (restoredPre && (preScrollTop || preScrollLeft)) {
                restoredPre.scrollTop = preScrollTop;
                restoredPre.scrollLeft = preScrollLeft;
            }
            if (host && hostScrollTop) {
                host.scrollTop = hostScrollTop;
            }

            window.__renderedJobId = j.job_id;
            window.__renderedJobJson = newJsonStr;
        } catch (e) {
            console.warn('job detail failed', e);
        }
    }

    if ($('refreshJobsBtn')) $('refreshJobsBtn').addEventListener('click', () => { loadJobs(); });

    if ($('runPipelineBtn')) {
        $('runPipelineBtn').addEventListener('click', async () => {
            const schema_id = $('schemaSelect').value;
            if (!schema_id) return;
            const selected = Array.from(document.querySelectorAll('.doc-check:checked')).map(c => c.value);
            if (!selected.length) return;

            const btn = $('runPipelineBtn');
            btn.disabled = true;
            const oldText = btn.textContent;
            btn.textContent = 'Starting...';
            try {
                const fd = new FormData();
                fd.append('schema_id', schema_id);
                fd.append('documents', JSON.stringify(selected));
                const strategy = ($('layer3StrategySelect') && $('layer3StrategySelect').value) || 'graph_memory_concurrent';
                fd.append('strategy', strategy);
                const res = await api('/pipeline/run', { method: 'POST', body: fd });
                btn.textContent = 'Running (job ' + res.job_id + ')...';
                state.selectedJobId = res.job_id;
                loadJobs();

                let polls = 0;
                const interval = setInterval(async () => {
                    polls++;
                    try {
                        const j = await api('/pipeline/jobs/' + res.job_id);
                        loadJobs();
                        if (j.status === 'completed' || j.status === 'killed' || polls > 300) {
                            clearInterval(interval);
                            btn.textContent = oldText;
                            btn.disabled = false;
                            updateRunBtn();
                        }
                    } catch (e) {
                        clearInterval(interval);
                        btn.textContent = oldText;
                        btn.disabled = false;
                    }
                }, 2000);
            } catch (e) {
                btn.textContent = oldText;
                btn.disabled = false;
                alert('Pipeline start failed: ' + e.message);
            }
        });
    }

    // ======================= User Pipeline & Jobs =======================

    async function runUserPipeline() {
        const btn = $('userAutoRunPipelineBtn') || $('quickRunPipelineBtn');
        if (btn) btn.disabled = true;
        showStatus('userAutoRunStatus', 'Starting extraction pipeline for your workspace...', 'info');

        try {
            const fd = new FormData();
            // Normal users always run the recommended concurrent strategy.
            fd.append('strategy', 'graph_memory_concurrent');
            const chosenSchema = $('userSchemaSelect') && $('userSchemaSelect').value;
            if (chosenSchema) fd.append('schema_id', chosenSchema);
            const res = await api('/me/pipeline/run', { method: 'POST', body: fd });
            showStatus('userAutoRunStatus', `Job ${res.job_id} queued for ${res.targets} document(s).`, 'success');
            loadUserJobs();
        } catch (e) {
            showStatus('userAutoRunStatus', 'Failed to run pipeline: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    if ($('userAutoRunPipelineBtn')) $('userAutoRunPipelineBtn').addEventListener('click', runUserPipeline);
    if ($('refreshUserSchemasBtn')) $('refreshUserSchemasBtn').addEventListener('click', loadUserSchemas);

    async function loadUserSchemas() {
        const sel = $('userSchemaSelect');
        if (!sel) return;
        try {
            const schemas = await api('/me/schemas');
            const current = sel.value;
            sel.innerHTML = '<option value="">— select your schema —</option>';
            (schemas || []).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.schema_id;
                const label = s.schema_name || s.document_type || s.schema_id;
                const ver = s.version ? ` (v${s.version})` : '';
                opt.textContent = `${label}${ver} · ${s.field_count} field(s)`;
                sel.appendChild(opt);
            });
            if (current) sel.value = current;
        } catch (e) {
            sel.innerHTML = `<option value="">Failed to load schemas</option>`;
        }
    }
    if ($('quickRunPipelineBtn')) {
        $('quickRunPipelineBtn').addEventListener('click', () => {
            if (state.role === 'user') {
                runUserPipeline();
            } else {
                // Admin quick run: scroll down and pre-select
                const pipeSection = $('adminPipelineSection');
                if (pipeSection) pipeSection.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    let userJobSignature = null;
    async function loadUserJobs() {
        if (state.role !== 'user') return;
        try {
            const data = await api('/me/pipeline/status');
            const jobs = data.jobs || [];
            state.userJobs = jobs;
            setLiveOcrJobs(jobs);
            const signature = jobs
                .map(j => `${j.job_id}|${j.status}|${j.succeeded || 0}|${j.failed || 0}|${j.currently_processing || ''}`)
                .sort()
                .join('\n');
            if (userJobSignature !== null && signature !== userJobSignature) loadUserDocuments();
            userJobSignature = signature;
            const host = $('userJobList');
            if (!host) return;

            if (!jobs.length) {
                host.innerHTML = '<p class="muted">No jobs yet. Click "Run Pipeline" above once you confirm a schema.</p>';
                return;
            }

            host.innerHTML = '';
            jobs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            jobs.forEach(j => {
                const total = j.total || 0;
                const done = (j.succeeded || 0) + (j.failed || 0);
                const ocr = ocrModel(j.progress, j.status, { key: j.job_id, docsDone: done, docsTotal: total });
                const row = el('div', 'user-job-row');

                let actionButtons = '';
                if (j.status === 'running' || j.status === 'queued') {
                    actionButtons = `
                        <button class="btn btn-ghost btn-sm" title="Kill job" style="color:#fca5a5" data-action="kill" data-job="${escapeHtml(j.job_id)}">Kill</button>
                    `;
                } else if (j.status === 'completed' || j.succeeded > 0) {
                    actionButtons = `
                        <button class="btn btn-outline btn-sm" title="Download JSON report" data-action="download-json" data-job="${escapeHtml(j.job_id)}">JSON</button>
                        <button class="btn btn-primary btn-sm" title="Download PDF report" data-action="download-pdf" data-job="${escapeHtml(j.job_id)}">PDF</button>
                    `;
                }

                const currentDoc = j.currently_processing ? ` • processing: <code>${escapeHtml(j.currently_processing)}</code>` : '';

                row.innerHTML = `
                    <div class="user-job-row-left">
                        <div class="job-id">${escapeHtml(j.job_id)} <span class="badge ${jobStatusBadgeClass(j.status)}">${escapeHtml(j.status)}</span></div>
                        <div class="job-meta">
                            Success: <strong style="color:#6ee7b7">${j.succeeded}</strong> •
                            Failed: <strong style="color:#fca5a5">${j.failed}</strong> •
                            Remaining: ${j.remaining} / ${total}${currentDoc}
                        </div>
                        ${ocrRowTextMarkup(ocr)}
                    </div>
                    <div class="user-job-row-right">
                        ${ocrRowBarMarkup(ocr)}
                        <div class="job-item-actions">${actionButtons}</div>
                    </div>
                `;

                row.addEventListener('click', async (e) => {
                    const btn = e.target.closest('button[data-action]');
                    if (btn) {
                        e.stopPropagation();
                        const act = btn.dataset.action;
                        const jid = btn.dataset.job;
                        try {
                            if (act === 'download-json') {
                                const jobDetail = await api(`/me/pipeline/jobs/${jid}`);
                                const jsonStr = JSON.stringify(jobDetail, null, 2);
                                const blob = new Blob([jsonStr], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `${jid}.json`;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                                return;
                            }
                            if (act === 'download-pdf') {
                                downloadJobPdf(jid);
                                return;
                            }
                            if (act === 'kill') {
                                if (!confirm(`Cancel job ${jid}?`)) return;
                                await api(`/me/pipeline/jobs/${jid}/kill`, { method: 'POST' });
                            }
                            loadUserJobs();
                        } catch (err) {
                            alert(`Action ${act} failed: ${err.message}`);
                        }
                        return;
                    }
                    loadJobDetail(j.job_id, true);
                });

                host.appendChild(row);
            });
            if (state.selectedJobId && state.role === 'user') loadJobDetail(state.selectedJobId, false);
        } catch (e) {
            console.warn('loadUserJobs failed', e);
        }
    }

    if ($('refreshUserJobsBtn')) $('refreshUserJobsBtn').addEventListener('click', loadUserJobs);

    // ======================= Admin Logs Viewer =======================

    // Log lines and cells are escaped first. Search matches are wrapped in <mark> after escaping.
    const LOG_LEVEL_RE = /\b(CRITICAL|ERROR|WARNING|WARN|INFO|DEBUG)\b/;
    const logState = { systemLines: [], userLogs: [] };

    function logLevelOf(line) {
        const m = LOG_LEVEL_RE.exec(line);
        if (!m) return '';
        if (m[1] === 'CRITICAL' || m[1] === 'ERROR') return 'ERROR';
        if (m[1] === 'WARNING' || m[1] === 'WARN') return 'WARN';
        return m[1];
    }

    function highlightText(text, query) {
        const raw = String(text === null || text === undefined ? '' : text);
        if (!query) return escapeHtml(raw);
        const lower = raw.toLowerCase();
        const q = query.toLowerCase();
        let out = '';
        let pos = 0;
        let idx = lower.indexOf(q, pos);
        while (idx !== -1) {
            out += escapeHtml(raw.slice(pos, idx)) + '<mark>' + escapeHtml(raw.slice(idx, idx + q.length)) + '</mark>';
            pos = idx + q.length;
            idx = lower.indexOf(q, pos);
        }
        return out + escapeHtml(raw.slice(pos));
    }

    function setLogStatus(id, text) {
        const node = $(id);
        if (node) node.textContent = text;
    }

    function filteredSystemLines() {
        const query = $('systemLogSearch') ? $('systemLogSearch').value.trim().toLowerCase() : '';
        const level = $('systemLogLevel') ? $('systemLogLevel').value : '';
        return logState.systemLines.filter((line) => {
            if (level && logLevelOf(line) !== level) return false;
            return !query || line.toLowerCase().includes(query);
        });
    }

    function renderSystemLogs() {
        const host = $('systemLogsList');
        if (!host) return;
        const query = $('systemLogSearch') ? $('systemLogSearch').value.trim() : '';
        const lines = filteredSystemLines();
        if (!logState.systemLines.length) {
            host.innerHTML = '<span class="muted">No system logs recorded yet.</span>';
        } else if (!lines.length) {
            host.innerHTML = '<span class="muted">No lines match the current search or level filter.</span>';
        } else {
            host.innerHTML = lines.map((line) => {
                const lv = logLevelOf(line);
                const cls = lv === 'ERROR' ? ' is-error' : (lv === 'WARN' ? ' is-warn' : '');
                return `<span class="log-line${cls}">${highlightText(line, query)}</span>`;
            }).join('');
        }
        setLogStatus('systemLogStatus', `${lines.length} of ${logState.systemLines.length} lines`);
        if ($('systemLogTail') && $('systemLogTail').checked) host.scrollTop = host.scrollHeight;
    }

    function renderUserLogs() {
        const host = $('userLogsList');
        if (!host) return;
        const query = $('userLogSearch') ? $('userLogSearch').value.trim() : '';
        const needle = query.toLowerCase();
        const logs = logState.userLogs.slice().reverse().filter((l) => {
            if (!needle) return true;
            const text = [l.timestamp, l.username, l.action, JSON.stringify(l.detail)].join(' ').toLowerCase();
            return text.includes(needle);
        });

        if (!logState.userLogs.length) {
            host.innerHTML = '<p class="muted">No user activity recorded yet.</p>';
        } else if (!logs.length) {
            host.innerHTML = '<p class="muted">No entries match the current search.</p>';
        } else {
            let html = `
                <table class="log-table">
                    <thead>
                        <tr>
                            <th style="width: 22%;">Timestamp</th>
                            <th style="width: 18%;">User</th>
                            <th style="width: 22%;">Action</th>
                            <th style="width: 38%;">Detail</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            logs.forEach((l) => {
                html += `
                    <tr>
                        <td class="muted small">${highlightText(l.timestamp, query)}</td>
                        <td><strong>${highlightText(l.username, query)}</strong></td>
                        <td><span class="badge badge-info">${highlightText(l.action, query)}</span></td>
                        <td><code style="font-size:11px;">${highlightText(JSON.stringify(l.detail), query)}</code></td>
                    </tr>
                `;
            });
            html += '</tbody></table>';
            host.innerHTML = html;
        }
        setLogStatus('userLogStatus', `${logs.length} of ${logState.userLogs.length} entries`);
    }

    async function loadUserActivityLogs() {
        if (state.role !== 'admin') return;
        const host = $('userLogsList');
        if (!host) return;
        const filterUser = $('logFilterUsername') ? $('logFilterUsername').value.trim() : '';

        try {
            const path = '/admin/logs/users' + (filterUser ? `?username=${encodeURIComponent(filterUser)}` : '');
            const data = await api(path);
            logState.userLogs = data.logs || [];
            renderUserLogs();
        } catch (e) {
            logState.userLogs = [];
            host.innerHTML = `<p class="muted">Error loading user logs: ${escapeHtml(e.message)}</p>`;
        }
    }

    async function loadSystemLogs() {
        if (state.role !== 'admin') return;
        const host = $('systemLogsList');
        if (!host) return;

        try {
            const data = await api('/admin/logs/system?limit=300');
            logState.systemLines = (data.lines || []).map((line) => String(line));
            renderSystemLogs();
        } catch (e) {
            logState.systemLines = [];
            host.textContent = 'Error loading system logs: ' + e.message;
        }
    }

    function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            ok ? resolve() : reject(new Error('copy not permitted'));
        });
    }

    function setupLogControls() {
        const host = $('systemLogsList');
        const tail = $('systemLogTail');
        const search = $('systemLogSearch');
        const level = $('systemLogLevel');
        const userSearch = $('userLogSearch');

        if (search) search.addEventListener('input', renderSystemLogs);
        if (level) level.addEventListener('change', renderSystemLogs);
        if (userSearch) userSearch.addEventListener('input', renderUserLogs);

        // Tail follows the newest line. Scrolling up pauses it; reaching the bottom again does not restart it.
        if (host && tail) {
            host.addEventListener('scroll', () => {
                const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 16;
                if (!nearBottom && tail.checked) tail.checked = false;
            });
            tail.addEventListener('change', () => {
                if (tail.checked) host.scrollTop = host.scrollHeight;
            });
        }

        const copyBtn = $('copyLogsBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const text = filteredSystemLines().join('\n');
                try {
                    await copyTextToClipboard(text);
                    setLogStatus('systemLogStatus', `Copied ${filteredSystemLines().length} lines`);
                } catch (e) {
                    setLogStatus('systemLogStatus', 'Copy failed: ' + e.message);
                }
            });
        }

        const dlBtn = $('downloadLogsBtn');
        if (dlBtn) {
            dlBtn.addEventListener('click', () => {
                const lines = filteredSystemLines();
                const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const a = document.createElement('a');
                a.href = url;
                a.download = `system-logs-${stamp}.txt`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
        }
    }

    // Auto-refresh every 5 s, only for the admin Logs tab and only while its toggle is on.
    setInterval(() => {
        if (!state.token || state.role !== 'admin') return;
        const tab = $('tab-logs');
        if (!tab || !tab.classList.contains('active')) return;
        if ($('systemLogsPanel') && !$('systemLogsPanel').classList.contains('hidden')) {
            if ($('systemLogAutoRefresh') && $('systemLogAutoRefresh').checked) loadSystemLogs();
        } else if ($('userLogAutoRefresh') && $('userLogAutoRefresh').checked) {
            loadUserActivityLogs();
        }
    }, 5000);

    setupLogControls();

    if ($('logSubTabUsersBtn') && $('logSubTabSystemBtn')) {
        $('logSubTabUsersBtn').addEventListener('click', () => {
            $('logSubTabUsersBtn').className = 'btn btn-primary btn-sm';
            $('logSubTabSystemBtn').className = 'btn btn-outline btn-sm';
            $('userLogsPanel').classList.remove('hidden');
            $('systemLogsPanel').classList.add('hidden');
            loadUserActivityLogs();
        });

        $('logSubTabSystemBtn').addEventListener('click', () => {
            $('logSubTabSystemBtn').className = 'btn btn-primary btn-sm';
            $('logSubTabUsersBtn').className = 'btn btn-outline btn-sm';
            $('systemLogsPanel').classList.remove('hidden');
            $('userLogsPanel').classList.add('hidden');
            loadSystemLogs();
        });
    }

    if ($('applyLogFilterBtn')) $('applyLogFilterBtn').addEventListener('click', loadUserActivityLogs);
    if ($('clearLogFilterBtn')) {
        $('clearLogFilterBtn').addEventListener('click', () => {
            if ($('logFilterUsername')) $('logFilterUsername').value = '';
            loadUserActivityLogs();
        });
    }
    if ($('refreshLogsBtn')) {
        $('refreshLogsBtn').addEventListener('click', () => {
            if ($('systemLogsPanel') && !$('systemLogsPanel').classList.contains('hidden')) {
                loadSystemLogs();
            } else {
                loadUserActivityLogs();
            }
        });
    }

    // ======================= Admin User Management =======================

    async function loadUsersList() {
        if (state.role !== 'admin') return;
        const host = $('usersListTable');
        if (!host) return;

        try {
            const users = await api('/admin/users');
            if (!users.length) {
                host.innerHTML = '<p class="muted">No users found.</p>';
                return;
            }

            let html = `
                <table class="log-table">
                    <thead>
                        <tr>
                            <th>User ID</th>
                            <th>Username</th>
                            <th>Role</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            users.forEach(u => {
                html += `
                    <tr>
                        <td class="muted small">${escapeHtml(u.user_id)}</td>
                        <td><strong>${escapeHtml(u.username)}</strong></td>
                        <td><span class="badge ${u.role === 'admin' ? 'badge-primary' : 'badge-info'}">${escapeHtml(u.role)}</span></td>
                    </tr>
                `;
            });
            html += '</tbody></table>';
            host.innerHTML = html;
        } catch (e) {
            host.innerHTML = `<p class="muted">Error loading users: ${e.message}</p>`;
        }
    }

    if ($('refreshUsersListBtn')) $('refreshUsersListBtn').addEventListener('click', loadUsersList);

    if ($('createUserForm')) {
        $('createUserForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = $('newUsername').value.trim();
            const password = $('newPassword').value;
            const role = $('newRole').value;
            const btn = $('createUserBtn');

            if (!username || !password) return;

            btn.disabled = true;
            showStatus('createUserStatus', 'Creating account...', 'info');

            try {
                const res = await api('/admin/users', {
                    method: 'POST',
                    json: { username, password, role },
                });
                showStatus('createUserStatus', `User '${res.username}' created successfully with role '${res.role}'!`, 'success');
                $('newUsername').value = '';
                $('newPassword').value = '';
                loadUsersList();
            } catch (err) {
                showStatus('createUserStatus', 'Failed to create user: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    }

    // ======================= Admin Graph Builds =======================

    function graphBuildStatusHtml(b) {
        if (b.is_empty) return '<span class="badge badge-danger">Empty (0 nodes)</span>';
        const parts = [];
        if (b.in_use) parts.push('<span class="badge badge-primary">In use</span>');
        if (b.is_active) parts.push('<span class="badge badge-ok-green">Admin choice</span>');
        if (!parts.length) parts.push('<span class="badge badge-secondary">Available</span>');
        return parts.join(' ');
    }

    function renderGraphBuilds(docs) {
        const host = $('graphBuildsList');
        if (!host) return;
        if (!docs.length) {
            host.innerHTML = '<p class="muted">No graph builds found.</p>';
            return;
        }
        host.innerHTML = docs.map(d => {
            const owner = d.owner || '';
            const rows = d.builds.map(b => `
                <tr class="${b.is_empty ? 'row-empty' : ''}">
                    <td class="muted small">${escapeHtml(b.job_id || '-')}</td>
                    <td>${escapeHtml(b.created_at ? new Date(b.created_at).toLocaleString() : '-')}</td>
                    <td>${escapeHtml(b.node_count)}</td>
                    <td>${escapeHtml(b.edge_count)}</td>
                    <td>${graphBuildStatusHtml(b)}</td>
                    <td>
                        <button class="btn btn-outline btn-sm" data-action="select"
                            data-doc-id="${escapeHtml(d.doc_id)}" data-owner="${escapeHtml(owner)}"
                            data-job-id="${escapeHtml(b.job_id || '')}"
                            ${b.selectable ? '' : 'disabled title="Empty builds cannot be selected"'}>Select</button>
                    </td>
                </tr>`).join('');
            return `
                <div class="graph-build-doc">
                    <h3>${escapeHtml(d.doc_id)} <span class="muted small">owner: ${escapeHtml(owner || 'ownerless')}</span></h3>
                    <p class="muted small">Used by Query Bot: ${escapeHtml(d.in_use_job_id || 'none')}${d.active_job_id ? ' (admin choice)' : ' (newest non-empty build)'}</p>
                    <table class="log-table">
                        <thead>
                            <tr><th>Job ID</th><th>Created</th><th>Nodes</th><th>Edges</th><th>Status</th><th></th></tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <button class="btn btn-ghost btn-sm" data-action="clear"
                        data-doc-id="${escapeHtml(d.doc_id)}" data-owner="${escapeHtml(owner)}"
                        ${d.active_job_id ? '' : 'disabled'}>Use newest non-empty build</button>
                </div>`;
        }).join('');
    }

    async function loadGraphBuilds() {
        if (state.role !== 'admin') return;
        const host = $('graphBuildsList');
        if (!host) return;
        try {
            const res = await api('/admin/query-bot/documents');
            renderGraphBuilds(res.documents || []);
        } catch (e) {
            host.innerHTML = `<p class="muted">Error loading graph builds: ${escapeHtml(e.message)}</p>`;
        }
    }

    if ($('graphBuildsRefresh')) $('graphBuildsRefresh').addEventListener('click', loadGraphBuilds);

    if ($('graphBuildsList')) {
        $('graphBuildsList').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn || btn.disabled) return;
            const docId = btn.dataset.docId;
            const owner = btn.dataset.owner || null;
            btn.disabled = true;
            try {
                if (btn.dataset.action === 'select') {
                    await api('/admin/query-bot/active-build', {
                        method: 'PUT',
                        json: { doc_id: docId, owner, job_id: btn.dataset.jobId },
                    });
                    showStatus('graphBuildsStatus', `Query Bot now uses build ${escapeHtml(btn.dataset.jobId)} for ${escapeHtml(docId)}.`, 'success');
                } else {
                    const qs = `doc_id=${encodeURIComponent(docId)}&owner=${encodeURIComponent(owner || '')}`;
                    await api(`/admin/query-bot/active-build?${qs}`, { method: 'DELETE' });
                    showStatus('graphBuildsStatus', `Query Bot now uses the newest non-empty build for ${escapeHtml(docId)}.`, 'success');
                }
                loadGraphBuilds();
            } catch (err) {
                showStatus('graphBuildsStatus', 'Failed: ' + escapeHtml(err.message), 'error');
                btn.disabled = false;
            }
        });
    }

    // ======================= Query Bot Tab =======================

    // Holds all extracted data and document map
    let qbAllExtractedData = null;
    let qbDocsMap = {};

    // Shows which graph build answers for the selected document. Entries without a `graph` key
    // come from in-memory jobs, so no build line is shown for them.
    function updateQbBuildInfo(m) {
        const info = $('tab_qb_graph_build');
        if (!info) return;
        const isGraph = !!m && ((m.strategy || '').startsWith('graph_memory') || m.has_graph);
        if (!isGraph || m.graph === undefined) {
            info.style.display = 'none';
            info.textContent = '';
            return;
        }
        info.style.display = 'block';
        const g = m.graph;
        if (m.graph_empty) {
            info.textContent = 'Graph empty: every stored build has 0 nodes, so questions cannot be answered from it.';
            return;
        }
        info.textContent = g
            ? `Graph build: ${g.job_id} · ${g.created_at ? new Date(g.created_at).toLocaleString() : 'date unknown'} · ${g.node_count} nodes`
            : 'No graph build';
    }

    function updateQbModeBadge() {
        const docSelect = $('tab_qb_doc_select');
        const modeBadge = $('tab_qb_mode_badge');
        if (!docSelect || !modeBadge) return;
        const selectedDocId = docSelect.value;
        const m = selectedDocId ? qbDocsMap[selectedDocId] : null;
        updateQbBuildInfo(m);
        if (!m) {
            modeBadge.style.display = 'none';
            return;
        }
        const isGraph = (m.strategy || '').startsWith('graph_memory') || m.has_graph;
        modeBadge.style.display = 'inline-block';
        if (m.graph_empty) {
            modeBadge.className = 'badge badge-mute';
            modeBadge.textContent = 'Graph empty';
            return;
        }
        modeBadge.className = 'badge ' + (isGraph ? 'badge-primary' : 'badge-secondary');
        modeBadge.textContent = isGraph ? 'Graph Memory' : 'JSON Fallback';
    }

    async function loadAllExtractedData() {
        try {
            const docSelect = $('tab_qb_doc_select');
            const modeBadge = $('tab_qb_mode_badge');

            // 1. Fetch available documents from dedicated query-bot endpoint
            let docs = [];
            try {
                const docRes = await api('/api/query-bot/documents');
                docs = docRes.documents || [];
            } catch (err) {
                console.warn('Failed to load /api/query-bot/documents, fallback to jobs', err);
            }

            // 2. Fetch /pipeline/status for any in-flight active jobs
            const statusData = await api('/pipeline/status').catch(() => ({}));
            const jobs = Object.values(statusData.jobs || {});
            const completedJobs = jobs.filter(j => j.status === 'completed');

            qbDocsMap = {};
            const merged = {};

            // Register documents from /api/query-bot/documents
            docs.forEach(d => {
                qbDocsMap[d.doc_id] = {
                    doc_id: d.doc_id,
                    stem: d.stem,
                    label: d.label || d.doc_id,
                    strategy: d.strategy || (d.has_graph ? 'graph_memory_concurrent' : 'page_scan'),
                    has_graph: !!d.has_graph,
                    has_extracted: !!d.has_extracted,
                    job_id: d.job_id,
                    owner: d.owner,
                    graph: d.graph || null,
                    graph_empty: !!d.graph_empty,
                    extracted_data: null,
                };
            });

            // Merge details from completed in-memory jobs if available
            if (completedJobs.length > 0) {
                const details = await Promise.all(
                    completedJobs.map(j => api('/pipeline/jobs/' + j.job_id).catch(() => null))
                );
                details.forEach(j => {
                    if (!j) return;
                    const sucs = j.successes || [];
                    sucs.forEach(s => {
                        const docId = s.pdf || s.doc_id || (s.extracted_json ? s.extracted_json.replace('.extracted.json', '.pdf') : null);
                        if (docId) {
                            if (!qbDocsMap[docId]) {
                                qbDocsMap[docId] = {
                                    doc_id: docId,
                                    job_id: j.job_id,
                                    strategy: s.strategy || j.strategy || 'graph_memory_concurrent',
                                    has_graph: (s.strategy || j.strategy || '').startsWith('graph_memory'),
                                };
                            }
                            qbDocsMap[docId].extracted_data = s.extracted_data;
                        }
                        if (s.extracted_data) {
                            const key = s.extracted_json || s.pdf || s.doc_id || 'document';
                            merged[key] = s.extracted_data;
                        }
                    });
                    if (!sucs.length && j.extracted_data) {
                        merged[j.job_id] = j.extracted_data;
                        qbDocsMap[j.job_id] = {
                            doc_id: j.job_id,
                            job_id: j.job_id,
                            extracted_data: j.extracted_data,
                            strategy: j.strategy || 'graph_memory_concurrent',
                            has_graph: (j.strategy || '').startsWith('graph_memory'),
                        };
                    }
                });
            }

            const docKeys = Object.keys(qbDocsMap);

            if (!docKeys.length) {
                qbAllExtractedData = null;
                qbDocsMap = {};
                if (docSelect) {
                    docSelect.innerHTML = '<option value="">-- No documents processed yet --</option>';
                }
                if (modeBadge) modeBadge.style.display = 'none';
                return;
            }

            qbAllExtractedData = Object.keys(merged).length ? merged : null;

            if (docSelect) {
                const prevVal = docSelect.value;
                docSelect.innerHTML = docKeys.map(d => {
                    const m = qbDocsMap[d];
                    const stratLabel = m.graph_empty ? 'graph empty' : ((m.strategy === 'graph_memory' || m.has_graph) ? 'graph_memory' : 'page_scan');
                    return `<option value="${escapeHtml(d)}">${escapeHtml(d)} (${stratLabel})</option>`;
                }).join('');

                if (prevVal && qbDocsMap[prevVal]) {
                    docSelect.value = prevVal;
                } else if (docKeys.length > 0) {
                    docSelect.value = docKeys[0];
                }

                updateQbModeBadge();
            }
        } catch (e) {
            console.warn('loadAllExtractedData error', e);
        }
    }

    const QB_STAGE_TEXT = {
        searching_graph: 'Searching graph…',
        reading_pages: 'Reading pages…',
        answering: 'Answering…',
    };

    function parseSseBlock(block, onEvent) {
        let name = 'message';
        const dataLines = [];
        block.split('\n').forEach((line) => {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        });
        if (!dataLines.length) return;
        let data;
        try {
            data = JSON.parse(dataLines.join('\n'));
        } catch (_) {
            return;
        }
        onEvent(name, data);
    }

    // fetch with a ReadableStream, not EventSource: EventSource cannot send the bearer header.
    async function streamQueryBot(payload, onEvent) {
        const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
        if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
        const resp = await fetch(API_BASE + '/api/query-bot/ask/stream', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        if (resp.status === 401) {
            logout();
            throw new Error('Session expired or unauthorized. Please log in again.');
        }
        if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try {
                const body = await resp.json();
                detail = body.detail || detail;
            } catch (_) { /* response was not JSON */ }
            throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end = buffer.indexOf('\n\n');
            while (end !== -1) {
                parseSseBlock(buffer.slice(0, end), onEvent);
                buffer = buffer.slice(end + 2);
                end = buffer.indexOf('\n\n');
            }
        }
        if (buffer.trim()) parseSseBlock(buffer, onEvent);
    }

    // Shows the source list collapsed by default: one "Page X — snippet" entry per page.
    function renderQbSources(botDiv, sources, meta) {
        const unique = window.QueryBotRender.dedupeSources(sources);
        if (!unique.length) return;
        const details = document.createElement('details');
        details.className = 'qb-sources';
        const summary = document.createElement('summary');
        summary.textContent = `Sources (${unique.length})`;
        const list = document.createElement('ul');
        list.className = 'qb-source-list';
        unique.forEach((src) => {
            const item = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'qb-source-link';
            const text = window.QueryBotRender.snippet(src.evidence || src.node || '');
            btn.textContent = `${window.QueryBotRender.sourceLabel(src)} \u2014 ${text}`;
            btn.addEventListener('click', () => openQbSourcePage(meta, src.page, botDiv));
            item.appendChild(btn);
            list.appendChild(item);
        });
        details.append(summary, list);
        botDiv.appendChild(details);
    }

    // Opens the stored markdown for the document and shows only the chunk between the page markers.
    async function openQbSourcePage(meta, page, botDiv) {
        if (!meta || !meta.doc_id) return;
        let viewer = botDiv.querySelector('.qb-page-viewer');
        if (!viewer) {
            viewer = document.createElement('pre');
            viewer.className = 'qb-page-viewer';
            botDiv.appendChild(viewer);
        }
        const pageNo = String(page).replace(/\D/g, '');
        if (!meta.owner) {
            viewer.textContent = `Page ${pageNo} cannot be opened: the owner of ${meta.doc_id} is not known to this view.`;
            return;
        }
        viewer.textContent = `Loading page ${pageNo}…`;
        try {
            const data = await api(ocrDocUrl('admin', { doc_id: meta.doc_id, owner: meta.owner }));
            const markdown = data.markdown_content || '';
            const re = new RegExp(`<!-- PAGE ${pageNo} [\\s\\S]*?<!-- /PAGE ${pageNo} -->`);
            const match = re.exec(markdown);
            viewer.textContent = match
                ? `Page ${pageNo} of ${meta.doc_id}\n\n${match[0]}`
                : `Page ${pageNo} is not in the stored markdown for ${meta.doc_id}.`;
            viewer.scrollIntoView({ block: 'nearest' });
        } catch (e) {
            viewer.textContent = `Failed to load page ${pageNo}: ${e.message}`;
        }
    }

    async function askTabQueryBot() {
        const input = $('tab_qb_input');
        const btn = $('tab_qb_btn');
        const msgs = $('tab_qb_msgs');
        const docSelect = $('tab_qb_doc_select');
        const modeBadge = $('tab_qb_mode_badge');
        if (!input || !btn || !msgs) return;

        const question = input.value.trim();
        if (!question) { input.focus(); return; }

        const selectedDocId = docSelect ? docSelect.value : null;
        const selectedMeta = selectedDocId ? qbDocsMap[selectedDocId] : null;

        if (!selectedDocId) {
            const errDiv = document.createElement('div');
            errDiv.className = 'query-bot-msg bot error';
            errDiv.textContent = 'Please select a document from the dropdown first.';
            msgs.appendChild(errDiv);
            msgs.scrollTop = msgs.scrollHeight;
            return;
        }

        const userDiv = document.createElement('div');
        userDiv.className = 'query-bot-msg user';
        userDiv.textContent = question;
        msgs.appendChild(userDiv);

        const botDiv = document.createElement('div');
        botDiv.className = 'query-bot-msg bot loading';
        const stageLine = document.createElement('div');
        stageLine.className = 'qb-stage';
        stageLine.textContent = QB_STAGE_TEXT.searching_graph;
        botDiv.appendChild(stageLine);
        msgs.appendChild(botDiv);
        msgs.scrollTop = msgs.scrollHeight;

        input.value = '';
        input.disabled = true;
        btn.disabled = true;
        btn.textContent = 'Asking…';

        try {
            const reqPayload = {
                question,
                doc_id: selectedDocId || undefined,
                job_id: selectedMeta ? selectedMeta.job_id : undefined,
                owner: (selectedMeta && selectedMeta.owner) ? selectedMeta.owner : undefined,
                extracted_data: (selectedMeta && selectedMeta.extracted_data) ? selectedMeta.extracted_data : undefined,
            };

            let sources = [];
            let answered = false;
            let streamEl = null;
            await streamQueryBot(reqPayload, (name, data) => {
                if (name === 'stage') {
                    stageLine.textContent = QB_STAGE_TEXT[data.stage] || 'Working…';
                } else if (name === 'token') {
                    // Plain text while streaming. The sanitised Markdown replaces it on the answer event.
                    if (!streamEl) {
                        streamEl = el('div', 'qb-answer qb-answer-stream');
                        botDiv.appendChild(streamEl);
                    }
                    streamEl.textContent += data.text || '';
                    msgs.scrollTop = msgs.scrollHeight;
                } else if (name === 'sources') {
                    sources = data.sources || [];
                } else if (name === 'answer') {
                    answered = true;
                    if (streamEl) streamEl.remove();
                    stageLine.remove();
                    botDiv.className = 'query-bot-msg bot';
                    botDiv.appendChild(el('div', 'qb-answer', window.QueryBotRender.renderMarkdown(data.answer || 'No answer returned.')));
                    renderQbSources(botDiv, sources, selectedMeta);

                    const isGraph = data.mode === 'graph';
                    const isEmptyGraph = data.mode === 'graph_empty';
                    const badgeClass = isGraph ? 'badge-primary' : (isEmptyGraph ? 'badge-warn' : 'badge-secondary');
                    const badgeText = isGraph ? 'Graph Memory' : (isEmptyGraph ? 'Empty Graph' : 'JSON Fallback');
                    botDiv.appendChild(el('div', 'qb-mode-row', `<span class="badge ${badgeClass}">${badgeText}</span>`));

                    if (modeBadge) {
                        modeBadge.style.display = 'inline-block';
                        modeBadge.className = `badge ${badgeClass}`;
                        modeBadge.textContent = badgeText;
                    }
                } else if (name === 'done') {
                    const ms = data.timings && data.timings.total_ms;
                    if (ms !== undefined && ms !== null) {
                        botDiv.appendChild(el('div', 'qb-timing', `Answered in ${(ms / 1000).toFixed(1)} s`));
                    }
                } else if (name === 'error') {
                    throw new Error(data.detail || 'Query bot failed.');
                }
            });
            if (!answered) {
                stageLine.remove();
                botDiv.className = 'query-bot-msg bot';
                botDiv.textContent = 'No answer returned.';
            }
        } catch (err) {
            botDiv.className = 'query-bot-msg bot error';
            botDiv.textContent = 'Error: ' + (err.message || String(err));
        } finally {
            input.disabled = false;
            btn.disabled = false;
            btn.textContent = 'Ask Bot';
            input.focus();
            msgs.scrollTop = msgs.scrollHeight;
        }
    }

    if ($('tab_qb_doc_select')) $('tab_qb_doc_select').addEventListener('change', updateQbModeBadge);
    if ($('tab_qb_btn')) $('tab_qb_btn').addEventListener('click', askTabQueryBot);
    if ($('tab_qb_input')) {
        $('tab_qb_input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); askTabQueryBot(); }
        });
    }
    if ($('qbClearBtn')) {
        $('qbClearBtn').addEventListener('click', () => {
            const msgs = $('tab_qb_msgs');
            if (msgs) {
                msgs.innerHTML = '<div class="query-bot-msg bot">Hi! Ask me anything about the extracted document data.</div>';
            }
        });
    }

    // ======================= Downloads (Jobs & Schemas) =======================
    window.downloadJobJson = function() {
        if (!window.__currentJobDetail) return;
        const jsonStr = JSON.stringify(window.__currentJobDetail, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${window.__currentJobDetail.job_id || 'pipeline_job'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    window.downloadJobPdf = async function(jobId) {
        if (!jobId && window.__currentJobDetail) jobId = window.__currentJobDetail.job_id;
        if (!jobId) return;
        try {
            const apiPath = state.role === 'user' ? (`${API_BASE}/me/pipeline/jobs/${jobId}/pdf`) : (`${API_BASE}/pipeline/jobs/${jobId}/pdf`);
            const resp = await fetch(apiPath, {
                headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {}
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(errText || 'Failed to download PDF');
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${jobId}_report.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('PDF download failed: ' + e.message);
        }
    };

    window.downloadSchemaPdf = async function(schemaId) {
        schemaId = schemaId || state.lastConfirmedSchemaId;
        if (!schemaId) {
            alert('No confirmed schema available to download.');
            return;
        }
        try {
            const resp = await fetch(`${API_BASE}/schema/${schemaId}/pdf`, {
                headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {}
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(errText || 'Failed to download schema PDF');
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${schemaId}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Schema PDF download failed: ' + e.message);
        }
    };

    window.downloadSchemaJson = async function(schemaId) {
        schemaId = schemaId || state.lastConfirmedSchemaId;
        if (!schemaId) {
            alert('No confirmed schema available to download.');
            return;
        }
        try {
            const resp = await fetch(`${API_BASE}/schema/${schemaId}/json`, {
                headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {}
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(errText || 'Failed to download schema JSON');
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${schemaId}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Schema JSON download failed: ' + e.message);
        }
    };

    // ======================= Init & Bootstrap =======================

    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);

    initTheme();
    checkHealth();

    if ($('loginForm')) $('loginForm').addEventListener('submit', handleLoginSubmit);
    if ($('logoutBtn')) $('logoutBtn').addEventListener('click', logout);

    if (state.token) {
        initAuthenticatedSession();
    } else {
        showLoginModal();
    }

    setInterval(checkHealth, 15000);
    setInterval(() => {
        if (state.token) {
            if (state.role === 'admin') loadJobs();
            else if (state.role === 'user') loadUserJobs();
        }
    }, 4000);
    // Text-only clock update between polls. It makes no network calls.
    setInterval(tickOcrElapsed, 1000);
    // Live OCR jobs: one detail fetch per second while a job is running (see pollLiveOcrJobs).
    setInterval(pollLiveOcrJobs, 1000);

})();


