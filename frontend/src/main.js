import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initI18n } from './lib/i18n.svelte.js'

// The catalog for the chosen language is in place before anything renders, so
// there is no English flash for a non-English account.
initI18n().then(() => mount(App, { target: document.getElementById('app') }))
