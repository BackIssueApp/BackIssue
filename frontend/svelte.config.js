// Pointer-only conveniences we use on purpose: closing a modal/drawer by
// clicking its backdrop (keyboard users have Escape), dismissing a toast by
// clicking it (they also auto-dismiss and announce via role="status"), and
// click delegation on the plugin-injected menu container. These three lint
// rules flag exactly those patterns — silence them; every other a11y warning
// still fires.
const QUIET = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
  'a11y_no_noninteractive_element_interactions',
]);

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  onwarn(warning, handler) {
    if (QUIET.has(warning.code)) return;
    handler(warning);
  },
};
