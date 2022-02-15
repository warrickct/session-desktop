/* eslint-disable no-console */

const path = require('path');
const url = require('url');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const _ = require('lodash');
const pify = require('pify');
const electron = require('electron');
const { setup: setupSpellChecker } = require('./app/spell_check');
const packageJson = require('./package.json');
const GlobalErrors = require('./app/global_errors');

GlobalErrors.addHandler();
const electronLocalshortcut = require('electron-localshortcut');

const getRealPath = pify(fs.realpath);
const {
  app,
  BrowserWindow,
  ipcMain: ipc,
  Menu,
  protocol: electronProtocol,
  session,
  shell,
  systemPreferences,
} = electron;

// FIXME Hardcoding appId to prevent build failrues on release.
// const appUserModelId = packageJson.build.appId;
const appUserModelId = 'com.loki-project.messenger-desktop';
console.log('Set Windows Application User Model ID (AUMID)', {
  appUserModelId,
});
app.setAppUserModelId(appUserModelId);

// Keep a global reference of the window object, if you don't, the window will
//   be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function getMainWindow() {
  return mainWindow;
}

// Tray icon and related objects
let tray = null;

const config = require('./app/config');

// Very important to put before the single instance check, since it is based on the
//   userData directory.
const userConfig = require('./app/user_config');
const passwordUtil = require('./ts/util/passwordUtils');

const development = config.environment === 'development';
const appInstance = config.util.getEnv('NODE_APP_INSTANCE') || 0;

// We generally want to pull in our own modules after this point, after the user
//   data directory has been set.
const attachments = require('./ts/attachments/attachments');
const attachmentChannel = require('./app/attachment_channel');

const updater = require('./ts/updater/index');

const createTrayIcon = require('./app/tray_icon');
const ephemeralConfig = require('./app/ephemeral_config');
const logging = require('./app/logging');
const sql = require('./app/sql');
const sqlChannels = require('./app/sql_channel');
const windowState = require('./app/window_state');
const { createTemplate } = require('./app/menu');
const { installFileHandler, installWebHandler } = require('./app/protocol_filter');
const { installPermissionsHandler } = require('./app/permissions');

let appStartInitialSpellcheckSetting = true;

async function getSpellCheckSetting() {
  const json = await sql.getItemById('spell-check');
  // Default to `true` if setting doesn't exist yet
  if (!json) {
    return true;
  }

  return json.value;
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  // Using focus() instead of show() seems to be important on Windows when our window
  //   has been docked using Aero Snap/Snap Assist. A full .show() call here will cause
  //   the window to reposition:
  //   https://github.com/signalapp/Signal-Desktop/issues/1429
  if (mainWindow.isVisible()) {
    mainWindow.focus();
  } else {
    mainWindow.show();
  }

  // toggle the visibility of the show/hide tray icon menu entries
  if (tray) {
    tray.updateContextMenu();
  }
}

if (!process.mas) {
  console.log('making app single instance');
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // Don't allow second instance if we are in prod
    if (appInstance === 0) {
      console.log('quitting; we are the second instance');
      app.exit();
    }
  } else {
    app.on('second-instance', () => {
      // Someone tried to run a second instance, we should focus our window
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }

        showWindow();
      }
      return true;
    });
  }
}

const windowFromUserConfig = userConfig.get('window');
const windowFromEphemeral = ephemeralConfig.get('window');
let windowConfig = windowFromEphemeral || windowFromUserConfig;
if (windowFromUserConfig) {
  userConfig.set('window', null);
  ephemeralConfig.set('window', windowConfig);
}

const loadLocale = require('./app/locale').load;

// Both of these will be set after app fires the 'ready' event
let logger;
let locale;

function prepareURL(pathSegments, moreKeys) {
  return url.format({
    pathname: path.join.apply(null, pathSegments),
    protocol: 'file:',
    slashes: true,
    query: {
      name: packageJson.productName,
      locale: locale.name,
      version: app.getVersion(),
      commitHash: config.get('commitHash'),
      serverUrl: config.get('serverUrl'),
      localUrl: config.get('localUrl'),
      cdnUrl: config.get('cdnUrl'),
      // one day explain why we need to do this - neuroscr
      seedNodeList: JSON.stringify(config.get('seedNodeList')),
      environment: config.environment,
      node_version: process.versions.node,
      hostname: os.hostname(),
      appInstance: process.env.NODE_APP_INSTANCE,
      proxyUrl: process.env.HTTPS_PROXY || process.env.https_proxy,
      contentProxyUrl: config.contentProxyUrl,
      appStartInitialSpellcheckSetting,
      ...moreKeys,
    },
  });
}

function handleUrl(event, target) {
  event.preventDefault();
  const { protocol } = url.parse(target);
  if (protocol === 'http:' || protocol === 'https:') {
    shell.openExternal(target);
  }
}

function captureClicks(window) {
  window.webContents.on('will-navigate', handleUrl);
  window.webContents.on('new-window', handleUrl);
}

const WINDOW_SIZE = Object.freeze({
  defaultWidth: 880,
  defaultHeight: 820,
  minWidth: 880,
  minHeight: 600,
});

function getWindowSize() {
  const { screen } = electron;
  const screenSize = screen.getPrimaryDisplay().workAreaSize;
  const { minWidth, minHeight, defaultWidth, defaultHeight } = WINDOW_SIZE;
  // Ensure that the screen can fit within the default size
  const width = Math.min(defaultWidth, Math.max(minWidth, screenSize.width));
  const height = Math.min(defaultHeight, Math.max(minHeight, screenSize.height));

  return { width, height, minWidth, minHeight };
}

function isVisible(window, bounds) {
  const boundsX = _.get(bounds, 'x') || 0;
  const boundsY = _.get(bounds, 'y') || 0;
  const boundsWidth = _.get(bounds, 'width') || WINDOW_SIZE.defaultWidth;
  const boundsHeight = _.get(bounds, 'height') || WINDOW_SIZE.defaultHeight;
  const BOUNDS_BUFFER = 100;

  // requiring BOUNDS_BUFFER pixels on the left or right side
  const rightSideClearOfLeftBound = window.x + window.width >= boundsX + BOUNDS_BUFFER;
  const leftSideClearOfRightBound = window.x <= boundsX + boundsWidth - BOUNDS_BUFFER;

  // top can't be offscreen, and must show at least BOUNDS_BUFFER pixels at bottom
  const topClearOfUpperBound = window.y >= boundsY;
  const topClearOfLowerBound = window.y <= boundsY + boundsHeight - BOUNDS_BUFFER;

  return (
    rightSideClearOfLeftBound &&
    leftSideClearOfRightBound &&
    topClearOfUpperBound &&
    topClearOfLowerBound
  );
}

function getStartInTray() {
  const startInTray =
    process.argv.some(arg => arg === '--start-in-tray') || userConfig.get('startInTray');
  const usingTrayIcon = startInTray || process.argv.some(arg => arg === '--use-tray-icon');
  return { usingTrayIcon, startInTray };
}
async function createWindow() {
  const { screen } = electron;
  const { minWidth, minHeight, width, height } = getWindowSize();

  const windowOptions = Object.assign(
    {
      show: true,
      width,
      height,
      minWidth,
      minHeight,
      autoHideMenuBar: false,
      backgroundColor: '#000',
      webPreferences: {
        nodeIntegration: false,
        enableRemoteModule: true,
        nodeIntegrationInWorker: false,
        contextIsolation: false,
        preload: path.join(__dirname, 'preload.js'),
        nativeWindowOpen: true,
        spellcheck: await getSpellCheckSetting(),
      },
      // don't setup icon, the executable one will be used by default
    },
    _.pick(windowConfig, ['maximized', 'autoHideMenuBar', 'width', 'height', 'x', 'y'])
  );

  if (!_.isNumber(windowOptions.width) || windowOptions.width < minWidth) {
    windowOptions.width = Math.max(minWidth, width);
  }
  if (!_.isNumber(windowOptions.height) || windowOptions.height < minHeight) {
    windowOptions.height = Math.max(minHeight, height);
  }
  if (!_.isBoolean(windowOptions.maximized)) {
    delete windowOptions.maximized;
  }
  if (!_.isBoolean(windowOptions.autoHideMenuBar)) {
    delete windowOptions.autoHideMenuBar;
  }

  const visibleOnAnyScreen = _.some(screen.getAllDisplays(), display => {
    if (!_.isNumber(windowOptions.x) || !_.isNumber(windowOptions.y)) {
      return false;
    }

    return isVisible(windowOptions, _.get(display, 'bounds'));
  });
  if (!visibleOnAnyScreen) {
    console.log('Location reset needed');
    delete windowOptions.x;
    delete windowOptions.y;
  }

  if (windowOptions.fullscreen === false) {
    delete windowOptions.fullscreen;
  }

  logger.info('Initializing BrowserWindow config: %s', JSON.stringify(windowOptions));

  // Create the browser window.
  mainWindow = new BrowserWindow(windowOptions);
  setupSpellChecker(mainWindow, locale.messages);

  electronLocalshortcut.register(mainWindow, 'F5', () => {
    mainWindow.reload();
  });
  electronLocalshortcut.register(mainWindow, 'CommandOrControl+R', () => {
    mainWindow.reload();
  });

  function captureAndSaveWindowStats() {
    if (!mainWindow) {
      return;
    }

    const size = mainWindow.getSize();
    const position = mainWindow.getPosition();

    // so if we need to recreate the window, we have the most recent settings
    windowConfig = {
      maximized: mainWindow.isMaximized(),
      autoHideMenuBar: mainWindow.isMenuBarAutoHide(),
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1],
    };

    if (mainWindow.isFullScreen()) {
      // Only include this property if true, because when explicitly set to
      // false the fullscreen button will be disabled on osx
      windowConfig.fullscreen = true;
    }

    logger.info('Updating BrowserWindow config: %s', JSON.stringify(windowConfig));
    ephemeralConfig.set('window', windowConfig);
  }

  const debouncedCaptureStats = _.debounce(captureAndSaveWindowStats, 500);
  mainWindow.on('resize', debouncedCaptureStats);
  mainWindow.on('move', debouncedCaptureStats);

  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
    if (passwordWindow) {
      passwordWindow.close();
      passwordWindow = null;
    }
  });

  mainWindow.loadURL(prepareURL([__dirname, 'background.html']));

  if (config.get('openDevTools')) {
    // Open the DevTools.
    mainWindow.webContents.openDevTools({
      mode: 'bottom',
    });
  }

  captureClicks(mainWindow);

  // Emitted when the window is about to be closed.
  // Note: We do most of our shutdown logic here because all windows are closed by
  //   Electron before the app quits.
  mainWindow.on('close', async e => {
    console.log('close event', {
      readyForShutdown: mainWindow ? mainWindow.readyForShutdown : null,
      shouldQuit: windowState.shouldQuit(),
    });
    // If the application is terminating, just do the default
    if (mainWindow.readyForShutdown && windowState.shouldQuit()) {
      return;
    }

    // Prevent the shutdown
    e.preventDefault();
    mainWindow.hide();

    // On Mac, or on other platforms when the tray icon is in use, the window
    // should be only hidden, not closed, when the user clicks the close button
    if (
      !windowState.shouldQuit() &&
      (getStartInTray().usingTrayIcon || process.platform === 'darwin')
    ) {
      // toggle the visibility of the show/hide tray icon menu entries
      if (tray) {
        tray.updateContextMenu();
      }

      return;
    }

    await requestShutdown();
    if (mainWindow) {
      mainWindow.readyForShutdown = true;
    }
    app.quit();
  });

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });
}

ipc.on('show-window', () => {
  showWindow();
});

let isReadyForUpdates = false;
async function readyForUpdates() {
  if (isReadyForUpdates) {
    return;
  }

  isReadyForUpdates = true;

  // disable for now
  /*
  // First, install requested sticker pack
  const incomingUrl = getIncomingUrl(process.argv);
  if (incomingUrl) {
    handleSgnlLink(incomingUrl);
  }
  */

  // Second, start checking for app updates
  try {
    await updater.start(getMainWindow, userConfig, locale.messages, logger);
  } catch (error) {
    const log = logger || console;
    log.error('Error starting update checks:', error && error.stack ? error.stack : error);
  }
}
ipc.once('ready-for-updates', readyForUpdates);

// Forcefully call readyForUpdates after 10 minutes.
// This ensures we start the updater.
const TEN_MINUTES = 10 * 60 * 1000;
setTimeout(readyForUpdates, TEN_MINUTES);

function openReleaseNotes() {
  shell.openExternal(
    `https://github.com/oxen-io/session-desktop/releases/tag/v${app.getVersion()}`
  );
}

function openNewBugForm() {
  shell.openExternal('https://github.com/oxen-io/session-desktop/issues/new');
}

function openSupportPage() {
  shell.openExternal('https://docs.oxen.io/products-built-on-oxen/session');
}

let passwordWindow;
function showPasswordWindow() {
  if (passwordWindow) {
    passwordWindow.show();
    return;
  }
  const { minWidth, minHeight, width, height } = getWindowSize();
  const windowOptions = {
    show: true, // allow to start minimised in tray
    width,
    height,
    minWidth,
    minHeight,
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      enableRemoteModule: true,
      nodeIntegrationInWorker: false,
      contextIsolation: false,

      // sandbox: true,
      preload: path.join(__dirname, 'password_preload.js'),
      nativeWindowOpen: true,
    },
    // don't setup icon, the executable one will be used by default
  };

  passwordWindow = new BrowserWindow(windowOptions);

  passwordWindow.loadURL(prepareURL([__dirname, 'password.html']));

  captureClicks(passwordWindow);

  passwordWindow.on('close', e => {
    // If the application is terminating, just do the default
    if (windowState.shouldQuit()) {
      return;
    }

    // Prevent the shutdown
    e.preventDefault();
    passwordWindow.hide();

    // On Mac, or on other platforms when the tray icon is in use, the window
    // should be only hidden, not closed, when the user clicks the close button
    if (
      !windowState.shouldQuit() &&
      (getStartInTray().usingTrayIcon || process.platform === 'darwin')
    ) {
      // toggle the visibility of the show/hide tray icon menu entries
      if (tray) {
        tray.updateContextMenu();
      }

      return;
    }

    passwordWindow.readyForShutdown = true;

    // Quit the app if we don't have a main window
    if (!mainWindow) {
      app.quit();
    }
  });

  passwordWindow.on('closed', () => {
    passwordWindow = null;
  });
}

let aboutWindow;
function showAbout() {
  if (aboutWindow) {
    aboutWindow.show();
    return;
  }

  const options = {
    width: 500,
    height: 400,
    resizable: false,
    title: locale.messages.about,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'about_preload.js'),
      nativeWindowOpen: true,
    },
    parent: mainWindow,
  };

  aboutWindow = new BrowserWindow(options);

  captureClicks(aboutWindow);

  aboutWindow.loadURL(prepareURL([__dirname, 'about.html']));

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });
}

let debugLogWindow;
async function showDebugLogWindow() {
  if (debugLogWindow) {
    debugLogWindow.show();
    return;
  }

  const theme = await getThemeFromMainWindow();
  const size = mainWindow.getSize();
  const options = {
    width: Math.max(size[0] - 100, WINDOW_SIZE.minWidth),
    height: Math.max(size[1] - 100, WINDOW_SIZE.minHeight),
    resizable: false,
    title: locale.messages.debugLog,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    show: false,
    modal: true,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'debug_log_preload.js'),
      nativeWindowOpen: true,
    },
    parent: mainWindow,
  };

  debugLogWindow = new BrowserWindow(options);

  captureClicks(debugLogWindow);

  debugLogWindow.loadURL(prepareURL([__dirname, 'debug_log.html'], { theme }));

  debugLogWindow.on('closed', () => {
    debugLogWindow = null;
  });

  debugLogWindow.once('ready-to-show', () => {
    debugLogWindow.show();
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
let ready = false;
app.on('ready', async () => {
  const userDataPath = await getRealPath(app.getPath('userData'));
  const installPath = await getRealPath(app.getAppPath());

  installFileHandler({
    protocol: electronProtocol,
    userDataPath,
    installPath,
    isWindows: process.platform === 'win32',
  });

  installWebHandler({
    protocol: electronProtocol,
  });

  installPermissionsHandler({ session, userConfig });

  await logging.initialize();
  logger = logging.getLogger();
  logger.info('app ready');
  logger.info(`starting version ${packageJson.version}`);
  if (!locale) {
    const appLocale = app.getLocale() || 'en';
    locale = loadLocale({ appLocale, logger });
  }

  const key = getDefaultSQLKey();

  // Try to show the main window with the default key
  // If that fails then show the password window
  const dbHasPassword = userConfig.get('dbHasPassword');
  if (dbHasPassword) {
    showPasswordWindow();
  } else {
    await showMainWindow(key);
  }
});

function getDefaultSQLKey() {
  let key = userConfig.get('key');
  if (!key) {
    console.log('key/initialize: Generating new encryption key, since we did not find it on disk');
    // https://www.zetetic.net/sqlcipher/sqlcipher-api/#key
    key = crypto.randomBytes(32).toString('hex');
    userConfig.set('key', key);
  }

  return key;
}

async function removeDB() {
  // this don't remove attachments and stuff like that...
  const userDir = await getRealPath(app.getPath('userData'));
  await sql.removeDB(userDir);

  try {
    console.error('Remove DB: removing.', userDir);

    userConfig.remove();
    ephemeralConfig.remove();
  } catch (e) {
    console.error('Remove DB: Failed to remove configs.', e);
  }
}

async function showMainWindow(sqlKey, passwordAttempt = false) {
  const userDataPath = await getRealPath(app.getPath('userData'));

  sql.initialize({
    configDir: userDataPath,
    key: sqlKey,
    messages: locale.messages,
    passwordAttempt,
  });
  appStartInitialSpellcheckSetting = await getSpellCheckSetting();
  await sqlChannels.initialize();

  async function cleanupOrphanedAttachments() {
    const allAttachments = await attachments.getAllAttachments(userDataPath);
    const orphanedAttachments = await sql.removeKnownAttachments(allAttachments);
    await attachments.deleteAll({
      userDataPath,
      attachments: orphanedAttachments,
    });
  }

  await attachmentChannel.initialize({
    configDir: userDataPath,
    cleanupOrphanedAttachments,
  });

  ready = true;

  await createWindow();

  if (getStartInTray().usingTrayIcon) {
    tray = createTrayIcon(getMainWindow, locale.messages);
  }

  setupMenu();

  // Check updates
  readyForUpdates();
}

function setupMenu(options) {
  const { platform } = process;
  const menuOptions = Object.assign({}, options, {
    development,
    showDebugLog: showDebugLogWindow,
    showWindow,
    showAbout,
    openReleaseNotes,
    openNewBugForm,
    openSupportPage,
    platform,
  });
  const template = createTemplate(menuOptions, locale.messages);
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function requestShutdown() {
  if (!mainWindow || !mainWindow.webContents) {
    return;
  }

  console.log('requestShutdown: Requesting close of mainWindow...');
  const request = new Promise((resolve, reject) => {
    ipc.once('now-ready-for-shutdown', (_event, error) => {
      console.log('requestShutdown: Response received');

      if (error) {
        return reject(error);
      }

      return resolve();
    });
    mainWindow.webContents.send('get-ready-for-shutdown');

    // We'll wait two minutes, then force the app to go down. This can happen if someone
    //   exits the app before we've set everything up in preload() (so the browser isn't
    //   yet listening for these events), or if there are a whole lot of stacked-up tasks.
    // Note: two minutes is also our timeout for SQL tasks in data.ts in the browser.
    setTimeout(() => {
      console.log('requestShutdown: Response never received; forcing shutdown.');
      resolve();
    }, 2 * 60 * 1000);
  });

  try {
    await request;
  } catch (error) {
    console.log('requestShutdown error:', error && error.stack ? error.stack : error);
  }
}

app.on('before-quit', () => {
  console.log('before-quit event', {
    readyForShutdown: mainWindow ? mainWindow.readyForShutdown : null,
    shouldQuit: windowState.shouldQuit(),
  });

  if (tray) {
    tray.destroy();
  }

  windowState.markShouldQuit();
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!ready) {
    return;
  }

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

// Defense in depth. We never intend to open webviews or windows. Prevent it completely.
app.on('web-contents-created', (createEvent, contents) => {
  contents.on('will-attach-webview', attachEvent => {
    attachEvent.preventDefault();
  });
  contents.on('new-window', newEvent => {
    newEvent.preventDefault();
  });
});

// Ingested in preload.js via a sendSync call
ipc.on('locale-data', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = locale.messages;
});

ipc.on('add-setup-menu-items', () => {
  setupMenu({
    includeSetup: false,
  });
});

ipc.on('draw-attention', () => {
  if (!mainWindow) {
    return;
  }
  if (process.platform === 'win32') {
    mainWindow.flashFrame(true);
  }
});

ipc.on('restart', () => {
  app.relaunch();
  app.quit();
});

ipc.on('resetDatabase', async () => {
  await removeDB();
  app.relaunch();
  app.quit();
});

ipc.on('set-auto-hide-menu-bar', (event, autoHide) => {
  if (mainWindow) {
    mainWindow.setAutoHideMenuBar(autoHide);
  }
});

ipc.on('set-menu-bar-visibility', (event, visibility) => {
  if (mainWindow) {
    mainWindow.setMenuBarVisibility(visibility);
  }
});

ipc.on('close-about', () => {
  if (aboutWindow) {
    aboutWindow.close();
  }
});

// Password screen related IPC calls
ipc.on('password-window-login', async (event, passPhrase) => {
  const sendResponse = e => event.sender.send('password-window-login-response', e);

  try {
    const passwordAttempt = true;
    await showMainWindow(passPhrase, passwordAttempt);
    sendResponse();
  } catch (e) {
    const localisedError = locale.messages.invalidPassword;
    sendResponse(localisedError || 'Invalid password');
  }
});
ipc.on('start-in-tray-on-start', async (event, newValue) => {
  try {
    userConfig.set('startInTray', newValue);
    if (newValue) {
      if (!tray) {
        tray = createTrayIcon(getMainWindow, locale.messages);
      }
    } else {
      // destroy is not working for a lot of desktop env. So for simplicity, we don't destroy it here but just
      // show a toast to explain to the user that he needs to restart
      // tray.destroy();
      // tray = null;
    }
    event.sender.send('start-in-tray-on-start-response', null);
  } catch (e) {
    event.sender.send('start-in-tray-on-start-response', e);
  }
});

ipc.on('get-start-in-tray', async (event, newValue) => {
  try {
    const val = userConfig.get('startInTray', newValue);
    event.sender.send('get-start-in-tray-response', val);
  } catch (e) {
    event.sender.send('get-start-in-tray-response', false);
  }
});

ipc.on('set-password', async (event, passPhrase, oldPhrase) => {
  const sendResponse = e => event.sender.send('set-password-response', e);

  try {
    // Check if the hash we have stored matches the hash of the old passphrase.
    const hash = sql.getPasswordHash();

    const hashMatches = oldPhrase && passwordUtil.matchesHash(oldPhrase, hash);
    if (hash && !hashMatches) {
      const incorrectOldPassword = locale.messages.invalidOldPassword;
      sendResponse(
        incorrectOldPassword || 'Failed to set password: Old password provided is invalid'
      );
      return;
    }

    if (_.isEmpty(passPhrase)) {
      const defaultKey = getDefaultSQLKey();
      sql.setSQLPassword(defaultKey);
      sql.removePasswordHash();
      userConfig.set('dbHasPassword', false);
    } else {
      sql.setSQLPassword(passPhrase);
      const newHash = passwordUtil.generateHash(passPhrase);
      sql.savePasswordHash(newHash);
      userConfig.set('dbHasPassword', true);
    }

    sendResponse();
  } catch (e) {
    const localisedError = locale.messages.setPasswordFail;
    sendResponse(localisedError || 'Failed to set password');
  }
});

// Debug Log-related IPC calls

ipc.on('show-debug-log', showDebugLogWindow);
ipc.on('close-debug-log', () => {
  if (debugLogWindow) {
    debugLogWindow.close();
  }
});
ipc.on('save-debug-log', (_event, logText) => {
  const osSpecificDesktopFolder = app.getPath('desktop');
  console.info(`Trying to save logs to log Desktop ${osSpecificDesktopFolder}`);

  const outputPath = path.join(osSpecificDesktopFolder, `session_debug_${Date.now()}.log`);
  fs.writeFile(outputPath, logText, err => {
    if (err) {
      console.error(`Error saving debug log to ${outputPath}`);
      return;
    }
    console.info(`Saved log - ${outputPath}`);
  });
});

// This should be called with an ipc sendSync
ipc.on('get-media-permissions', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = userConfig.get('mediaPermissions') || false;
});
ipc.on('set-media-permissions', (event, value) => {
  userConfig.set('mediaPermissions', value);

  // We reinstall permissions handler to ensure that a revoked permission takes effect
  installPermissionsHandler({ session, userConfig });

  event.sender.send('set-success-media-permissions', null);
});

// This should be called with an ipc sendSync
ipc.on('get-call-media-permissions', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = userConfig.get('callMediaPermissions') || false;
});
ipc.on('set-call-media-permissions', (event, value) => {
  userConfig.set('callMediaPermissions', value);

  // We reinstall permissions handler to ensure that a revoked permission takes effect
  installPermissionsHandler({ session, userConfig });

  event.sender.send('set-success-call-media-permissions', null);
});

// Loki - Auto updating
ipc.on('get-auto-update-setting', event => {
  const configValue = userConfig.get('autoUpdate');
  // eslint-disable-next-line no-param-reassign
  event.returnValue = typeof configValue !== 'boolean' ? true : configValue;
});

ipc.on('set-auto-update-setting', (event, enabled) => {
  userConfig.set('autoUpdate', !!enabled);

  if (enabled) {
    readyForUpdates();
  } else {
    updater.stop();
    isReadyForUpdates = false;
  }
});

function getThemeFromMainWindow() {
  return new Promise(resolve => {
    ipc.once('get-success-theme-setting', (_event, value) => resolve(value));
    mainWindow.webContents.send('get-theme-setting');
  });
}

function askForMediaAccess() {
  // Microphone part
  let status = systemPreferences.getMediaAccessStatus('microphone');
  if (status !== 'granted') {
    systemPreferences.askForMediaAccess('microphone');
  }
  // Camera part
  status = systemPreferences.getMediaAccessStatus('camera');
  if (status !== 'granted') {
    systemPreferences.askForMediaAccess('camera');
  }
}

ipc.on('media-access', () => {
  askForMediaAccess();
});
