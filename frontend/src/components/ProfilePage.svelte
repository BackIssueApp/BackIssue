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
  let copied = $state(false);

  const PROVIDER_LABELS = { whmcs: 'WHMCS', oidc: 'SSO' };
  const providerLabel = (id) => PROVIDER_LABELS[id] || String(id || '').toUpperCase();
  // Accounts that sign in through an external service (SSO/OIDC, billing, …)
  // don't have a local password — it's managed by that provider.
  const isExternal = $derived((profile?.providers || []).length > 0);
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
    try {
      await navigator.clipboard.writeText(freshKey);
      copied = true; clearTimeout(copyKey._t); copyKey._t = setTimeout(() => { copied = false; }, 1400);
    } catch { notify('Copy failed — select and copy it manually.', 'error'); }
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

<main id="profile-page" class="scan-page profile-page pfx">
  <div class="pfx__head">
    <button class="pfx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
    <h2 class="pfx__title">Profile</h2>
  </div>
  <div class="pfx__scroll">
    <div class="pfx__inner">

      <!-- identity hero -->
      <div class="pfx__hero">
        <span class="pfx__avatar">{(auth.user?.username || '?').slice(0, 1).toUpperCase()}</span>
        <div class="pfx__hero-main">
          <div class="pfx__hero-top">
            <span class="pfx__name">{auth.user?.username}</span>
            <span class="pfx__roletag">{auth.user?.role}</span>
            {#each profile?.providers || [] as p (p)}<span class="pfx__provider" title="Linked to {providerLabel(p)}">{providerLabel(p)}</span>{/each}
          </div>
          {#if profile}
            <div class="pfx__hero-meta">
              <span>Member since <b>{fmtDate(profile.created_at)}</b></span>
              <span>Last signed in <b>{fmtDate(profile.last_seen)}</b></span>
            </div>
          {/if}
        </div>
      </div>

      <div class="pfx__cards">
        <!-- account -->
        <div class="pfx__card">
          <div class="pfx__cardhead">Account</div>
          <div class="pfx__field">
            <span class="pfx__label">Email</span>
            <div class="pfx__email">
              <input type="email" spellcheck="false" bind:value={email} placeholder="you@example.com" />
              <button class="pfx__ghost" onclick={saveEmail}>Save</button>
            </div>
          </div>
          <div class="pfx__rule"></div>
          <div class="pfx__actions">
            {#if !isExternal}<button class="pfx__ghost" onclick={openAccountModal}>Change password</button>{/if}
            <button class="pfx__ghost" onclick={signOutOthers}>Sign out other devices</button>
            <button class="pfx__ghost pfx__ghost--danger" onclick={logout}>Sign out</button>
          </div>
          {#if isExternal}
            <p class="pfx__note">You sign in through {profile.providers.map(providerLabel).join(', ')}, so your password is managed there — not here.</p>
          {/if}
        </div>

        <!-- api key -->
        <div class="pfx__card">
          <div class="pfx__cardhead">API key</div>
          <p class="pfx__note pfx__note--top">A personal key for apps and scripts that talk to this BackIssue install — sent as an <code>X-Api-Key</code> header (or <code>Authorization: Bearer</code>). It can do exactly what your account can, nothing more.</p>

          {#if freshKey}
            <div class="pfx__freshkey">
              <code>{freshKey}</code>
              <button class="pfx__ghost pfx__ghost--sm" onclick={copyKey}><Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p class="pfx__warn">Copy it now — it won't be shown again.</p>
            {#if qrDataUrl}
              <div class="pfx__qr">
                <div class="pfx__qr-img"><img src={qrDataUrl} alt="Pairing QR code" width="110" height="110" /></div>
                <p class="pfx__note">Scan in the <b>BackIssue</b> mobile app (Connect → Scan QR) to pair without typing.</p>
              </div>
            {/if}
          {:else if apiKey}
            <div class="pfx__keyrows">
              <div class="pfx__keyrow"><span>Key</span><code>{apiKey.prefix}…</code></div>
              <div class="pfx__keyrow"><span>Created</span><span>{fmtDate(apiKey.created_at)}</span></div>
              <div class="pfx__keyrow"><span>Last used</span><span>{fmtDate(apiKey.last_used)}</span></div>
            </div>
          {:else}
            <div class="pfx__nokey">No API key yet. Generate one to connect the mobile app or scripts.</div>
          {/if}

          <div class="pfx__actions pfx__actions--key">
            <button class="pfx__primary" onclick={generateKey}>{apiKey ? 'Replace key' : 'Generate key'}</button>
            {#if apiKey}<button class="pfx__ghost pfx__ghost--danger" onclick={revokeKey}>Revoke</button>{/if}
          </div>
        </div>
      </div>

      <!-- Per-user plugin options (reading shelves/defaults, OPDS, …) inject
           here — plain DOM, must stay mounted. -->
      <div id="profile-plugin-slot" class="pfx__plugin"></div>
    </div>
  </div>
</main>

<style>
  /* Layout comes from the route reveal rule `body.profilepage .profile-page`;
     the scoped root must NOT set display or it defeats the .scan-page hide. */
  .pfx { min-height: 0; }
  .pfx__head { flex: none; display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
  .pfx__iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
  .pfx__iconbtn:hover { color: var(--text); }
  .pfx__title { margin: 0; font-family: var(--font-display); font-size: 24px; letter-spacing: .03em; font-weight: 400; }
  .pfx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 24px 60px; }
  .pfx__inner { max-width: 840px; margin: 0 auto; }

  .pfx__hero { display: flex; align-items: center; gap: 18px; padding: 22px; border: 1px solid #3a3350; border-radius: 16px; background: linear-gradient(150deg, #221c30, #191622); margin-bottom: 18px; }
  .pfx__avatar { width: 64px; height: 64px; border-radius: 50%; background: var(--accent); color: #fff; font: 700 26px var(--font-body); display: grid; place-items: center; flex: none; box-shadow: 0 8px 24px rgba(255,45,111,.3); }
  .pfx__hero-main { flex: 1; min-width: 0; }
  .pfx__hero-top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .pfx__name { font-family: var(--font-display); font-size: 24px; letter-spacing: .02em; }
  .pfx__roletag { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .05em; color: var(--accent); border: 1px solid rgba(255,45,111,.4); border-radius: 5px; padding: 2px 8px; }
  .pfx__provider { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--cyan); border: 1px solid rgba(43,212,217,.4); border-radius: 5px; padding: 2px 8px; }
  .pfx__hero-meta { display: flex; gap: 20px; margin-top: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--faint); }
  .pfx__hero-meta b { color: var(--text); }

  .pfx__cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  .pfx__card { border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.012); padding: 18px 20px; }
  .pfx__cardhead { font-family: var(--font-display); font-size: 15px; letter-spacing: .03em; margin-bottom: 14px; }
  .pfx__field { display: flex; flex-direction: column; gap: 6px; }
  .pfx__label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .pfx__email { display: flex; gap: 8px; }
  .pfx__email input { flex: 1; height: 38px; padding: 0 11px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .pfx__email input:focus { outline: none; border-color: var(--accent); }
  .pfx__rule { height: 1px; background: #2a2536; margin: 16px 0; }
  .pfx__actions { display: flex; flex-wrap: wrap; gap: 9px; }
  .pfx__actions--key { margin-top: 14px; }
  .pfx__ghost { height: 36px; padding: 0 14px; border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .pfx__ghost:hover { border-color: var(--muted); }
  .pfx__ghost--sm { height: 30px; flex: none; }
  .pfx__ghost--danger { color: var(--red); border-color: rgba(255,90,82,.35); }
  .pfx__primary { height: 36px; padding: 0 15px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .pfx__note { font-size: 12px; color: var(--faint); margin: 12px 0 0; line-height: 1.55; }
  .pfx__note--top { margin: 0 0 14px; }
  .pfx__note code, .pfx__note--top code { font-family: var(--font-mono); color: var(--muted); }
  .pfx__note b { color: var(--text); }

  .pfx__freshkey { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--ink); border: 1px solid rgba(95,211,138,.35); border-radius: 9px; }
  .pfx__freshkey code { flex: 1; min-width: 0; font: 12.5px var(--font-mono); color: var(--green); overflow: hidden; text-overflow: ellipsis; }
  .pfx__warn { font-size: 11.5px; color: var(--amber); margin: 8px 0 0; }
  .pfx__qr { display: flex; gap: 16px; align-items: center; margin-top: 16px; padding: 14px; background: rgba(255,255,255,.02); border: 1px solid #2a2536; border-radius: 11px; }
  .pfx__qr-img { width: 118px; height: 118px; border-radius: 9px; background: #fff; display: grid; place-items: center; flex: none; }
  .pfx__keyrows { display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
  .pfx__keyrow { display: flex; justify-content: space-between; align-items: center; }
  .pfx__keyrow > span:first-child { color: var(--faint); }
  .pfx__keyrow code { font: 12px var(--font-mono); color: var(--text); }
  .pfx__nokey { padding: 16px; border: 1px dashed var(--line); border-radius: 10px; text-align: center; font-size: 12.5px; color: var(--faint); }

  .pfx__plugin:empty { display: none; }
  .pfx__plugin { margin-top: 16px; }

  @media (max-width: 720px) {
    .pfx__cards { grid-template-columns: 1fr; }
  }
</style>
