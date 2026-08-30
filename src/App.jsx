import { useEffect, useState } from 'react';

const priorities = ['Low', 'Medium', 'High'];
const statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];

function PriorityBadge({ value }) {
  return <span className={`priority-badge priority-${value.toLowerCase()}`}>{value}</span>;
}

function renderMarkdown(text) {
  const escaped = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, '<br />');
}

function ViewSwitcher({ active }) {
  return (
    <nav className="view-switcher" aria-label="Issue views">
      <a className={active === 'list' ? 'active' : ''} href="/">List</a>
      <a className={active === 'board' ? 'active' : ''} href="/board">Board</a>
    </nav>
  );
}

function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to authenticate.');
      onAuthenticated(payload.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="card auth-card">
    <p className="eyebrow">Bugsilla</p><h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
    <p className="muted">{mode === 'login' ? 'Sign in to view and collaborate on issues.' : 'The first account becomes the workspace administrator.'}</p>
    <form onSubmit={submit} noValidate>
      {mode === 'signup' && <><label htmlFor="auth-name">Name</label><input id="auth-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength="120" /></>}
      <label htmlFor="auth-email">Email</label><input id="auth-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
      <label htmlFor="auth-password">Password</label><input id="auth-password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength="8" />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>{submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
    </form>
    <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>{mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}</button>
  </main>;
}

function AppNav({ user, onLogout }) {
  const [dark, setDark] = useState(() => localStorage.getItem('bugsilla-theme') === 'dark');
  useEffect(() => { document.body.classList.toggle('dark-mode', dark); localStorage.setItem('bugsilla-theme', dark ? 'dark' : 'light'); }, [dark]);
  return <header className="app-nav"><a href="/">Bugsilla</a><div>{user.role === 'admin' && <a href="/admin">Admin</a>}<span>{user.name}{user.role === 'admin' && ' · Admin'}</span><button type="button" aria-label="Toggle dark mode" onClick={() => setDark(!dark)}>{dark ? 'Light mode' : 'Dark mode'}</button><button type="button" onClick={onLogout}>Sign out</button></div></header>;
}

function CreateIssueForm() {
  const [form, setForm] = useState({ title: '', description: '', priority: 'Medium', productId: '', componentId: '', versionId: '', milestoneId: '', groupId: '', keywordIds: [] });
  const [products, setProducts] = useState([]);
  const [catalog, setCatalog] = useState({ components: [], versions: [], milestones: [] });
  const [catalogError, setCatalogError] = useState('');
  const [groups, setGroups] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const updateField = (event) => {
    setForm({ ...form, [event.target.name]: event.target.value });
  };

  useEffect(() => {
    fetch('/api/products')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load products.');
        setProducts(data);
        if (data.length) setForm((current) => ({ ...current, productId: String(data[0].id) }));
      })
      .catch((requestError) => setCatalogError(requestError.message));
  }, []);
  useEffect(() => { fetch('/api/keywords').then((response) => response.json()).then(setKeywords).catch(() => setKeywords([])); }, []);

  useEffect(() => {
    fetch('/api/groups').then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load visibility groups.');
      setGroups(data);
      if (data.length) setForm((current) => ({ ...current, groupId: String(data[0].id) }));
    }).catch((requestError) => setCatalogError(requestError.message));
  }, []);

  useEffect(() => {
    if (!form.productId) return;
    setCatalog({ components: [], versions: [], milestones: [] });
    setForm((current) => ({ ...current, componentId: '', versionId: '', milestoneId: '' }));
    Promise.all(['components', 'versions', 'milestones'].map(async (kind) => {
      const response = await fetch(`/api/${kind}?product_id=${form.productId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Unable to load ${kind}.`);
      return [kind, data];
    }))
      .then((entries) => {
        const nextCatalog = Object.fromEntries(entries);
        setCatalog(nextCatalog);
        setForm((current) => ({
          ...current,
          componentId: nextCatalog.components[0] ? String(nextCatalog.components[0].id) : '',
          versionId: nextCatalog.versions[0] ? String(nextCatalog.versions[0].id) : '',
          milestoneId: nextCatalog.milestones[0] ? String(nextCatalog.milestones[0].id) : ''
        }));
      })
      .catch((requestError) => setCatalogError(requestError.message));
  }, [form.productId]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!form.title.trim() || !form.description.trim() || !form.productId || !form.componentId) {
      setError('Please provide a title, description, product, and component.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to create the issue.');
      window.location.assign(`/issues/${payload.id}`);
    } catch (requestError) {
      setError(requestError.message);
      setSubmitting(false);
    }
  }

  return (
    <main className="card">
      <p className="eyebrow">New issue</p>
      <h1>File a bug</h1>
      <form onSubmit={submit} noValidate>
        <label htmlFor="title">Title <span aria-hidden="true">*</span></label>
        <input id="title" name="title" value={form.title} onChange={updateField} maxLength="255" required autoFocus />
        <label htmlFor="description">Description <span aria-hidden="true">*</span></label>
        <textarea id="description" name="description" value={form.description} onChange={updateField} required rows="7" />
        <fieldset className="catalog-fields">
          <legend>Project details</legend>
          <label htmlFor="product">Product <span aria-hidden="true">*</span></label>
          <select id="product" name="productId" value={form.productId} onChange={updateField} required disabled={!products.length}>
            {!products.length && <option value="">Loading products…</option>}
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
          <label htmlFor="component">Component <span aria-hidden="true">*</span></label>
          <select id="component" name="componentId" value={form.componentId} onChange={updateField} required disabled={!catalog.components.length}>
            {!catalog.components.length && <option value="">Loading components…</option>}
            {catalog.components.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
          </select>
          <label htmlFor="version">Affected version</label>
          <select id="version" name="versionId" value={form.versionId} onChange={updateField} disabled={!catalog.versions.length}>
            <option value="">Not specified</option>
            {catalog.versions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}
          </select>
          <label htmlFor="milestone">Target milestone</label>
          <select id="milestone" name="milestoneId" value={form.milestoneId} onChange={updateField} disabled={!catalog.milestones.length}>
            <option value="">Not specified</option>
            {catalog.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.name}</option>)}
          </select>
          <label htmlFor="visibility-group">Visibility</label>
          <select id="visibility-group" name="groupId" value={form.groupId} onChange={updateField} disabled={!groups.length}>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <label htmlFor="keywords">Keywords</label>
          <select id="keywords" name="keywordIds" multiple value={form.keywordIds} onChange={(event) => setForm({ ...form, keywordIds: [...event.target.selectedOptions].map((option) => option.value) })}>
            {keywords.map((keyword) => <option key={keyword.id} value={keyword.id}>{keyword.name}</option>)}
          </select>
        </fieldset>
        <label htmlFor="priority">Priority</label>
        <select id="priority" name="priority" value={form.priority} onChange={updateField}>
          {priorities.map((priority) => <option key={priority}>{priority}</option>)}
        </select>
        {error && <p className="error" role="alert">{error}</p>}
        {catalogError && <p className="error" role="alert">{catalogError}</p>}
        <button type="submit" disabled={submitting}>{submitting ? 'Creating issue…' : 'Submit issue'}</button>
      </form>
    </main>
  );
}

function IssueList() {
  const [issues, setIssues] = useState();
  const [stats, setStats] = useState();
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ q: '', status: '', priority: '', keyword: '' });
  const [keywords, setKeywords] = useState([]);
  const [savedSearches, setSavedSearches] = useState([]);
  const [savingSearch, setSavingSearch] = useState(false);

  useEffect(() => {
    const parameters = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) parameters.set(key, value); });
    const query = parameters.toString();
    setIssues(undefined);
    setError('');
    fetch(`/api/issues${query ? `?${query}` : ''}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load issues.');
        setIssues(data);
      })
      .catch((requestError) => setError(requestError.message));
  }, [filters]);

  useEffect(() => {
    fetch('/api/stats')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load dashboard statistics.');
        setStats(data);
      })
      .catch(() => setStats(undefined));
  }, []);
  useEffect(() => { fetch('/api/keywords').then((response) => response.json()).then(setKeywords).catch(() => setKeywords([])); }, []);

  useEffect(() => {
    fetch('/api/saved-searches').then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load saved searches.');
      setSavedSearches(data);
    }).catch(() => setSavedSearches([]));
  }, []);

  const updateFilter = (event) => setFilters({ ...filters, [event.target.name]: event.target.value });
  const hasFilters = Object.values(filters).some(Boolean);
  async function saveSearch() {
    const name = window.prompt('Name this saved search:');
    if (!name?.trim()) return;
    setSavingSearch(true);
    try {
      const response = await fetch('/api/saved-searches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, queryParams: filters }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save search.');
      setSavedSearches([data, ...savedSearches]);
    } catch (requestError) {
      setError(requestError.message);
    } finally { setSavingSearch(false); }
  }

  return (
    <main className="issues-page">
      <header className="page-header">
        <div><p className="eyebrow">Issue tracker</p><h1>All issues</h1><ViewSwitcher active="list" /></div>
        <a className="primary-link" href="/issues/new">New issue</a>
      </header>
      {stats && (
        <section className="issue-stats" aria-label="Issue status totals">
          {statuses.map((status) => (
            <article key={status} className={`stat-card stat-${status.toLowerCase().replaceAll(' ', '-')}`}>
              <strong>{stats[status] || 0}</strong>
              <span>{status}</span>
            </article>
          ))}
        </section>
      )}
      <form className="issue-filters" onSubmit={(event) => event.preventDefault()}>
        <div className="search-field"><label htmlFor="issue-search">Search issues</label><input id="issue-search" name="q" type="search" placeholder="Search title or description" value={filters.q} onChange={updateFilter} maxLength="100" /></div>
        <div><label htmlFor="status-filter">Status</label><select id="status-filter" name="status" value={filters.status} onChange={updateFilter}><option value="">All statuses</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></div>
        <div><label htmlFor="priority-filter">Priority</label><select id="priority-filter" name="priority" value={filters.priority} onChange={updateFilter}><option value="">All priorities</option>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select></div>
        <div><label htmlFor="keyword-filter">Keyword</label><select id="keyword-filter" name="keyword" value={filters.keyword} onChange={updateFilter}><option value="">All keywords</option>{keywords.map((keyword) => <option key={keyword.id} value={keyword.id}>{keyword.name}</option>)}</select></div>
        {hasFilters && <button className="clear-filters" type="button" onClick={() => setFilters({ q: '', status: '', priority: '', keyword: '' })}>Clear filters</button>}
      </form>
      <div className="saved-searches">
        <label htmlFor="saved-search">Saved searches</label>
        <select id="saved-search" defaultValue="" onChange={(event) => { const search = savedSearches.find((candidate) => String(candidate.id) === event.target.value); if (search) setFilters(search.query_params); event.target.value = ''; }}><option value="">Choose a saved search…</option>{savedSearches.map((search) => <option key={search.id} value={search.id}>{search.name}</option>)}</select>
        <button type="button" className="clear-filters" onClick={saveSearch} disabled={savingSearch}>{savingSearch ? 'Saving…' : 'Save this search'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!issues && !error && <p className="loading">Loading issues…</p>}
      {issues?.length === 0 && <section className="empty-state"><h2>{hasFilters ? 'No matching issues' : 'No issues yet'}</h2><p>{hasFilters ? 'Try changing or clearing your filters.' : 'Create the first issue to begin tracking work.'}</p>{hasFilters ? <button className="clear-filters" type="button" onClick={() => setFilters({ q: '', status: '', priority: '', keyword: '' })}>Clear filters</button> : <a href="/issues/new">File a bug</a>}</section>}
      {issues?.length > 0 && (
        <section className="issues-table-wrap" aria-label="All issues">
          <table className="issues-table">
            <thead><tr><th scope="col">Issue</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Assignee</th></tr></thead>
            <tbody>{issues.map((issue) => (
              <tr key={issue.id} className="issue-row" onClick={() => window.location.assign(`/issues/${issue.id}`)}>
                <td><a href={`/issues/${issue.id}`} className="issue-title">#{issue.id} · {issue.title}</a></td>
                <td><span className="status-badge">{issue.status}</span></td>
                <td><PriorityBadge value={issue.priority} /></td>
                <td>{issue.assignee || 'Unassigned'}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function KanbanBoard() {
  const [issues, setIssues] = useState();
  const [error, setError] = useState('');
  const [draggedId, setDraggedId] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);

  useEffect(() => {
    fetch('/api/issues?limit=100')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load the board.');
        setIssues(data);
      })
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function moveIssue(status) {
    const issue = issues?.find((candidate) => candidate.id === draggedId);
    setDraggedId(null);
    if (!issue || issue.status === status) return;

    const originalStatus = issue.status;
    setUpdatingId(issue.id);
    setIssues(issues.map((candidate) => candidate.id === issue.id ? { ...candidate, status } : candidate));
    try {
      const response = await fetch(`/api/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to move issue.');
      setIssues((current) => current.map((candidate) => candidate.id === issue.id ? { ...candidate, status: payload.status } : candidate));
    } catch (requestError) {
      setIssues((current) => current.map((candidate) => candidate.id === issue.id ? { ...candidate, status: originalStatus } : candidate));
      setError(requestError.message);
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <main className="issues-page board-page">
      <header className="page-header">
        <div><p className="eyebrow">Issue tracker</p><h1>Workflow board</h1><ViewSwitcher active="board" /></div>
        <a className="primary-link" href="/issues/new">New issue</a>
      </header>
      <p className="board-intro">Drag an issue card to move it through the workflow.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!issues && !error && <p className="loading">Loading board…</p>}
      {issues && (
        <section className="kanban-board" aria-label="Issue workflow board">
          {statuses.map((status) => {
            const columnIssues = issues.filter((issue) => issue.status === status);
            return (
              <section key={status} className={`kanban-column column-${status.toLowerCase().replaceAll(' ', '-')}`} onDragOver={(event) => event.preventDefault()} onDrop={() => moveIssue(status)}>
                <header><h2>{status}</h2><span>{columnIssues.length}</span></header>
                <div className="kanban-drop-zone">
                  {columnIssues.map((issue) => (
                    <article key={issue.id} className={`kanban-card ${draggedId === issue.id ? 'dragging' : ''}`} draggable onDragStart={() => setDraggedId(issue.id)} onDragEnd={() => setDraggedId(null)}>
                      <a href={`/issues/${issue.id}`}>#{issue.id} · {issue.title}</a>
                      <div><PriorityBadge value={issue.priority} /><span>{issue.assignee || 'Unassigned'}</span></div>
                      {updatingId === issue.id && <small>Moving…</small>}
                    </article>
                  ))}
                  {!columnIssues.length && <p className="empty-column">Drop issues here</p>}
                </div>
              </section>
            );
          })}
        </section>
      )}
    </main>
  );
}

function AdminPanel() {
  const [data, setData] = useState({ products: [], groups: [], keywords: [], users: [] });
  const [error, setError] = useState('');
  const load = () => Promise.all(['products', 'groups', 'keywords', 'admin/users'].map((path) => fetch(`/api/${path}`).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }))).then(([products, groups, keywords, users]) => setData({ products, groups, keywords, users })).catch((requestError) => setError(requestError.message));
  useEffect(() => { load(); }, []);
  async function add(event) { event.preventDefault(); const form = new FormData(event.currentTarget); const type = form.get('type'); const name = String(form.get('name')).trim(); if (!name) return; const response = await fetch(`/api/${type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); if (!response.ok) { setError((await response.json()).error); return; } event.currentTarget.reset(); load(); }
  async function role(id, value) { await fetch(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: value }) }); load(); }
  return <main className="issues-page admin-page"><header className="page-header"><div><p className="eyebrow">Administrator</p><h1>Workspace administration</h1></div><a className="primary-link" href="/">Back to issues</a></header>{error && <p className="error">{error}</p>}<section className="admin-grid">{[['products', 'Products'], ['groups', 'Groups'], ['keywords', 'Keywords']].map(([type, label]) => <article className="admin-card" key={type}><h2>{label}</h2><ul>{data[type].map((item) => <li key={item.id}>{item.name}</li>)}</ul><form onSubmit={add}><input type="hidden" name="type" value={type} /><input name="name" placeholder={`New ${label.toLowerCase().slice(0, -1)}`} /><button>Add</button></form></article>)}</section><section className="admin-card"><h2>Users & roles</h2>{data.users.map((user) => <p key={user.id}>{user.name} <span>{user.email}</span><select value={user.role} onChange={(event) => role(user.id, event.target.value)}><option value="member">Member</option><option value="admin">Admin</option></select></p>)}</section></main>;
}

function IssueDetail({ id }) {
  const [issue, setIssue] = useState();
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [priorityError, setPriorityError] = useState('');
  const [updatingPriority, setUpdatingPriority] = useState(false);
  const [assigneeError, setAssigneeError] = useState('');
  const [updatingAssignee, setUpdatingAssignee] = useState(false);
  const [users, setUsers] = useState([]);
  const [commentForm, setCommentForm] = useState({ text: '' });
  const [commentError, setCommentError] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dependencyId, setDependencyId] = useState('');
  const [dependencyError, setDependencyError] = useState('');

  function loadIssue() {
    fetch(`/api/issues/${id}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setIssue(data);
      })
      .catch((requestError) => setError(requestError.message));
  }
  useEffect(() => {
    loadIssue();
  }, [id]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (String(message.issueId) === String(id)) loadIssue();
    };
    return () => events.close();
  }, [id]);

  useEffect(() => {
    fetch('/api/users').then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load users.');
      setUsers(data);
    }).catch(() => setUsers([]));
  }, []);

  if (error) return <main className="card"><h1>Issue unavailable</h1><p className="error">{error}</p><a href="/">Back to all issues</a></main>;
  if (!issue) return <main className="card"><p>Loading issue…</p></main>;

  async function updateStatus(event) {
    const status = event.target.value;
    setStatusError('');
    setUpdatingStatus(true);
    try {
      const response = await fetch(`/api/issues/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to update status.');
      setIssue({ ...issue, status: payload.status });
    } catch (requestError) {
      setStatusError(requestError.message);
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function updatePriority(event) {
    const priority = event.target.value;
    setPriorityError('');
    setUpdatingPriority(true);
    try {
      const response = await fetch(`/api/issues/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to update priority.');
      setIssue({ ...issue, priority: payload.priority });
    } catch (requestError) {
      setPriorityError(requestError.message);
    } finally {
      setUpdatingPriority(false);
    }
  }

  async function updateAssignee(event) {
    const assignee = event.target.value || null;
    setAssigneeError('');
    setUpdatingAssignee(true);
    try {
      const response = await fetch(`/api/issues/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to update assignee.');
      setIssue({ ...issue, assignee: payload.assignee });
    } catch (requestError) {
      setAssigneeError(requestError.message);
    } finally {
      setUpdatingAssignee(false);
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    const text = commentForm.text.trim();
    setCommentError('');
    if (!text) {
      setCommentError('Please write a comment before posting.');
      return;
    }
    setSubmittingComment(true);
    try {
      const response = await fetch(`/api/issues/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commentForm)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to post comment.');
      setIssue({ ...issue, comments: [...(issue.comments || []), payload] });
      setCommentForm({ text: '' });
    } catch (requestError) {
      setCommentError(requestError.message);
    } finally {
      setSubmittingComment(false);
    }
  }

  async function toggleWatch() {
    const response = await fetch(`/api/issues/${id}/watch`, { method: issue.watching ? 'DELETE' : 'POST' });
    if (response.ok) setIssue({ ...issue, watching: !issue.watching });
  }
  async function uploadAttachment(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAttachmentError(''); setUploading(true);
    try {
      const body = new FormData(); body.append('file', file);
      const response = await fetch(`/api/issues/${id}/attachments`, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to upload file.');
      setIssue({ ...issue, attachments: [data, ...(issue.attachments || [])] });
    } catch (requestError) { setAttachmentError(requestError.message); }
    finally { setUploading(false); event.target.value = ''; }
  }
  async function addDependency(event) {
    event.preventDefault(); setDependencyError('');
    try {
      const response = await fetch(`/api/issues/${id}/dependencies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockedIssueId: dependencyId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to add dependency.');
      const refreshed = await fetch(`/api/issues/${id}`).then((result) => result.json());
      setIssue(refreshed); setDependencyId('');
    } catch (requestError) { setDependencyError(requestError.message); }
  }

  return (
    <main className="card issue-detail">
      <a className="back-link" href="/">← All issues</a>
      <p className="eyebrow">Issue #{issue.id}</p>
      <h1>{issue.title}</h1>
      <div className="metadata"><span>{issue.status}</span><PriorityBadge value={issue.priority} /></div>
      <button className="watch-button" type="button" onClick={toggleWatch}>{issue.watching ? 'Watching this issue' : 'Watch this issue'}</button>
      <p className="watcher-summary">Watchers: {issue.watchers?.length ? issue.watchers.map((watcher) => watcher.name).join(', ') : 'None'}</p>
      <div className="status-control">
        <label htmlFor="issue-status">Status</label>
        <select id="issue-status" value={issue.status} onChange={updateStatus} disabled={updatingStatus}>
          {statuses.map((status) => <option key={status}>{status}</option>)}
        </select>
        {updatingStatus && <span className="updating-status">Updating…</span>}
        {statusError && <p className="error" role="alert">{statusError}</p>}
      </div>
      <div className="status-control">
        <label htmlFor="issue-priority">Priority</label>
        <select id="issue-priority" value={issue.priority} onChange={updatePriority} disabled={updatingPriority}>
          {priorities.map((priority) => <option key={priority}>{priority}</option>)}
        </select>
        {updatingPriority && <span className="updating-status">Updating…</span>}
        {priorityError && <p className="error" role="alert">{priorityError}</p>}
      </div>
      <div className="status-control">
        <label htmlFor="issue-assignee">Assignee</label>
        <select id="issue-assignee" value={issue.assignee || ''} onChange={updateAssignee} disabled={updatingAssignee}>
          <option value="">Unassigned</option>
          {users.map((user) => <option key={user.id} value={user.name}>{user.name}</option>)}
        </select>
        {updatingAssignee && <span className="updating-status">Updating…</span>}
        {assigneeError && <p className="error" role="alert">{assigneeError}</p>}
      </div>
      <section className="issue-section" aria-labelledby="description-heading">
        <h2 id="description-heading">Description</h2>
        <p className="description">{issue.description}</p>
      </section>
      <section className="issue-section"><h2>Keywords</h2>{issue.keywords?.length ? <p className="keyword-tags">{issue.keywords.map((keyword) => <span key={keyword.id}>{keyword.name}</span>)}</p> : <p className="muted">No keywords assigned.</p>}</section>
      <dl className="issue-fields">
        <div><dt>Product</dt><dd>{issue.product_name || 'Unclassified'}</dd></div>
        <div><dt>Component</dt><dd>{issue.component_name || 'Unclassified'}</dd></div>
        <div><dt>Affected version</dt><dd>{issue.version_name || 'Not specified'}</dd></div>
        <div><dt>Target milestone</dt><dd>{issue.milestone_name || 'Not specified'}</dd></div>
        <div><dt>Status</dt><dd>{issue.status}</dd></div>
        <div><dt>Priority</dt><dd><PriorityBadge value={issue.priority} /></dd></div>
        <div><dt>Assignee</dt><dd>{issue.assignee || 'Unassigned'}</dd></div>
        <div><dt>Created</dt><dd>{new Date(issue.created_at).toLocaleString()}</dd></div>
      </dl>
      <section className="issue-section"><h2>Attachments</h2><label className="file-picker">{uploading ? 'Uploading…' : 'Attach a file'}<input type="file" onChange={uploadAttachment} disabled={uploading} /></label>{attachmentError && <p className="error">{attachmentError}</p>}{issue.attachments?.length ? <ul className="link-list">{issue.attachments.map((attachment) => <li key={attachment.id}><a href={attachment.url}>{attachment.filename}</a> <span>{Math.ceil(attachment.size / 1024)} KB · {attachment.uploaded_by}</span></li>)}</ul> : <p className="muted">No attachments yet.</p>}</section>
      <section className="issue-section"><h2>Dependencies</h2><div className="dependency-lists"><div><h3>Blocks</h3>{issue.blocks?.length ? <ul className="link-list">{issue.blocks.map((item) => <li key={item.id}><a href={`/issues/${item.id}`}>#{item.id} · {item.title}</a></li>)}</ul> : <p className="muted">None</p>}</div><div><h3>Depends on</h3>{issue.dependsOn?.length ? <ul className="link-list">{issue.dependsOn.map((item) => <li key={item.id}><a href={`/issues/${item.id}`}>#{item.id} · {item.title}</a></li>)}</ul> : <p className="muted">None</p>}</div></div><form className="dependency-form" onSubmit={addDependency}><label htmlFor="blocked-issue">This issue blocks #</label><input id="blocked-issue" inputMode="numeric" value={dependencyId} onChange={(event) => setDependencyId(event.target.value)} required /><button type="submit">Add dependency</button>{dependencyError && <p className="error">{dependencyError}</p>}</form></section>
      <section className="comments-section" aria-labelledby="comments-heading">
        <h2 id="comments-heading">Discussion & history <span>{(issue.comments?.length || 0) + (issue.activity?.length || 0)}</span></h2>
        {issue.comments?.length || issue.activity?.length ? (
          <ol className="comment-list">{[
            ...(issue.comments || []).map((comment) => ({ ...comment, kind: 'comment', occurredAt: comment.created_at })),
            ...(issue.activity || []).map((activity) => ({ ...activity, kind: 'activity', occurredAt: activity.changed_at }))
          ].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt)).map((entry) => entry.kind === 'comment' ? (
            <li key={`comment-${entry.id}`} className="comment"><p className="comment-meta">{entry.author || 'Unknown user'} <time dateTime={entry.created_at}>commented {new Date(entry.created_at).toLocaleString()}</time></p><p className="description markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }} /></li>
          ) : <li key={`activity-${entry.id}`} className="comment activity-entry"><p className="comment-meta">{entry.changed_by} <time dateTime={entry.changed_at}>updated {new Date(entry.changed_at).toLocaleString()}</time></p><p className="description">Changed {entry.field_changed} from <strong>{entry.old_value || 'Unassigned'}</strong> to <strong>{entry.new_value || 'Unassigned'}</strong>.</p></li>)}</ol>
        ) : <p className="no-comments">No discussion or activity yet.</p>}
        <form className="comment-form" onSubmit={submitComment} noValidate>
          <h3>Add a comment</h3>
          <label htmlFor="comment-text">Comment <span aria-hidden="true">*</span></label>
          <textarea id="comment-text" value={commentForm.text} onChange={(event) => setCommentForm({ ...commentForm, text: event.target.value })} rows="5" maxLength="5000" required />
          {commentError && <p className="error" role="alert">{commentError}</p>}
          <button type="submit" disabled={submittingComment}>{submittingComment ? 'Posting…' : 'Post comment'}</button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    fetch('/api/auth/me').then(async (response) => {
      if (response.status === 401) return setUser(null);
      const data = await response.json();
      if (!response.ok) return setUser(null);
      setUser(data.user);
    }).catch(() => setUser(null));
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    window.location.assign('/');
  }

  useEffect(() => {
    let pendingGo = false;
    const onKeyDown = (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === 'c') window.location.assign('/issues/new');
      if (pendingGo && event.key.toLowerCase() === 'b') { event.preventDefault(); window.location.assign('/board'); }
      pendingGo = event.key.toLowerCase() === 'g';
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (user === undefined) return <main className="card"><p>Loading Bugsilla…</p></main>;
  if (!user) return <AuthPage onAuthenticated={setUser} />;

  const match = window.location.pathname.match(/^\/issues\/(\d+)$/);
  const page = match ? <IssueDetail id={match[1]} /> : window.location.pathname === '/issues/new' ? <CreateIssueForm /> : window.location.pathname === '/board' ? <KanbanBoard /> : window.location.pathname === '/admin' ? user.role === 'admin' ? <AdminPanel /> : <main className="card"><h1>Access denied</h1><p className="error">Administrator access is required.</p></main> : <IssueList />;
  return <><AppNav user={user} onLogout={logout} />{page}</>;
}
