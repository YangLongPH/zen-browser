/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Built-in MCP server: lets an AI agent drive Zen (tabs, spaces, routing,
// containers, prefs, extensions, history, pages) over the Model Context
// Protocol's Streamable HTTP transport on 127.0.0.1.
//
// Off by default. Enable with `zen.mcp.enabled` (port: `zen.mcp.port`).

import { TOOLS } from "./ZenMcpTools.sys.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PREF_ENABLED = "zen.mcp.enabled";
const PREF_PORT = "zen.mcp.port";
const DEFAULT_PORT = 9020;

const STATUS_TEXT = {
  200: "OK",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  500: "Internal Server Error",
};

function debug(...args) {
  if (Services.prefs.getBoolPref("zen.mcp.debug", false)) {
    console.info("[ZenMcp]", ...args);
  }
}

function concatBytes(chunks, length) {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOfHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 13 &&
      bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Parses an HTTP/1.1 request out of the received bytes.
 *
 * @param {Uint8Array} bytes - Everything received on the connection so far
 * @returns {object|null} The request, or null while it is still incomplete
 */
function parseRequest(bytes) {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd === -1) {
    return null;
  }
  const decoder = new TextDecoder();
  const [requestLine, ...headerLines] = decoder
    .decode(bytes.subarray(0, headerEnd))
    .split("\r\n");
  const [method, target = "/"] = requestLine.split(" ");
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
  }
  const bodyStart = headerEnd + 4;
  const length = parseInt(headers["content-length"] || "0", 10);
  if (bytes.length < bodyStart + length) {
    return null;
  }
  return {
    method,
    path: target.split("?")[0],
    headers,
    body: decoder.decode(bytes.subarray(bodyStart, bodyStart + length)),
  };
}

/** One HTTP request/response on an accepted socket (Connection: close). */
class Connection {
  #transport;
  #input;
  #binaryInput;
  #output;
  #server;
  #chunks = [];
  #length = 0;
  #done = false;

  constructor(transport, server) {
    this.#transport = transport;
    this.#server = server;
    this.#input = transport
      .openInputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncInputStream);
    this.#binaryInput = Cc[
      "@mozilla.org/binaryinputstream;1"
    ].createInstance(Ci.nsIBinaryInputStream);
    this.#binaryInput.setInputStream(this.#input);
    // Unbuffered: a buffered stream is copied to the socket asynchronously, so
    // closing right after writing could drop the response.
    this.#output = transport
      .openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0)
      .QueryInterface(Ci.nsIAsyncOutputStream);
  }

  start() {
    this.#wait();
  }

  #wait() {
    this.#input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  onInputStreamReady() {
    try {
      this.#onReadable();
    } catch (error) {
      console.error("[ZenMcp] Connection error:", error);
      this.#close();
    }
  }

  #onReadable() {
    if (this.#done) {
      return;
    }
    let available;
    try {
      // Throws once the peer has closed the connection.
      available = this.#input.available();
    } catch (error) {
      debug("peer closed before a full request", error.name);
      this.#close();
      return;
    }
    if (!available) {
      // Woken up before any bytes arrived: keep waiting.
      this.#wait();
      return;
    }
    const chunk = Uint8Array.from(this.#binaryInput.readByteArray(available));
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    debug("read", chunk.length, "bytes, total", this.#length);
    if (this.#length > MAX_REQUEST_BYTES) {
      this.#respond(413, {}, "");
      return;
    }
    const request = parseRequest(concatBytes(this.#chunks, this.#length));
    if (!request) {
      this.#wait();
      return;
    }
    debug(request.method, request.path, request.body.slice(0, 120));
    this.#done = true;
    this.#server
      .handle(request)
      .then(
        ({ status, headers = {}, body = "" }) =>
          this.#respond(status, headers, body),
        error => {
          console.error("[ZenMcp] Request failed:", error);
          this.#respond(500, {}, "");
        }
      );
  }

  async #respond(status, headers, body) {
    this.#done = true;
    try {
      const bodyBytes = new TextEncoder().encode(body);
      let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ""}\r\n`;
      const allHeaders = {
        ...headers,
        "Content-Length": String(bodyBytes.length),
        Connection: "close",
      };
      for (const [name, value] of Object.entries(allHeaders)) {
        head += `${name}: ${value}\r\n`;
      }
      head += "\r\n";
      const headBytes = new TextEncoder().encode(head);
      const bytes = concatBytes(
        [headBytes, bodyBytes],
        headBytes.length + bodyBytes.length
      );
      await this.#writeAll(bytes);
      debug("responded", status, bytes.length, "bytes");
    } catch (error) {
      console.error("[ZenMcp] Failed to write response:", error);
    }
    this.#close();
  }

  /**
   * Writes every byte to the non-blocking socket stream, waiting whenever the
   * socket's send buffer is full.
   *
   * @param {Uint8Array} bytes - The full response
   * @returns {Promise<void>} Resolved once all bytes are handed to the socket
   */
  #writeAll(bytes) {
    // nsIOutputStream.write() takes a "binary string": one char per byte.
    let data = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      data += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    let offset = 0;
    return new Promise((resolve, reject) => {
      const pump = () => {
        try {
          while (offset < data.length) {
            let written;
            try {
              written = this.#output.write(
                data.slice(offset),
                data.length - offset
              );
            } catch (error) {
              if (error.result !== Cr.NS_BASE_STREAM_WOULD_BLOCK) {
                throw error;
              }
              written = 0;
            }
            if (!written) {
              this.#output.asyncWait(
                { onOutputStreamReady: pump },
                0,
                0,
                Services.tm.mainThread
              );
              return;
            }
            offset += written;
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      pump();
    });
  }

  #close() {
    this.#done = true;
    this.#server.release(this);
    try {
      // Closing both streams closes the transport once the data is sent.
      this.#output.close();
      this.#input.close();
    } catch {}
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Converts a tool's return value into MCP content blocks.
 *
 * @param {*} value - What the tool returned
 * @returns {Array<object>} MCP content
 */
function toContent(value) {
  if (value?.__mcpContent) {
    return value.__mcpContent;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return [{ type: "text", text }];
}

class nsZenMcpServer {
  #socket = null;
  #port = DEFAULT_PORT;
  // Only JS references keep a pending connection (and its stream callback)
  // alive; without this set the GC can collect it mid-request.
  #connections = new Set();

  release(connection) {
    this.#connections.delete(connection);
  }

  get running() {
    return !!this.#socket;
  }

  get port() {
    return this.#port;
  }

  init() {
    Services.prefs.addObserver(PREF_ENABLED, () => this.#syncWithPref());
    Services.prefs.addObserver(PREF_PORT, () => {
      if (this.running) {
        this.stop();
        this.#syncWithPref();
      }
    });
    this.#syncWithPref();
  }

  #syncWithPref() {
    if (Services.prefs.getBoolPref(PREF_ENABLED, false)) {
      this.start();
    } else {
      this.stop();
    }
  }

  start() {
    if (this.#socket) {
      return;
    }
    this.#port = Services.prefs.getIntPref(PREF_PORT, DEFAULT_PORT);
    try {
      const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
        Ci.nsIServerSocket
      );
      // Loopback only: the server must never be reachable from the network.
      socket.init(this.#port, true, -1);
      socket.asyncListen({
        onSocketAccepted: (_server, transport) => {
          debug("accepted", transport.port);
          const connection = new Connection(transport, this);
          this.#connections.add(connection);
          connection.start();
        },
        onStopListening: () => {},
      });
      this.#socket = socket;
      console.info(`[ZenMcp] Listening on http://127.0.0.1:${this.#port}/mcp`);
    } catch (error) {
      console.error(`[ZenMcp] Could not listen on port ${this.#port}:`, error);
    }
  }

  stop() {
    this.#socket?.close();
    this.#socket = null;
  }

  /**
   * Rejects requests from web pages (DNS rebinding / CSRF): only local MCP
   * clients, which send no Origin or a loopback one, are allowed.
   *
   * @param {object} headers - Lower-cased request headers
   * @returns {boolean} True when the request may proceed
   */
  #isAllowedOrigin(headers) {
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
    if (headers.host && !loopback.test(headers.host)) {
      return false;
    }
    if (headers.origin && headers.origin !== "null") {
      try {
        return loopback.test(new URL(headers.origin).host);
      } catch {
        return false;
      }
    }
    return true;
  }

  async handle(request) {
    if (!this.#isAllowedOrigin(request.headers)) {
      return { status: 403 };
    }
    if (request.path !== "/mcp") {
      return { status: 404 };
    }
    if (request.method === "OPTIONS") {
      return { status: 204, headers: { Allow: "POST" } };
    }
    if (request.method !== "POST") {
      // No server-initiated stream: GET (SSE) and DELETE are not supported.
      return { status: 405, headers: { Allow: "POST" } };
    }

    let message;
    try {
      message = JSON.parse(request.body);
    } catch {
      return this.#json(400, jsonRpcError(null, -32700, "Parse error"));
    }

    const messages = Array.isArray(message) ? message : [message];
    const responses = [];
    for (const msg of messages) {
      const response = await this.#dispatch(msg);
      if (response) {
        responses.push(response);
      }
    }
    if (!responses.length) {
      return { status: 202 };
    }
    return this.#json(200, Array.isArray(message) ? responses : responses[0]);
  }

  #json(status, payload) {
    return {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  }

  async #dispatch(msg) {
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // Responses to our (non-existent) requests, or junk.
      return msg?.id === undefined
        ? null
        : jsonRpcError(msg.id, -32600, "Invalid Request");
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) {
      return null;
    }

    switch (msg.method) {
      case "initialize":
        return jsonRpcResult(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "zen-browser",
            title: "Zen Browser",
            version: Services.appinfo.version,
          },
          instructions:
            "Controls the user's real Zen Browser session (their logins and tabs). " +
            "Tabs are addressed by the `id` from tabs_list; spaces by name or uuid. " +
            "Zen-specific concepts: spaces (workspaces) each have an optional default " +
            "container; space routing rules send matching URLs to a space; essentials " +
            "are pinned tabs shared across spaces.",
        });
      case "ping":
        return jsonRpcResult(msg.id, {});
      case "tools/list":
        return jsonRpcResult(msg.id, {
          tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        });
      case "tools/call": {
        const tool = TOOLS.find(t => t.name === msg.params?.name);
        if (!tool) {
          return jsonRpcError(
            msg.id,
            -32602,
            `Unknown tool: ${msg.params?.name}`
          );
        }
        try {
          const value = await tool.run(msg.params.arguments ?? {});
          return jsonRpcResult(msg.id, { content: toContent(value) });
        } catch (error) {
          return jsonRpcResult(msg.id, {
            content: [{ type: "text", text: String(error?.message ?? error) }],
            isError: true,
          });
        }
      }
      default:
        return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
}

export const gZenMcpServer = new nsZenMcpServer();
