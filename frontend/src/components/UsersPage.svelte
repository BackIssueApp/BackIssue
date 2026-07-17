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
  let tab = $state('accounts'); // accounts | roles

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

  // A friendly label for an external-login source. Known providers get a nice
  // name; anything else shows its id uppercased so new plugins still surface.
  const PROVIDER_LABELS = { whmcs: 'WHMCS', oidc: 'SSO' };
  const providerLabel = (id) => PROVIDER_LABELS[id] || String(id || '').toUpperCase();

  // ---- roles ----
  const roleLabel = (name) => roles.find((r) => r.name === name)?.label || name;
  const permLabel = (key) => perms.find((p) => p.key === key)?.label || key;
  // Presentational role tint/icon — admin star, trusted shield, viewer eye,
  // custom violet shield. Nothing in the data requires this mapping.
  const ROLE_ICON = { admin: 'star', trusted: 'shield', viewer: 'eye' };
  const ROLE_TONE = { admin: 'var(--accent)', trusted: 'var(--cyan)', viewer: 'var(--green)' };
  const roleIcon = (name) => ROLE_ICON[name] || 'shield';
  const roleTone = (name) => ROLE_TONE[name] || '#a78bfa';

  function openEditor(role) {
    editor = role
      ? { isNew: false, name: role.name, label: role.label, permissions: new Set(role.permissions) }
      : { isNew: true, name: '', label: '', permissions: new Set() };
    tab = 'roles';
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

  const isSelf = (u) => u.id === auth.user?.id;
</script>

<main id="users-page" class="scan-page users-page usx">
  <div class="usx__head">
    <button id="users-back" class="usx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
    <h2 class="usx__title">Users</h2>
    <span class="usx__summary">{loaded ? `${users.length} account${users.length === 1 ? '' : 's'}` : ''}</span>
    <label class="usx__reg">
      <span class="switch switch--sm"><input type="checkbox" checked={allowRegistration} onchange={toggleRegistration} /><span class="switch__track"></span></span>
      Allow self-registration <span class="usx__reg-note">(new accounts start as viewers)</span>
    </label>
  </div>

  <div class="usx__tabs">
    <button class="usx__tab" class:is-active={tab === 'accounts'} onclick={() => (tab = 'accounts')}><Icon name="user" size={15} /> Accounts<span class="usx__tab-count">{users.length}</span></button>
    <button class="usx__tab" class:is-active={tab === 'roles'} onclick={() => (tab = 'roles')}><Icon name="shield" size={15} /> Roles<span class="usx__tab-count">{roles.length}</span></button>
  </div>

  <div class="usx__scroll">
    <div class="usx__inner">
      {#if tab === 'accounts'}
        <div class="usx__table">
          <div class="usx__thead">
            <span>Account</span><span class="usx__col-seen">Last seen</span><span>Role</span><span class="usx__r">Actions</span>
          </div>
          {#each users as u (u.id)}
            <div class="usx__urow" class:is-off={u.disabled}>
              <div class="usx__acct">
                <span class="usx__avatar" style="background:{roleTone(u.role)};">{u.username.slice(0, 1).toUpperCase()}</span>
                <div class="usx__acct-main">
                  <div class="usx__acct-top"><span class="usx__uname">{u.username}</span>{#if isSelf(u)}<span class="usx__you">You</span>{/if}</div>
                  <div class="usx__acct-sub">
                    {#each u.providers || [] as p (p)}<span class="usx__provider" title="Account linked to {providerLabel(p)}">{providerLabel(p)}</span>{/each}
                    {#if u.disabled}<span class="usx__disabled">Disabled</span>{/if}
                  </div>
                </div>
              </div>
              <span class="usx__col-seen usx__seen">{u.last_seen ? 'seen ' + new Date(u.last_seen).toLocaleDateString() : 'never signed in'}</span>
              <select class="usx__rolesel" value={u.role} onchange={(e) => setRole(u, e.currentTarget.value)} disabled={isSelf(u)}>
                {#each roles as r (r.name)}<option value={r.name}>{r.label}</option>{/each}
              </select>
              <div class="usx__uactions">
                {#if !isSelf(u)}
                  <button class="usx__ghost" onclick={() => toggleDisabled(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>
                  <button class="usx__del" aria-label="Delete {u.username}" onclick={() => remove(u)}><Icon name="trash" size={14} /></button>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        <div class="usx__create">
          <div class="usx__create-head">Create an account</div>
          <form class="usx__create-form" onsubmit={(e) => { e.preventDefault(); create(); }}>
            <label class="usx__field"><span class="usx__label">Username</span><input type="text" placeholder="username" bind:value={nu.username} required minlength="2" maxlength="32" autocomplete="off" /></label>
            <label class="usx__field"><span class="usx__label">Password</span><input type="password" placeholder="8+ characters" bind:value={nu.password} required minlength="8" autocomplete="new-password" /></label>
            <label class="usx__field"><span class="usx__label">Role</span><select bind:value={nu.role}>{#each roles as r (r.name)}<option value={r.name}>{r.label}</option>{/each}</select></label>
            <button class="usx__primary">Create</button>
          </form>
        </div>
      {:else}
        <div class="usx__roles-head">
          <p class="usx__roles-intro">Roles bundle permissions. Built-in roles are fixed; create custom roles from the permission catalog.</p>
          <button class="usx__primary usx__primary--icon" onclick={() => openEditor(null)}><Icon name="plus" size={14} /> New role</button>
        </div>

        {#each roles as r (r.name)}
          <div class="usx__role">
            <div class="usx__role-head">
              <span class="usx__role-ico" style="background:color-mix(in srgb, {roleTone(r.name)} 12%, transparent); color:{roleTone(r.name)};"><Icon name={roleIcon(r.name)} size={16} /></span>
              <span class="usx__role-name">{r.label}</span>
              {#if r.builtin}<span class="usx__builtin">Built-in</span>{/if}
              <span class="usx__role-users">{r.users} account{r.users === 1 ? '' : 's'}</span>
              {#if !r.builtin}
                <div class="usx__role-actions">
                  <button class="usx__ghost" onclick={() => openEditor(r)}>Edit</button>
                  <button class="usx__del" aria-label="Delete role" onclick={() => removeRole(r)}><Icon name="trash" size={14} /></button>
                </div>
              {/if}
            </div>
            <div class="usx__chips">
              {#if r.permissions.includes('*')}<span class="usx__chip usx__chip--all">Everything</span>
              {:else if r.permissions.length === 0}<span class="usx__chip-none">No permissions</span>
              {:else}{#each r.permissions as k (k)}<span class="usx__chip">{permLabel(k)}</span>{/each}{/if}
            </div>
          </div>
        {/each}

        {#if editor}
          <form class="usx__editor" onsubmit={(e) => { e.preventDefault(); saveRole(); }}>
            <div class="usx__editor-title">{editor.isNew ? 'New role' : 'Edit role'}</div>
            <div class="usx__editor-ids">
              <label class="usx__field"><span class="usx__label">Role name</span>
                {#if editor.isNew}
                  <input type="text" class="usx__mono" placeholder="e.g. kids" bind:value={editor.name} required minlength="2" maxlength="32" pattern="[a-z0-9][a-z0-9_\-]+" autocomplete="off" />
                {:else}
                  <input type="text" class="usx__mono" value={editor.name} disabled />
                {/if}
              </label>
              <label class="usx__field"><span class="usx__label">Display label</span><input type="text" placeholder={editor.name || 'Kids'} bind:value={editor.label} maxlength="48" /></label>
            </div>
            {#each permGroups as [group, list] (group)}
              <div class="usx__pgroup">
                <div class="usx__pgroup-head">{group}</div>
                <div class="usx__perms">
                  {#each list as p (p.key)}
                    <label class="usx__perm" class:is-on={editor.permissions.has(p.key)} title={p.description}>
                      <input type="checkbox" checked={editor.permissions.has(p.key)} onchange={() => togglePerm(p.key)} hidden />
                      <span class="usx__perm-box">{#if editor.permissions.has(p.key)}<Icon name="check" size={12} />{/if}</span>
                      <span class="usx__perm-info"><span class="usx__perm-label">{p.label}</span><span class="usx__perm-desc">{p.description}</span></span>
                    </label>
                  {/each}
                </div>
              </div>
            {/each}
            <div class="usx__editor-actions">
              <button type="button" class="usx__ghost" onclick={() => { editor = null; }}>Cancel</button>
              <button class="usx__primary">{editor.isNew ? 'Create role' : 'Save role'}</button>
            </div>
          </form>
        {/if}
      {/if}
    </div>
  </div>
</main>

<style>
  /* Layout comes from the route reveal rule `body.userspage .users-page`; the
     scoped root must NOT set display or it defeats the .scan-page hide. */
  .usx { min-height: 0; }
  .usx__head { flex: none; display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .usx__iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
  .usx__iconbtn:hover { color: var(--text); }
  .usx__title { margin: 0; font-family: var(--font-display); font-size: 24px; letter-spacing: .03em; font-weight: 400; }
  .usx__summary { font: 12px var(--font-mono); color: var(--faint); }
  .usx__reg { margin-left: auto; display: flex; align-items: center; gap: 11px; cursor: pointer; font-size: 12.5px; color: var(--muted); }
  .usx__reg-note { color: #6f6885; }

  .usx__tabs { flex: none; display: flex; gap: 6px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
  .usx__tab { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 15px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 13px var(--font-body); cursor: pointer; }
  .usx__tab.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .usx__tab-count { font: 600 11px var(--font-mono); color: #6f6885; }
  .usx__tab.is-active .usx__tab-count { color: rgba(255,255,255,.85); }

  .usx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 24px 60px; }
  .usx__inner { max-width: 860px; margin: 0 auto; }

  /* accounts table */
  .usx__table { border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.012); overflow: hidden; margin-bottom: 22px; }
  .usx__thead, .usx__urow { display: grid; grid-template-columns: 1.5fr 1fr 150px auto; gap: 12px; align-items: center; padding: 11px 16px; }
  .usx__thead { padding: 10px 16px; border-bottom: 1px solid var(--line); font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .usx__r { text-align: right; }
  .usx__urow { border-bottom: 1px solid #221e2c; }
  .usx__urow:last-child { border-bottom: none; }
  .usx__urow:hover { background: rgba(255,255,255,.025); }
  .usx__urow.is-off { opacity: .55; }
  .usx__acct { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .usx__avatar { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; font: 700 13px var(--font-body); color: #fff; }
  .usx__acct-main { min-width: 0; }
  .usx__acct-top { display: flex; align-items: center; gap: 7px; }
  .usx__uname { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usx__you { font: 600 9.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--cyan); border: 1px solid rgba(43,212,217,.4); border-radius: 4px; padding: 1px 6px; }
  .usx__acct-sub { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
  .usx__acct-sub:empty { display: none; }
  .usx__provider { font: 600 9.5px var(--font-mono); color: #a78bfa; border: 1px solid rgba(167,139,250,.35); border-radius: 4px; padding: 1px 5px; }
  .usx__disabled { font: 600 9.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--red); }
  .usx__seen { font: 11.5px var(--font-mono); color: var(--faint); }
  .usx__rolesel { max-width: 150px; height: 34px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .usx__rolesel:focus { outline: none; border-color: var(--accent); }
  .usx__uactions { display: flex; gap: 7px; justify-content: flex-end; }

  .usx__ghost { height: 30px; padding: 0 12px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; }
  .usx__ghost:hover { color: var(--text); }
  .usx__del { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid rgba(255,90,82,.3); background: transparent; color: var(--red); border-radius: 7px; cursor: pointer; flex: none; }
  .usx__del:hover { background: rgba(255,90,82,.1); }
  .usx__primary { height: 38px; padding: 0 18px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 13px var(--font-body); cursor: pointer; }
  .usx__primary--icon { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 15px; font-size: 12.5px; flex: none; }

  .usx__create { border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.012); padding: 18px 20px; }
  .usx__create-head { font-family: var(--font-display); font-size: 15px; letter-spacing: .03em; margin-bottom: 14px; }
  .usx__create-form { display: grid; grid-template-columns: 1fr 1fr 130px auto; gap: 10px; align-items: end; }
  .usx__field { display: flex; flex-direction: column; gap: 6px; }
  .usx__label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .usx__create-form input, .usx__create-form select, .usx__editor input { height: 38px; padding: 0 11px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .usx__create-form input:focus, .usx__create-form select:focus, .usx__editor input:focus { outline: none; border-color: var(--accent); }
  .usx__mono { font-family: var(--font-mono); }
  .usx__editor input:disabled { opacity: .6; }

  /* roles */
  .usx__roles-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .usx__roles-intro { font-size: 13px; color: var(--faint); margin: 0; max-width: 520px; line-height: 1.5; }
  .usx__role { border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.012); padding: 15px 17px; margin-bottom: 11px; }
  .usx__role-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .usx__role-ico { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex: none; }
  .usx__role-name { font-size: 14.5px; font-weight: 600; }
  .usx__builtin { font: 600 9.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--faint); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; }
  .usx__role-users { font: 11px var(--font-mono); color: var(--faint); }
  .usx__role-actions { margin-left: auto; display: flex; gap: 7px; }
  .usx__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .usx__chip { font: 11px var(--font-body); color: var(--muted); background: var(--panel-2); border-radius: 5px; padding: 3px 9px; }
  .usx__chip--all { color: var(--green); background: rgba(95,211,138,.12); }
  .usx__chip-none { font: 11px var(--font-body); color: #6f6885; }

  .usx__editor { border: 1px solid var(--accent); border-radius: 13px; background: rgba(255,45,111,.04); padding: 18px 20px; margin-top: 16px; }
  .usx__editor-title { font-family: var(--font-display); font-size: 16px; letter-spacing: .03em; margin-bottom: 14px; }
  .usx__editor-ids { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
  .usx__pgroup { margin-bottom: 16px; }
  .usx__pgroup-head { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); margin-bottom: 9px; }
  .usx__perms { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .usx__perm { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line); background: transparent; cursor: pointer; }
  .usx__perm.is-on { border-color: var(--accent); background: rgba(255,45,111,.06); }
  .usx__perm-box { width: 18px; height: 18px; border-radius: 5px; flex: none; margin-top: 1px; display: grid; place-items: center; color: #fff; border: 1px solid #4a4458; }
  .usx__perm.is-on .usx__perm-box { border-color: var(--accent); background: var(--accent); }
  .usx__perm-info { flex: 1; min-width: 0; }
  .usx__perm-label { display: block; font-size: 12.5px; font-weight: 500; }
  .usx__perm-desc { display: block; font-size: 11px; color: #6f6885; margin-top: 1px; line-height: 1.35; }
  .usx__editor-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 6px; }
  .usx__editor-actions .usx__ghost { height: 36px; padding: 0 16px; }

  @media (max-width: 720px) {
    .usx__thead, .usx__urow { grid-template-columns: 1fr 150px auto; }
    .usx__col-seen { display: none; }
    .usx__create-form { grid-template-columns: 1fr; }
    .usx__editor-ids, .usx__perms { grid-template-columns: 1fr; }
  }
</style>
