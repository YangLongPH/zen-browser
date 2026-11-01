# Zen MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server built into
Zen, so AI agents (Claude Code, Claude Desktop, Cursor, …) can drive the
browser: tabs, spaces, space routing, containers, settings, extensions,
history and page content.

- Transport: Streamable HTTP, JSON responses only (no server-initiated stream).
- Endpoint: `http://127.0.0.1:<zen.mcp.port>/mcp`, loopback only. Requests whose
  `Host` or `Origin` is not loopback are rejected, so web pages cannot reach it.
- Off by default: set `zen.mcp.enabled` to `true` (`zen.mcp.port`, default
  `9020`). `zen.mcp.debug` logs each request to the browser console.

```sh
claude mcp add --transport http --scope user zen-browser http://127.0.0.1:9020/mcp
```

## Tools

| Group | Tools |
| --- | --- |
| Windows & tabs | `windows_list`, `tabs_list`, `tab_open`, `tab_activate`, `tab_close`, `tab_navigate`, `tab_update` (pin, essentials, move to space) |
| Spaces | `spaces_list`, `space_switch`, `space_create`, `space_update`, `space_delete` |
| Space routing | `routing_list`, `routing_add`, `routing_remove`, `routing_set_default` |
| Containers | `containers_list`, `container_create`, `container_delete` |
| Settings | `prefs_get`, `prefs_set`, `prefs_reset` (any about:config pref) |
| Extensions | `extensions_list`, `extension_set_enabled`, `extension_install` (AMO slug, URL or file), `extension_uninstall` |
| History & bookmarks | `history_search`, `history_delete`, `bookmarks_search` |
| Pages | `page_read` (text, links, HTML), `page_eval`, `page_screenshot` |

Tabs are addressed by the session-stable `id` from `tabs_list`; spaces by name
or uuid. With window sync every window holds a copy of each tab; page tools use
whichever copy is loaded.

## Files

- `ZenMcp.sys.mjs`: entry point (`ZenMcp.init()`), registers the page actor and
  starts the server.
- `ZenMcpServer.sys.mjs`: HTTP over `nsIServerSocket` and JSON-RPC dispatch.
- `ZenMcpTools.sys.mjs`: tool definitions.
- `ZenMcpParent.sys.mjs` / `ZenMcpChild.sys.mjs`: `ZenMcp` window actor; the
  child reads and scripts pages in their content process.

## Status

The modules are not wired into the build yet (`moz.build`, components
manifest). Until then they can be loaded into a release Zen at startup through
an unsandboxed autoconfig script that maps `resource://zenmcp/` to this folder
and calls `ZenMcp.init()` after `browser-delayed-startup-finished`. Content
processes cannot read arbitrary paths, so such a loader must copy
`ZenMcpChild.sys.mjs` somewhere the content sandbox can read and pass its URL as
`ZenMcp.init({ childModuleURI })`.
