import { mountColophonPanel } from '../panel/app.js'

async function getDocTitle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return null
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_TITLE' })
    return response?.title || null
  } catch {
    return null
  }
}

async function init() {
  const root = document.getElementById('root')
  const docTitle = await getDocTitle()

  mountColophonPanel(root, {
    mode: 'sidepanel',
    docTitle: docTitle ?? 'Untitled document',
  })
}

init()
