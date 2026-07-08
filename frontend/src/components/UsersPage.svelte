<script>
  // User administration (needs users.manage): accounts, the registration
  // toggle, and role management — built-in roles (viewer/trusted/admin) plus
  // custom roles assembled from the permission catalog (core + plugins).
  import { goBack } from '../lib/router.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api.js';
  import { auth } from '../lib/auth.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog } from './DialogModal.svelte';

  let { active = false } = $props();
  let users = $state([]);
  let roles = $state([]);
  let perms = $state([]);
  let allowRegistration = $state(false);
  let loaded = $state(false);
  let nu = $state({ username: '', password: '', role: 'viewer' });

  // Role editor: null = closed, { name, label, permissions:Set, isNew }
  let editor = $state(null);

  // Checkbox groups: core perms by category, plugin perms under the plugin name.
  const permGroups = $derived.by(() => {
    const groups = new Map();
    for (const p of perms) {
      const g = p.plugin ? `Plugin: ${p.plugin}` : p.category || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    return [...groups.entries()];
  });

  async function refresh() {
    try {
      const [u, r, p, s] = await Promise.all([
        apiGet('/api/users'), apiGet('/api/roles'), apiGet('/api/permissions'), apiGet('/api/settings'),
      ]);
      users = u.users || [];
      roles = r.roles || [];
      perms = p.permissions || [];
      allowRegistration = !!s.allowRegistration;
      loaded = true;
    } catch { /* keep last */ }
  }
  $effect(() => { if (active) refresh(); });

  async function setRole(u, role) {
    const r = await apiPatch(`/api/users/${u.id}`, { role });
    if (r.error) { notify(r.error, 'error'); refresh(); return; }
    notify(`${u.username} is now ${roleLabel(role)}`, 'ok');
    refresh();
  }
  async function toggleDisabled(u) {
    const r = await apiPatch(`/api/users/${u.id}`, { disabled: !u.disabled });
    if (r.error) { notify(r.error, 'error'); return; }
    refresh();
  }
  async function remove(u) {
    if (!(await confirmDialog({
      title: `Delete ${u.username}?`,
      message: 'Their account and sessions are removed permanently.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    const r = await apiDelete(`/api/users/${u.id}`);
    if (r.error) { notify(r.error, 'error'); return; }
    refresh();
  }
  async function create() {
    const r = await apiPost('/api/users', nu);
    if (r.error) { notify(r.error, 'error'); return; }
    notify(`Account "${r.user.username}" created (${roleLabel(r.user.role)}).`, 'ok');
    nu = { username: '', password: '', role: 'viewer' };
    refresh();
  }
  async function toggleRegistration() {
    const r = await apiPost('/api/settings', { allowRegistration: !allowRegistration });
    if (r.error) { notify(r.error, 'error'); return; }
    allowRegistration = !!r.allowRegistration;
  }

  // ---- roles ----
  const roleLabel = (name) => roles.find((r) => r.name === name)?.label || name;
  const permLabel = (key) => perms.find((p) => p.key === key)?.label || key;

  function openEditor(role) {
    editor = role
      ? { isNew: false, name: role.name, label: role.label, permissions: new Set(role.permissions) }
      : { isNew: true, name: '', label: '', permissions: new Set() };
  }
  function togglePerm(key) {
    if (editor.permissions.has(key)) editor.permissions.delete(key);
    else editor.permissions.add(key);
    editor = { ...editor, permissions: new Set(editor.permissions) }; // reassign for reactivity
  }
  async function saveRole() {
    const body = { label: editor.label || editor.name, permissions: [...editor.permissions] };
    const r = editor.isNew
      ? await apiPost('/api/roles', { name: editor.name.trim().toLowerCase(), ...body })
      : await apiPatch(`/api/roles/${editor.name}`, body);
    if (r.error) { notify(r.error, 'error'); return; }
    notify(editor.isNew ? `Role "${editor.name}" created.` : `Role "${editor.name}" updated.`, 'ok');
    editor = null;
    refresh();
  }
  async function removeRole(role) {
    if (!(await confirmDialog({
      title: `Delete the ${role.label} role?`,
      message: 'Accounts cannot keep a deleted role — this only works once no account uses it.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    const r = await apiDelete(`/api/roles/${role.name}`);
    if (r.error) { notify(r.error, 'error'); return; }
    refresh();
  }
</script>

<main id="users-page" class="scan-page users-page">
  <div class="scan-page__bar">
    <button id="users-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Users</h2>
    <span class="scan-summary muted">{loaded ? `${users.length} account${users.length === 1 ? '' : 's'}` : ''}</span>
    <label class="userreg">
      <span class="switch switch--sm"><input type="checkbox" checked={allowRegistration} onchange={toggleRegistration} /><span class="switch__track"></span></span>
      Allow self-registration <span class="muted">(new accounts start as viewers)</span>
    </label>
  </div>

  <div class="users-scroll">
    {#each users as u (u.id)}
      <div class="user-row" class:is-off={u.disabled}>
        <span class="user-row__name">{u.username}{#if u.id === auth.user?.id}<span class="user-row__you">you</span>{/if}</span>
        <span class="user-row__seen muted">{u.last_seen ? 'seen ' + new Date(u.last_seen).toLocaleDateString() : 'never signed in'}</span>
        <select class="user-row__role" value={u.role} onchange={(e) => setRole(u, e.currentTarget.value)} disabled={u.id === auth.user?.id}>
          {#each roles as r (r.name)}
            <option value={r.name}>{r.label}</option>
          {/each}
        </select>
        <button class="btn btn--ghost btn--sm" disabled={u.id === auth.user?.id} onclick={() => toggleDisabled(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn btn--ghost btn--sm btn--danger" disabled={u.id === auth.user?.id} onclick={() => remove(u)}>Delete</button>
      </div>
    {/each}

    <div class="user-new">
      <div class="modal__subhead">Create an account</div>
      <form class="user-new__form" onsubmit={(e) => { e.preventDefault(); create(); }}>
        <input type="text" placeholder="username" bind:value={nu.username} required minlength="2" maxlength="32" autocomplete="off" />
        <input type="password" placeholder="password (8+ chars)" bind:value={nu.password} required minlength="8" autocomplete="new-password" />
        <select bind:value={nu.role}>
          {#each roles as r (r.name)}
            <option value={r.name}>{r.label}</option>
          {/each}
        </select>
        <button class="btn btn--primary btn--sm">+ Create</button>
      </form>
    </div>

    <!-- Roles: what each role may do; built-ins are fixed, custom roles are
         assembled permission-by-permission from the catalog below. -->
    <div class="roles-block">
      <div class="modal__subhead">Roles
        <button class="btn btn--ghost btn--sm" onclick={() => openEditor(null)}>+ New role</button>
      </div>
      {#each roles as r (r.name)}
        <div class="role-row">
          <span class="role-row__name">{r.label}
            {#if r.builtin}<span class="role-row__badge">built-in</span>{/if}
          </span>
          <span class="role-row__users muted">{r.users} account{r.users === 1 ? '' : 's'}</span>
          <span class="role-row__perms muted">
            {#if r.permissions.includes('*')}everything
            {:else if r.permissions.length === 0}nothing
            {:else}{r.permissions.map(permLabel).join(' · ')}{/if}
          </span>
          {#if !r.builtin}
            <button class="btn btn--ghost btn--sm" onclick={() => openEditor(r)}>Edit</button>
            <button class="btn btn--ghost btn--sm btn--danger" onclick={() => removeRole(r)}>Delete</button>
          {/if}
        </div>
      {/each}

      {#if editor}
        <form class="role-editor" onsubmit={(e) => { e.preventDefault(); saveRole(); }}>
          <div class="role-editor__head">
            {#if editor.isNew}
              <input type="text" placeholder="role name (e.g. kids)" bind:value={editor.name}
                     required minlength="2" maxlength="32" pattern="[a-z0-9][a-z0-9_\-]+" autocomplete="off" />
            {:else}
              <span class="role-editor__name">{editor.name}</span>
            {/if}
            <input type="text" placeholder="display label" bind:value={editor.label} maxlength="48" />
          </div>
          {#each permGroups as [group, list] (group)}
            <div class="role-editor__group">
              <div class="role-editor__grouphead">{group}</div>
              {#each list as p (p.key)}
                <label class="role-editor__perm" title={p.description}>
                  <input type="checkbox" checked={editor.permissions.has(p.key)} onchange={() => togglePerm(p.key)} />
                  <span>{p.label}</span>
                  <span class="muted">{p.description}</span>
                </label>
              {/each}
            </div>
          {/each}
          <div class="role-editor__actions">
            <button type="button" class="btn btn--ghost btn--sm" onclick={() => { editor = null; }}>Cancel</button>
            <button class="btn btn--primary btn--sm">{editor.isNew ? 'Create role' : 'Save role'}</button>
          </div>
        </form>
      {/if}
    </div>
  </div>
</main>
