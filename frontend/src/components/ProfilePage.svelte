<script>
  // Per-user profile: identity, account details/actions, and a slot where
  // plugins add their own per-user options (reading shelves & defaults, OPDS
  // access, …). Reached from the sidebar's account menu.
  import { goBack } from '../lib/router.svelte.js';
  import { auth, logout } from '../lib/auth.svelte.js';
  import { openAccountModal } from './AccountModal.svelte';
  import { apiGet, apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog } from './DialogModal.svelte';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();
  let profile = $state(null);
  let email = $state('');
  let apiKey = $state(null);      // { prefix, created_at, last_used } | null
  let freshKey = $state('');      // the raw key, shown once after generation
  let qrDataUrl = $state('');     // QR of the connection payload for the mobile app

  const PROVIDER_LABELS = { whmcs: 'WHMCS', oidc: 'SSO' };
  const providerLabel = (id) => PROVIDER_LABELS[id] || String(id || '').toUpperCase();
  const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

  async function load() {
    try { const r = await apiGet('/api/auth/profile'); profile = r.user; email = profile?.email || ''; }
    catch { profile = null; }
    try { apiKey = (await apiGet('/api/auth/apikey')).key; } catch { apiKey = null; }
  }
  $effect(() => { if (active) load(); });

  async function generateKey() {
    if (apiKey && !(await confirmDialog({
      title: 'Replace your API key?',
      message: 'A new key is generated and the current one stops working immediately. Anything using the old key must be updated.',
      confirmLabel: 'Replace key', danger: true,
    }))) return;
    const r = await apiPost('/api/auth/apikey', {});
    if (r.error) return notify(r.error, 'error');
    freshKey = r.key;
    renderQr(r.key);
    load();
  }
  // QR encodes { u: server origin, k: key } so the mobile app can pair by scan.
  async function renderQr(key) {
    try {
      const QRCode = (await import('qrcode')).default;
      const payload = JSON.stringify({ u: location.origin, k: key });
      qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 240 });
    } catch { qrDataUrl = ''; }
  }
  async function revokeKey() {
    if (!(await confirmDialog({
      title: 'Revoke your API key?',
      message: 'The key stops working immediately. Anything using it loses access.',
      confirmLabel: 'Revoke key', danger: true,
    }))) return;
    const r = await fetch('/api/auth/apikey', { method: 'DELETE' }).then((x) => x.json()).catch(() => ({ error: 'request failed' }));
    if (r.error) return notify(r.error, 'error');
    freshKey = '';
    notify('API key revoked.', 'ok');
    load();
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(freshKey); notify('Key copied.', 'ok'); }
    catch { notify('Copy failed — select and copy it manually.', 'error'); }
  }

  async function saveEmail() {
    const r = await apiPost('/api/auth/email', { email });
    if (r.error) return notify(r.error, 'error');
    notify('Email saved.', 'ok');
    load();
  }
  async function signOutOthers() {
    if (!(await confirmDialog({
      title: 'Sign out other devices?',
      message: 'Every other signed-in session is ended. This device stays signed in.',
      confirmLabel: 'Sign out others',
    }))) return;
    const r = await apiPost('/api/auth/logout-others', {});
    if (r.error) return notify(r.error, 'error');
    notify(r.cleared ? `Signed out ${r.cleared} other session${r.cleared === 1 ? '' : 's'}.` : 'No other sessions were active.', 'ok');
  }
</script>

<main id="profile-page" class="scan-page profile-page">
  <div class="scan-page__bar">
    <button class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Profile</h2>
  </div>
  <div class="profile-body">
    <div class="profile-measure">
      <section class="profile-id">
        <span class="profile-id__avatar">{(auth.user?.username || '?').slice(0, 1).toUpperCase()}</span>
        <div>
          <div class="profile-id__name">{auth.user?.username}
            {#each profile?.providers || [] as p}<span class="user-row__src" title="Linked to {providerLabel(p)}">{providerLabel(p)}</span>{/each}
          </div>
          <div class="profile-id__role">{auth.user?.role}</div>
        </div>
      </section>

      <section class="settings-section">
        <p class="modal__subhead">Account</p>
        <div class="profile-email">
          <label for="profile-email">Email</label>
          <div class="profile-email__row">
            <input id="profile-email" type="email" spellcheck="false" bind:value={email} placeholder="you@example.com" />
            <button class="btn btn--ghost btn--sm" onclick={saveEmail}>Save</button>
          </div>
        </div>
        {#if profile}
          <div class="profile-meta">
            <span><b>Member since</b> {fmtDate(profile.created_at)}</span>
            <span><b>Last signed in</b> {fmtDate(profile.last_seen)}</span>
          </div>
        {/if}
        <div class="profile-actions">
          <button class="btn btn--ghost" onclick={openAccountModal}>Change password</button>
          <button class="btn btn--ghost" onclick={signOutOthers}>Sign out other devices</button>
          <button class="btn btn--ghost btn--danger" onclick={logout}>Sign out</button>
        </div>
      </section>

      <section class="settings-section">
        <p class="modal__subhead">API key</p>
        <p class="modal__note">A personal key for apps and scripts that talk to this BackIssue install
          — send it as an <code>X-Api-Key</code> header (or <code>Authorization: Bearer</code>).
          It can do exactly what your account can do, nothing more.</p>
        {#if freshKey}
          <div class="apikey-fresh">
            <code class="mono">{freshKey}</code>
            <button class="btn btn--ghost btn--sm" onclick={copyKey}><Icon name="copy" size={14} /> Copy</button>
          </div>
          <p class="modal__note">Copy it now — it won't be shown again.</p>
          {#if qrDataUrl}
            <div class="apikey-qr">
              <img src={qrDataUrl} alt="Pairing QR code" width="200" height="200" />
              <p class="modal__note">Or scan this in the <b>BackIssue</b> mobile app (Connect → Scan QR) to pair without typing.</p>
            </div>
          {/if}
        {:else if apiKey}
          <div class="profile-meta">
            <span><b>Key</b> <code class="mono">{apiKey.prefix}…</code></span>
            <span><b>Created</b> {fmtDate(apiKey.created_at)}</span>
            <span><b>Last used</b> {fmtDate(apiKey.last_used)}</span>
          </div>
        {/if}
        <div class="profile-actions">
          <button class="btn btn--ghost" onclick={generateKey}>{apiKey ? 'Replace key' : 'Generate key'}</button>
          {#if apiKey}<button class="btn btn--ghost btn--danger" onclick={revokeKey}>Revoke</button>{/if}
        </div>
      </section>

      <!-- Per-user plugin options (reading shelves/defaults, OPDS, …) inject
           here — plain DOM, must stay mounted. -->
      <div id="profile-plugin-slot"></div>
    </div>
  </div>
</main>
