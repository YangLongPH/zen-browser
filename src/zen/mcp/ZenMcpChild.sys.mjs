/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs in the page's content process: reads the DOM and evaluates scripts for
// the MCP page_* tools.

function truncate(text, maxLength) {
  return text.length > maxLength
    ? { text: text.slice(0, maxLength), truncated: true, length: text.length }
    : { text, truncated: false, length: text.length };
}

export class ZenMcpChild extends JSWindowActorChild {
  async receiveMessage({ name, data }) {
    switch (name) {
      case "read":
        return this.#read(data);
      case "eval":
        return this.#eval(data);
    }
    throw new Error(`Unknown ZenMcp message ${name}`);
  }

  #read({ format, maxLength }) {
    const doc = this.document;
    const base = { url: doc.URL, title: doc.title };
    if (format === "links") {
      const links = Array.from(doc.links, link => ({
        text: (link.innerText || link.title || "").trim().slice(0, 200),
        href: link.href,
      })).filter(link => link.href);
      return { ...base, links: links.slice(0, 1000), total: links.length };
    }
    if (format === "html") {
      return { ...base, ...truncate(doc.documentElement.outerHTML, maxLength) };
    }
    return { ...base, ...truncate(doc.body?.innerText ?? "", maxLength) };
  }

  async #eval({ expression }) {
    const win = this.contentWindow;
    // Same view as the page's own scripts (no Xray wrappers).
    const sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      sameZoneAs: win,
      wantXrays: false,
    });
    let value = Cu.evalInSandbox(expression, sandbox);
    if (value && typeof value.then === "function") {
      value = await value;
    }
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      return { error: `Result is not JSON-serializable: ${error}` };
    }
    return json === undefined ? null : JSON.parse(json);
  }
}
