/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tool definitions for the Zen MCP server. Each tool: { name, description,
// inputSchema, annotations?, run(args) }. run() returns JSON-able data, or
// { __mcpContent: [...] } for non-text content (images).

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  gZenSpaceRoutingManager:
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs",
});

Cu.importGlobalProperties(["fetch"]);

const ACTOR_NAME = "ZenMcp";
const MAX_LIST = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function browserWindows() {
  return lazy.BrowserWindowTracker.orderedWindows.filter(
    win => !win.closed && win.gBrowser
  );
}

function topWindow() {
  const win = browserWindows()[0];
  if (!win) {
    throw new Error("No Zen window is open.");
  }
  return win;
}

const tabIds = new WeakMap();
let nextTabId = 1;

/**
 * Session-stable id for a tab (browserId is 0 for tabs that were never loaded).
 *
 * @param {Element} tab - The tab
 * @returns {number} The id
 */
function tabId(tab) {
  let id = tabIds.get(tab);
  if (!id) {
    id = nextTabId++;
    tabIds.set(tab, id);
  }
  return id;
}

function isRealTab(tab) {
  return !tab.hasAttribute("zen-empty-tab") && !tab.closing;
}

// gBrowser.tabs only covers the active space; Zen keeps every space's tabs here.
function allTabs(win) {
  return Array.from(win.gZenWorkspaces.allStoredTabs).filter(isRealTab);
}

function tabUrl(tab) {
  const spec = tab.linkedBrowser?.currentURI?.spec;
  if (spec && spec !== "about:blank") {
    return spec;
  }
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    const entry = state.entries?.[(state.index || 1) - 1];
    return entry?.url ?? spec ?? null;
  } catch {
    return spec ?? null;
  }
}

function spaceName(win, uuid) {
  return uuid ? win.gZenWorkspaces.getWorkspaceFromId(uuid)?.name : undefined;
}

function containerName(userContextId) {
  if (!userContextId) {
    return null;
  }
  return lazy.ContextualIdentityService.getUserContextLabel(userContextId);
}

function tabInfo(tab, win) {
  const space = tab.getAttribute("zen-workspace-id") || null;
  return {
    id: tabId(tab),
    window: browserWindows().indexOf(win),
    title: tab.label,
    url: tabUrl(tab),
    active: tab.selected,
    pinned: tab.pinned,
    essential: tab.hasAttribute("zen-essential"),
    space,
    spaceName: spaceName(win, space),
    container: tab.userContextId || 0,
    containerName: containerName(tab.userContextId),
    unloaded: tab.hasAttribute("pending"),
  };
}

/**
 * Finds a tab by id, or the selected tab of the front window.
 *
 * @param {number} [id] - Tab id from tabs_list
 * @returns {{tab: Element, win: Window}} The tab and its window
 */
function findTab(id) {
  if (id === undefined || id === null) {
    const win = topWindow();
    return { tab: win.gBrowser.selectedTab, win };
  }
  for (const win of browserWindows()) {
    for (const tab of allTabs(win)) {
      if (tabIds.get(tab) === id) {
        return { tab, win };
      }
    }
  }
  throw new Error(`No tab with id ${id}. Call tabs_list for current ids.`);
}

function spaceInfo(win, space) {
  return {
    id: space.uuid,
    name: space.name,
    icon: space.icon || null,
    container: space.containerTabId || 0,
    containerName: containerName(space.containerTabId),
    active: space.uuid === win.gZenWorkspaces.activeWorkspace,
  };
}

/**
 * Resolves a space by uuid (with or without braces) or by name.
 *
 * @param {Window} win - Browser window
 * @param {string} ref - Space uuid or name
 * @returns {object} The workspace data
 */
function resolveSpace(win, ref) {
  const spaces = win.gZenWorkspaces.getWorkspaces();
  const wanted = String(ref).trim();
  const braced = wanted.startsWith("{") ? wanted : `{${wanted}}`;
  const space =
    spaces.find(s => s.uuid === wanted || s.uuid === braced) ??
    spaces.find(s => s.name.toLowerCase() === wanted.toLowerCase());
  if (!space) {
    throw new Error(
      `No space "${ref}". Spaces: ${spaces.map(s => s.name).join(", ")}`
    );
  }
  return space;
}

async function activateTab(tab, win) {
  const space = tab.getAttribute("zen-workspace-id");
  if (
    space &&
    !tab.hasAttribute("zen-essential") &&
    space !== win.gZenWorkspaces.activeWorkspace
  ) {
    await win.gZenWorkspaces.changeWorkspaceWithID(space);
  }
  win.gBrowser.selectedTab = tab;
  win.focus();
}

function systemPrincipal() {
  return Services.scriptSecurityManager.getSystemPrincipal();
}

function prefInfo(name) {
  const type = Services.prefs.getPrefType(name);
  if (type === Services.prefs.PREF_INVALID) {
    return { name, exists: false };
  }
  let value;
  let typeName;
  switch (type) {
    case Services.prefs.PREF_BOOL:
      value = Services.prefs.getBoolPref(name);
      typeName = "bool";
      break;
    case Services.prefs.PREF_INT:
      value = Services.prefs.getIntPref(name);
      typeName = "int";
      break;
    default:
      value = Services.prefs.getStringPref(name, "");
      typeName = "string";
  }
  return {
    name,
    type: typeName,
    value,
    userSet: Services.prefs.prefHasUserValue(name),
    locked: Services.prefs.prefIsLocked(name),
  };
}

function addonInfo(addon) {
  return {
    id: addon.id,
    name: addon.name,
    version: addon.version,
    type: addon.type,
    enabled: addon.isActive,
    userDisabled: addon.userDisabled,
    builtin: addon.isBuiltin,
    system: addon.isSystem,
    description: addon.description,
  };
}

async function getAddon(id) {
  const addon = await lazy.AddonManager.getAddonByID(id);
  if (!addon) {
    throw new Error(`No extension with id ${id}. Call extensions_list.`);
  }
  return addon;
}

/**
 * The tab whose page is actually loaded: with window sync, every window has a
 * copy of a tab (same element id) but usually only one copy is loaded.
 *
 * @param {Element} tab - The tab
 * @returns {Element} The tab or its loaded synced copy
 */
function loadedTab(tab) {
  if (tab.linkedBrowser?.browsingContext?.currentWindowGlobal || !tab.id) {
    return tab;
  }
  for (const win of browserWindows()) {
    const twin = allTabs(win).find(
      other =>
        other.id === tab.id &&
        other.linkedBrowser?.browsingContext?.currentWindowGlobal
    );
    if (twin) {
      return twin;
    }
  }
  return tab;
}

function windowGlobalOf(tab) {
  const windowGlobal =
    loadedTab(tab).linkedBrowser?.browsingContext?.currentWindowGlobal;
  if (!windowGlobal) {
    throw new Error(
      "The tab has no loaded page (it is unloaded): tab_activate it first."
    );
  }
  return windowGlobal;
}

/**
 * Sends a query to the page actor, failing instead of hanging forever.
 *
 * @param {Element} tab - The tab
 * @param {string} name - Message name
 * @param {object} data - Message data
 * @param {number} [timeoutMs] - Give up after this long
 * @returns {Promise<*>} The child's reply
 */
async function queryPage(tab, name, data, timeoutMs = 15000) {
  const windowGlobal = windowGlobalOf(tab);
  let actor;
  try {
    actor = windowGlobal.getActor(ACTOR_NAME);
  } catch (error) {
    throw new Error(
      `This page cannot be scripted (only http, https and file pages): ${error.message}`
    );
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The page did not answer within ${timeoutMs} ms.`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([actor.sendQuery(name, data), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function iso(microseconds) {
  return microseconds ? new Date(microseconds / 1000).toISOString() : null;
}

const tabIdSchema = {
  type: "integer",
  description: "Tab id from tabs_list. Omit for the active tab.",
};
const spaceSchema = {
  type: "string",
  description: "Space name or uuid (see spaces_list).",
};

function tool(name, description, properties, run, extra = {}) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required: extra.required ?? [],
      additionalProperties: false,
    },
    annotations: extra.annotations,
    run,
  };
}

const READ_ONLY = { readOnlyHint: true };
const DESTRUCTIVE = { destructiveHint: true };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const TOOLS = [
  // --- Windows & tabs ------------------------------------------------------
  tool(
    "windows_list",
    "List browser windows with their active space and tab count.",
    {},
    () =>
      browserWindows().map((win, index) => ({
        window: index,
        title: win.document.title,
        activeSpace: spaceName(win, win.gZenWorkspaces.activeWorkspace),
        tabs: allTabs(win).length,
        private: win.document.documentElement.hasAttribute("privatebrowsingmode"),
      })),
    { annotations: READ_ONLY }
  ),

  tool(
    "tabs_list",
    "List open tabs (all windows) with id, url, title, space, container, pinned/essential state. Use the id with other tab/page tools.",
    {
      space: { ...spaceSchema, description: "Only tabs of this space." },
      window: { type: "integer", description: "Only this window index." },
    },
    ({ space, window }) => {
      const result = [];
      browserWindows().forEach((win, index) => {
        if (window !== undefined && window !== index) {
          return;
        }
        const spaceId = space ? resolveSpace(win, space).uuid : null;
        for (const tab of allTabs(win)) {
          if (spaceId && tab.getAttribute("zen-workspace-id") !== spaceId) {
            continue;
          }
          result.push(tabInfo(tab, win));
        }
      });
      return result;
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "tab_open",
    "Open a URL in a new tab. Optionally in a given space (and its container) or container; switches to it unless background is true.",
    {
      url: { type: "string" },
      space: spaceSchema,
      container: {
        type: "integer",
        description: "Container id (containers_list). Default: the space's container.",
      },
      background: { type: "boolean", description: "Do not switch to the tab." },
    },
    async ({ url, space, container, background }) => {
      const win = topWindow();
      const target = space ? resolveSpace(win, space) : null;
      const activeSpace = win.gZenWorkspaces.getActiveWorkspaceFromCache();
      const userContextId =
        container ?? target?.containerTabId ?? activeSpace?.containerTabId ?? 0;
      const tab = win.gBrowser.addTab(url, {
        triggeringPrincipal: systemPrincipal(),
        userContextId,
        inBackground: true,
        skipAnimation: true,
      });
      if (target) {
        win.gZenWorkspaces.moveTabToWorkspace(tab, target.uuid);
      }
      if (!background) {
        await activateTab(tab, win);
      }
      return tabInfo(tab, win);
    },
    { required: ["url"] }
  ),

  tool(
    "tab_activate",
    "Switch to a tab (and to its space).",
    { id: tabIdSchema },
    async ({ id }) => {
      const { tab, win } = findTab(id);
      await activateTab(tab, win);
      return tabInfo(tab, win);
    },
    { required: ["id"] }
  ),

  tool(
    "tab_close",
    "Close tabs.",
    { ids: { type: "array", items: { type: "integer" } } },
    ({ ids }) => {
      for (const id of ids) {
        const { tab, win } = findTab(id);
        win.gBrowser.removeTab(tab, { animate: false });
      }
      return { closed: ids };
    },
    { required: ["ids"], annotations: DESTRUCTIVE }
  ),

  tool(
    "tab_navigate",
    "Load a URL in a tab, or go back/forward/reload.",
    {
      id: tabIdSchema,
      url: { type: "string" },
      action: { type: "string", enum: ["back", "forward", "reload"] },
    },
    ({ id, url, action }) => {
      const { tab, win } = findTab(id);
      const browser = tab.linkedBrowser;
      if (url) {
        browser.fixupAndLoadURIString(url, {
          triggeringPrincipal: systemPrincipal(),
        });
      } else if (action === "back") {
        browser.goBack();
      } else if (action === "forward") {
        browser.goForward();
      } else if (action === "reload") {
        browser.reload();
      } else {
        throw new Error("Pass url or action.");
      }
      return tabInfo(tab, win);
    }
  ),

  tool(
    "tab_update",
    "Pin/unpin a tab, add/remove it from essentials, or move it to another space.",
    {
      id: tabIdSchema,
      pinned: { type: "boolean" },
      essential: { type: "boolean" },
      space: { ...spaceSchema, description: "Move the tab to this space." },
    },
    ({ id, pinned, essential, space }) => {
      const { tab, win } = findTab(id);
      if (space) {
        win.gZenWorkspaces.moveTabToWorkspace(tab, resolveSpace(win, space).uuid);
      }
      if (essential === true) {
        win.gZenPinnedTabManager.addToEssentials(tab);
      } else if (essential === false && tab.hasAttribute("zen-essential")) {
        win.gZenPinnedTabManager.removeEssentials(tab);
      }
      if (pinned === true && !tab.pinned) {
        win.gBrowser.pinTab(tab);
      } else if (pinned === false && tab.pinned) {
        win.gBrowser.unpinTab(tab);
      }
      return tabInfo(tab, win);
    }
  ),

  // --- Spaces ---------------------------------------------------------------
  tool(
    "spaces_list",
    "List spaces (workspaces) with their default container and which one is active.",
    {},
    () => {
      const win = topWindow();
      return win.gZenWorkspaces
        .getWorkspaces()
        .map(space => spaceInfo(win, space));
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "space_switch",
    "Switch the front window to a space.",
    { space: spaceSchema },
    async ({ space }) => {
      const win = topWindow();
      const target = resolveSpace(win, space);
      await win.gZenWorkspaces.changeWorkspaceWithID(target.uuid);
      return spaceInfo(win, target);
    },
    { required: ["space"] }
  ),

  tool(
    "space_create",
    "Create a space. icon: an emoji, or a Zen icon URL like chrome://browser/skin/zen-icons/selectable/heart.svg.",
    {
      name: { type: "string" },
      icon: { type: "string" },
      container: { type: "integer", description: "Default container id (0 = none)." },
      switchTo: { type: "boolean" },
    },
    async ({ name, icon, container = 0, switchTo = false }) => {
      const win = topWindow();
      const created = await win.gZenWorkspaces.createAndSaveWorkspace(
        name,
        icon,
        !switchTo,
        container
      );
      if (!created) {
        throw new Error("Spaces are disabled in this window.");
      }
      return spaceInfo(win, resolveSpace(win, created.uuid));
    },
    { required: ["name"] }
  ),

  tool(
    "space_update",
    "Rename a space, change its icon, or its default container.",
    {
      space: spaceSchema,
      name: { type: "string" },
      icon: { type: "string" },
      container: { type: "integer" },
    },
    ({ space, name, icon, container }) => {
      const win = topWindow();
      const updated = { ...resolveSpace(win, space) };
      if (name !== undefined) {
        updated.name = name;
      }
      if (icon !== undefined) {
        updated.icon = icon;
      }
      if (container !== undefined) {
        updated.containerTabId = container;
      }
      win.gZenWorkspaces.saveWorkspace(updated);
      return spaceInfo(win, resolveSpace(win, updated.uuid));
    },
    { required: ["space"] }
  ),

  tool(
    "space_delete",
    "Delete a space AND close all its tabs.",
    { space: spaceSchema },
    async ({ space }) => {
      const win = topWindow();
      const target = resolveSpace(win, space);
      await win.gZenWorkspaces.removeWorkspace(target.uuid);
      return { deleted: target.name };
    },
    { required: ["space"], annotations: DESTRUCTIVE }
  ),

  // --- Space routing --------------------------------------------------------
  tool(
    "routing_list",
    "List space routing rules (URL -> space). First matching rule wins; also applies to links opened from other apps.",
    {},
    () => {
      const win = topWindow();
      const target = id =>
        id === "most-recent-space" ? id : spaceName(win, id) ?? id;
      return {
        defaultExternalRoute: target(
          lazy.gZenSpaceRoutingManager.getDefaultExternalRoute()
        ),
        routes: lazy.gZenSpaceRoutingManager.getAllRoutes().map(route => ({
          id: route.id,
          matchType: route.matchType,
          reference: route.reference,
          openIn: target(route.openIn),
        })),
      };
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "routing_add",
    "Add a space routing rule. matchType: contains (substring), equal-to (normalized URL), regex (JS, case-insensitive).",
    {
      reference: { type: "string" },
      matchType: { type: "string", enum: ["contains", "equal-to", "regex"] },
      space: { ...spaceSchema, description: "Target space, or most-recent-space." },
    },
    ({ reference, matchType = "contains", space }) => {
      const win = topWindow();
      const openIn =
        space === "most-recent-space" ? space : resolveSpace(win, space).uuid;
      const route = lazy.gZenSpaceRoutingManager.createNewRoute();
      Object.assign(route, { reference, matchType, openIn });
      lazy.gZenSpaceRoutingManager.updateRoute(route);
      lazy.gZenSpaceRoutingManager.saveRoutes();
      return route;
    },
    { required: ["reference", "space"] }
  ),

  tool(
    "routing_remove",
    "Remove a space routing rule by id.",
    { id: { type: "string" } },
    ({ id }) => {
      if (!lazy.gZenSpaceRoutingManager.getRoute(id)) {
        throw new Error(`No route ${id}.`);
      }
      lazy.gZenSpaceRoutingManager.removeRoute(id);
      lazy.gZenSpaceRoutingManager.saveRoutes();
      return { removed: id };
    },
    { required: ["id"], annotations: DESTRUCTIVE }
  ),

  tool(
    "routing_set_default",
    "Set where external links that match no rule open: a space, or most-recent-space.",
    { space: spaceSchema },
    ({ space }) => {
      const win = topWindow();
      const target =
        space === "most-recent-space" ? space : resolveSpace(win, space).uuid;
      lazy.gZenSpaceRoutingManager.setDefaultExternalRoute(target);
      lazy.gZenSpaceRoutingManager.saveRoutes();
      return { defaultExternalRoute: space };
    },
    { required: ["space"] }
  ),

  // --- Containers -----------------------------------------------------------
  tool(
    "containers_list",
    "List containers (separate cookie jars). id 0 = no container.",
    {},
    () =>
      lazy.ContextualIdentityService.getPublicIdentities().map(identity => ({
        id: identity.userContextId,
        name: containerName(identity.userContextId),
        icon: identity.icon,
        color: identity.color,
      })),
    { annotations: READ_ONLY }
  ),

  tool(
    "container_create",
    "Create a container.",
    {
      name: { type: "string" },
      icon: {
        type: "string",
        enum: ["fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"],
      },
      color: {
        type: "string",
        enum: ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar"],
      },
    },
    ({ name, icon = "fingerprint", color = "blue" }) => {
      const identity = lazy.ContextualIdentityService.create(name, icon, color);
      return { id: identity.userContextId, name, icon, color };
    },
    { required: ["name"] }
  ),

  tool(
    "container_delete",
    "Delete a container (its cookies and site data are removed too).",
    { id: { type: "integer" } },
    ({ id }) => {
      if (!lazy.ContextualIdentityService.remove(id)) {
        throw new Error(`No container ${id}.`);
      }
      return { deleted: id };
    },
    { required: ["id"], annotations: DESTRUCTIVE }
  ),

  // --- Preferences (about:config) ------------------------------------------
  tool(
    "prefs_get",
    "Read browser settings (about:config prefs) by exact names or by prefix, e.g. prefix \"zen.workspaces.\".",
    {
      names: { type: "array", items: { type: "string" } },
      prefix: { type: "string" },
    },
    ({ names, prefix }) => {
      if (names?.length) {
        return names.map(prefInfo);
      }
      if (prefix === undefined) {
        throw new Error("Pass names or prefix.");
      }
      const children = Services.prefs.getChildList(prefix).sort();
      return {
        total: children.length,
        prefs: children.slice(0, MAX_LIST).map(prefInfo),
      };
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "prefs_set",
    "Change a browser setting (about:config pref). Type follows the existing pref, else the JSON type of value.",
    {
      name: { type: "string" },
      value: { type: ["boolean", "number", "string"] },
    },
    ({ name, value }) => {
      if (Services.prefs.prefIsLocked(name)) {
        throw new Error(`${name} is locked.`);
      }
      const type = Services.prefs.getPrefType(name);
      if (
        type === Services.prefs.PREF_BOOL ||
        (type === Services.prefs.PREF_INVALID && typeof value === "boolean")
      ) {
        Services.prefs.setBoolPref(
          name,
          value === true || value === "true"
        );
      } else if (
        type === Services.prefs.PREF_INT ||
        (type === Services.prefs.PREF_INVALID && Number.isInteger(value))
      ) {
        const number = Number(value);
        if (!Number.isInteger(number)) {
          throw new Error(`${name} needs an integer.`);
        }
        Services.prefs.setIntPref(name, number);
      } else {
        Services.prefs.setStringPref(name, String(value));
      }
      return prefInfo(name);
    },
    { required: ["name", "value"] }
  ),

  tool(
    "prefs_reset",
    "Reset a browser setting to its default.",
    { name: { type: "string" } },
    ({ name }) => {
      Services.prefs.clearUserPref(name);
      return prefInfo(name);
    },
    { required: ["name"] }
  ),

  // --- Extensions -----------------------------------------------------------
  tool(
    "extensions_list",
    "List installed extensions and themes with enabled state.",
    {
      includeBuiltin: {
        type: "boolean",
        description: "Include built-in/system add-ons.",
      },
    },
    async ({ includeBuiltin = false }) => {
      const addons = await lazy.AddonManager.getAddonsByTypes([
        "extension",
        "theme",
      ]);
      return addons
        .filter(addon => includeBuiltin || (!addon.isBuiltin && !addon.isSystem))
        .map(addonInfo);
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "extension_set_enabled",
    "Enable or disable an extension or theme.",
    { id: { type: "string" }, enabled: { type: "boolean" } },
    async ({ id, enabled }) => {
      const addon = await getAddon(id);
      await (enabled ? addon.enable() : addon.disable());
      return addonInfo(await getAddon(id));
    },
    { required: ["id", "enabled"] }
  ),

  tool(
    "extension_install",
    "Install an extension from addons.mozilla.org (slug, e.g. \"ublock-origin\"), an .xpi URL, or a local .xpi path.",
    {
      amoSlug: { type: "string" },
      url: { type: "string" },
      path: { type: "string" },
    },
    async ({ amoSlug, url, path }) => {
      let install;
      if (path) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        install = await lazy.AddonManager.getInstallForFile(file, null, {
          source: "internal",
        });
      } else {
        if (amoSlug) {
          const response = await fetch(
            `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(amoSlug)}/`
          );
          if (!response.ok) {
            throw new Error(`AMO has no add-on "${amoSlug}".`);
          }
          url = (await response.json()).current_version.file.url;
        }
        if (!url) {
          throw new Error("Pass amoSlug, url or path.");
        }
        install = await lazy.AddonManager.getInstallForURL(url, {
          telemetryInfo: { source: "internal" },
        });
      }
      const addon = await install.install();
      return addonInfo(addon);
    }
  ),

  tool(
    "extension_uninstall",
    "Uninstall an extension or theme.",
    { id: { type: "string" } },
    async ({ id }) => {
      const addon = await getAddon(id);
      await addon.uninstall();
      return { uninstalled: id, name: addon.name };
    },
    { required: ["id"], annotations: DESTRUCTIVE }
  ),

  // --- History & bookmarks --------------------------------------------------
  tool(
    "history_search",
    "Search browsing history by URL/title substring (empty query = most recent).",
    {
      query: { type: "string" },
      maxResults: { type: "integer", default: 25 },
    },
    async ({ query = "", maxResults = 25 }) => {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const pattern = `%${query.replace(/[/%_]/g, "/$&")}%`;
      const rows = await db.executeCached(
        `SELECT url, title, visit_count, last_visit_date
           FROM moz_places
          WHERE last_visit_date NOT NULL
            AND (url LIKE :pattern ESCAPE '/' OR title LIKE :pattern ESCAPE '/')
          ORDER BY last_visit_date DESC
          LIMIT :limit`,
        { pattern, limit: Math.min(maxResults, MAX_LIST) }
      );
      return rows.map(row => ({
        url: row.getResultByName("url"),
        title: row.getResultByName("title"),
        visits: row.getResultByName("visit_count"),
        lastVisit: iso(row.getResultByName("last_visit_date")),
      }));
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "history_delete",
    "Remove a URL from browsing history.",
    { url: { type: "string" } },
    async ({ url }) => ({
      url,
      removed: await lazy.PlacesUtils.history.remove(url),
    }),
    { required: ["url"], annotations: DESTRUCTIVE }
  ),

  tool(
    "bookmarks_search",
    "Search bookmarks by title/URL.",
    { query: { type: "string" } },
    async ({ query }) => {
      const results = await lazy.PlacesUtils.bookmarks.search(query);
      return results.slice(0, MAX_LIST).map(bookmark => ({
        guid: bookmark.guid,
        title: bookmark.title,
        url: bookmark.url?.href ?? null,
        parentGuid: bookmark.parentGuid,
      }));
    },
    { required: ["query"], annotations: READ_ONLY }
  ),

  // --- Page content ---------------------------------------------------------
  tool(
    "page_read",
    "Read a tab's page: visible text (default), links, or HTML.",
    {
      id: tabIdSchema,
      format: { type: "string", enum: ["text", "links", "html"] },
      maxLength: { type: "integer", default: 20000 },
    },
    async ({ id, format = "text", maxLength = 20000 }) => {
      const { tab } = findTab(id);
      return queryPage(tab, "read", { format, maxLength });
    },
    { annotations: READ_ONLY }
  ),

  tool(
    "page_eval",
    "Evaluate JavaScript in a tab's page and return the JSON result (promises are awaited, up to timeoutMs).",
    {
      id: tabIdSchema,
      expression: { type: "string" },
      timeoutMs: { type: "integer", default: 15000 },
    },
    async ({ id, expression, timeoutMs = 15000 }) => {
      const { tab } = findTab(id);
      return queryPage(tab, "eval", { expression }, timeoutMs);
    },
    { required: ["expression"] }
  ),

  tool(
    "page_screenshot",
    "Screenshot the visible part of a tab (JPEG). The tab should be the active one in its window.",
    {
      id: tabIdSchema,
      maxWidth: { type: "integer", default: 1280 },
    },
    async ({ id, maxWidth = 1280 }) => {
      const { tab: requested } = findTab(id);
      const tab = loadedTab(requested);
      const win = tab.ownerDocument.defaultView;
      const windowGlobal = windowGlobalOf(tab);
      const { width } = tab.linkedBrowser.getBoundingClientRect();
      const scale = Math.min(1, maxWidth / Math.max(width, 1));
      const bitmap = await windowGlobal.drawSnapshot(
        null,
        scale,
        "rgb(255,255,255)"
      );
      const canvas = win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      const data = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
      return {
        __mcpContent: [{ type: "image", data, mimeType: "image/jpeg" }],
      };
    },
    { annotations: READ_ONLY }
  ),
];

export { ACTOR_NAME };
