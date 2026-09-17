/**
 * `for await (const chunk of stream)` for WebKit.
 *
 * pdf.js reads its streams that way — a page's text, and the compressed data
 * inside a file — and the WebKit the app runs on does not make a ReadableStream
 * iterable yet. The loop then fails before it starts, as "undefined is not a
 * function", and a specification never gets read. This fills in the one method
 * the loop asks for; where the browser has its own, that one is kept.
 */
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype.values = function values({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (err) {
          reader.releaseLock();
          throw err;
        }
      },
      async return(value) {
        if (!preventCancel) {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        } else {
          reader.releaseLock();
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}
