import { mountColophonPanel } from '../panel/app.js'

const host = document.getElementById('app').attachShadow({ mode: 'open' })
mountColophonPanel(host, { mode: 'sidepanel' })
