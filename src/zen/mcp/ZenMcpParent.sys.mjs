/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of the ZenMcp window actor; the MCP tools call sendQuery() on it
// and the work happens in ZenMcpChild, inside the page's content process.
export class ZenMcpParent extends JSWindowActorParent {}
