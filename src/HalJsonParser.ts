/**
 * Parser for RWS 2.0 HAL JSON responses (`application/hal+json;v=2.0`) - the
 * officially supported primary GET representation on OmniCore controllers.
 *
 * Live-verified 2026-07-09 on OmniCore VC RW7.21 across every GET endpoint
 * family the client touches (panel, rapid, motionsystem, system, ctrl, elog,
 * iosystem, cfg, mastership, users/rmmp). The wire shape is:
 *
 *   { "_links":    { "base": {...}, "self": {...} [, "next": {...}] },
 *     "status":    { "code": 294912 },                  // negative on errors, plus "msg"
 *     "state":     [ { "_type": "...", "_title": "...", ...fields } ],
 *     "_embedded": { "resources": [ { "_type": "...", ...fields } ] } }
 *
 * `_type` carries the same identifier the XHTML representation puts in the
 * `<li class="...">` attribute, `_title` mirrors the `title` attribute, and
 * the former `<span class="X">` fields become plain JSON keys. Resources can
 * nest (e.g. `sys-options-li` holds an `options` array of typed objects,
 * `cfg-dt-instance-li` an `attrib` array of `cfg-ia-t` entries), so lookups
 * recurse - mirroring how the XHTML parser finds `<li>` anywhere in the
 * document. Presents the same read interface as `XhtmlParser` so `RwsClient2`
 * can treat both representations alike.
 */

type JsonNode = string | number | boolean | null | JsonNode[] | { [key: string]: JsonNode };
type JsonObject = { [key: string]: JsonNode };

export class HalJsonParser {
  private readonly root: JsonNode | null;

  constructor(body: string) {
    let parsed: JsonNode | null = null;
    try { parsed = JSON.parse(body) as JsonNode; } catch { parsed = null; }
    this.root = parsed;
  }

  /** Cheap sniff used to pick a parser: HAL bodies are single JSON objects. */
  static looksLikeJson(body: string): boolean {
    return body.trimStart().startsWith('{');
  }

  /** Returns the field map of the first resource whose `_type` matches. */
  getState(type: string): Record<string, string> {
    return this.getAllStates(type)[0] ?? {};
  }

  /** Returns field maps for every resource with a matching `_type`, in document order. */
  getAllStates(type: string): Array<Record<string, string>> {
    const results: Array<Record<string, string>> = [];
    this.walk(this.root, obj => {
      if (obj['_type'] === type) { results.push(HalJsonParser.flatten(obj)); }
    });
    return results;
  }

  /** First scalar value stored under `key` in any resource (XhtmlParser.get analogue). */
  get(key: string): string | undefined {
    let found: string | undefined;
    this.walk(this.root, obj => {
      if (found !== undefined) { return; }
      const v = obj[key];
      if (v !== undefined && v !== null && typeof v !== 'object' && !key.startsWith('_')) {
        found = String(v);
      }
    });
    return found;
  }

  /**
   * Error details from the top-level status block. Success responses carry a
   * positive code (294912 observed live); errors a negative code plus `msg`.
   */
  getError(): { code: string; msg: string } | null {
    const status = this.rootObject()?.['status'];
    if (!status || typeof status !== 'object' || Array.isArray(status)) { return null; }
    const code = (status as JsonObject)['code'];
    if (typeof code !== 'number' || code >= 0) { return null; }
    const msg = (status as JsonObject)['msg'];
    return { code: String(code), msg: typeof msg === 'string' ? msg : '' };
  }

  /**
   * Pagination link (`_links.next.href`), raw as sent. Live-verified quirk:
   * the controller XML-escapes ampersands even inside JSON strings
   * (`"signals?start=3&amp;limit=3"`) - callers must unescape, exactly as on
   * the XHTML `rel="next"` path.
   */
  nextHref(): string | undefined {
    const links = this.rootObject()?.['_links'];
    if (!links || typeof links !== 'object' || Array.isArray(links)) { return undefined; }
    const next = (links as JsonObject)['next'];
    if (!next || typeof next !== 'object' || Array.isArray(next)) { return undefined; }
    const href = (next as JsonObject)['href'];
    return typeof href === 'string' && href ? href : undefined;
  }

  private rootObject(): JsonObject | null {
    return this.root && typeof this.root === 'object' && !Array.isArray(this.root)
      ? this.root as JsonObject
      : null;
  }

  /** Depth-first visit of every object in the tree, skipping `_links` blocks. */
  private walk(node: JsonNode | null, visit: (obj: JsonObject) => void): void {
    if (Array.isArray(node)) {
      for (const item of node) { this.walk(item, visit); }
      return;
    }
    if (node && typeof node === 'object') {
      visit(node as JsonObject);
      for (const [key, value] of Object.entries(node)) {
        if (key === '_links') { continue; }
        if (value && typeof value === 'object') { this.walk(value, visit); }
      }
    }
  }

  /** Scalar fields → strings; `_title` kept; self link exposed as `_href` (XHTML parity). */
  private static flatten(obj: JsonObject): Record<string, string> {
    const fields: Record<string, string> = {};
    const title = obj['_title'];
    if (typeof title === 'string') { fields['_title'] = title; }
    const links = obj['_links'];
    if (links && typeof links === 'object' && !Array.isArray(links)) {
      const self = (links as JsonObject)['self'];
      if (self && typeof self === 'object' && !Array.isArray(self)) {
        const href = (self as JsonObject)['href'];
        if (typeof href === 'string') { fields['_href'] = href; }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('_')) { continue; }
      if (value === null || typeof value === 'object') { continue; } // nested resources have their own _type
      fields[key] = String(value);
    }
    return fields;
  }
}
