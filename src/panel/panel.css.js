export const PANEL_CSS = `
  :host {
    color-scheme: light;
    --colophon-text: #15151a;
    --colophon-muted: #767681;
    --colophon-line: #ececf2;
    --colophon-soft: #f8f7fc;
    --colophon-purple: #5d3fd3;
    --colophon-purple-soft: #f3efff;
    --colophon-green: #2f955c;
    --colophon-green-soft: #effaf2;
    --colophon-red-soft: #fff3f1;
    --colophon-shadow: 0 18px 48px rgba(22, 22, 35, 0.14);
    all: initial;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  *, *::before, *::after { box-sizing: border-box; }

  .colophon-panel {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100vh;
    background: #fff;
    color: var(--colophon-text);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: inherit;
    font-size: 13px;
    letter-spacing: 0;
  }

  .colophon-panel--floating {
    width: min(360px, calc(100vw - 28px));
    height: min(720px, calc(100vh - 28px));
    min-height: 520px;
    border: 1px solid rgba(19, 19, 26, 0.16);
    border-radius: 8px;
    box-shadow: var(--colophon-shadow);
  }

  .colophon-topbar {
    height: 54px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-bottom: 1px solid var(--colophon-line);
    flex: 0 0 auto;
  }

  .colophon-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 700;
    font-size: 15px;
  }

  .colophon-logo {
    width: 18px;
    height: 18px;
    display: inline-grid;
    place-items: center;
    color: #0f0f14;
  }

  .colophon-tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .icon-btn {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #3f3f49;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }

  .icon-btn:hover { background: #f4f4f7; }

  .docbar {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border-bottom: 1px solid var(--colophon-line);
    flex: 0 0 auto;
  }

  .doc-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 650;
  }

  .doc-menu { margin-left: auto; }

  .timeline {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 14px 118px;
    scrollbar-width: thin;
  }

  .context-card {
    border: 1px solid var(--colophon-line);
    background: linear-gradient(180deg, #fff, #faf9fd);
    border-radius: 8px;
    padding: 14px 12px;
    margin-bottom: 14px;
    box-shadow: 0 7px 18px rgba(20, 20, 30, 0.04);
  }

  .context-label {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .context-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
  }

  .context-text {
    line-height: 1.35;
    font-size: 13px;
  }

  .timeline-item {
    display: grid;
    grid-template-columns: 26px 1fr;
    column-gap: 8px;
    position: relative;
  }

  .timeline-item::before {
    content: "";
    position: absolute;
    left: 12px;
    top: 28px;
    bottom: 0;
    width: 1px;
    background: linear-gradient(var(--colophon-line), transparent);
  }

  .timeline-item:last-child::before { display: none; }

  .mark {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    margin-top: 4px;
    box-shadow: 0 8px 18px rgba(94, 63, 211, 0.15);
    z-index: 1;
  }

  .mark::after {
    content: "";
    position: absolute;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    z-index: -1;
    opacity: 0.58;
    filter: blur(5px);
  }

  .mark--ai {
    background: var(--colophon-purple-soft);
    color: var(--colophon-purple);
    box-shadow: 0 8px 18px rgba(94, 63, 211, 0.16);
  }

  .mark--ai::after { background: #ded5ff; }

  .mark--you {
    background: var(--colophon-green-soft);
    color: var(--colophon-green);
    box-shadow: 0 8px 18px rgba(47, 149, 92, 0.14);
  }

  .mark--you::after { background: #d9f6df; }

  .mark--accepted {
    background: var(--colophon-green);
    color: #fff;
    box-shadow: 0 8px 18px rgba(47, 149, 92, 0.28);
  }

  .mark--accepted::after { background: #bcecc8; }

  .mark--quiet { background: #f4f4f6; color: #777782; }

  .item-main { min-width: 0; padding-bottom: 14px; }

  .item-head {
    min-height: 26px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--colophon-muted);
  }

  .actor {
    font-weight: 750;
    color: var(--colophon-purple);
  }

  .actor--you { color: var(--colophon-green); }
  .actor--quiet { color: #767681; }

  .time { margin-left: auto; font-size: 10px; color: #888894; }

  .card {
    border: 1px solid var(--colophon-line);
    border-radius: 8px;
    background: #fff;
    padding: 12px;
    box-shadow: 0 7px 20px rgba(24, 24, 38, 0.05);
  }

  .card--ai { background: linear-gradient(180deg, #fff, #fbf9ff); border-color: #ede7ff; }
  .card--applied { background: linear-gradient(180deg, #fbfff9, #fff); border-color: #e0f2e4; }
  .card--dismissed { background: #fafafa; color: #686873; }

  .card-copy {
    line-height: 1.45;
    margin: 0 0 12px;
    overflow-wrap: anywhere;
  }

  .card-note {
    color: var(--colophon-muted);
    line-height: 1.35;
    margin: -6px 0 12px;
  }

  .actions-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .button {
    height: 30px;
    border-radius: 6px;
    border: 1px solid #dddde8;
    background: #fff;
    color: #343442;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .button:hover { background: #f7f7fa; }
  .button--primary { background: var(--colophon-purple); border-color: var(--colophon-purple); color: #fff; }
  .button--ghost { border-color: transparent; color: var(--colophon-purple); background: transparent; }

  .progress {
    height: 5px;
    border-radius: 999px;
    background: #e7e7ee;
    overflow: hidden;
    margin-top: 12px;
  }

  .progress span {
    display: block;
    width: 74%;
    height: 100%;
    background: var(--colophon-purple);
  }

  .diff {
    display: grid;
    gap: 8px;
    margin: 4px 0 12px;
  }

  .diff-line {
    border-left: 3px solid;
    padding: 8px 9px;
    border-radius: 0 6px 6px 0;
    line-height: 1.38;
  }

  .diff-line--old { border-color: #f0aaa0; background: var(--colophon-red-soft); }
  .diff-line--new { border-color: #7fc792; background: var(--colophon-green-soft); }

  .source-card {
    display: grid;
    grid-template-columns: 32px 1fr auto;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--colophon-line);
    border-radius: 7px;
    padding: 9px;
    background: #fff;
    margin-top: 8px;
  }

  .source-icon {
    width: 30px;
    height: 30px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    background: var(--colophon-purple-soft);
    color: var(--colophon-purple);
  }

  .source-title { font-weight: 700; font-size: 12px; }
  .source-url { font-size: 10px; color: var(--colophon-muted); margin-top: 2px; }

  .image-thumb {
    width: 150px;
    height: 74px;
    border-radius: 8px;
    object-fit: cover;
    display: block;
    margin-top: 6px;
    background: linear-gradient(135deg, #a18b74, #d7d1c8 52%, #5d7f62);
  }

  .thread {
    display: grid;
    gap: 10px;
  }

  .thread-bubble {
    border-left: 3px solid #ded6ff;
    padding: 8px 10px;
    background: #fbfaff;
    border-radius: 0 7px 7px 0;
    line-height: 1.4;
  }

  .thread-bubble--you {
    border-color: #aee0bb;
    background: #f7fff8;
  }

  .composer {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 18px;
    height: 42px;
    border: 1px solid var(--colophon-line);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(10px);
    display: grid;
    grid-template-columns: 1fr 30px;
    gap: 8px;
    align-items: center;
    padding: 6px 7px 6px 12px;
    box-shadow: 0 10px 28px rgba(20, 20, 32, 0.08);
  }

  .composer input {
    border: 0;
    outline: 0;
    font: inherit;
    font-size: 12px;
    min-width: 0;
    background: transparent;
    color: var(--colophon-text);
  }

  .composer button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: #d8d8df;
    color: #fff;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .composer button:hover { background: var(--colophon-purple); }

  .ellipsis {
    color: var(--colophon-green);
    font-size: 18px;
    line-height: 1;
    letter-spacing: 2px;
    padding-left: 4px;
  }

  .floating-shell {
    position: fixed;
    right: 24px;
    top: 72px;
    z-index: 2147483647;
  }

  .drag-handle { cursor: grab; user-select: none; }
  .drag-handle:active { cursor: grabbing; }
`
