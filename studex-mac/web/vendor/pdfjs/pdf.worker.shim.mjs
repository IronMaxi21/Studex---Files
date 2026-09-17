// The worker reads streams with `for await` too, so it gets the same fill-in
// before pdf.js itself is evaluated. Imports run in the order they are written.
import '../../js/stream-iterator.js';
import './pdf.worker.min.mjs';
