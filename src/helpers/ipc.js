'use strict';
// Every ipcMain handler. The renderer half is preload.js; keep the two in sync.
const path = require('node:path');
const { ipcMain, dialog, screen } = require('electron');
const { resizePill, clampToWorkArea } = require('./windowConfig');

function registerIpc({ sessions, getWindow }) {
  ipcMain.handle('list', () => sessions.list());
  ipcMain.handle('send', (_e, id, text) => sessions.send(id, text));
  ipcMain.handle('approve', (_e, id) => sessions.approve(id));
  ipcMain.handle('deny', (_e, id) => sessions.deny(id));
  ipcMain.handle('stop', (_e, id) => sessions.stop(id));

  ipcMain.handle('pick', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const cwd = r.filePaths[0];
    return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
  });

  ipcMain.on('resize', (_e, expanded) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) resizePill(win, expanded);
  });

  // Moving the pill by hand: the bar can't be an OS drag region because that
  // swallows its click (see Pill.jsx). The cursor is read here, in screen
  // coordinates, so renderer and window can never disagree about units.
  let grab = null;   // cursor offset inside the window, while a drag is on
  const live = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  ipcMain.on('drag-start', () => {
    const win = live();
    if (!win) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    grab = { x: c.x - b.x, y: c.y - b.y };
  });
  ipcMain.on('drag-move', () => {
    const win = live();
    if (!win || !grab) return;
    const c = screen.getCursorScreenPoint();
    win.setPosition(Math.round(c.x - grab.x), Math.round(c.y - grab.y));
  });
  ipcMain.on('drag-end', () => {
    grab = null;
    const win = live();
    if (!win) return;
    // Dropped half off a display, it would grow off-screen on expand.
    const b = win.getBounds();
    win.setBounds(clampToWorkArea(b, screen.getDisplayMatching(b)));
  });
}

module.exports = { registerIpc };
