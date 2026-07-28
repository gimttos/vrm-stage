/**
 * Minimal OSC 1.0 reader — just enough for the VMC protocol.
 *
 * Hand-rolled rather than pulled from npm: OSC's wire format is small and fully
 * specified, and the bridge is the one piece a user has to run locally, so it is
 * worth keeping dependency-free and auditable.
 *
 * Layout: null-terminated strings padded to 4-byte boundaries, a type-tag string
 * beginning with ',', then big-endian arguments in tag order.
 */

const BUNDLE_TAG = '#bundle';

/** Reads a null-terminated, 4-byte-aligned OSC string. */
function readString(view, offset) {
  let end = offset;
  while (end < view.byteLength && view[end] !== 0) end++;
  const value = Buffer.from(view.subarray(offset, end)).toString('utf8');
  // At least one null, then pad to the next multiple of four.
  const next = offset + Math.ceil((end - offset + 1) / 4) * 4;
  return { value, next };
}

function readArguments(view, offset, tags) {
  const args = [];
  let cursor = offset;

  for (const tag of tags) {
    switch (tag) {
      case 'i': {
        args.push(new DataView(view.buffer, view.byteOffset + cursor, 4).getInt32(0, false));
        cursor += 4;
        break;
      }
      case 'f': {
        args.push(new DataView(view.buffer, view.byteOffset + cursor, 4).getFloat32(0, false));
        cursor += 4;
        break;
      }
      case 's':
      case 'S': {
        const { value, next } = readString(view, cursor);
        args.push(value);
        cursor = next;
        break;
      }
      case 'b': {
        const size = new DataView(view.buffer, view.byteOffset + cursor, 4).getInt32(0, false);
        cursor += 4 + Math.ceil(size / 4) * 4;
        args.push(null);
        break;
      }
      case 'T':
        args.push(true);
        break;
      case 'F':
        args.push(false);
        break;
      case 'N':
        args.push(null);
        break;
      case 'I':
        args.push(Infinity);
        break;
      default:
        // Unknown tag: we cannot know its width, so stop rather than misread the
        // rest of the packet as garbage.
        return { args, cursor, truncated: true };
    }
  }

  return { args, cursor, truncated: false };
}

/**
 * Decodes one OSC packet into a flat list of `{ address, args }`.
 * Bundles are flattened; nested bundles are handled recursively.
 */
export function decodePacket(buffer) {
  const view = new Uint8Array(buffer);
  const messages = [];
  collect(view, 0, view.byteLength, messages);
  return messages;
}

function collect(view, start, end, out) {
  if (end - start < 4) return;

  const head = readString(view, start);

  if (head.value === BUNDLE_TAG) {
    // 8-byte timetag follows the '#bundle' string, then size-prefixed elements.
    let cursor = head.next + 8;
    while (cursor + 4 <= end) {
      const size = new DataView(view.buffer, view.byteOffset + cursor, 4).getInt32(0, false);
      cursor += 4;
      if (size <= 0 || cursor + size > end) break;
      collect(view, cursor, cursor + size, out);
      cursor += size;
    }
    return;
  }

  if (!head.value.startsWith('/')) return;

  const tagsRead = readString(view, head.next);
  if (!tagsRead.value.startsWith(',')) {
    out.push({ address: head.value, args: [] });
    return;
  }

  const { args } = readArguments(view, tagsRead.next, tagsRead.value.slice(1));
  out.push({ address: head.value, args });
}
