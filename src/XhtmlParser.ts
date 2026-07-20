/**
 * Lightweight regex-based XHTML parser for ABB RWS 2.0 responses.
 * RWS 2.0 returns application/xhtml+xml;v=2.0 for all endpoints.
 * Data lives in <li class="TYPE"> elements containing <span class="FIELD">VALUE</span> nodes.
 */
export class XhtmlParser {
  constructor(private readonly html: string) {}

  /** Returns span-value map from the first <li class="liClass"> in the document. */
  getState(liClass: string): Record<string, string> {
    return this.getAllStates(liClass)[0] ?? {};
  }

  /** Returns an array of span-value maps, one per <li class="liClass"> in the document. */
  getAllStates(liClass: string): Array<Record<string, string>> {
    const results: Array<Record<string, string>> = [];
    const liRe = new RegExp(`<li class="${liClass}"([^>]*)>([\\s\\S]*?)</li>`, 'g');
    for (const m of this.html.matchAll(liRe)) {
      const attrs = m[1];
      const inner = m[2];
      const fields: Record<string, string> = {};

      const titleM = attrs.match(/title="([^"]*)"/);
      if (titleM) { fields['_title'] = titleM[1]; }

      // href with rel="self" - stores the resource path (used for signal network/device)
      const hrefM = inner.match(/href="([^"]*?)" rel="self"/);
      if (hrefM) { fields['_href'] = hrefM[1]; }

      for (const [, cls, val] of inner.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) {
        fields[cls] = val;
      }
      results.push(fields);
    }
    return results;
  }

  /** Extracts a single span value from anywhere in the document. */
  get(spanClass: string): string | undefined {
    return this.html.match(new RegExp(`<span class="${spanClass}">([^<]*)<\\/span>`))?.[1];
  }

  /**
   * Returns error details if the response contains an ABB error status block.
   * Error pattern: <span class="code">-1073445862</span><span class="msg">...</span>
   */
  getError(): { code: string; msg: string } | null {
    const codeM = this.html.match(/<span class="code">(-\d+)<\/span>/);
    if (!codeM) { return null; }
    const msgM = this.html.match(/<span class="msg">([^<]*)<\/span>/);
    return { code: codeM[1], msg: msgM?.[1] ?? '' };
  }
}
