/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Entry point: registers the page actor and starts the MCP server when
// `zen.mcp.enabled` is set. Call init() once, after the first browser window
// has finished its delayed startup.

import { ACTOR_NAME } from "./ZenMcpTools.sys.mjs";
import { gZenMcpServer } from "./ZenMcpServer.sys.mjs";

let initialized = false;

export const ZenMcp = {
  /**
   * @param {object} [options]
   * @param {string} [options.childModuleURI] - Where content processes load
   *   the page actor from. Defaults to next to this module; a loader running
   *   the modules from outside the app (dev) must point it somewhere the
   *   content sandbox can read.
   */
  init({ childModuleURI } = {}) {
    if (initialized) {
      return;
    }
    initialized = true;
    ChromeUtils.registerWindowActor(ACTOR_NAME, {
      parent: {
        esModuleURI: new URL("ZenMcpParent.sys.mjs", import.meta.url).href,
      },
      child: {
        esModuleURI:
          childModuleURI ??
          new URL("ZenMcpChild.sys.mjs", import.meta.url).href,
      },
      // Web pages only.
      matches: ["http://*/*", "https://*/*", "file:///*"],
      allFrames: false,
      // The child runs in web content processes. The parent has no message
      // handlers, so a compromised content process gains nothing from it.
      safeForUntrustedWebProcess: true,
    });
    gZenMcpServer.init();
  },

  get server() {
    return gZenMcpServer;
  },
};
